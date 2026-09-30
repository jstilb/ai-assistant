#!/usr/bin/env bun
/**
 * GraphPersistence - JSONL-based file storage for DevGraph
 *
 * Append-only JSONL files per node/edge type.
 * Uses StateManager for meta.json persistence.
 * Deduplication via node/edge ID.
 * Incremental ingestion tracking.
 *
 * Storage layout:
 *   MEMORY/GRAPH/
 *   +-- meta.json          (graph metadata via StateManager)
 *   +-- nodes/
 *   |   +-- session.jsonl
 *   |   +-- commit.jsonl
 *   |   +-- ...
 *   +-- edges/
 *       +-- produced.jsonl
 *       +-- modifies.jsonl
 *       +-- ...
 *
 * @module Graph/GraphPersistence
 * @version 1.0.0
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'fs';
import { join, basename, dirname } from 'path';
import { z } from 'zod';
import { createStateManager } from '../../../../lib/core/StateManager';
import { getSharedGraphDir } from '../../../../lib/core/KayaHome';
import { createAppendLog, type AppendLog, type AppendLogOptions } from '../../../../lib/core/AppendLog.ts';
import type { GraphNode, GraphEdge, GraphState, GraphNodeType, GraphEdgeType } from './types';
import { ALL_NODE_TYPES, ALL_EDGE_TYPES, createEmptyGraphState } from './types';
import { GraphEngine } from './GraphEngine';

// ============================================
// CONSTANTS
// ============================================

const GRAPH_DIR = getSharedGraphDir();
const NODES_DIR = join(GRAPH_DIR, 'nodes');
const EDGES_DIR = join(GRAPH_DIR, 'edges');
const META_PATH = join(GRAPH_DIR, 'meta.json');

/**
 * Rotated-shard retention for graph logs (Slice B1 — context integrity).
 *
 * loadNodes()/loadEdges() now fold EVERY rotated shard into their result —
 * correctness depends on all of them, not just the active file. AppendLog's
 * generic default retention (90 days / max 10 rotated files) exists for
 * logs where old rotated data is disposable; for the graph it is not.
 * Left at the default, a routine future rotation's automatic doCleanup()
 * pass would silently delete a rotated shard that queries still depend on —
 * silent permanent data loss, just delayed past 90 days rather than
 * immediate. Graph logs opt out of automatic deletion entirely; compactAll()
 * (which ARCHIVES, never deletes) is the only sanctioned way to retire a
 * rotated shard.
 */
const GRAPH_LOG_OPTIONS: AppendLogOptions = {
  retentionDays: 36_500, // ~100 years — effectively never auto-deleted
  maxRotatedFiles: 100_000, // effectively unbounded
};

// ============================================
// STATE SCHEMA
// ============================================

const GraphStateSchema = z.object({
  version: z.number(),
  lastIngested: z.string(),
  nodeCount: z.number(),
  edgeCount: z.number(),
  nodesByType: z.record(z.string(), z.number()),
  edgesByType: z.record(z.string(), z.number()),
});

/** Result of compacting a single node/edge type's rotated shards (Slice B1). */
export interface CompactResult {
  type: string;
  /** Deduplicated record count now in the active file. */
  recordCount: number;
  /** Archive destination paths for the now-redundant rotated shards. */
  archivedShards: string[];
  /** Malformed lines skipped while folding (should be 0 in practice). */
  malformedCount: number;
}

// ============================================
// GRAPH PERSISTENCE
// ============================================

// Module-level singleton — lives for the duration of the process
// Maps filePath -> Set<id>. Eliminates O(n) file read on every appendNode call.
// @deprecated Use GraphPersistence instance methods instead
let _nodeIdCache: Map<string, Set<string>> | null = null;

/** Get the in-memory node ID set for a given file path.
 * Initial load reads the file once; subsequent calls use the in-memory set.
 * @deprecated Use GraphPersistence instance getNodeIds() instead
 */
function getNodeIdSet(filePath: string): Set<string> {
  if (_nodeIdCache === null) _nodeIdCache = new Map();
  if (!_nodeIdCache.has(filePath)) {
    _nodeIdCache.set(filePath, loadNodeIdsFromFile(filePath));
  }
  return _nodeIdCache.get(filePath)!;
}

