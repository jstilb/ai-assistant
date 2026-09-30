#!/usr/bin/env bun
/**
 * MemoryStore.ts - Unified memory storage for Kaya
 *
 * Consolidates 5 different memory capture patterns across Kaya skills:
 * - LEARNING (AgentMetacognition captures)
 * - research (Research outputs)
 * - WORK (Session scratch spaces)
 * - CONVERGENCE (ralph loop tracking)
 * - KAYASYSTEMUPDATES (System documentation)
 *
 * Features:
 * - Unified schema for all memory types
 * - Auto-deduplication using content hashing
 * - Tag-based discovery across all types
 * - Lifecycle tiers: hot -> warm -> cold (archive)
 * - Cross-skill indexing for fast lookups
 * - TTL support for auto-expiring memories
 * - Full-text and tag search
 *
 * Usage:
 *   # As library
 *   import { memoryStore, createMemoryStore } from './MemoryStore';
 *   await memoryStore.capture({ type: 'learning', title: '...', content: '...' });
 *
 *   # As CLI
 *   bun run MemoryStore.ts capture --type learning --title "Title" --content "Content"
 *   bun run MemoryStore.ts search --type learning --tags "algorithm,isc"
 *   bun run MemoryStore.ts get <id>
 *   bun run MemoryStore.ts stats
 *   bun run MemoryStore.ts consolidate
 *
 * @author Kaya Engineering
 * @version 1.0.0
 */

import { parseArgs } from "util";
import { join, dirname } from "path";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, unlinkSync } from "fs";
import { kayaHomePath } from "./KayaHome";

// ============================================================================
// Types
// ============================================================================

/**
 * Memory entry type - categorizes the nature of the memory
 */
export type MemoryType = 'learning' | 'decision' | 'artifact' | 'insight' | 'signal' | 'research';

/**
 * Memory tier - determines storage lifecycle
 * - hot: Recent, actively used (7 days default)
 * - warm: Persistent, indexed (indefinite)
 * - cold: Archived, compressed (queryable but slower)
 */
export type MemoryTier = 'hot' | 'warm' | 'cold';

/**
 * A single memory entry with full metadata
 */
export interface MemoryEntry {
  /** Unique identifier (nanoid-style) */
  id: string;
  /** Type classification */
  type: MemoryType;
  /** Optional sub-category within type (e.g., ALGORITHM, SYSTEM) */
  category?: string;
  /** Brief, descriptive title */
  title: string;
  /** Full content of the memory */
  content: string;
  /** Source skill/workflow that captured this */
  source: string;
  /** ISO timestamp of creation */
  timestamp: string;
  /** Searchable tags */
  tags: string[];
  /** Lifecycle tier */
  tier: MemoryTier;
  /** Time-to-live in seconds (auto-archive after expiry) */
  ttl?: number;
  /** Links to related entry IDs */
  references?: string[];
  /** Arbitrary additional data */
  metadata?: Record<string, unknown>;
  /** Content hash for deduplication */
  _hash?: string;
}

/**
 * Options for capturing a new memory
 */
export interface CaptureOptions {
  type: MemoryType;
  category?: string;
  title: string;
  content: string;
  tags?: string[];
  tier?: MemoryTier;
  ttl?: number;
  deduplicate?: boolean;
  metadata?: Record<string, unknown>;
  source?: string;
  references?: string[];
}

/**
 * Options for searching memories
 */
export interface SearchOptions {
  type?: MemoryType | MemoryType[];
  category?: string;
  tags?: string[];
  tier?: MemoryTier;
  since?: Date | string;
  until?: Date | string;
  limit?: number;
  fullText?: string;
}

/**
 * Statistics about the memory store
 */
export interface MemoryStats {
  total: number;
  byType: Record<MemoryType, number>;
  byTier: Record<MemoryTier, number>;
  indexSize: number;
  oldestEntry?: string;
  newestEntry?: string;
}

/**
 * Index structure for fast lookups
 */
interface MemoryIndex {
  version: number;
  lastUpdated: string;
  entries: Record<string, IndexEntry>;
  byType: Record<MemoryType, string[]>;
  byTier: Record<MemoryTier, string[]>;
  byTag: Record<string, string[]>;
  byCategory: Record<string, string[]>;
}

interface IndexEntry {
  id: string;
  type: MemoryType;
  category?: string;
  title: string;
  tags: string[];
  tier: MemoryTier;
  timestamp: string;
  hash: string;
  ttl?: number;
  expiresAt?: string;
}

/**
 * Hash map for deduplication
 */
interface DedupHashes {
  version: number;
  hashes: Record<string, string>; // hash -> entry ID
}

/**
 * Dedup table format version. Bumped to 2 in slice S9 (let-the-model-speak):
 * pre-S9 `hashContent()` hashed only `content.slice(0, 500)`, so a v1 (or
 * unversioned) dedup-hashes.json's keys were computed from a truncated
 * prefix, not the full content. Those keys are NOT valid inputs to compare
 * against v2's full-content hashes — a stale v1 file must be discarded, not
 * merged or partially trusted. See docs/decisions/016.
 */
const CURRENT_DEDUP_VERSION = 2;

// ============================================================================
// Memory Store Implementation
// ============================================================================

export interface MemoryStore {
  /**
   * Capture a new memory entry. The returned object is additively widened
   * with `deduped` (S9): `true` when an existing entry with an identical
   * full-content+tags hash was returned instead of a new entry being
   * created, `false` when a fresh entry was written. Existing callers that
   * only read `MemoryEntry` fields are unaffected — this is a pure addition.
   */
  capture(options: CaptureOptions): Promise<MemoryEntry & { deduped: boolean }>;
  /** Get entry by ID */
  get(id: string): Promise<MemoryEntry | null>;
  /** Search entries */
  search(options: SearchOptions): Promise<MemoryEntry[]>;
  /** Find entries with similar content */
  findSimilar(content: string, threshold?: number): Promise<MemoryEntry[]>;
  /** Update an existing entry */
  update(id: string, updates: Partial<CaptureOptions>): Promise<MemoryEntry>;
  /** Archive an entry (move to cold tier) */
  archive(id: string): Promise<void>;
  /** Permanently delete an entry */
  delete(id: string): Promise<void>;
  /** Consolidate: archive old entries, deduplicate */
  consolidate(): Promise<{ archived: number; deduplicated: number }>;
  /** Get statistics */
  getStats(): Promise<MemoryStats>;
  /** Rebuild the index from entry files */
  rebuildIndex(): Promise<void>;
  /**
   * Repair cold-tier archive files whose lines hold more than one JSON record
   * (glued by the pre-2026-09-21 trailing-newline bug). Splits each glued line
   * back into one record per line. Returns per-file counts; never drops data —
   * a fragment that still fails to parse is left in place and reported.
   */
  repairArchives(): Promise<{ files: number; gluedLines: number; recordsRecovered: number; unparseable: number }>;
}

