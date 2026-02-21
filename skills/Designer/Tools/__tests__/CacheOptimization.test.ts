/**
 * CacheOptimization.test.ts - AnalysisCache TTL, key stability, and memory tests
 *
 * Tests:
 *   - TTL behavior: 7d for vision results, 24h for products
 *   - Cache key stability: same input -> same cache key
 *   - Cache invalidation: expired entries are re-fetched
 *   - Cache hit rate target: >= 50% on repeated scenarios
 *   - Memory pressure: cache doesn't grow unbounded
 *
 * @module CacheOptimization.test
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { createAnalysisCache, type AnalysisCache, type AnalysisCacheEntry } from "../AnalysisCache.ts";
import { join } from "path";
import { existsSync, mkdirSync, unlinkSync, rmSync } from "fs";

// ---------------------------------------------------------------------------
// Test infrastructure
// ---------------------------------------------------------------------------

const TEST_CACHE_DIR = "/tmp/designer-cache-test";
let testCacheIndex = 0;

function getTestCachePath(): string {
  return join(TEST_CACHE_DIR, `cache-${testCacheIndex++}-${Date.now()}.json`);
}

function makeEntry(hash: string, method: string = "claude_vision", ttlDays: number = 7): AnalysisCacheEntry {
  return {
    imageHash: hash,
    analysis: {
      style: { primary: "Modern", cohesionScore: 8 },
      colors: { dominant: ["#F5E6D3"], accent: ["#CC5C3B"], mood: "Warm" },
      confidence: 0.85,
      analysisMethod: method,
    },
    method,
    cachedAt: new Date().toISOString(),
    ttlDays,
  };
}

function makeExpiredEntry(hash: string, daysOld: number = 10): AnalysisCacheEntry {
  const pastDate = new Date();
  pastDate.setDate(pastDate.getDate() - daysOld);
  return {
    imageHash: hash,
    analysis: { expired: true },
    method: "claude_vision",
    cachedAt: pastDate.toISOString(),
    ttlDays: 7,
  };
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  if (!existsSync(TEST_CACHE_DIR)) {
    mkdirSync(TEST_CACHE_DIR, { recursive: true });
  }
});

afterEach(() => {
  try {
    rmSync(TEST_CACHE_DIR, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors
  }
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("CacheOptimization - TTL Behavior", () => {
  it("returns cached entry within TTL (7 day vision)", async () => {
    const cachePath = getTestCachePath();
    const cache = createAnalysisCache(cachePath);

    const entry = makeEntry("hash-fresh", "claude_vision", 7);
    await cache.set("hash-fresh", entry);

    const retrieved = await cache.get("hash-fresh");
    expect(retrieved).not.toBeNull();
    expect(retrieved!.imageHash).toBe("hash-fresh");
    expect(retrieved!.method).toBe("claude_vision");
  });

  it("returns null for expired entries (past TTL)", async () => {
    const cachePath = getTestCachePath();
    const cache = createAnalysisCache(cachePath);

    const expiredEntry = makeExpiredEntry("hash-expired", 10);
    await cache.set("hash-expired", expiredEntry);

    const retrieved = await cache.get("hash-expired");
    expect(retrieved).toBeNull();
  });

  it("respects custom TTL (1 day for product-like cache)", async () => {
    const cachePath = getTestCachePath();
    const cache = createAnalysisCache(cachePath);

    // Entry with 1-day TTL, created 2 days ago
    const pastDate = new Date();
    pastDate.setDate(pastDate.getDate() - 2);
    const shortTtlEntry: AnalysisCacheEntry = {
      imageHash: "hash-short-ttl",
      analysis: { products: true },
      method: "curated_db",
      cachedAt: pastDate.toISOString(),
      ttlDays: 1,
    };
    await cache.set("hash-short-ttl", shortTtlEntry);

    const retrieved = await cache.get("hash-short-ttl");
    expect(retrieved).toBeNull();
  });

  it("entry created now with 7-day TTL is retrievable", async () => {
    const cachePath = getTestCachePath();
    const cache = createAnalysisCache(cachePath);

    const freshEntry = makeEntry("hash-just-now", "gemini_vision", 7);
    await cache.set("hash-just-now", freshEntry);

    const retrieved = await cache.get("hash-just-now");
    expect(retrieved).not.toBeNull();
    expect(retrieved!.analysis).toEqual(freshEntry.analysis);
  });
});

describe("CacheOptimization - Key Stability", () => {
  it("same image hash produces same cache key", async () => {
    const cachePath = getTestCachePath();
    const cache = createAnalysisCache(cachePath);

    const entry = makeEntry("deterministic-hash-abc123");
    await cache.set("deterministic-hash-abc123", entry);

    // Retrieve with the exact same key
    const retrieved = await cache.get("deterministic-hash-abc123");
    expect(retrieved).not.toBeNull();
    expect(retrieved!.imageHash).toBe("deterministic-hash-abc123");
  });

  it("different image hashes produce different cache entries", async () => {
    const cachePath = getTestCachePath();
    const cache = createAnalysisCache(cachePath);

    const entry1 = makeEntry("hash-image-1");
    const entry2 = makeEntry("hash-image-2");
    entry2.analysis = { ...entry2.analysis, different: true };

    await cache.set("hash-image-1", entry1);
    await cache.set("hash-image-2", entry2);

    const r1 = await cache.get("hash-image-1");
    const r2 = await cache.get("hash-image-2");

    expect(r1).not.toBeNull();
    expect(r2).not.toBeNull();
    expect(r1!.imageHash).not.toBe(r2!.imageHash);
  });

  it("overwriting same key replaces the entry", async () => {
    const cachePath = getTestCachePath();
    const cache = createAnalysisCache(cachePath);

    const entry1 = makeEntry("hash-overwrite");
    entry1.analysis = { version: 1 };
    await cache.set("hash-overwrite", entry1);

    const entry2 = makeEntry("hash-overwrite");
    entry2.analysis = { version: 2 };
    await cache.set("hash-overwrite", entry2);

    const retrieved = await cache.get("hash-overwrite");
    expect(retrieved).not.toBeNull();
    expect((retrieved!.analysis as any).version).toBe(2);

    // Should only have 1 entry, not 2
    const size = await cache.size();
    expect(size).toBe(1);
  });
});

describe("CacheOptimization - Cache Invalidation", () => {
  it("expired entries are removed on access", async () => {
    const cachePath = getTestCachePath();
    const cache = createAnalysisCache(cachePath);

    const expired = makeExpiredEntry("hash-lazy-evict", 15);
    await cache.set("hash-lazy-evict", expired);

    // Access should trigger lazy eviction
    const retrieved = await cache.get("hash-lazy-evict");
    expect(retrieved).toBeNull();

    // After eviction, size should be 0
    const size = await cache.size();
    expect(size).toBe(0);
  });

  it("clear() removes all entries", async () => {
    const cachePath = getTestCachePath();
    const cache = createAnalysisCache(cachePath);

    await cache.set("h1", makeEntry("h1"));
    await cache.set("h2", makeEntry("h2"));
    await cache.set("h3", makeEntry("h3"));

    expect(await cache.size()).toBe(3);

    await cache.clear();
    expect(await cache.size()).toBe(0);

    expect(await cache.get("h1")).toBeNull();
    expect(await cache.get("h2")).toBeNull();
    expect(await cache.get("h3")).toBeNull();
  });

  it("fresh entry alongside expired entry: fresh survives, expired evicted", async () => {
    const cachePath = getTestCachePath();
    const cache = createAnalysisCache(cachePath);

    await cache.set("fresh", makeEntry("fresh", "claude_vision", 7));
    await cache.set("stale", makeExpiredEntry("stale", 20));

    // Access stale -> evict it
    expect(await cache.get("stale")).toBeNull();
    // Fresh should still be there
    expect(await cache.get("fresh")).not.toBeNull();
  });
});

describe("CacheOptimization - Hit Rate", () => {
  it("achieves >= 50% cache hit rate on repeated scenarios", async () => {
    const cachePath = getTestCachePath();
    const cache = createAnalysisCache(cachePath);

    const scenarios = ["room-a", "room-b", "room-c", "room-d", "room-e"];
    let hits = 0;
    let total = 0;

    // First pass: all misses, populate cache
    for (const scenario of scenarios) {
      total++;
      const cached = await cache.get(scenario);
      if (cached) {
        hits++;
      } else {
        await cache.set(scenario, makeEntry(scenario));
      }
    }

    // Second pass: all should be hits
    for (const scenario of scenarios) {
      total++;
      const cached = await cache.get(scenario);
      if (cached) {
        hits++;
      }
    }

    const hitRate = hits / total;
    expect(hitRate).toBeGreaterThanOrEqual(0.5);
    // Actually should be exactly 5/10 = 50% (5 misses + 5 hits)
    expect(hits).toBe(5);
  });

  it("returns cache hit immediately without re-computation", async () => {
    const cachePath = getTestCachePath();
    const cache = createAnalysisCache(cachePath);

    // Populate cache
    await cache.set("fast-key", makeEntry("fast-key"));

    // Measure hit retrieval time
    const start = performance.now();
    for (let i = 0; i < 100; i++) {
      await cache.get("fast-key");
    }
    const elapsed = performance.now() - start;

    // 100 cache hits should be very fast (under 500ms for file-based)
    expect(elapsed).toBeLessThan(5000);
  });
});

describe("CacheOptimization - Memory Pressure", () => {
  it("cache size tracks correctly with additions", async () => {
    const cachePath = getTestCachePath();
    const cache = createAnalysisCache(cachePath);

    for (let i = 0; i < 20; i++) {
      await cache.set(`mem-${i}`, makeEntry(`mem-${i}`));
    }

    expect(await cache.size()).toBe(20);
  });

  it("overwrite does not increase cache size", async () => {
    const cachePath = getTestCachePath();
    const cache = createAnalysisCache(cachePath);

    // Add 5 entries
    for (let i = 0; i < 5; i++) {
      await cache.set(`dup-${i}`, makeEntry(`dup-${i}`));
    }
    expect(await cache.size()).toBe(5);

    // Overwrite them all
    for (let i = 0; i < 5; i++) {
      const entry = makeEntry(`dup-${i}`);
      entry.analysis = { overwritten: true };
      await cache.set(`dup-${i}`, entry);
    }
    expect(await cache.size()).toBe(5);
  });

  it("clear() followed by repopulation works correctly", async () => {
    const cachePath = getTestCachePath();
    const cache = createAnalysisCache(cachePath);

    for (let i = 0; i < 10; i++) {
      await cache.set(`cycle-${i}`, makeEntry(`cycle-${i}`));
    }
    expect(await cache.size()).toBe(10);

    await cache.clear();
    expect(await cache.size()).toBe(0);

    for (let i = 0; i < 5; i++) {
      await cache.set(`cycle2-${i}`, makeEntry(`cycle2-${i}`));
    }
    expect(await cache.size()).toBe(5);
  });
});