function loadNodeIdsFromFile(filePath: string): Set<string> {
  if (!existsSync(filePath)) return new Set();
  const ids = new Set<string>();
  const content = readFileSync(filePath, 'utf-8');
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed.id) ids.add(parsed.id);
    } catch { /* skip malformed */ }
  }
  return ids;
}

// ============================================
// ROTATED-SHARD MERGE (Slice B1 — context integrity)
// ============================================
//
// AppendLog rotates any JSONL over 10MB to a timestamped sibling
// `<type>.<ISO>.jsonl`, leaving the active `<type>.jsonl` holding only the
// most recent slice. Reading only the active file makes every record in a
// rotated sibling invisible to every graph query. This helper folds the
// active file + all rotated siblings into a single id-deduplicated set,
// oldest shard first, active file last so it wins any id collisions
// (last-write-wins). Used by both the read path (loadNodes/loadEdges) and
// the append-dedup ID warm (getNodeIds/getEdgeIds) so that:
//   (a) queries see every historical record, and
//   (b) re-ingestion can never recreate a record that already exists in a
//       rotated shard (the root cause of the learned_from write-amplification
//       bug — dedup that only sees the active file rewrites the whole
//       historical edge set on every run).

/** Minimal shape every graph record satisfies — used to key the fold. */
interface Identifiable {
  id: string;
}

/**
 * A tombstone marker appended by GraphPersistence.tombstoneNode() (Slice C1
 * — context integrity). Distinct from a full GraphNode: it deliberately
 * lacks title/tags/metadata so the append is a cheap, mechanical write that
 * doesn't require re-reading or re-serializing the full record it expires.
 * See the "EXPIRY FOLD" note above readShardsFolded() for how it's merged.
 */
interface TombstoneMarker {
  id: string;
  tombstone: true;
  valid_to: string;
  created_at: string;
  reason?: string;
}

/** Narrow a folded line to a tombstone marker without widening to `any`. */
function isTombstoneMarker(value: object): value is TombstoneMarker {
  const v = value as { tombstone?: unknown; valid_to?: unknown };
  return v.tombstone === true && typeof v.valid_to === 'string';
}

/**
 * Merge a type's active JSONL file with all of its rotated siblings, folding
 * by record id (last-write-wins; the active/newest file wins ties). Malformed
 * lines are skipped and counted, never thrown — mirrors the existing
 * loadNodes()/loadEdges() tolerance.
 *
 * EXPIRY FOLD (Slice C1 — context integrity): a line may be a bare
 * TombstoneMarker rather than a full record (see tombstoneNode()). When one
 * is encountered, its `valid_to` is MERGED onto whatever record already sits
 * in `folded` for that id — never a wholesale replace. A tombstone always
 * appends strictly after the record it expires (same file, later line; or a
 * later-processed shard — active file is always folded last), so the base
 * record has always already been folded by the time its tombstone is seen.
 * The one exception is a tombstone for an id `readShardsFolded` has never
 * seen (a bug elsewhere, since tombstoneNode() itself refuses to write an
 * orphan) — in that pathological case the bare marker is kept as-is rather
 * than dropped, so the malformed state stays visible instead of silently
 * vanishing.
 */
function readShardsFolded<T extends Identifiable>(
  activePath: string,
  rotatedPaths: string[],
): { records: T[]; malformedCount: number } {
  const folded = new Map<string, T>();
  let malformedCount = 0;

  // Oldest rotated shards first, active (newest) file last so it wins ties.
  const orderedPaths = [...rotatedPaths, activePath];

  for (const filePath of orderedPaths) {
    if (!existsSync(filePath)) continue;
    const content = readFileSync(filePath, 'utf-8');
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      try {
        // JSON.parse is inherently `any` at the boundary; the existing
        // loadNodes()/loadEdges() callers already cast the same way and
        // this preserves that precedent rather than widening it.
        const parsed = JSON.parse(line) as T;
        if (!parsed.id) continue;

        if (isTombstoneMarker(parsed)) {
          const existing = folded.get(parsed.id);
          folded.set(parsed.id, existing ? { ...existing, valid_to: parsed.valid_to } : parsed);
        } else {
          folded.set(parsed.id, parsed);
        }
      } catch {
        malformedCount++;
      }
    }
  }

  return { records: Array.from(folded.values()), malformedCount };
}

