#!/usr/bin/env bun
/**
 * EmbeddingEngine.ts - Local vector embedding layer for semantic graph retrieval
 *
 * Generates 384-dimension embeddings via all-MiniLM-L6-v2 (@xenova/transformers).
 * Stores vectors in SQLite (bun:sqlite) at MEMORY/GRAPH/embeddings/index.db.
 * Runs fully in-process — no cloud, no Python, no persistent server.
 *
 * Key contracts:
 * - `file` node type is excluded from the index by default
 * - Non-blocking: ingesters fire-and-forget via EmbeddingQueue.enqueue()
 * - Graceful degradation: if index.db is missing, callers fall back to lexical search
 *
 * @module Graph/EmbeddingEngine
 * @version 1.0.0
 */

import { existsSync, mkdirSync, statSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { createHash } from 'crypto';
import { Database } from 'bun:sqlite';
import type { GraphNode, GraphNodeType } from './types';
import { ALL_NODE_TYPES } from './types';
import { GraphPersistence } from './GraphPersistence';
import { getSharedGraphDir } from '../../../../lib/core/KayaHome';

// ============================================
// CONSTANTS
// ============================================

const GRAPH_DIR = getSharedGraphDir();
const EMBEDDINGS_DIR = join(GRAPH_DIR, 'embeddings');
const INDEX_DB_PATH = join(EMBEDDINGS_DIR, 'index.db');
const META_JSON_PATH = join(EMBEDDINGS_DIR, 'meta.json');

const MODEL_NAME = 'Xenova/all-MiniLM-L6-v2';
const EMBEDDING_DIM = 384;
const BATCH_SIZE = 32;

/** Node types excluded from the embedding index by default */
const EXCLUDED_TYPES: Set<GraphNodeType> = new Set(['file']);

// ============================================
// TYPES
// ============================================

export interface EmbeddingStats {
  totalNodes: number;
  indexedNodes: number;
  coveragePct: number;
  perTypeCoverage: Record<string, { total: number; indexed: number }>;
  indexFileSizeBytes: number;
  modelName: string;
  dimensions: number;
  lastRunTimestamp: string;
  lastRunNodesProcessed: number;
  p50EmbedMs: number;
  p95EmbedMs: number;
}

interface EmbeddingMeta {
  modelName: string;
  dimensions: number;
  lastBuilt: string;
  coveragePct: number;
  lastRunNodesProcessed: number;
  p50EmbedMs: number;
  p95EmbedMs: number;
}

interface EmbeddingRow {
  node_id: string;
  node_type: string;
  embedding: Buffer;
  text_hash: string;
  created_at: string;
  updated_at: string;
}

export interface BuildFilter {
  type?: GraphNodeType;
}

// ============================================
// EMBEDDING QUEUE (in-process, fire-and-forget)
// ============================================

const _queue: string[] = [];

export const EmbeddingQueue = {
  enqueue(nodeId: string): void {
    _queue.push(nodeId);
  },
  drain(): string[] {
    return _queue.splice(0, _queue.length);
  },
  size(): number {
    return _queue.length;
  },
};

// ============================================
// EMBEDDING ENGINE
// ============================================

export class EmbeddingEngine {
  private db: Database | null = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private pipeline: ((texts: string[], opts?: Record<string, unknown>) => Promise<any>) | null = null;
  private persistence: GraphPersistence;

  constructor(dbPath?: string, graphDir?: string) {
    this.persistence = new GraphPersistence(graphDir || GRAPH_DIR);
    this._dbPath = dbPath || INDEX_DB_PATH;
  }

  private _dbPath: string;

  // ============================================
  // INITIALIZATION
  // ============================================

  /**
   * Open (or create) the SQLite index with the correct schema.
   * Returns false if db cannot be opened.
   */
  openDb(): boolean {
    try {
      ensureDir(EMBEDDINGS_DIR);
      this.db = new Database(this._dbPath);
      this.db.run(`
        CREATE TABLE IF NOT EXISTS node_embeddings (
          node_id     TEXT PRIMARY KEY,
          node_type   TEXT NOT NULL,
          embedding   BLOB NOT NULL,
          text_hash   TEXT NOT NULL,
          created_at  TEXT NOT NULL,
          updated_at  TEXT NOT NULL
        )
      `);
      this.db.run(`CREATE INDEX IF NOT EXISTS idx_node_embeddings_type    ON node_embeddings(node_type)`);
      this.db.run(`CREATE INDEX IF NOT EXISTS idx_node_embeddings_updated ON node_embeddings(updated_at)`);
      return true;
    } catch (err) {
      console.warn('[EmbeddingEngine] Failed to open index.db:', err);
      this.db = null;
      return false;
    }
  }

  /**
   * Load the @xenova/transformers pipeline (one-time, cached in process).
   * After first load, no network calls are made — model is served from fs cache.
   */
  private async loadPipeline(): Promise<boolean> {
    if (this.pipeline) return true;
    try {
      // @xenova/transformers uses env.allowLocalModels and caches to ~/.cache/
      const { pipeline, env } = await import('@xenova/transformers');
      env.allowRemoteModels = true;
      env.useBrowserCache = false;
      this.pipeline = await pipeline('feature-extraction', MODEL_NAME, {
        quantized: true,
      });
      return true;
    } catch (err) {
      console.warn('[EmbeddingEngine] Failed to load model pipeline:', err);
      this.pipeline = null;
      return false;
    }
  }

  // ============================================
  // CORE EMBEDDING
  // ============================================

  /**
   * Embed a single text string.
   * Returns a 384-dimension Float32Array.
   */
  async embedText(text: string): Promise<Float32Array> {
    const ok = await this.loadPipeline();
    if (!ok || !this.pipeline) {
      throw new Error('[EmbeddingEngine] Model pipeline not available');
    }
    const output = await this.pipeline([text], { pooling: 'mean', normalize: true });
    return output[0].data as Float32Array;
  }

  /**
   * Embed a graph node using the canonical text representation:
   * "{title} [type:{type}] [tags:{tags}] {content[:200]}"
   */
  async embedNode(node: GraphNode): Promise<Float32Array> {
    const text = buildNodeText(node);
    return this.embedText(text);
  }

  /**
   * Embed a batch of texts (up to BATCH_SIZE at once for throughput).
   * Returns Float32Array per text.
   */
  private async embedBatch(texts: string[]): Promise<Float32Array[]> {
    const ok = await this.loadPipeline();
    if (!ok || !this.pipeline) {
      throw new Error('[EmbeddingEngine] Model pipeline not available');
    }
    const output = await this.pipeline(texts, { pooling: 'mean', normalize: true });
    const results: Float32Array[] = [];
    for (let i = 0; i < texts.length; i++) {
      // output[i].data is Float32Array
      results.push(output[i].data as Float32Array);
    }
    return results;
  }

  // ============================================
  // INDEX OPERATIONS
  // ============================================

  /**
   * Upsert an embedding into the index.
   * textHash is SHA-256 of the embedded text for change detection.
   */
  upsertEmbedding(nodeId: string, nodeType: string, vector: Float32Array, textHash: string): void {
    if (!this.db) throw new Error('[EmbeddingEngine] Database not open');
    const now = new Date().toISOString();
    const buf = Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);

    const existing = this.db.query<Pick<EmbeddingRow, 'text_hash'>, [string]>(
      'SELECT text_hash FROM node_embeddings WHERE node_id = ?'
    ).get(nodeId);

    if (existing) {
      if (existing.text_hash === textHash) return; // unchanged
      this.db.run(
        'UPDATE node_embeddings SET embedding = ?, text_hash = ?, updated_at = ? WHERE node_id = ?',
        [buf, textHash, now, nodeId]
      );
    } else {
      this.db.run(
        'INSERT INTO node_embeddings (node_id, node_type, embedding, text_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
        [nodeId, nodeType, buf, textHash, now, now]
      );
    }
  }

  /**
   * Check whether a node is already indexed with the same text hash.
   */
  isIndexed(nodeId: string, textHash: string): boolean {
    if (!this.db) return false;
    const row = this.db.query<Pick<EmbeddingRow, 'text_hash'>, [string]>(
      'SELECT text_hash FROM node_embeddings WHERE node_id = ?'
    ).get(nodeId);
    return row !== null && row.text_hash === textHash;
  }

  /**
   * Get a raw embedding vector by node ID.
   * Returns null if not indexed.
   */
  getEmbedding(nodeId: string): Float32Array | null {
    if (!this.db) return null;
    const row = this.db.query<Pick<EmbeddingRow, 'embedding'>, [string]>(
      'SELECT embedding FROM node_embeddings WHERE node_id = ?'
    ).get(nodeId);
    if (!row) return null;
    return new Float32Array(row.embedding.buffer);
  }

  /**
   * Count indexed nodes, optionally filtered by type.
   */
  indexedCount(type?: GraphNodeType): number {
    if (!this.db) return 0;
    if (type) {
      const row = this.db.query<{ cnt: number }, [string]>(
        'SELECT COUNT(*) AS cnt FROM node_embeddings WHERE node_type = ?'
      ).get(type);
      return row?.cnt ?? 0;
    }
    const row = this.db.query<{ cnt: number }, []>(
      'SELECT COUNT(*) AS cnt FROM node_embeddings'
    ).get();
    return row?.cnt ?? 0;
  }

  /**
   * Get all indexed node IDs (for incremental detection).
   */
  indexedNodeIds(): Set<string> {
    if (!this.db) return new Set();
    const rows = this.db.query<{ node_id: string }, []>(
      'SELECT node_id FROM node_embeddings'
    ).all();
    return new Set(rows.map(r => r.node_id));
  }

  /**
   * Delete stale entries no longer present in the graph.
   */
  pruneStale(currentNodeIds: Set<string>): number {
    if (!this.db) return 0;
    const indexed = this.indexedNodeIds();
    let pruned = 0;
    for (const id of indexed) {
      if (!currentNodeIds.has(id)) {
        this.db.run('DELETE FROM node_embeddings WHERE node_id = ?', [id]);
        pruned++;
      }
    }
    return pruned;
  }

  /**
   * Drop the entire index (for --rebuild).
   */
  dropIndex(): void {
    if (!this.db) return;
    this.db.run('DELETE FROM node_embeddings');
  }

  // ============================================
  // BATCH PROCESSING
  // ============================================

  /**
   * Process the in-memory EmbeddingQueue — embed all queued node IDs.
   * Called asynchronously after ingestion completes.
   */
  async processQueue(): Promise<void> {
    const nodeIds = EmbeddingQueue.drain();
    if (nodeIds.length === 0) return;

    if (!this.db) {
      const opened = this.openDb();
      if (!opened) {
        console.warn('[EmbeddingEngine] processQueue: DB unavailable, skipping');
        return;
      }
    }

    // Load the nodes from JSONL
    // excludeExpired (Slice C1): index/coverage stats should reflect LIVE
    // facts only — an expired outcome shouldn't count toward "eligible"
    // totals or get embedded into the semantic-search index.
    const allNodes = this.persistence.loadAllNodes({ excludeExpired: true });
    const nodeMap = new Map<string, GraphNode>();
    for (const n of allNodes) nodeMap.set(n.id, n);

    const targets: GraphNode[] = [];
    for (const id of nodeIds) {
      const node = nodeMap.get(id);
      if (node && !EXCLUDED_TYPES.has(node.type)) {
        targets.push(node);
      }
    }

    await this._embedNodes(targets);
  }

  /**
   * Build embeddings for all non-file nodes (or filtered by type).
   * Skips already-indexed nodes unless text hash changed.
   */
  async buildAll(filter?: BuildFilter): Promise<{ embedded: number; skipped: number }> {
    if (!this.db) {
      const opened = this.openDb();
      if (!opened) return { embedded: 0, skipped: 0 };
    }

    // excludeExpired (Slice C1): index/coverage stats should reflect LIVE
    // facts only — an expired outcome shouldn't count toward "eligible"
    // totals or get embedded into the semantic-search index.
    const allNodes = this.persistence.loadAllNodes({ excludeExpired: true });
    const targets = allNodes.filter(n => {
      if (EXCLUDED_TYPES.has(n.type)) return false;
      if (filter?.type && n.type !== filter.type) return false;
      const text = buildNodeText(n);
      const hash = sha256(text);
      return !this.isIndexed(n.id, hash);
    });

    const result = await this._embedNodes(targets);
    return result;
  }

  /**
   * Embed only nodes missing from the index (idempotent).
   * Second run on an unchanged graph returns 0.
   */
  async buildIncremental(): Promise<{ embedded: number; skipped: number }> {
    if (!this.db) {
      const opened = this.openDb();
      if (!opened) return { embedded: 0, skipped: 0 };
    }

    // excludeExpired (Slice C1): index/coverage stats should reflect LIVE
    // facts only — an expired outcome shouldn't count toward "eligible"
    // totals or get embedded into the semantic-search index.
    const allNodes = this.persistence.loadAllNodes({ excludeExpired: true });
    const targets = allNodes.filter(n => {
      if (EXCLUDED_TYPES.has(n.type)) return false;
      const text = buildNodeText(n);
      const hash = sha256(text);
      return !this.isIndexed(n.id, hash);
    });

    return this._embedNodes(targets);
  }

  /**
   * Internal batch embedding with timing stats.
   */
  private async _embedNodes(nodes: GraphNode[]): Promise<{ embedded: number; skipped: number }> {
    if (nodes.length === 0) return { embedded: 0, skipped: 0 };

    const ok = await this.loadPipeline();
    if (!ok) return { embedded: 0, skipped: 0 };

    let embedded = 0;
    let skipped = 0;
    const latencies: number[] = [];

    for (let i = 0; i < nodes.length; i += BATCH_SIZE) {
      const batch = nodes.slice(i, i + BATCH_SIZE);
      const texts = batch.map(buildNodeText);
      const t0 = Date.now();
      const vectors = await this.embedBatch(texts);
      const batchMs = Date.now() - t0;
      const perNode = batchMs / batch.length;
      for (let j = 0; j < batch.length; j++) latencies.push(perNode);

      for (let j = 0; j < batch.length; j++) {
        const node = batch[j];
        const vector = vectors[j];
        const text = texts[j];
        const hash = sha256(text);
        try {
          this.upsertEmbedding(node.id, node.type, vector, hash);
          embedded++;
        } catch {
          skipped++;
        }
      }
    }

    // Update meta.json
    const p50 = percentile(latencies, 50);
    const p95 = percentile(latencies, 95);
    saveMeta({
      modelName: MODEL_NAME,
      dimensions: EMBEDDING_DIM,
      lastBuilt: new Date().toISOString(),
      coveragePct: this._computeCoverage(),
      lastRunNodesProcessed: embedded,
      p50EmbedMs: p50,
      p95EmbedMs: p95,
    });

    return { embedded, skipped };
  }

  // ============================================
  // STATS
  // ============================================

  /**
   * Report index coverage statistics.
   * Satisfies ISC row 6004: outputs 6 required fields.
   */
  stats(): EmbeddingStats {
    // excludeExpired (Slice C1): index/coverage stats should reflect LIVE
    // facts only — an expired outcome shouldn't count toward "eligible"
    // totals or get embedded into the semantic-search index.
    const allNodes = this.persistence.loadAllNodes({ excludeExpired: true });
    const eligible = allNodes.filter(n => !EXCLUDED_TYPES.has(n.type));
    const totalNodes = eligible.length;
    const indexedNodes = this.indexedCount();

    // Per-type breakdown
    const perTypeCoverage: Record<string, { total: number; indexed: number }> = {};
    for (const type of ALL_NODE_TYPES) {
      if (EXCLUDED_TYPES.has(type)) {
        perTypeCoverage[type] = { total: 0, indexed: 0 };
        continue;
      }
      const typeNodes = allNodes.filter(n => n.type === type);
      const typeIndexed = this.indexedCount(type);
      perTypeCoverage[type] = { total: typeNodes.length, indexed: typeIndexed };
    }

    const indexFileSizeBytes = existsSync(this._dbPath) ? statSync(this._dbPath).size : 0;
    const coveragePct = totalNodes > 0 ? Math.round((indexedNodes / totalNodes) * 100) : 0;

    // Load timing from meta.json
    const meta = loadMeta();

    return {
      totalNodes,
      indexedNodes,
      coveragePct,
      perTypeCoverage,
      indexFileSizeBytes,
      modelName: MODEL_NAME,
      dimensions: EMBEDDING_DIM,
      lastRunTimestamp: meta?.lastBuilt ?? '',
      lastRunNodesProcessed: meta?.lastRunNodesProcessed ?? 0,
      p50EmbedMs: meta?.p50EmbedMs ?? 0,
      p95EmbedMs: meta?.p95EmbedMs ?? 0,
    };
  }

  private _computeCoverage(): number {
    if (!this.db) return 0;
    // excludeExpired (Slice C1): index/coverage stats should reflect LIVE
    // facts only — an expired outcome shouldn't count toward "eligible"
    // totals or get embedded into the semantic-search index.
    const allNodes = this.persistence.loadAllNodes({ excludeExpired: true });
    const eligible = allNodes.filter(n => !EXCLUDED_TYPES.has(n.type));
    const total = eligible.length;
    if (total === 0) return 0;
    const indexed = this.indexedCount();
    return indexed / total;
  }

  /**
   * Close the database connection.
   */
  close(): void {
    this.db?.close();
    this.db = null;
  }
}

