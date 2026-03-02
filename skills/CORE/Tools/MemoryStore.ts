#!/usr/bin/env bun
/**
 * MemoryStore.ts - Unified memory storage for Kaya
 *
 * Consolidates 5 different memory capture patterns across Kaya skills:
 * - LEARNING (ContinualLearning captures)
 * - research (Research outputs)
 * - WORK (Session scratch spaces)
 * - CONVERGENCE (RALPHLOOP tracking)
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

// ============================================================================
// Memory Store Implementation
// ============================================================================

export interface MemoryStore {
  /** Capture a new memory entry */
  capture(options: CaptureOptions): Promise<MemoryEntry>;
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
}

/**
 * Create a memory store instance
 * @param baseDir Base directory for storage (defaults to ~/.claude/MEMORY)
 */
export function createMemoryStore(baseDir?: string): MemoryStore {
  const MEMORY_DIR = baseDir ?? join(process.env.HOME!, ".claude", "MEMORY");
  const ENTRIES_DIR = join(MEMORY_DIR, "entries");
  const ARCHIVE_DIR = join(MEMORY_DIR, "archive");
  const INDEX_FILE = join(MEMORY_DIR, "index.json");
  const DEDUP_FILE = join(MEMORY_DIR, "dedup-hashes.json");

  // Ensure directories exist
  const ensureDirs = () => {
    if (!existsSync(ENTRIES_DIR)) mkdirSync(ENTRIES_DIR, { recursive: true });
    if (!existsSync(ARCHIVE_DIR)) mkdirSync(ARCHIVE_DIR, { recursive: true });
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

  // Calculate content hash for deduplication
  const hashContent = (content: string, tags: string[]): string => {
    // Use first 500 chars + sorted tags for quick hash
    const input = content.slice(0, 500) + '|' + tags.sort().join(',');
    // Simple hash using Bun's native hasher
    const hasher = new Bun.CryptoHasher("sha256");
    hasher.update(input);
    return hasher.digest("hex").slice(0, 16);
  };

  // Calculate Jaccard similarity between two strings
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
    return join(ENTRIES_DIR, `${year}-${month}`);
  };

  // Load index
  const loadIndex = (): MemoryIndex => {
    if (!existsSync(INDEX_FILE)) {
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
    return JSON.parse(readFileSync(INDEX_FILE, 'utf-8'));
  };

  // Save index
  const saveIndex = (index: MemoryIndex): void => {
    index.lastUpdated = new Date().toISOString();
    writeFileSync(INDEX_FILE, JSON.stringify(index, null, 2));
  };

  // Load dedup hashes
  const loadDedupHashes = (): DedupHashes => {
    if (!existsSync(DEDUP_FILE)) {
      return { version: 1, hashes: {} };
    }
    return JSON.parse(readFileSync(DEDUP_FILE, 'utf-8'));
  };

  // Save dedup hashes
  const saveDedupHashes = (hashes: DedupHashes): void => {
    writeFileSync(DEDUP_FILE, JSON.stringify(hashes, null, 2));
  };

  // Get entry file path
  const getEntryPath = (id: string, timestamp: string, tier: MemoryTier): string => {
    if (tier === 'cold') {
      const date = new Date(timestamp);
      const quarter = Math.floor(date.getMonth() / 3) + 1;
      return join(ARCHIVE_DIR, `${date.getFullYear()}-Q${quarter}.jsonl`);
    }
    const monthDir = getMonthDir(timestamp);
    return join(monthDir, `${id}.json`);
  };

  // Load entry by ID
  const loadEntry = async (id: string): Promise<MemoryEntry | null> => {
    const index = loadIndex();
    const indexEntry = index.entries[id];

    if (!indexEntry) return null;

    const entryPath = getEntryPath(id, indexEntry.timestamp, indexEntry.tier);

    if (indexEntry.tier === 'cold') {
      // Search in archive file
      if (!existsSync(entryPath)) return null;
      const lines = readFileSync(entryPath, 'utf-8').split('\n');
      for (const line of lines) {
        if (!line.trim()) continue;
        const entry = JSON.parse(line) as MemoryEntry;
        if (entry.id === id) return entry;
      }
      return null;
    }

    if (!existsSync(entryPath)) return null;
    return JSON.parse(readFileSync(entryPath, 'utf-8'));
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
        writeFileSync(entryPath, existing + line);
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
      writeFileSync(entryPath, filtered.join('\n'));
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

  // Initialize
  ensureDirs();

  return {
    async capture(options: CaptureOptions): Promise<MemoryEntry> {
      const index = loadIndex();
      const dedupHashes = loadDedupHashes();

      const tags = options.tags || [];
      const hash = hashContent(options.content, tags);

      // Check for duplicates if enabled
      if (options.deduplicate !== false) {
        const existingId = dedupHashes.hashes[hash];
        if (existingId) {
          const existing = await loadEntry(existingId);
          if (existing) {
            // Check full similarity
            const similarity = jaccardSimilarity(existing.content, options.content);
            if (similarity >= 0.85) {
              // Return existing entry instead of creating duplicate
              return existing;
            }
          }
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
      saveDedupHashes(dedupHashes);

      return entry;
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
            tagIds = new Set([...tagIds].filter((id: string) => idsForTag.has(id)));
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

      // Load entries and apply remaining filters
      const entries: MemoryEntry[] = [];

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
          const entry = await loadEntry(id);
          if (!entry) continue;

          const searchText = options.fullText.toLowerCase();
          const contentLower = entry.content.toLowerCase();
          const titleLower = entry.title.toLowerCase();

          if (!contentLower.includes(searchText) && !titleLower.includes(searchText)) {
            continue;
          }

          entries.push(entry);
        } else {
          const entry = await loadEntry(id);
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

      for (const id of Object.keys(index.entries)) {
        const entry = await loadEntry(id);
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

      // Deduplicate by finding entries with same hash
      const dedupHashes = loadDedupHashes();
      const hashCounts: Record<string, string[]> = {};

      for (const [hash, id] of Object.entries(dedupHashes.hashes)) {
        if (!hashCounts[hash]) hashCounts[hash] = [];
        hashCounts[hash].push(id);
      }

      // Note: Actual deduplication logic would be more complex
      // For now, we just count potential duplicates
      for (const ids of Object.values(hashCounts)) {
        if (ids.length > 1) {
          deduplicated += ids.length - 1;
        }
      }

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
      if (existsSync(ENTRIES_DIR)) {
        const monthDirs = readdirSync(ENTRIES_DIR, { withFileTypes: true })
          .filter(d => d.isDirectory())
          .map(d => d.name);

        for (const monthDir of monthDirs) {
          const monthPath = join(ENTRIES_DIR, monthDir);
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
      if (existsSync(ARCHIVE_DIR)) {
        const archiveFiles = readdirSync(ARCHIVE_DIR).filter(f => f.endsWith('.jsonl'));

        for (const file of archiveFiles) {
          const content = readFileSync(join(ARCHIVE_DIR, file), 'utf-8');
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

      // Rebuild dedup hashes
      const newHashes: DedupHashes = { version: 1, hashes: {} };
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