/** Clear the in-memory node ID cache. Call after --rebuild or in tests.
 * @deprecated Use GraphPersistence instance clearCache() instead
 */
export function clearNodeIdCache(): void {
  _nodeIdCache = null;
}

export class GraphPersistence {
  private baseDir: string;
  private nodesDir: string;
  private edgesDir: string;
  private metaPath: string;
  /**
   * Root for archived (compacted-away) rotated shards. Deliberately a
   * SIBLING of baseDir, not a subdirectory of it: archived shards are
   * full-size, never-deleted copies of data that's now also merged into the
   * active file, so keeping them inside baseDir would make `du -sh baseDir`
   * grow after compaction instead of shrink (measured on the real store —
   * see Slice B1 report). Living outside baseDir means compaction actually
   * reduces the live store's footprint while the archive stays reversible.
   */
  private archiveDir: string;
  private stateManager: ReturnType<typeof createStateManager<GraphState>>;

  /** Per-type in-memory ID cache for nodes. Loaded once on first access per type. */
  private _nodeIdCache = new Map<GraphNodeType, Set<string>>();
  /** Per-type in-memory ID cache for edges. Loaded once on first access per type. */
  private _edgeIdCache = new Map<GraphEdgeType, Set<string>>();
  /** Per-type AppendLog instances for node JSONL files. Reused across calls. */
  private _nodeLogCache = new Map<GraphNodeType, AppendLog>();
  /** Per-type AppendLog instances for edge JSONL files. Reused across calls. */
  private _edgeLogCache = new Map<GraphEdgeType, AppendLog>();

  constructor(baseDir?: string) {
    this.baseDir = baseDir || GRAPH_DIR;
    this.nodesDir = join(this.baseDir, 'nodes');
    this.edgesDir = join(this.baseDir, 'edges');
    this.metaPath = join(this.baseDir, 'meta.json');
    this.archiveDir = join(dirname(this.baseDir), `${basename(this.baseDir)}-archive`);

    this.stateManager = createStateManager<GraphState>({
      path: this.metaPath,
      schema: GraphStateSchema as z.ZodSchema<GraphState>,
      defaults: createEmptyGraphState,
      // Shared out-of-repo store: multiple concurrent sessions + crons may
      // rewrite meta.json — widen the lock window beyond the 5s default.
      lockTimeout: 10000,
    });

    this.ensureDirectories();
  }

  // ============================================
  // DIRECTORY SETUP
  // ============================================

  private ensureDirectories(): void {
    if (!existsSync(this.baseDir)) mkdirSync(this.baseDir, { recursive: true });
    if (!existsSync(this.nodesDir)) mkdirSync(this.nodesDir, { recursive: true });
    if (!existsSync(this.edgesDir)) mkdirSync(this.edgesDir, { recursive: true });
  }

  // ============================================
  // FILE PATHS
  // ============================================

  private nodeFilePath(type: GraphNodeType): string {
    return join(this.nodesDir, `${type}.jsonl`);
  }

  private edgeFilePath(type: GraphEdgeType): string {
    return join(this.edgesDir, `${type}.jsonl`);
  }

  /** Get (or create) the AppendLog for a node type's JSONL file. */
  private getNodeLog(type: GraphNodeType): AppendLog {
    let log = this._nodeLogCache.get(type);
    if (!log) {
      log = createAppendLog(this.nodeFilePath(type), GRAPH_LOG_OPTIONS);
      this._nodeLogCache.set(type, log);
    }
    return log;
  }

  /** Get (or create) the AppendLog for an edge type's JSONL file. */
  private getEdgeLog(type: GraphEdgeType): AppendLog {
    let log = this._edgeLogCache.get(type);
    if (!log) {
      log = createAppendLog(this.edgeFilePath(type), GRAPH_LOG_OPTIONS);
      this._edgeLogCache.set(type, log);
    }
    return log;
  }