// ============================================
// KNN QUERY SUPPORT
// ============================================

export interface KnnCandidate {
  nodeId: string;
  nodeType: string;
  score: number; // cosine similarity (0-1)
}

/**
 * Perform a brute-force cosine similarity KNN scan against all indexed vectors.
 * SQLite stores BLOB vectors; we load type-filtered rows and compute in-process.
 *
 * Note: sqlite-vec extension is not bundled with bun:sqlite.
 * We implement cosine similarity directly — this is correct and efficient
 * for the target scale (26K nodes × 384 dims ≈ 40MB, fully cached by SQLite).
 */
export function knnSearch(
  db: Database,
  queryVector: Float32Array,
  topK: number,
  nodeType?: GraphNodeType,
  minScore: number = 0.40,
): KnnCandidate[] {
  let rows: Array<{ node_id: string; node_type: string; embedding: Buffer }>;

  if (nodeType) {
    rows = db.query<{ node_id: string; node_type: string; embedding: Buffer }, [string]>(
      'SELECT node_id, node_type, embedding FROM node_embeddings WHERE node_type = ?'
    ).all(nodeType);
  } else {
    rows = db.query<{ node_id: string; node_type: string; embedding: Buffer }, []>(
      'SELECT node_id, node_type, embedding FROM node_embeddings'
    ).all();
  }

  const candidates: KnnCandidate[] = [];

  for (const row of rows) {
    const vec = new Float32Array(row.embedding.buffer, row.embedding.byteOffset, row.embedding.byteLength / 4);
    const score = cosineSimilarity(queryVector, vec);
    if (score >= minScore) {
      candidates.push({ nodeId: row.node_id, nodeType: row.node_type, score });
    }
  }

  // Sort descending by score, return top K
  candidates.sort((a, b) => b.score - a.score);
  return candidates.slice(0, topK);
}