/**
 * Create a memory store instance
 * @param baseDir Base directory for storage (defaults to ~/.claude/MEMORY)
 */
export function createMemoryStore(baseDir?: string): MemoryStore {
  // Resolve the memory directory at CALL time (inside these getters, invoked
  // fresh on every read/write), not once here at factory-creation time.
  // `memoryStore` below is a process-lifetime singleton created at module
  // import — a module-level `const MEMORY_DIR = ...` (the old code) would
  // freeze the resolved directory to whatever process.env.HOME happened to
  // be at first import, and would never even look at KAYA_HOME/KAYA_DIR.
  // Any test/process that sandboxes KAYA_HOME after that first import (the
  // repo convention — see KayaHome.ts) silently kept writing to the real
  // ~/.claude/MEMORY. Resolving lazily via kayaHomePath() matches the
  // pattern E2 established for NotificationService.ts. See slice E5.
  const resolveMemoryDir = (): string => baseDir ?? kayaHomePath("MEMORY");
  const getEntriesDir = (): string => join(resolveMemoryDir(), "entries");
  const getArchiveDir = (): string => join(resolveMemoryDir(), "archive");
  const getIndexFile = (): string => join(resolveMemoryDir(), "index.json");
  const getDedupFile = (): string => join(resolveMemoryDir(), "dedup-hashes.json");

  // Ensure directories exist (call-time resolved — see resolveMemoryDir() above)
  const ensureDirs = () => {
    const entriesDir = getEntriesDir();
    const archiveDir = getArchiveDir();
    if (!existsSync(entriesDir)) mkdirSync(entriesDir, { recursive: true });
    if (!existsSync(archiveDir)) mkdirSync(archiveDir, { recursive: true });
  };

  // Generate a short unique ID
  const generateId = (): string => {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    const timestamp = Date.now().toString(36);
    let random = '';
    for (let i = 0; i < 6; i++) {
      random += chars[Math.floor(Math.random() * chars.length)];
    }
    return `${timestamp}-${random}`;
  };

  // Calculate content hash for deduplication (S9: FULL content, not a
  // 500-char prefix — see CURRENT_DEDUP_VERSION comment above for why the
  // old truncated hash was a correctness bug, not just an optimization: two
  // different memories sharing an identical prefix hashed identically,
  // making capture() treat them as dedup candidates ("the census trap").
  // Hashing the full content means a hash match now means true full-content
  // (mod tag order) equality — exact dedup is actually exact.
  const hashContent = (content: string, tags: string[]): string => {
    const input = content + '|' + [...tags].sort().join(',');
    // Full (untruncated) SHA-256 hex digest: this hash is now the SOLE
    // signal capture() uses to decide "is this the same memory" — no
    // truncation, no fuzzy fallback, so collision probability is
    // cryptographic, not a 64-bit truncation plus a similarity heuristic.
    const hasher = new Bun.CryptoHasher("sha256");
    hasher.update(input);
    return hasher.digest("hex");
  };

  // Calculate Jaccard similarity between two strings.
  //
  // NOTE (S9 / let-the-model-speak): this is NOT used by capture() anymore.
  // It remains for findSimilar() — an explicit query API where the CALLER
  // reads a similarity-ranked list and judges what to do with it. capture()
  // used to run this on every dedup-hash collision and silently return the
  // OLD entry (as if a fresh write had succeeded) whenever similarity was
  // >= 0.85. That was wrong for two independent reasons: (1) the collision
  // it fired on was itself a prefix-hash false positive, not a real
  // candidate match, and (2) even with a correct hash, deciding "these two
  // memories are close enough to be the same" by token-overlap ratio is a
  // judgment call, not a deterministic fact — the kind of judgment this
  // plan's north star says the write path must not make silently. Near-
  // duplicate consolidation is now explicitly NOT code's job: it belongs to
  // the weekly LLM synthesis pass (AgentMetacognition v2), which can read
  // intent and merge/supersede with a rationale, not just a token-overlap
  // score. See docs/decisions/016.
  const jaccardSimilarity = (a: string, b: string): number => {
    const tokenize = (s: string) => new Set(s.toLowerCase().split(/\W+/).filter(t => t.length > 2));
    const setA = tokenize(a);
    const setB = tokenize(b);

    if (setA.size === 0 || setB.size === 0) return 0;

    const intersection = new Set([...setA].filter(x => setB.has(x)));
    const union = new Set([...setA, ...setB]);

    return intersection.size / union.size;
  };

  // Get month directory for an entry
  const getMonthDir = (timestamp: string): string => {
    const date = new Date(timestamp);
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    return join(getEntriesDir(), `${year}-${month}`);
  };

  // Load index
  const loadIndex = (): MemoryIndex => {
    const indexFile = getIndexFile();
    if (!existsSync(indexFile)) {
      return {
        version: 1,
        lastUpdated: new Date().toISOString(),
        entries: {},
        byType: { learning: [], decision: [], artifact: [], insight: [], signal: [], research: [] },
        byTier: { hot: [], warm: [], cold: [] },
        byTag: {},
        byCategory: {},
      };
    }
    return JSON.parse(readFileSync(indexFile, 'utf-8'));
  };

  // Save index
  const saveIndex = (index: MemoryIndex): void => {
    ensureDirs();
    index.lastUpdated = new Date().toISOString();
    writeFileSync(getIndexFile(), JSON.stringify(index, null, 2));
  };

  // Load dedup hashes.
  //
  // S9 migration: a v1 (or unversioned — the actual pre-S9 shape had no
  // `version` key at all) dedup-hashes.json was built from
  // content.slice(0, 500)-based hashes. Those hash strings mean nothing
  // under v2's full-content hashing — they must not be merged, reused, or
  // silently trusted. On a version mismatch this LOUDLY (console.error, not
  // a swallowed catch) discards the stale table and starts a fresh v2 one.
  // This opens a one-time window where an exact duplicate of pre-migration
  // content could be recaptured once before its new full-content hash is
  // recorded — an explicit, logged tradeoff (see docs/decisions/016), not
  // silent data loss: the discarded v1 entries were never validated against
  // full content in the first place (that truncation was the bug this slice
  // fixes), so nothing that was correctly deduped before is lost here.
  const loadDedupHashes = (): DedupHashes => {
    const dedupFile = getDedupFile();
    if (!existsSync(dedupFile)) {
      return { version: CURRENT_DEDUP_VERSION, hashes: {} };
    }

    let parsed: Partial<DedupHashes> | undefined;
    try {
      parsed = JSON.parse(readFileSync(dedupFile, 'utf-8'));
    } catch (e) {
      console.error(
        `[MemoryStore] dedup-hashes.json at ${dedupFile} is corrupt/unreadable ` +
        `(${e instanceof Error ? e.message : String(e)}) — discarding it and starting a ` +
        `fresh v${CURRENT_DEDUP_VERSION} dedup table. This opens a one-time exact-duplicate ` +
        `detection window; it is logged, not silent.`
      );
      return { version: CURRENT_DEDUP_VERSION, hashes: {} };
    }

    if (!parsed || parsed.version !== CURRENT_DEDUP_VERSION) {
      console.error(
        `[MemoryStore] dedup-hashes.json at ${dedupFile} is version ${parsed?.version ?? 'unversioned (pre-S9)'} ` +
        `— its hashes were computed from a truncated 500-char content prefix, not the full content, and are ` +
        `not valid under v${CURRENT_DEDUP_VERSION} full-content hashing. Discarding this stale table and ` +
        `starting a fresh v${CURRENT_DEDUP_VERSION} one. This opens a ONE-TIME window where an exact ` +
        `duplicate of pre-migration content may be recaptured once before its new hash is recorded — an ` +
        `explicit, logged tradeoff (docs/decisions/016), not silent data loss.`
      );
      return { version: CURRENT_DEDUP_VERSION, hashes: {} };
    }

    return parsed as DedupHashes;
  };

  // Save dedup hashes
  const saveDedupHashes = (hashes: DedupHashes): void => {
    ensureDirs();
    writeFileSync(getDedupFile(), JSON.stringify(hashes, null, 2));
  };

  // Get entry file path
  const getEntryPath = (id: string, timestamp: string, tier: MemoryTier): string => {
    if (tier === 'cold') {
      const date = new Date(timestamp);
      const quarter = Math.floor(date.getMonth() / 3) + 1;
      return join(getArchiveDir(), `${date.getFullYear()}-Q${quarter}.jsonl`);
    }
    const monthDir = getMonthDir(timestamp);
    return join(monthDir, `${id}.json`);
  };

  /**
   * Per-call cache of parsed cold-tier archive files, keyed by archive path.
   * A fresh Map per call site (never module-level) so it can never serve a
   * stale entry across a mutation.
   */
  type ArchiveCache = Map<string, Map<string, MemoryEntry>>;

  // Load one entry given its ALREADY-RESOLVED index record.
  const readEntryFile = (
    id: string,
    indexEntry: MemoryIndex['entries'][string],
    archiveCache?: ArchiveCache,
  ): MemoryEntry | null => {
    const entryPath = getEntryPath(id, indexEntry.timestamp, indexEntry.tier);

    if (indexEntry.tier === 'cold') {
      // Cold entries live one-per-line in a quarterly .jsonl, so finding one
      // means parsing the whole file. Without the cache, a loop over N cold
      // ids re-parsed the same archive N times.
      if (archiveCache) {
        let byId = archiveCache.get(entryPath);
        if (!byId) {
          byId = new Map<string, MemoryEntry>();
          if (existsSync(entryPath)) {
            for (const line of readFileSync(entryPath, 'utf-8').split('\n')) {
              if (!line.trim()) continue;
              const entry = JSON.parse(line) as MemoryEntry;
              byId.set(entry.id, entry);
            }
          }
          archiveCache.set(entryPath, byId);
        }
        return byId.get(id) ?? null;
      }

      if (!existsSync(entryPath)) return null;
      for (const line of readFileSync(entryPath, 'utf-8').split('\n')) {
        if (!line.trim()) continue;
        const entry = JSON.parse(line) as MemoryEntry;
        if (entry.id === id) return entry;
      }
      return null;
    }

    if (!existsSync(entryPath)) return null;
    return JSON.parse(readFileSync(entryPath, 'utf-8'));
  };

  /**
   * Load an entry against an ALREADY-LOADED index.
   *
   * WHY THIS EXISTS: loadEntry() re-reads and re-parses the whole index file
   * on every call. That is fine for a single lookup and catastrophic inside a
   * loop — and three call sites loop over every candidate id (search(),
   * findSimilar(), and consolidate()'s duplicate scan). At the live corpus
   * size (MEMORY/index.json = 4.2MB / 6,937 entries, measured 2026-07-30) an
   * unfiltered `search({ fullText })` therefore made ~6,937 readFileSync +
   * JSON.parse passes over that 4.2MB — ~29GB of redundant parsing for ONE
   * query. That is the ~60s/query cost which made Slice D1's retrieval-quality
   * eval too slow to wire into the nightly suite. Every one of those loops
   * already held a fully-loaded index; it just wasn't being passed down.
   */
  const loadEntryFromIndex = async (
    id: string,
    index: MemoryIndex,
    archiveCache?: ArchiveCache,
  ): Promise<MemoryEntry | null> => {
    const indexEntry = index.entries[id];
    if (!indexEntry) return null;
    return readEntryFile(id, indexEntry, archiveCache);
  };

  // Load entry by ID. Single-lookup convenience wrapper — reads the index
  // itself. Inside a loop, use loadEntryFromIndex() with a hoisted index.
  const loadEntry = async (id: string): Promise<MemoryEntry | null> => {
    const index = loadIndex();
    const indexEntry = index.entries[id];

    if (!indexEntry) return null;

    return readEntryFile(id, indexEntry);
  };

  // Save entry
  const saveEntry = async (entry: MemoryEntry): Promise<void> => {
    const entryPath = getEntryPath(entry.id, entry.timestamp, entry.tier);
    const dir = dirname(entryPath);

    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    if (entry.tier === 'cold') {
      // Append to archive file
      const line = JSON.stringify(entry) + '\n';
      if (existsSync(entryPath)) {
        const existing = readFileSync(entryPath, 'utf-8');
        // Guarantee a newline boundary before appending. An archive whose last
        // record lacks a trailing newline (older deleteEntryFile() wrote
        // `filtered.join('\n')`) would otherwise glue two JSON objects onto one
        // line and break every strict reader (2026-09-21 weekly-cleanup crash).
        const sep = existing.length === 0 || existing.endsWith('\n') ? '' : '\n';
        writeFileSync(entryPath, existing + sep + line);
      } else {
        writeFileSync(entryPath, line);
      }
    } else {
      writeFileSync(entryPath, JSON.stringify(entry, null, 2));
    }
  };

  // Delete entry file
  const deleteEntryFile = (id: string, timestamp: string, tier: MemoryTier): void => {
    const entryPath = getEntryPath(id, timestamp, tier);

    if (tier === 'cold') {
      // Remove from archive file
      if (!existsSync(entryPath)) return;
      const lines = readFileSync(entryPath, 'utf-8').split('\n');
      const filtered = lines.filter(line => {
        if (!line.trim()) return false;
        try {
          const entry = JSON.parse(line);
          return entry.id !== id;
        } catch {
          return true;
        }
      });
      // Always end with a newline so the next append starts on its own line.
      writeFileSync(entryPath, filtered.length > 0 ? filtered.join('\n') + '\n' : '');
    } else {
      if (existsSync(entryPath)) unlinkSync(entryPath);
    }
  };

  // Update index for an entry
  const updateIndex = (entry: MemoryEntry, index: MemoryIndex, remove: boolean = false): void => {
    const id = entry.id;

    if (remove) {
      // Remove from all index structures
      delete index.entries[id];

      for (const type of Object.keys(index.byType) as MemoryType[]) {
        index.byType[type] = index.byType[type].filter(i => i !== id);
      }

      for (const tier of Object.keys(index.byTier) as MemoryTier[]) {
        index.byTier[tier] = index.byTier[tier].filter(i => i !== id);
      }

      for (const tag of Object.keys(index.byTag)) {
        index.byTag[tag] = index.byTag[tag].filter(i => i !== id);
      }

      for (const cat of Object.keys(index.byCategory)) {
        index.byCategory[cat] = index.byCategory[cat].filter(i => i !== id);
      }
    } else {
      // Add/update entry
      const indexEntry: IndexEntry = {
        id: entry.id,
        type: entry.type,
        category: entry.category,
        title: entry.title,
        tags: entry.tags,
        tier: entry.tier,
        timestamp: entry.timestamp,
        hash: entry._hash || '',
        ttl: entry.ttl,
      };

      if (entry.ttl) {
        const expiresAt = new Date(new Date(entry.timestamp).getTime() + entry.ttl * 1000);
        indexEntry.expiresAt = expiresAt.toISOString();
      }

      index.entries[id] = indexEntry;

      // Update type index
      if (!index.byType[entry.type].includes(id)) {
        index.byType[entry.type].push(id);
      }

      // Update tier index
      for (const tier of Object.keys(index.byTier) as MemoryTier[]) {
        index.byTier[tier] = index.byTier[tier].filter(i => i !== id);
      }
      if (!index.byTier[entry.tier].includes(id)) {
        index.byTier[entry.tier].push(id);
      }

      // Update tag index
      for (const tag of entry.tags) {
        if (!index.byTag[tag]) index.byTag[tag] = [];
        if (!index.byTag[tag].includes(id)) index.byTag[tag].push(id);
      }

      // Update category index
      if (entry.category) {
        if (!index.byCategory[entry.category]) index.byCategory[entry.category] = [];
        if (!index.byCategory[entry.category].includes(id)) {
          index.byCategory[entry.category].push(id);
        }
      }
    }
  };

  // NOTE: directories are ensured lazily inside saveIndex()/saveDedupHashes()
  // above (i.e. only when an actual write happens), not eagerly here. An
  // eager call here would run at factory-creation time — which for the
  // `memoryStore` singleton below means module-import time — re-introducing
  // a call-time-vs-eval-time freeze of "which KAYA_HOME was active right now."

  return {
    async capture(options: CaptureOptions): Promise<MemoryEntry & { deduped: boolean }> {
      const index = loadIndex();
      const dedupHashes = loadDedupHashes();

      const tags = options.tags || [];
      const hash = hashContent(options.content, tags);

      // Exact-dedup check (S9): hashContent() hashes the FULL content, so a
      // hash match here means genuinely identical content + tags — not a
      // truncated-prefix false positive. There is no Jaccard-similarity
      // fallback anymore: it existed only to guard against prefix-hash
      // collisions between genuinely different memories, and that failure
      // mode no longer exists. Near-duplicate (non-identical) content is
      // simply never collapsed by capture() — see jaccardSimilarity()'s
      // doc comment and docs/decisions/016 for why that's now intentional.
      if (options.deduplicate !== false) {
        const existingId = dedupHashes.hashes[hash];
        if (existingId) {
          const existing = await loadEntry(existingId);
          if (existing) {
            console.log(
              `[MemoryStore] capture(): deduped against existing entry ${existing.id} ` +
              `(exact full-content+tags hash match ${hash.slice(0, 12)}...)`
            );
            // Return a NEW object (existing entry's fields + deduped: true)
            // rather than mutating/persisting `existing` — `deduped` is a
            // signal about this capture() call, not a property of the
            // stored record, and must never be written to disk.
            return { ...existing, deduped: true };
          }
          // The dedup table pointed at an entry that no longer exists
          // (deleted, pruned, or a stale/corrupt index) — loud, not a
          // silent phantom dedup: fall through and capture a fresh entry.
          console.error(
            `[MemoryStore] capture(): dedup-hashes.json referenced entry ${existingId} for a ` +
            `matching hash, but that entry could not be loaded — capturing a new entry instead ` +
            `of silently returning a phantom dedup.`
          );
        }
      }

      const entry: MemoryEntry = {
        id: generateId(),
        type: options.type,
        category: options.category,
        title: options.title,
        content: options.content,
        source: options.source || 'MemoryStore',
        timestamp: new Date().toISOString(),
        tags,
        tier: options.tier || 'hot',
        ttl: options.ttl,
        references: options.references,
        metadata: options.metadata,
        _hash: hash,
      };

      // Save entry
      await saveEntry(entry);

      // Update index
      updateIndex(entry, index);
      saveIndex(index);

      // Update dedup hashes
      dedupHashes.hashes[hash] = entry.id;
      dedupHashes.version = CURRENT_DEDUP_VERSION;
      saveDedupHashes(dedupHashes);

      return { ...entry, deduped: false };
    },

    async get(id: string): Promise<MemoryEntry | null> {
      return loadEntry(id);
    },

    async search(options: SearchOptions): Promise<MemoryEntry[]> {
      const index = loadIndex();
      let candidateIds: Set<string> | null = null;

      // Filter by type
      if (options.type) {
        const types = Array.isArray(options.type) ? options.type : [options.type];
        const typeIds = new Set<string>();
        for (const type of types) {
          for (const id of index.byType[type] || []) {
            typeIds.add(id);
          }
        }
        candidateIds = typeIds;
      }

      // Filter by tier
      if (options.tier) {
        const tierIds = new Set(index.byTier[options.tier] || []);
        if (candidateIds) {
          candidateIds = new Set([...candidateIds].filter(id => tierIds.has(id)));
        } else {
          candidateIds = tierIds;
        }
      }

      // Filter by tags (must have ALL specified tags)
      if (options.tags && options.tags.length > 0) {
        let tagIds: Set<string> | null = null;
        for (const tag of options.tags) {
          const idsForTag = new Set(index.byTag[tag] || []);
          if (tagIds === null) {
            tagIds = idsForTag;
          } else {
            tagIds = new Set([...tagIds].filter(id => idsForTag.has(id)));
          }
        }
        if (candidateIds && tagIds) {
          candidateIds = new Set([...candidateIds].filter(id => tagIds!.has(id)));
        } else if (tagIds) {
          candidateIds = tagIds;
        }
      }

      // Filter by category
      if (options.category) {
        const catIds = new Set(index.byCategory[options.category] || []);
        if (candidateIds) {
          candidateIds = new Set([...candidateIds].filter(id => catIds.has(id)));
        } else {
          candidateIds = catIds;
        }
      }

      // If no filters, get all entries
      if (candidateIds === null) {
        candidateIds = new Set(Object.keys(index.entries));
      }

      // Load entries and apply remaining filters. `index` above is reused for
      // every candidate rather than re-read per entry, and cold-tier archives
      // are parsed once per file — see loadEntryFromIndex's doc comment.
      const entries: MemoryEntry[] = [];
      const archiveCache: ArchiveCache = new Map();

      for (const id of candidateIds) {
        const indexEntry = index.entries[id];
        if (!indexEntry) continue;

        // Filter by date range
        if (options.since) {
          const since = typeof options.since === 'string' ? new Date(options.since) : options.since;
          if (new Date(indexEntry.timestamp) < since) continue;
        }

        if (options.until) {
          const until = typeof options.until === 'string' ? new Date(options.until) : options.until;
          if (new Date(indexEntry.timestamp) > until) continue;
        }

        // Load full entry for full-text search
        if (options.fullText) {
          const entry = await loadEntryFromIndex(id, index, archiveCache);
          if (!entry) continue;

          const searchText = options.fullText.toLowerCase();
          const contentLower = entry.content.toLowerCase();
          const titleLower = entry.title.toLowerCase();

          if (!contentLower.includes(searchText) && !titleLower.includes(searchText)) {
            continue;
          }

          entries.push(entry);
        } else {
          const entry = await loadEntryFromIndex(id, index, archiveCache);
          if (entry) entries.push(entry);
        }
      }

      // Sort by timestamp descending (newest first)
      entries.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

      // Apply limit
      if (options.limit && entries.length > options.limit) {
        return entries.slice(0, options.limit);
      }

      return entries;
    },

    async findSimilar(content: string, threshold: number = 0.5): Promise<MemoryEntry[]> {
      const index = loadIndex();
      const similar: Array<{ entry: MemoryEntry; similarity: number }> = [];
      const archiveCache: ArchiveCache = new Map();

      for (const id of Object.keys(index.entries)) {
        const entry = await loadEntryFromIndex(id, index, archiveCache);
        if (!entry) continue;

        const similarity = jaccardSimilarity(content, entry.content);
        if (similarity >= threshold) {
          similar.push({ entry, similarity });
        }
      }

      // Sort by similarity descending
      similar.sort((a, b) => b.similarity - a.similarity);

      return similar.map(s => s.entry);
    },

    async update(id: string, updates: Partial<CaptureOptions>): Promise<MemoryEntry> {
      const entry = await loadEntry(id);
      if (!entry) {
        throw new Error(`Entry not found: ${id}`);
      }

      const index = loadIndex();
      const oldTier = entry.tier;

      // Apply updates
      if (updates.title !== undefined) entry.title = updates.title;
      if (updates.content !== undefined) entry.content = updates.content;
      if (updates.category !== undefined) entry.category = updates.category;
      if (updates.tags !== undefined) entry.tags = updates.tags;
      if (updates.tier !== undefined) entry.tier = updates.tier;
      if (updates.ttl !== undefined) entry.ttl = updates.ttl;
      if (updates.metadata !== undefined) entry.metadata = updates.metadata;
      if (updates.references !== undefined) entry.references = updates.references;

      // Recalculate hash if content changed
      if (updates.content !== undefined || updates.tags !== undefined) {
        entry._hash = hashContent(entry.content, entry.tags);
      }

      // Handle tier change
      if (oldTier !== entry.tier) {
        deleteEntryFile(id, entry.timestamp, oldTier);
      }

      // Save updated entry
      await saveEntry(entry);

      // Update index
      updateIndex(entry, index);
      saveIndex(index);

      return entry;
    },

    async archive(id: string): Promise<void> {
      const entry = await loadEntry(id);
      if (!entry) {
        throw new Error(`Entry not found: ${id}`);
      }

      const oldTier = entry.tier;
      entry.tier = 'cold';

      // Delete from old location
      deleteEntryFile(id, entry.timestamp, oldTier);

      // Save to archive
      await saveEntry(entry);

      // Update index
      const index = loadIndex();
      updateIndex(entry, index);
      saveIndex(index);
    },

    async delete(id: string): Promise<void> {
      const index = loadIndex();
      const indexEntry = index.entries[id];

      if (!indexEntry) {
        return; // Already doesn't exist
      }

      // Delete file
      deleteEntryFile(id, indexEntry.timestamp, indexEntry.tier);

      // Remove from index
      updateIndex({ id, tier: indexEntry.tier } as MemoryEntry, index, true);
      saveIndex(index);

      // Remove from dedup hashes
      const dedupHashes = loadDedupHashes();
      const hashToRemove = Object.entries(dedupHashes.hashes).find(([_, entryId]) => entryId === id)?.[0];
      if (hashToRemove) {
        delete dedupHashes.hashes[hashToRemove];
        saveDedupHashes(dedupHashes);
      }
    },

    async consolidate(): Promise<{ archived: number; deduplicated: number }> {
      const index = loadIndex();
      let archived = 0;
      let deduplicated = 0;

      const now = new Date();
      const hotThreshold = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000); // 7 days

      // Archive old hot entries
      for (const id of [...index.byTier.hot]) {
        const indexEntry = index.entries[id];
        if (!indexEntry) continue;

        const entryDate = new Date(indexEntry.timestamp);

        // Check TTL expiration
        if (indexEntry.expiresAt && new Date(indexEntry.expiresAt) < now) {
          await this.archive(id);
          archived++;
          continue;
        }

        // Archive entries older than threshold
        if (entryDate < hotThreshold) {
          await this.archive(id);
          archived++;
        }
      }

      // Deduplicate: find entries with the same _hash field, keep newest, archive rest.
      // The dedup-hashes.json tracks hash→id (latest winner), but old entries may still
      // be on disk with duplicate _hash values from earlier captures.
      const currentIndex = loadIndex(); // re-read after archiving above
      const consolidateArchiveCache: ArchiveCache = new Map();
      const hashToIds: Map<string, { id: string; timestamp: string }[]> = new Map();

      for (const [id, indexEntry] of Object.entries(currentIndex.entries)) {
        // indexEntry is used for its timestamp field below
        // Reconstruct hash by looking up what hash points to this ID in dedupHashes
        // Fall back to scanning: group by entries that were stored with the same hash
        // (we use the index timestamp + id to find duplicates by loading them)
        const entry = await loadEntryFromIndex(id, currentIndex, consolidateArchiveCache);
        if (!entry) continue;
        const hash = entry._hash;
        if (!hash) continue;
        if (!hashToIds.has(hash)) hashToIds.set(hash, []);
        hashToIds.get(hash)!.push({ id, timestamp: entry.timestamp ?? indexEntry.timestamp });
      }

      for (const [, entries] of hashToIds) {
        if (entries.length <= 1) continue;

        // Sort by timestamp descending — keep newest, archive the rest
        entries.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
        const [, ...duplicates] = entries;

        for (const dup of duplicates) {
          try {
            await this.archive(dup.id);
            deduplicated++;
          } catch {
            // Entry may have already been archived above — skip silently
          }
        }
      }

      // Rebuild dedup-hashes.json to only reference surviving (non-archived) entries
      const finalIndex = loadIndex();
      const dedupHashes = loadDedupHashes();
      for (const [hash, id] of Object.entries(dedupHashes.hashes)) {
        if (!finalIndex.entries[id] || finalIndex.entries[id].tier === 'cold') {
          delete dedupHashes.hashes[hash];
        }
      }
      saveDedupHashes(dedupHashes);

      return { archived, deduplicated };
    },

    async getStats(): Promise<MemoryStats> {
      const index = loadIndex();

      const stats: MemoryStats = {
        total: Object.keys(index.entries).length,
        byType: {
          learning: index.byType.learning?.length || 0,
          decision: index.byType.decision?.length || 0,
          artifact: index.byType.artifact?.length || 0,
          insight: index.byType.insight?.length || 0,
          signal: index.byType.signal?.length || 0,
          research: index.byType.research?.length || 0,
        },
        byTier: {
          hot: index.byTier.hot?.length || 0,
          warm: index.byTier.warm?.length || 0,
          cold: index.byTier.cold?.length || 0,
        },
        indexSize: JSON.stringify(index).length,
      };

      // Find oldest and newest
      const timestamps = Object.values(index.entries).map(e => e.timestamp).sort();
      if (timestamps.length > 0) {
        stats.oldestEntry = timestamps[0];
        stats.newestEntry = timestamps[timestamps.length - 1];
      }

      return stats;
    },

    async repairArchives(): Promise<{ files: number; gluedLines: number; recordsRecovered: number; unparseable: number }> {
      const archiveDir = getArchiveDir();
      const result = { files: 0, gluedLines: 0, recordsRecovered: 0, unparseable: 0 };
      if (!existsSync(archiveDir)) return result;
      for (const file of readdirSync(archiveDir).filter(f => f.endsWith('.jsonl'))) {
        const archivePath = join(archiveDir, file);
        const out: string[] = [];
        let changed = false;
        for (const line of readFileSync(archivePath, 'utf-8').split('\n')) {
          if (!line.trim()) continue;
          try {
            JSON.parse(line);
            out.push(line);
            continue;
          } catch {
            result.gluedLines++;
            // Glued line: greedily peel off the longest parseable prefix at each
            // `}{` boundary until the remainder parses or nothing does.
            let rest = line;
            let recovered = 0;
            while (rest.length > 0) {
              let split = -1;
              let idx = rest.indexOf('}{');
              while (idx !== -1) {
                const candidate = rest.slice(0, idx + 1);
                try {
                  JSON.parse(candidate);
                  split = idx + 1;
                  break;
                } catch {
                  // intentionally silent: probing each `}{` boundary for the longest parseable prefix; a miss is the normal path
                }
                idx = rest.indexOf('}{', idx + 1);
              }
              if (split === -1) {
                try { JSON.parse(rest); out.push(rest); recovered++; }
                catch { out.push(rest); result.unparseable++; console.error(`[MemoryStore] repairArchives: unparseable fragment kept in ${archivePath}: ${rest.slice(0, 80)}...`); }
                break;
              }
              out.push(rest.slice(0, split));
              recovered++;
              rest = rest.slice(split);
            }
            if (recovered > 1) { result.recordsRecovered += recovered; changed = true; }
          }
        }
        if (changed) {
          writeFileSync(archivePath, out.join('\n') + '\n');
          result.files++;
        }
      }
      return result;
    },

    async rebuildIndex(): Promise<void> {
      const newIndex: MemoryIndex = {
        version: 1,
        lastUpdated: new Date().toISOString(),
        entries: {},
        byType: { learning: [], decision: [], artifact: [], insight: [], signal: [], research: [] },
        byTier: { hot: [], warm: [], cold: [] },
        byTag: {},
        byCategory: {},
      };

      // Scan entries directory
      const entriesDir = getEntriesDir();
      if (existsSync(entriesDir)) {
        const monthDirs = readdirSync(entriesDir, { withFileTypes: true })
          .filter(d => d.isDirectory())
          .map(d => d.name);

        for (const monthDir of monthDirs) {
          const monthPath = join(entriesDir, monthDir);
          const files = readdirSync(monthPath).filter(f => f.endsWith('.json'));

          for (const file of files) {
            try {
              const content = readFileSync(join(monthPath, file), 'utf-8');
              const entry = JSON.parse(content) as MemoryEntry;
              updateIndex(entry, newIndex);
            } catch (e) {
              console.error(`Error reading ${file}:`, e);
            }
          }
        }
      }

      // Scan archive directory
      const archiveDir = getArchiveDir();
      if (existsSync(archiveDir)) {
        const archiveFiles = readdirSync(archiveDir).filter(f => f.endsWith('.jsonl'));

        for (const file of archiveFiles) {
          const content = readFileSync(join(archiveDir, file), 'utf-8');
          const lines = content.split('\n').filter(l => l.trim());

          for (const line of lines) {
            try {
              const entry = JSON.parse(line) as MemoryEntry;
              entry.tier = 'cold'; // Ensure tier is cold
              updateIndex(entry, newIndex);
            } catch (e) {
              // Skip malformed lines
            }
          }
        }
      }

      saveIndex(newIndex);

      // Rebuild dedup hashes. NOTE: this copies whatever hash string was
      // persisted in each entry's `_hash` field at capture time — entries
      // captured pre-S9 still carry their old truncated-prefix hash until
      // they're next `update()`d (which recomputes _hash) or recaptured.
      // That's unchanged pre-existing behavior (rebuildIndex() has always
      // trusted the persisted hash rather than recomputing it), and it's
      // safe here: an old-format hash string can never collide with a
      // fresh full-content hash by accident (see hashContent()'s doc
      // comment) — see docs/decisions/016.
      const newHashes: DedupHashes = { version: CURRENT_DEDUP_VERSION, hashes: {} };
      for (const id of Object.keys(newIndex.entries)) {
        const entry = newIndex.entries[id];
        if (entry.hash) {
          newHashes.hashes[entry.hash] = id;
        }
      }
      saveDedupHashes(newHashes);
    },
  };
}