  // ============================================
  // ID CACHES
  // ============================================

  /**
   * Get (or warm) the in-memory ID Set for a node type.
   * Cold path: reads file once per type. Hot path: O(1) Set lookup.
   */
  private getNodeIds(type: GraphNodeType): Set<string> {
    if (this._nodeIdCache.has(type)) {
      return this._nodeIdCache.get(type)!;
    }
    const ids = this.loadNodeIdsFromFile(type);
    this._nodeIdCache.set(type, ids);
    return ids;
  }

  /**
   * Warm the append-dedup ID set from EVERY shard (active + rotated), not
   * just the active file. This must see rotated ids — narrowing it would let
   * re-ingestion recreate records that already exist in a rotated shard
   * (the learned_from write-amplification bug).
   */
  private loadNodeIdsFromFile(type: GraphNodeType): Set<string> {
    const log = this.getNodeLog(type);
    const { records } = readShardsFolded<GraphNode>(log.path, log.rotatedPaths());
    return new Set(records.map(r => r.id));
  }

  /**
   * Get (or warm) the in-memory ID Set for an edge type.
   * Cold path: reads file once per type. Hot path: O(1) Set lookup.
   */
  private getEdgeIds(type: GraphEdgeType): Set<string> {
    if (this._edgeIdCache.has(type)) {
      return this._edgeIdCache.get(type)!;
    }
    const ids = this.loadEdgeIdsFromFile(type);
    this._edgeIdCache.set(type, ids);
    return ids;
  }

  /**
   * Warm the append-dedup ID set from EVERY shard (active + rotated), not
   * just the active file. This must see rotated ids — narrowing it would let
   * re-ingestion recreate records that already exist in a rotated shard
   * (the learned_from write-amplification bug).
   */
  private loadEdgeIdsFromFile(type: GraphEdgeType): Set<string> {
    const log = this.getEdgeLog(type);
    const { records } = readShardsFolded<GraphEdge>(log.path, log.rotatedPaths());
    return new Set(records.map(r => r.id));
  }

  /**
   * Clear all in-memory ID caches for both nodes and edges.
   * Call before rebuildMeta() or after any external modification of JSONL files.
   */
  public clearCache(): void {
    this._nodeIdCache.clear();
    this._edgeIdCache.clear();
  }

  // ============================================
  // NODE OPERATIONS
  // ============================================

  /**
   * Append a node to its type-specific JSONL file.
   * Skips if a node with the same ID already exists in that file.
   * @returns true if appended, false if duplicate
   */
  appendNode(node: GraphNode): boolean {
    const ids = this.getNodeIds(node.type);  // O(1) after initial load

    if (ids.has(node.id)) return false;

    this.getNodeLog(node.type).append(node);
    ids.add(node.id);  // Update cache immediately
    return true;
  }

  /**
   * Expire an EXISTING node in place by appending a tombstone marker
   * (Slice C1 — context integrity). Makes the dormant `valid_to` field live:
   * a superseded fact gets a validity window instead of being deleted or
   * left equally live/rankable forever.
   *
   * Deliberately a SEPARATE method from appendNode(), not a "smarter"
   * appendNode() — appendNode()'s `if (ids.has(node.id)) return false;` gate
   * exists to stop duplicate CREATES and is relied on everywhere for pure
   * append-dedup. Tombstoning an id that already exists is not a create; if
   * tombstoneNode() reused that gate it would silently no-op every call.
   * Writes a bare marker `{ id, tombstone: true, valid_to, created_at,
   * reason? }` — NOT a full record — because the JSONL append log is
   * append-only (no in-place patch is possible without corrupting every
   * line after it); readShardsFolded() merges `valid_to` onto the existing
   * full record at read time rather than this write blanking
   * title/tags/metadata.
   *
   * Refuses to write a marker for an id this type has never seen — an
   * orphan tombstone would fold into a bare, mostly-empty "record" with no
   * base to merge onto. Existence is checked via getNodeIds(), which spans
   * rotated shards, so this correctly recognizes ids that only exist in a
   * rotated sibling.
   *
   * @returns true if the tombstone was written, false if `id` doesn't exist
   *   in this node type (nothing written — fails loud via stderr, not silently)
   */
  tombstoneNode(type: GraphNodeType, id: string, validTo: string, reason?: string): boolean {
    if (!this.getNodeIds(type).has(id)) {
      process.stderr.write(
        `[GraphPersistence] tombstoneNode: no existing ${type} node with id ${id} — refusing to write an orphan tombstone\n`,
      );
      return false;
    }

    const marker: { id: string; tombstone: true; valid_to: string; created_at: string; reason?: string } = {
      id,
      tombstone: true,
      valid_to: validTo,
      created_at: new Date().toISOString(),
      ...(reason !== undefined ? { reason } : {}),
    };
    this.getNodeLog(type).append(marker);
    // No id-cache update: the id already exists (checked above), tombstoning
    // doesn't add a new one.
    return true;
  }