// ============================================
// UTILITY FUNCTIONS
// ============================================

/**
 * Build canonical text representation for a node.
 * title [type:T] [tags:tag1 tag2] {content[:200]}
 */
export function buildNodeText(node: GraphNode): string {
  const tagsStr = node.tags.length > 0 ? ` [tags:${node.tags.join(' ')}]` : '';
  const content = (node.metadata.content as string | undefined) ?? '';
  const contentSnip = content.slice(0, 200);
  return `${node.title} [type:${node.type}]${tagsStr}${contentSnip ? ' ' + contentSnip : ''}`;
}

/** SHA-256 hex digest of a string */
export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** Cosine similarity of two equal-length Float32Arrays */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

/** p-th percentile of a sorted numeric array */
function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.floor((p / 100) * (sorted.length - 1));
  return sorted[idx];
}

function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function saveMeta(meta: EmbeddingMeta): void {
  try {
    ensureDir(EMBEDDINGS_DIR);
    writeFileSync(META_JSON_PATH, JSON.stringify(meta, null, 2));
  } catch {
    // Non-fatal
  }
}

function loadMeta(): EmbeddingMeta | null {
  try {
    if (!existsSync(META_JSON_PATH)) return null;
    const metaRaw = readFileSync(META_JSON_PATH, 'utf-8');
    return JSON.parse(metaRaw) as EmbeddingMeta;
  } catch {
    return null;
  }
}