// ============================================================================
// Default Instance
// ============================================================================

/** Default memory store instance using ~/.claude/MEMORY */
export const memoryStore = createMemoryStore();

// ============================================================================
// CLI Interface
// ============================================================================

async function runCli(): Promise<void> {
  const { values, positionals } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      type: { type: "string", short: "t" },
      category: { type: "string", short: "c" },
      title: { type: "string" },
      content: { type: "string" },
      tags: { type: "string" },
      tier: { type: "string" },
      ttl: { type: "string" },
      since: { type: "string" },
      until: { type: "string" },
      limit: { type: "string", short: "l" },
      query: { type: "string", short: "q" },
      threshold: { type: "string" },
      json: { type: "boolean", short: "j" },
      help: { type: "boolean", short: "h" },
    },
    allowPositionals: true,
  });

  const command = positionals[0];

  if (values.help || !command) {
    console.log(`
MemoryStore - Unified memory storage for Kaya

Commands:
  capture     Create a new memory entry
  get <id>    Retrieve an entry by ID
  search      Search for entries
  similar     Find similar content
  update <id> Update an entry
  archive <id> Archive an entry to cold tier
  delete <id> Permanently delete an entry
  consolidate Archive old entries and deduplicate
  stats       Show memory statistics
  rebuild     Rebuild the index from files
  repair-archives  Split glued records in cold-tier archive files

Options:
  --type, -t       Memory type: learning|decision|artifact|insight|signal|research
  --category, -c   Sub-category within type
  --title          Entry title
  --content        Entry content
  --tags           Comma-separated tags
  --tier           Storage tier: hot|warm|cold
  --ttl            Time-to-live in seconds
  --since          Filter by date (ISO format)
  --until          Filter by date (ISO format)
  --limit, -l      Maximum results
  --query, -q      Full-text search query
  --threshold      Similarity threshold (0-1)
  --json, -j       Output as JSON
  --help, -h       Show help

Examples:
  bun run MemoryStore.ts capture --type learning --title "Pattern found" --content "..."
  bun run MemoryStore.ts search --type learning --tags "algorithm,isc"
  bun run MemoryStore.ts similar --content "ISC tracking" --threshold 0.6
  bun run MemoryStore.ts stats --json
`);
    return;
  }

  const store = memoryStore;

  try {
    switch (command) {
      case 'capture': {
        if (!values.type || !values.title || !values.content) {
          console.error('Error: --type, --title, and --content are required');
          process.exit(1);
        }
        const entry = await store.capture({
          type: values.type as MemoryType,
          category: values.category,
          title: values.title,
          content: values.content,
          tags: values.tags?.split(',').map(t => t.trim()),
          tier: values.tier as MemoryTier | undefined,
          ttl: values.ttl ? parseInt(values.ttl) : undefined,
        });
        if (values.json) {
          console.log(JSON.stringify(entry, null, 2));
        } else {
          console.log(`Created entry: ${entry.id}`);
          console.log(`  Type: ${entry.type}`);
          console.log(`  Title: ${entry.title}`);
          console.log(`  Tier: ${entry.tier}`);
        }
        break;
      }

      case 'get': {
        const id = positionals[1];
        if (!id) {
          console.error('Error: Entry ID required');
          process.exit(1);
        }
        const entry = await store.get(id);
        if (!entry) {
          console.error(`Entry not found: ${id}`);
          process.exit(1);
        }
        if (values.json) {
          console.log(JSON.stringify(entry, null, 2));
        } else {
          console.log(`ID: ${entry.id}`);
          console.log(`Type: ${entry.type}${entry.category ? `/${entry.category}` : ''}`);
          console.log(`Title: ${entry.title}`);
          console.log(`Tier: ${entry.tier}`);
          console.log(`Tags: ${entry.tags.join(', ') || 'none'}`);
          console.log(`Created: ${entry.timestamp}`);
          console.log(`\nContent:\n${entry.content}`);
        }
        break;
      }

      case 'search': {
        const results = await store.search({
          type: values.type as MemoryType | undefined,
          category: values.category,
          tags: values.tags?.split(',').map(t => t.trim()),
          tier: values.tier as MemoryTier | undefined,
          since: values.since,
          until: values.until,
          limit: values.limit ? parseInt(values.limit) : undefined,
          fullText: values.query,
        });
        if (values.json) {
          console.log(JSON.stringify(results, null, 2));
        } else {
          console.log(`Found ${results.length} entries:\n`);
          for (const entry of results) {
            console.log(`[${entry.id}] ${entry.type}${entry.category ? `/${entry.category}` : ''}: ${entry.title}`);
            console.log(`  Tags: ${entry.tags.join(', ') || 'none'} | Tier: ${entry.tier}`);
          }
        }
        break;
      }

      case 'similar': {
        if (!values.content && !values.query) {
          console.error('Error: --content or --query required');
          process.exit(1);
        }
        const threshold = values.threshold ? parseFloat(values.threshold) : 0.5;
        const results = await store.findSimilar(values.content || values.query!, threshold);
        if (values.json) {
          console.log(JSON.stringify(results, null, 2));
        } else {
          console.log(`Found ${results.length} similar entries:\n`);
          for (const entry of results) {
            console.log(`[${entry.id}] ${entry.title}`);
          }
        }
        break;
      }

      case 'update': {
        const id = positionals[1];
        if (!id) {
          console.error('Error: Entry ID required');
          process.exit(1);
        }
        const updates: Partial<CaptureOptions> = {};
        if (values.title) updates.title = values.title;
        if (values.content) updates.content = values.content;
        if (values.category) updates.category = values.category;
        if (values.tags) updates.tags = values.tags.split(',').map(t => t.trim());
        if (values.tier) updates.tier = values.tier as MemoryTier;
        if (values.ttl) updates.ttl = parseInt(values.ttl);

        const entry = await store.update(id, updates);
        if (values.json) {
          console.log(JSON.stringify(entry, null, 2));
        } else {
          console.log(`Updated entry: ${entry.id}`);
        }
        break;
      }

      case 'archive': {
        const id = positionals[1];
        if (!id) {
          console.error('Error: Entry ID required');
          process.exit(1);
        }
        await store.archive(id);
        console.log(`Archived entry: ${id}`);
        break;
      }

      case 'delete': {
        const id = positionals[1];
        if (!id) {
          console.error('Error: Entry ID required');
          process.exit(1);
        }
        await store.delete(id);
        console.log(`Deleted entry: ${id}`);
        break;
      }

      case 'consolidate': {
        const result = await store.consolidate();
        if (values.json) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          console.log(`Consolidation complete:`);
          console.log(`  Archived: ${result.archived} entries`);
          console.log(`  Deduplicated: ${result.deduplicated} entries`);
        }
        break;
      }

      case 'stats': {
        const stats = await store.getStats();
        if (values.json) {
          console.log(JSON.stringify(stats, null, 2));
        } else {
          console.log(`Memory Store Statistics:`);
          console.log(`  Total entries: ${stats.total}`);
          console.log(`  By type:`);
          for (const [type, count] of Object.entries(stats.byType)) {
            if (count > 0) console.log(`    ${type}: ${count}`);
          }
          console.log(`  By tier:`);
          for (const [tier, count] of Object.entries(stats.byTier)) {
            if (count > 0) console.log(`    ${tier}: ${count}`);
          }
          console.log(`  Index size: ${Math.round(stats.indexSize / 1024)}KB`);
          if (stats.oldestEntry) console.log(`  Oldest: ${stats.oldestEntry}`);
          if (stats.newestEntry) console.log(`  Newest: ${stats.newestEntry}`);
        }
        break;
      }

      case 'repair-archives': {
        const result = await store.repairArchives();
        if (values.json) console.log(JSON.stringify(result, null, 2));
        else console.log(`Archive repair: ${result.files} files rewritten, ${result.gluedLines} glued lines split into ${result.recordsRecovered} records, ${result.unparseable} fragments still unparseable`);
        break;
      }

      case 'rebuild': {
        console.log('Rebuilding index...');
        await store.rebuildIndex();
        console.log('Index rebuilt successfully');
        break;
      }

      default:
        console.error(`Unknown command: ${command}`);
        process.exit(1);
    }
  } catch (error) {
    console.error(`Error: ${error instanceof Error ? error.message : error}`);
    process.exit(1);
  }
}

// Run CLI if executed directly
if (import.meta.main) {
  runCli();
}