  /**
   * Append multiple nodes, skipping duplicates.
   * @returns Count of nodes actually appended
   */
  appendNodes(nodes: GraphNode[]): number {
    let count = 0;
    // Group by type for efficient dedup checking
    const byType = new Map<GraphNodeType, GraphNode[]>();
    for (const node of nodes) {
      const group = byType.get(node.type) || [];
      group.push(node);
      byType.set(node.type, group);
    }

    for (const [type, typeNodes] of byType) {
      const ids = this.getNodeIds(type);  // O(1) after initial load
      let batch = '';

      for (const node of typeNodes) {
        if (!ids.has(node.id)) {
          batch += JSON.stringify(node) + '\n';
          ids.add(node.id);  // Update in-memory cache
          count++;
        }
      }

      if (batch) {
        this.getNodeLog(type).appendRaw(batch);
      }
    }

    return count;
  }

  /**
   * Load all nodes of a given type from JSONL — the active file merged with
   * every rotated sibling, deduplicated by id (last-write-wins). See the
   * "ROTATED-SHARD MERGE" note above readShardsFolded() for why this is
   * required rather than reading the active file alone.
   *
   * `excludeExpired` (Slice C1 — context integrity) is opt-in and defaults
   * to unset/false — the read INCLUDES expired (tombstoned) nodes unless a
   * caller explicitly asks otherwise. This is deliberate, not an oversight:
   * flipping the default would require correctly auditing every one of this
   * method's ~10 existing call sites, and missing even one fails SILENTLY
   * in the dangerous direction (a forensic/integrity tool quietly starts
   * under-reporting). Include-by-default fails safe. Only the semantic-
   * search candidate hydration paths (EmbeddingEngine, EmbeddingQuerier)
   * pass `{ excludeExpired: true }` — see their call sites for why.
   */
  loadNodes(type: GraphNodeType, options?: { excludeExpired?: boolean }): GraphNode[] {
    const log = this.getNodeLog(type);
    const { records, malformedCount } = readShardsFolded<GraphNode>(log.path, log.rotatedPaths());

    if (malformedCount > 0) {
      process.stderr.write(
        `[GraphPersistence] Warning: ${malformedCount} malformed lines in ${log.path} (incl. rotated shards)\n`,
      );
    }

    if (options?.excludeExpired) {
      return records.filter(n => !n.valid_to);
    }
    return records;
  }

  /**
   * Load all nodes of all types. See loadNodes() for `excludeExpired`.
   */
  loadAllNodes(options?: { excludeExpired?: boolean }): GraphNode[] {
    const all: GraphNode[] = [];
    for (const type of ALL_NODE_TYPES) {
      all.push(...this.loadNodes(type, options));
    }
    return all;
  }

  // loadNodeIds() replaced by module-level getNodeIdSet() / loadNodeIdsFromFile() for O(1) per-call access

  // ============================================
  // EDGE OPERATIONS
  // ============================================

  /**
   * Append an edge to its type-specific JSONL file.
   * Skips if an edge with the same ID already exists.
   * @returns true if appended, false if duplicate
   */
  appendEdge(edge: GraphEdge): boolean {
    const ids = this.getEdgeIds(edge.type);  // O(1) after initial load

    if (ids.has(edge.id)) return false;

    this.getEdgeLog(edge.type).append(edge);
    ids.add(edge.id);  // Update cache immediately
    return true;
  }