// ============================================
// SINGLETON
// ============================================

let _instance: EmbeddingEngine | null = null;

export function getEmbeddingEngine(): EmbeddingEngine {
  if (!_instance) {
    _instance = new EmbeddingEngine();
  }
  return _instance;
}

// ============================================
// CLI
// ============================================

if (import.meta.main) {
  const args = Bun.argv.slice(2);

  if (args.includes('--stats')) {
    const engine = getEmbeddingEngine();
    engine.openDb();
    const s = engine.stats();
    console.log('Embedding Index Statistics');
    console.log('==========================');
    console.log(`Total eligible nodes:  ${s.totalNodes}`);
    console.log(`Indexed nodes:         ${s.indexedNodes}`);
    console.log(`Coverage:              ${s.coveragePct}%`);
    console.log(`Index file size:       ${(s.indexFileSizeBytes / 1024 / 1024).toFixed(2)} MB`);
    console.log(`Model:                 ${s.modelName} (${s.dimensions} dims)`);
    console.log(`Last run:              ${s.lastRunTimestamp || 'never'}`);
    console.log(`Last run nodes:        ${s.lastRunNodesProcessed}`);
    console.log(`P50 embed latency:     ${s.p50EmbedMs.toFixed(1)}ms`);
    console.log(`P95 embed latency:     ${s.p95EmbedMs.toFixed(1)}ms`);
    console.log('\nPer-type coverage:');
    for (const [type, cov] of Object.entries(s.perTypeCoverage)) {
      if (cov.total > 0 || type === 'file') {
        const pct = cov.total > 0 ? Math.round((cov.indexed / cov.total) * 100) : 0;
        console.log(`  ${type}: ${cov.indexed} / ${cov.total} (${pct}%)`);
      }
    }
    engine.close();
    process.exit(0);
  }

  if (args.includes('--build-all')) {
    const typeArg = args[args.indexOf('--type') + 1];
    const engine = getEmbeddingEngine();
    engine.openDb();
    console.log('Building all embeddings...');
    const result = await engine.buildAll(typeArg ? { type: typeArg as GraphNodeType } : undefined);
    console.log(`Done: ${result.embedded} embedded, ${result.skipped} skipped`);
    engine.close();
    process.exit(0);
  }

  if (args.includes('--incremental')) {
    const engine = getEmbeddingEngine();
    engine.openDb();
    console.log('Running incremental embedding...');
    const result = await engine.buildIncremental();
    console.log(`Done: ${result.embedded} nodes embedded`);
    engine.close();
    process.exit(0);
  }

  if (args.includes('--rebuild')) {
    const engine = getEmbeddingEngine();
    engine.openDb();
    console.log('Rebuilding entire index from scratch...');
    engine.dropIndex();
    const result = await engine.buildAll();
    console.log(`Done: ${result.embedded} embedded`);
    engine.close();
    process.exit(0);
  }

  if (args.includes('--search')) {
    const idx = args.indexOf('--search');
    const query = args[idx + 1];
    if (!query) {
      console.error('Usage: bun EmbeddingEngine.ts --search "query"');
      process.exit(1);
    }
    const engine = getEmbeddingEngine();
    const opened = engine.openDb();
    if (!opened) {
      console.warn('[EmbeddingEngine] Index not available, run --build-all first');
      process.exit(1);
    }
    const vec = await engine.embedText(query);
    const { Database: Db } = await import('bun:sqlite');
    const db = new Db(INDEX_DB_PATH);
    const candidates = knnSearch(db, vec, 10);
    const { GraphPersistence: GP } = await import('./GraphPersistence');
    const persistence = new GP();
    // excludeExpired (Slice C1): this is candidate hydration for a semantic
    // search result, same as EmbeddingQuerier.semanticSearch() — an expired
    // outcome shouldn't surface here either.
    const allNodes = persistence.loadAllNodes({ excludeExpired: true });
    const nodeMap = new Map(allNodes.map(n => [n.id, n]));
    for (const c of candidates) {
      const node = nodeMap.get(c.nodeId);
      console.log(`[${c.score.toFixed(2)}] ${node?.type ?? '?'}: ${node?.title ?? c.nodeId}`);
    }
    db.close();
    engine.close();
    process.exit(0);
  }

  if (args.includes('--bench')) {
    // Benchmark: 50 consecutive queries, report P95
    const engine = getEmbeddingEngine();
    const opened = engine.openDb();
    if (!opened) {
      console.error('Index not available');
      process.exit(1);
    }
    const { Database: Db } = await import('bun:sqlite');
    const db = new Db(INDEX_DB_PATH);
    const queries = [
      'authentication error', 'deploy failed', 'null pointer', 'session storage',
      'graph query', 'context manager', 'database migration', 'type error',
      'commit message', 'skill update',
    ];
    const times: number[] = [];
    for (let i = 0; i < 50; i++) {
      const q = queries[i % queries.length];
      const t0 = performance.now();
      const vec = await engine.embedText(q);
      knnSearch(db, vec, 10);
      times.push(performance.now() - t0);
    }
    times.sort((a, b) => a - b);
    const p50 = times[Math.floor(times.length * 0.50)];
    const p95 = times[Math.floor(times.length * 0.95)];
    console.log(`Benchmark (50 queries): P50=${p50.toFixed(1)}ms  P95=${p95.toFixed(1)}ms`);
    db.close();
    engine.close();
    process.exit(0);
  }

  console.log('EmbeddingEngine CLI');
  console.log('===================');
  console.log('  bun EmbeddingEngine.ts --stats');
  console.log('  bun EmbeddingEngine.ts --build-all [--type <type>]');
  console.log('  bun EmbeddingEngine.ts --incremental');
  console.log('  bun EmbeddingEngine.ts --rebuild');
  console.log('  bun EmbeddingEngine.ts --search "query"');
  console.log('  bun EmbeddingEngine.ts --bench');
}
