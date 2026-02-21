#!/usr/bin/env bun
/**
 * HotCache.ts
 *
 * Two-tier hot/cold memory cache for fast lookups of frequently
 * referenced people, projects, abbreviations, and terms.
 *
 * Hot tier: MEMORY/HOT_CACHE.json (compact, fast, structured)
 * Cold tier: Everything else in MEMORY/ (deep storage)
 *
 * Uses StateManager for all cache file I/O (no raw JSON.parse/readFileSync).
 *
 * Usage:
 *   bun HotCache.ts --list                            # Show all entries
 *   bun HotCache.ts --resolve "LV"                    # Look up shorthand
 *   bun HotCache.ts --decode "sync with J about LV"   # Decode message
 *   bun HotCache.ts --add "key" "value" "category"    # Add entry
 *   bun HotCache.ts --remove "key"                    # Remove entry
 *   bun HotCache.ts --maintain                        # Run promotion/demotion
 *   bun HotCache.ts --test                            # Run self-test
 */

import { existsSync, readFileSync, mkdirSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { z } from 'zod';
import { createStateManager, type StateManager } from './StateManager';

// ---------------------------------------------------------------------------
// Types & Schemas
// ---------------------------------------------------------------------------

const CacheEntrySchema = z.object({
  key: z.string(),
  value: z.string(),
  category: z.enum(['person', 'project', 'abbreviation', 'term']),
  referenceCount: z.number(),
  lastReferenced: z.string(),
  addedAt: z.string(),
});

const HotCacheDataSchema = z.object({
  version: z.number(),
  lastUpdated: z.string(),
  entries: z.array(CacheEntrySchema),
});

type CacheEntry = z.infer<typeof CacheEntrySchema>;
type HotCacheData = z.infer<typeof HotCacheDataSchema>;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const KAYA_HOME = process.env.KAYA_DIR || join(process.env.HOME!, '.claude');
const MEMORY_DIR = join(KAYA_HOME, 'MEMORY');
const MAX_ENTRIES = 80;
const PROMOTION_THRESHOLD = 3;    // references in last 7 days
const PROMOTION_WINDOW_DAYS = 7;
const DEMOTION_THRESHOLD_DAYS = 30;

// ---------------------------------------------------------------------------
// Seed data
// ---------------------------------------------------------------------------

function createSeedData(): HotCacheData {
  const now = new Date().toISOString();
  return {
    version: 1,
    lastUpdated: now,
    entries: [
      { key: 'J', value: 'Julie', category: 'person', referenceCount: 10, lastReferenced: now, addedAt: now },
      { key: 'Julie', value: 'Julie (partner)', category: 'person', referenceCount: 10, lastReferenced: now, addedAt: now },
      { key: 'LV', value: 'Lucidview', category: 'project', referenceCount: 5, lastReferenced: now, addedAt: now },
      { key: 'Kaya', value: 'Personal AI Assistant', category: 'abbreviation', referenceCount: 20, lastReferenced: now, addedAt: now },
      { key: 'WIG', value: 'Wildly Important Goal', category: 'abbreviation', referenceCount: 8, lastReferenced: now, addedAt: now },
      { key: 'DSA', value: 'Democratic Socialists of America', category: 'abbreviation', referenceCount: 3, lastReferenced: now, addedAt: now },
      { key: 'DTR', value: 'Daily/Time/Routine system', category: 'abbreviation', referenceCount: 4, lastReferenced: now, addedAt: now },
      { key: 'STORER', value: 'Stop Think Options Reflect Execute Review', category: 'abbreviation', referenceCount: 3, lastReferenced: now, addedAt: now },
      { key: 'SD', value: 'San Diego', category: 'abbreviation', referenceCount: 5, lastReferenced: now, addedAt: now },
      { key: 'Kaya', value: 'AI assistant identity', category: 'term', referenceCount: 15, lastReferenced: now, addedAt: now },
      { key: 'User', value: 'Principal user', category: 'person', referenceCount: 15, lastReferenced: now, addedAt: now },
    ],
  };
}

// ---------------------------------------------------------------------------
// HotCache class - uses StateManager for persistence
// ---------------------------------------------------------------------------

export class HotCache {
  private data: HotCacheData;
  private manager: StateManager<HotCacheData>;
  private memoryDir: string;

  /** Private constructor - use HotCache.create() instead */
  private constructor(data: HotCacheData, manager: StateManager<HotCacheData>, memoryDir: string) {
    this.data = data;
    this.manager = manager;
    this.memoryDir = memoryDir;
  }

  /**
   * Async factory method - creates a HotCache instance with StateManager
   * @param kayaHome - Optional Kaya home directory override (for testing)
   */
  static async create(kayaHome?: string): Promise<HotCache> {
    const root = kayaHome || KAYA_HOME;
    const filePath = join(root, 'MEMORY', 'HOT_CACHE.json');
    const memDir = join(root, 'MEMORY');

    const manager = createStateManager<HotCacheData>({
      path: filePath,
      schema: HotCacheDataSchema,
      defaults: createSeedData(),
    });

    const data = await manager.load();

    // If defaults were returned (no file existed), persist them
    if (!(await manager.exists())) {
      await manager.save(data);
    }

    return new HotCache(data, manager, memDir);
  }

  // -----------------------------------------------------------------------
  // resolve -- look up a shorthand, return full value or null
  // -----------------------------------------------------------------------
  resolve(shorthand: string): string | null {
    // Try exact match first
    const exact = this.data.entries.find(e => e.key === shorthand);
    if (exact) return exact.value;

    // Try case-insensitive match for short keys (1-3 chars)
    if (shorthand.length <= 3) {
      const upper = shorthand.toUpperCase();
      const match = this.data.entries.find(e => e.key.length <= 3 && e.key.toUpperCase() === upper);
      if (match) return match.value;
    }

    return null;
  }

  // -----------------------------------------------------------------------
  // recordReference -- bump reference count and timestamp
  // -----------------------------------------------------------------------
  async recordReference(key: string): Promise<void> {
    const entry = this.data.entries.find(
      e => e.key === key || (e.key.length <= 3 && e.key.toUpperCase() === key.toUpperCase()),
    );
    if (entry) {
      entry.referenceCount++;
      entry.lastReferenced = new Date().toISOString();
      this.data.lastUpdated = new Date().toISOString();
      await this.persist();
    }
  }

  // -----------------------------------------------------------------------
  // add -- insert a new entry (or update if key exists)
  // -----------------------------------------------------------------------
  async add(key: string, value: string, category: CacheEntry['category']): Promise<void> {
    const existing = this.data.entries.find(e => e.key === key);
    const now = new Date().toISOString();

    if (existing) {
      existing.value = value;
      existing.category = category;
      existing.lastReferenced = now;
    } else {
      if (this.data.entries.length >= MAX_ENTRIES) {
        // Evict lowest-referenced entry
        this.data.entries.sort((a, b) => a.referenceCount - b.referenceCount);
        this.data.entries.shift();
      }
      this.data.entries.push({
        key,
        value,
        category,
        referenceCount: 1,
        lastReferenced: now,
        addedAt: now,
      });
    }

    this.data.lastUpdated = now;
    await this.persist();
  }

  // -----------------------------------------------------------------------
  // remove -- delete an entry by key
  // -----------------------------------------------------------------------
  async remove(key: string): Promise<void> {
    const idx = this.data.entries.findIndex(e => e.key === key);
    if (idx !== -1) {
      this.data.entries.splice(idx, 1);
      this.data.lastUpdated = new Date().toISOString();
      await this.persist();
    }
  }

  // -----------------------------------------------------------------------
  // getAll -- return all entries sorted by reference count descending
  // -----------------------------------------------------------------------
  getAll(): CacheEntry[] {
    return [...this.data.entries].sort((a, b) => b.referenceCount - a.referenceCount);
  }

  // -----------------------------------------------------------------------
  // maintain -- run promotion/demotion cycle
  // -----------------------------------------------------------------------
  async maintain(): Promise<{ promoted: string[]; demoted: string[] }> {
    const now = Date.now();
    const promoted: string[] = [];
    const demoted: string[] = [];

    // Demotion: remove entries not referenced in 30+ days
    const cutoff = now - DEMOTION_THRESHOLD_DAYS * 24 * 60 * 60 * 1000;
    this.data.entries = this.data.entries.filter(entry => {
      const lastRef = new Date(entry.lastReferenced).getTime();
      if (lastRef < cutoff) {
        demoted.push(entry.key);
        return false;
      }
      return true;
    });

    // Promotion: scan MEMORY/ for frequently referenced terms
    const promotionCandidates = this.scanMemoryForCandidates();
    for (const candidate of promotionCandidates) {
      if (this.data.entries.length >= MAX_ENTRIES) break;
      const exists = this.data.entries.find(e => e.key === candidate.key);
      if (!exists) {
        this.data.entries.push(candidate);
        promoted.push(candidate.key);
      }
    }

    this.data.lastUpdated = new Date().toISOString();
    await this.persist();

    return { promoted, demoted };
  }

  // -----------------------------------------------------------------------
  // decodeMessage -- replace shorthands in a message with full values
  // -----------------------------------------------------------------------
  decodeMessage(message: string): { decoded: string; substitutions: Array<{ from: string; to: string }> } {
    const substitutions: Array<{ from: string; to: string }> = [];
    let decoded = message;

    // Sort entries by key length descending to match longer keys first
    const sorted = [...this.data.entries].sort((a, b) => b.key.length - a.key.length);

    for (const entry of sorted) {
      const { key, value } = entry;

      let pattern: RegExp;
      if (key.length <= 3) {
        // Short keys: only match whole uppercase words
        pattern = new RegExp(`\\b${escapeRegex(key)}\\b`, 'g');
        // Verify the match is the uppercase form
        const matches = decoded.match(pattern);
        if (matches) {
          for (const match of matches) {
            if (match === key) {
              decoded = decoded.replace(new RegExp(`\\b${escapeRegex(match)}\\b`, 'g'), value);
              substitutions.push({ from: match, to: value });
            }
          }
        }
      } else {
        // Longer keys: case-sensitive word boundary match
        pattern = new RegExp(`\\b${escapeRegex(key)}\\b`, 'g');
        if (pattern.test(decoded)) {
          decoded = decoded.replace(pattern, value);
          substitutions.push({ from: key, to: value });
        }
      }
    }

    return { decoded, substitutions };
  }

  // -----------------------------------------------------------------------
  // persist -- save state via StateManager
  // -----------------------------------------------------------------------
  private async persist(): Promise<void> {
    await this.manager.save(this.data);
  }

  // -----------------------------------------------------------------------
  // Private: scan deep memory for promotion candidates
  // Note: walkRecentFiles uses readFileSync for scanning arbitrary content
  // files (md, txt, jsonl) -- this is NOT the cache state file and is a
  // legitimate use of readFileSync for bulk content scanning.
  // -----------------------------------------------------------------------
  private scanMemoryForCandidates(): CacheEntry[] {
    const candidates: CacheEntry[] = [];
    const now = new Date();
    const windowStart = new Date(now.getTime() - PROMOTION_WINDOW_DAYS * 24 * 60 * 60 * 1000);

    // Scan recent MEMORY files for term frequency
    const termCounts = new Map<string, number>();

    try {
      const subdirs = ['LEARNING', 'WORK', 'VOICE'];
      for (const sub of subdirs) {
        const subPath = join(this.memoryDir, sub);
        if (!existsSync(subPath)) continue;
        this.walkRecentFiles(subPath, windowStart, (content) => {
          // Extract capitalized words and abbreviations that might be terms
          const words = content.match(/\b[A-Z][A-Za-z]{2,}\b/g) || [];
          const abbrevs = content.match(/\b[A-Z]{2,6}\b/g) || [];
          for (const w of [...words, ...abbrevs]) {
            termCounts.set(w, (termCounts.get(w) || 0) + 1);
          }
        });
      }
    } catch {
      // Silently handle file system errors during scanning
    }

    // Filter to terms that meet the promotion threshold
    const existingKeys = new Set(this.data.entries.map(e => e.key));
    for (const [term, count] of termCounts) {
      if (count >= PROMOTION_THRESHOLD && !existingKeys.has(term)) {
        candidates.push({
          key: term,
          value: term,
          category: term === term.toUpperCase() ? 'abbreviation' : 'term',
          referenceCount: count,
          lastReferenced: now.toISOString(),
          addedAt: now.toISOString(),
        });
      }
    }

    // Sort by count descending and take top results
    return candidates.sort((a, b) => b.referenceCount - a.referenceCount).slice(0, 10);
  }

  // -----------------------------------------------------------------------
  // Private: walk recent files in a directory
  // Uses readFileSync for content scanning of arbitrary files (not state)
  // -----------------------------------------------------------------------
  private walkRecentFiles(dir: string, since: Date, callback: (content: string) => void): void {
    try {
      const items = readdirSync(dir);
      for (const item of items) {
        const full = join(dir, item);
        try {
          const stat = statSync(full);
          if (stat.isDirectory()) {
            this.walkRecentFiles(full, since, callback);
          } else if (stat.isFile() && stat.mtime >= since) {
            // Only read text files, skip large files
            if (stat.size > 100_000) continue;
            const ext = item.split('.').pop()?.toLowerCase();
            if (['md', 'txt', 'json', 'jsonl'].includes(ext || '')) {
              const content = readFileSync(full, 'utf-8');
              callback(content);
            }
          }
        } catch {
          // Skip unreadable files
        }
      }
    } catch {
      // Skip unreadable directories
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ---------------------------------------------------------------------------
// Convenience singleton
// ---------------------------------------------------------------------------

let _instance: HotCache | null = null;

export async function getHotCache(): Promise<HotCache> {
  if (!_instance) {
    _instance = await HotCache.create();
  }
  return _instance;
}

// ---------------------------------------------------------------------------
// Self-test (async version)
// ---------------------------------------------------------------------------

async function runSelfTest(): Promise<void> {
  console.log('Running HotCache self-test...\n');
  let passed = 0;
  let failed = 0;

  function assert(label: string, condition: boolean): void {
    if (condition) {
      console.log(`  PASS: ${label}`);
      passed++;
    } else {
      console.error(`  FAIL: ${label}`);
      failed++;
    }
  }

  // Use a temp directory for isolated testing
  const tmpDir = join(process.env.TMPDIR || '/tmp', `hotcache-test-${Date.now()}`);
  mkdirSync(join(tmpDir, 'MEMORY'), { recursive: true });

  const cache = await HotCache.create(tmpDir);

  // Test: seed data loaded
  assert('Seed data loaded', cache.getAll().length === 11);

  // Test: resolve known key
  assert('Resolve "Kaya" returns value', cache.resolve('Kaya') === 'Personal AI Assistant');
  assert('Resolve "J" returns value', cache.resolve('J') === 'Julie');
  assert('Resolve "LV" returns value', cache.resolve('LV') === 'Lucidview');
  assert('Resolve "Kaya" returns value', cache.resolve('Kaya') === 'AI assistant identity');

  // Test: resolve unknown key
  assert('Resolve unknown returns null', cache.resolve('UNKNOWN') === null);

  // Test: case-insensitive short key
  assert('Resolve "lv" (lowercase) returns value', cache.resolve('lv') === 'Lucidview');

  // Test: add entry
  await cache.add('NYC', 'New York City', 'abbreviation');
  assert('Add entry works', cache.resolve('NYC') === 'New York City');
  assert('Entry count increased', cache.getAll().length === 12);

  // Test: update existing entry
  await cache.add('NYC', 'New York City, New York', 'abbreviation');
  assert('Update entry works', cache.resolve('NYC') === 'New York City, New York');
  assert('Entry count unchanged after update', cache.getAll().length === 12);

  // Test: remove entry
  await cache.remove('NYC');
  assert('Remove entry works', cache.resolve('NYC') === null);
  assert('Entry count decreased', cache.getAll().length === 11);

  // Test: recordReference
  const before = cache.getAll().find(e => e.key === 'Kaya')!.referenceCount;
  await cache.recordReference('Kaya');
  const after = cache.getAll().find(e => e.key === 'Kaya')!.referenceCount;
  assert('recordReference bumps count', after === before + 1);

  // Test: decodeMessage
  const result = cache.decodeMessage('sync with J about LV');
  assert('decodeMessage replaces J', result.decoded.includes('Julie'));
  assert('decodeMessage replaces LV', result.decoded.includes('Lucidview'));
  assert('decodeMessage tracks substitutions', result.substitutions.length >= 2);

  // Test: decodeMessage does not replace substrings
  const noSub = cache.decodeMessage('the JOB is done');
  assert('decodeMessage does not replace J in JOB', !noSub.decoded.includes('Julie'));

  // Test: decodeMessage with no matches
  const noMatch = cache.decodeMessage('hello world');
  assert('decodeMessage with no matches returns original', noMatch.decoded === 'hello world');
  assert('decodeMessage with no matches has empty substitutions', noMatch.substitutions.length === 0);

  // Test: getAll sorted by referenceCount
  const all = cache.getAll();
  for (let i = 0; i < all.length - 1; i++) {
    assert(`getAll sorted: index ${i} >= ${i + 1}`, all[i].referenceCount >= all[i + 1].referenceCount);
  }

  // Test: file persistence
  const cache3 = await HotCache.create(tmpDir);
  assert('Persistence: data survives reload', cache3.getAll().length > 0);

  // Cleanup
  try {
    const { rmSync } = require('fs');
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // Best-effort cleanup
  }

  console.log(`\n  Results: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    console.log(`
HotCache - Two-tier hot/cold memory cache

Usage:
  bun HotCache.ts --list                            Show all entries
  bun HotCache.ts --resolve "LV"                    Look up shorthand
  bun HotCache.ts --decode "sync with J about LV"   Decode message
  bun HotCache.ts --add "key" "value" "category"    Add entry
  bun HotCache.ts --remove "key"                    Remove entry
  bun HotCache.ts --maintain                        Run promotion/demotion
  bun HotCache.ts --test                            Run self-test

Categories: person, project, abbreviation, term
`);
    return;
  }

  if (args.includes('--test')) {
    await runSelfTest();
    return;
  }

  const cache = await HotCache.create();

  if (args.includes('--list')) {
    const entries = cache.getAll();
    console.log(`\nHot Cache (${entries.length} entries)\n${'='.repeat(60)}\n`);

    const categories = ['person', 'project', 'abbreviation', 'term'] as const;
    for (const cat of categories) {
      const catEntries = entries.filter(e => e.category === cat);
      if (catEntries.length === 0) continue;
      console.log(`${cat.toUpperCase()} (${catEntries.length})`);
      console.log(`${'─'.repeat(50)}`);
      for (const e of catEntries) {
        const ago = daysSince(e.lastReferenced);
        console.log(`  ${e.key.padEnd(12)} -> ${e.value.padEnd(35)} refs:${String(e.referenceCount).padStart(3)}  (${ago}d ago)`);
      }
      console.log('');
    }
    return;
  }

  if (args.includes('--resolve')) {
    const idx = args.indexOf('--resolve');
    const key = args[idx + 1];
    if (!key) {
      console.error('Error: --resolve requires a key argument');
      process.exit(1);
    }
    const result = cache.resolve(key);
    if (result) {
      console.log(result);
      await cache.recordReference(key);
    } else {
      console.log(`No entry found for "${key}"`);
      process.exit(1);
    }
    return;
  }

  if (args.includes('--decode')) {
    const idx = args.indexOf('--decode');
    const message = args[idx + 1];
    if (!message) {
      console.error('Error: --decode requires a message argument');
      process.exit(1);
    }
    const { decoded, substitutions } = cache.decodeMessage(message);
    console.log(`Original: ${message}`);
    console.log(`Decoded:  ${decoded}`);
    if (substitutions.length > 0) {
      console.log(`\nSubstitutions:`);
      for (const s of substitutions) {
        console.log(`  ${s.from} -> ${s.to}`);
      }
    }
    return;
  }

  if (args.includes('--add')) {
    const idx = args.indexOf('--add');
    const key = args[idx + 1];
    const value = args[idx + 2];
    const category = args[idx + 3] as CacheEntry['category'];

    if (!key || !value || !category) {
      console.error('Error: --add requires key, value, and category arguments');
      console.error('  Categories: person, project, abbreviation, term');
      process.exit(1);
    }

    const validCategories = ['person', 'project', 'abbreviation', 'term'];
    if (!validCategories.includes(category)) {
      console.error(`Error: Invalid category "${category}". Use: ${validCategories.join(', ')}`);
      process.exit(1);
    }

    await cache.add(key, value, category);
    console.log(`Added: ${key} -> ${value} (${category})`);
    return;
  }

  if (args.includes('--remove')) {
    const idx = args.indexOf('--remove');
    const key = args[idx + 1];
    if (!key) {
      console.error('Error: --remove requires a key argument');
      process.exit(1);
    }
    await cache.remove(key);
    console.log(`Removed: ${key}`);
    return;
  }

  if (args.includes('--maintain')) {
    console.log('Running maintenance cycle...\n');
    const { promoted, demoted } = await cache.maintain();

    if (promoted.length > 0) {
      console.log(`Promoted (${promoted.length}):`);
      for (const p of promoted) console.log(`  + ${p}`);
    } else {
      console.log('No promotions.');
    }

    if (demoted.length > 0) {
      console.log(`\nDemoted (${demoted.length}):`);
      for (const d of demoted) console.log(`  - ${d}`);
    } else {
      console.log('No demotions.');
    }

    console.log(`\nCache now has ${cache.getAll().length} entries.`);
    return;
  }

  console.error(`Unknown flag: ${args[0]}. Run with --help for usage.`);
  process.exit(1);
}

function daysSince(isoDate: string): number {
  return Math.floor((Date.now() - new Date(isoDate).getTime()) / (24 * 60 * 60 * 1000));
}

main().catch((err) => {
  console.error('Fatal:', err.message || err);
  process.exit(1);
});