  /**
   * Append multiple edges, skipping duplicates.
   * @returns Count of edges actually appended
   */
  appendEdges(edges: GraphEdge[]): number {
    let count = 0;
    const byType = new Map<GraphEdgeType, GraphEdge[]>();
    for (const edge of edges) {
      const group = byType.get(edge.type) || [];
      group.push(edge);
      byType.set(edge.type, group);
    }

    for (const [type, typeEdges] of byType) {
      const ids = this.getEdgeIds(type);  // O(1) after initial load
      let batch = '';

      for (const edge of typeEdges) {
        if (!ids.has(edge.id)) {
          batch += JSON.stringify(edge) + '\n';
          ids.add(edge.id);  // Update cache immediately
          count++;
        }
      }

      if (batch) {
        this.getEdgeLog(type).appendRaw(batch);
      }
    }

    return count;
  }

  /**
   * Load all edges of a given type from JSONL — the active file merged with
   * every rotated sibling, deduplicated by id (last-write-wins). See the
   * "ROTATED-SHARD MERGE" note above readShardsFolded() for why this is
   * required rather than reading the active file alone.
   */
  loadEdges(type: GraphEdgeType): GraphEdge[] {
    const log = this.getEdgeLog(type);
    const { records, malformedCount } = readShardsFolded<GraphEdge>(log.path, log.rotatedPaths());

    if (malformedCount > 0) {
      process.stderr.write(
        `[GraphPersistence] Warning: ${malformedCount} malformed edges in ${log.path} (incl. rotated shards)\n`,
      );
    }

    return records;
  }

  /**
   * Load all edges of all types.
   */
  loadAllEdges(): GraphEdge[] {
    const all: GraphEdge[] = [];
    for (const type of ALL_EDGE_TYPES) {
      all.push(...this.loadEdges(type));
    }
    return all;
  }


  // ============================================
  // GRAPH ENGINE HYDRATION
  // ============================================

  /**
   * Load all persisted data into a GraphEngine instance.
   * Rebuilds adjacency lists from JSONL files.
   *
   * `excludeExpired` (Slice C1 — context integrity) passes through to
   * loadAllNodes(); default unset/false, same fail-safe reasoning as
   * loadNodes() itself. Edges are NEVER filtered (Q2 of the design: GraphEdge
   * carries no validity field) — an edge whose endpoint got filtered out
   * just becomes a dangling adjacency entry, which GraphEngine already
   * tolerates (bfs() skips emitting a node it can't find by id but still
   * traverses through its edges to reach further neighbors — so filtering
   * a node doesn't sever a trace chain, it only keeps that one node out of
   * the printed results).
   */
  loadIntoEngine(engine?: GraphEngine, options?: { excludeExpired?: boolean }): GraphEngine {
    const graph = engine || new GraphEngine();

    const nodes = this.loadAllNodes(options);
    const edges = this.loadAllEdges();

    graph.loadFromArrays(nodes, edges);

    return graph;
  }

  // ============================================
  // META STATE
  // ============================================

  /**
   * Load graph metadata.
   */
  async loadMeta(): Promise<GraphState> {
    return this.stateManager.load();
  }

  /**
   * Save graph metadata.
   */
  async saveMeta(state: GraphState): Promise<void> {
    return this.stateManager.save(state);
  }

  /**
   * Update graph metadata atomically.
   */
  async updateMeta(fn: (state: GraphState) => GraphState): Promise<GraphState> {
    return this.stateManager.update(fn);
  }

  // ============================================
  // PHYSICAL COMPACTION (Slice B1 — context integrity)
  // ============================================
  //
  // The read-path fix (loadNodes/loadEdges/readShardsFolded) makes rotated
  // shards correct to read from forever via glob-merge — compaction is a
  // pure optimization on top of that, never a correctness requirement.
  // It physically collapses a type's active file + rotated siblings into a
  // single deduplicated active file, so future cold-process reads
  // (loadIntoEngine() re-reads everything from scratch on every CLI
  // invocation — there is no persistent cache) don't pay repeated I/O+parse
  // cost for data that's substantially overlapping (learned_from: 126,233 of
  // 126,233 rotated ids were already duplicated in the active file — that
  // redundant ~47MB was being read and immediately discarded on every call).
  //
  // Rotated siblings are ARCHIVED (moved to <baseDir>-archive/{nodes,edges}/,
  // a SIBLING of baseDir — never deleted) so compaction is always
  // reversible. The archive deliberately lives OUTSIDE baseDir: archived
  // files are full, uncompressed copies of data that's now also in the
  // merged active file, so archiving inside baseDir would make
  // `du -sh baseDir` grow after compaction instead of shrink.

  /**
   * Merge a type's active file + rotated shards into one deduplicated file,
   * written via temp-file + atomic rename (no partial-write window), then
   * archive the now-redundant rotated shards. Assumes callers have already
   * confirmed rotated.length > 0.
   */
  private compactShards<T extends Identifiable>(
    log: AppendLog,
    archiveDir: string,
  ): { recordCount: number; archivedShards: string[]; malformedCount: number } {
    const rotated = log.rotatedPaths();
    const { records, malformedCount } = readShardsFolded<T>(log.path, rotated);

    const tmpPath = `${log.path}.compact-tmp-${process.pid}-${Date.now()}`;
    const body = records.map(r => JSON.stringify(r)).join('\n') + (records.length > 0 ? '\n' : '');
    writeFileSync(tmpPath, body, 'utf-8');
    renameSync(tmpPath, log.path); // atomic — same directory/filesystem

    mkdirSync(archiveDir, { recursive: true });
    const archivedShards: string[] = [];
    for (const rotatedPath of rotated) {
      const dest = join(archiveDir, basename(rotatedPath));
      renameSync(rotatedPath, dest);
      archivedShards.push(dest);
    }

    return { recordCount: records.length, archivedShards, malformedCount };
  }

  /**
   * Physically compact a node type's rotated shards into its active file.
   * Returns null (no-op) if the type currently has no rotated shards.
   * Caller should call clearCache() afterward — compactAll() does this.
   */
  compactNodeType(type: GraphNodeType): CompactResult | null {
    const log = this.getNodeLog(type);
    if (log.rotatedPaths().length === 0) return null;
    const archiveDir = join(this.archiveDir, 'nodes');
    const result = this.compactShards<GraphNode>(log, archiveDir);
    return { type, ...result };
  }

  /**
   * Physically compact an edge type's rotated shards into its active file.
   * Returns null (no-op) if the type currently has no rotated shards.
   * Caller should call clearCache() afterward — compactAll() does this.
   */
  compactEdgeType(type: GraphEdgeType): CompactResult | null {
    const log = this.getEdgeLog(type);
    if (log.rotatedPaths().length === 0) return null;
    const archiveDir = join(this.archiveDir, 'edges');
    const result = this.compactShards<GraphEdge>(log, archiveDir);
    return { type, ...result };
  }

  /**
   * Compact every node/edge type that currently has rotated shards, then
   * rebuild meta.json from the compacted files. Idempotent — a second call
   * with nothing left to compact returns an empty `compacted` array.
   *
   * NOTE: this is a one-time physical cleanup, not a durable steady state.
   * A type's active file, right after compaction, already holds everything
   * that was in its rotated shards — so it may already exceed AppendLog's
   * maxSizeBytes threshold. The very next append() to that type will see
   * currentSize() > maxSizeBytes and rotate the freshly-compacted file
   * straight back into a new rotated shard. That's harmless for
   * correctness (the read-path fix handles any number of rotated shards
   * forever) but means the I/O/latency benefit of compaction can be
   * short-lived under active ingestion. Re-run compactAll() periodically
   * (e.g. as a maintenance job) if that becomes a recurring concern —
   * flagged as a Needs-Jm follow-up rather than solved here.
   */
  async compactAll(): Promise<{ compacted: CompactResult[]; state: GraphState }> {
    const compacted: CompactResult[] = [];
    for (const type of ALL_NODE_TYPES) {
      const result = this.compactNodeType(type);
      if (result) compacted.push(result);
    }
    for (const type of ALL_EDGE_TYPES) {
      const result = this.compactEdgeType(type);
      if (result) compacted.push(result);
    }
    this.clearCache();
    const state = await this.rebuildMeta();
    return { compacted, state };
  }

  /**
   * Recalculate and save meta.json from the actual JSONL files.
   */
  async rebuildMeta(): Promise<GraphState> {
    this.clearCache();  // Ensure fresh reads after any structural changes
    const state = createEmptyGraphState();

    for (const type of ALL_NODE_TYPES) {
      const nodes = this.loadNodes(type);
      state.nodesByType[type] = nodes.length;
      state.nodeCount += nodes.length;
    }

    for (const type of ALL_EDGE_TYPES) {
      const edges = this.loadEdges(type);
      state.edgesByType[type] = edges.length;
      state.edgeCount += edges.length;
    }

    state.lastIngested = new Date().toISOString();
    await this.saveMeta(state);
    return state;
  }

  /**
   * Get the base directory path.
   */
  getBaseDir(): string {
    return this.baseDir;
  }
}

// ============================================
// SINGLETON
// ============================================

let _instance: GraphPersistence | null = null;

/**
 * Get the default GraphPersistence instance.
 */
export function getGraphPersistence(): GraphPersistence {
  if (!_instance) {
    _instance = new GraphPersistence();
  }
  return _instance;
}

// ============================================
// CLI
// ============================================

if (import.meta.main) {
  const persistence = getGraphPersistence();

  const args = process.argv.slice(2);

  if (args.includes('--rebuild-meta')) {
    console.log('Rebuilding meta.json from JSONL files...');
    const state = await persistence.rebuildMeta();
    console.log('Graph state:', JSON.stringify(state, null, 2));
  } else if (args.includes('--load')) {
    console.log('Loading graph into engine...');
    const engine = persistence.loadIntoEngine();
    const stats = engine.getStats();
    console.log(`Loaded ${stats.nodeCount} nodes, ${stats.edgeCount} edges`);
    console.log('Stats:', JSON.stringify(stats, null, 2));
  } else if (args.includes('--verify')) {
    console.log('Verifying JSONL file integrity...');
    let totalFiles = 0;
    let totalValid = 0;
    let totalMalformed = 0;

    const verifyFile = (filePath: string, label: string) => {
      if (!existsSync(filePath)) return;
      totalFiles++;
      const content = readFileSync(filePath, 'utf-8');
      let valid = 0;
      let malformed = 0;
      for (const line of content.split('\n')) {
        if (!line.trim()) continue;
        try {
          JSON.parse(line);
          valid++;
        } catch {
          malformed++;
        }
      }
      totalValid += valid;
      totalMalformed += malformed;
      if (malformed > 0) {
        console.log(`  CORRUPT ${label}: ${malformed} malformed / ${valid + malformed} total lines`);
      } else {
        console.log(`  OK      ${label}: ${valid} lines`);
      }
    };

    const baseDir = persistence.getBaseDir();
    const nodesDir = join(baseDir, 'nodes');
    const edgesDir = join(baseDir, 'edges');

    for (const type of ALL_NODE_TYPES) {
      verifyFile(join(nodesDir, `${type}.jsonl`), `nodes/${type}.jsonl`);
    }
    for (const type of ALL_EDGE_TYPES) {
      verifyFile(join(edgesDir, `${type}.jsonl`), `edges/${type}.jsonl`);
    }

    console.log('');
    console.log(`Summary: ${totalFiles} files, ${totalValid} valid lines, ${totalMalformed} malformed lines`);

    if (totalMalformed > 0) {
      process.exit(1);
    }
  } else {
    console.log('GraphPersistence CLI');
    console.log('====================');
    console.log(`Base directory: ${persistence.getBaseDir()}`);
    console.log('');
    console.log('Usage:');
    console.log('  bun GraphPersistence.ts --rebuild-meta   Rebuild meta.json from JSONL');
    console.log('  bun GraphPersistence.ts --load           Load graph and show stats');
    console.log('  bun GraphPersistence.ts --verify         Verify JSONL file integrity');
  }
}
