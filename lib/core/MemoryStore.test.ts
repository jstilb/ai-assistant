#!/usr/bin/env bun
/**
 * MemoryStore.test.ts - Test suite for unified memory storage
 *
 * Test-First Development: These tests define the expected behavior
 * before implementation. Run with: bun test MemoryStore.test.ts
 */

import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

/**
 * Mirrors MemoryStore.ts's private `jaccardSimilarity()` exactly (tokenize:
 * lowercase, split on non-word runs, drop tokens of length <= 2). Not
 * exported by the module — this copy exists ONLY so S9's tests can assert,
 * as documentation of test intent, that a fixture's Jaccard similarity is
 * actually >= 0.85 (i.e. the kind of pair the OLD code's capture()-path
 * fuzzy check would have silently collapsed to one entry). Production
 * dedup decisions never call this from the test file — only capture()'s
 * own behavior is asserted against the real module.
 */
function testOnlyJaccard(a: string, b: string): number {
  const tokenize = (s: string) => new Set(s.toLowerCase().split(/\W+/).filter((t) => t.length > 2));
  const setA = tokenize(a);
  const setB = tokenize(b);
  if (setA.size === 0 || setB.size === 0) return 0;
  const intersection = new Set([...setA].filter((x) => setB.has(x)));
  const union = new Set([...setA, ...setB]);
  return intersection.size / union.size;
}

// Test will import from implementation
const TEST_DIR = join(import.meta.dir, "__test_memory__");

// Import will be added after implementation
// import { createMemoryStore, type MemoryEntry, type MemoryStore } from "./MemoryStore";

describe("MemoryStore", () => {
  let store: any; // Will be MemoryStore type

  beforeEach(() => {
    // Clean test directory
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true });
    }
    mkdirSync(TEST_DIR, { recursive: true });

    // Create store with test directory
    // store = createMemoryStore(TEST_DIR);
  });

  afterEach(() => {
    // Cleanup
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true });
    }
  });

  describe("capture()", () => {
    test("should capture a basic memory entry", async () => {
      const { createMemoryStore } = await import("./MemoryStore");
      store = createMemoryStore(TEST_DIR);

      const entry = await store.capture({
        type: "learning",
        title: "Test learning entry",
        content: "This is test content for a learning entry",
        tags: ["test", "learning"],
      });

      expect(entry).toBeDefined();
      expect(entry.id).toBeDefined();
      expect(entry.type).toBe("learning");
      expect(entry.title).toBe("Test learning entry");
      expect(entry.content).toBe("This is test content for a learning entry");
      expect(entry.tags).toContain("test");
      expect(entry.tags).toContain("learning");
      expect(entry.tier).toBe("hot"); // Default tier
      expect(entry.timestamp).toBeDefined();
    });

    test("should capture entry with category", async () => {
      const { createMemoryStore } = await import("./MemoryStore");
      store = createMemoryStore(TEST_DIR);

      const entry = await store.capture({
        type: "learning",
        category: "ALGORITHM",
        title: "Algorithm insight",
        content: "ISC tracking pattern discovered",
        tags: ["algorithm", "isc"],
      });

      expect(entry.category).toBe("ALGORITHM");
    });

    test("should capture entry with custom tier", async () => {
      const { createMemoryStore } = await import("./MemoryStore");
      store = createMemoryStore(TEST_DIR);

      const entry = await store.capture({
        type: "decision",
        title: "Architecture decision",
        content: "Decided to use event sourcing",
        tier: "warm",
      });

      expect(entry.tier).toBe("warm");
    });

    test("should capture entry with TTL", async () => {
      const { createMemoryStore } = await import("./MemoryStore");
      store = createMemoryStore(TEST_DIR);

      const entry = await store.capture({
        type: "signal",
        title: "Temporary signal",
        content: "This should expire",
        ttl: 3600, // 1 hour
      });

      expect(entry.ttl).toBe(3600);
    });

    test("should capture entry with metadata", async () => {
      const { createMemoryStore } = await import("./MemoryStore");
      store = createMemoryStore(TEST_DIR);

      const entry = await store.capture({
        type: "artifact",
        title: "Code artifact",
        content: "function test() {}",
        metadata: { language: "typescript", lines: 10 },
      });

      expect(entry.metadata).toBeDefined();
      expect(entry.metadata?.language).toBe("typescript");
      expect(entry.metadata?.lines).toBe(10);
    });

    test("should set source automatically", async () => {
      const { createMemoryStore } = await import("./MemoryStore");
      store = createMemoryStore(TEST_DIR);

      const entry = await store.capture({
        type: "learning",
        title: "Test entry",
        content: "Content",
      });

      expect(entry.source).toBe("MemoryStore"); // Default source
    });
  });

  describe("get()", () => {
    test("should retrieve entry by ID", async () => {
      const { createMemoryStore } = await import("./MemoryStore");
      store = createMemoryStore(TEST_DIR);

      const created = await store.capture({
        type: "learning",
        title: "Retrievable entry",
        content: "Test content",
      });

      const retrieved = await store.get(created.id);

      expect(retrieved).toBeDefined();
      expect(retrieved?.id).toBe(created.id);
      expect(retrieved?.title).toBe("Retrievable entry");
    });

    test("should return null for non-existent ID", async () => {
      const { createMemoryStore } = await import("./MemoryStore");
      store = createMemoryStore(TEST_DIR);

      const result = await store.get("non-existent-id");
      expect(result).toBeNull();
    });
  });

  describe("search()", () => {
    test("should search by type", async () => {
      const { createMemoryStore } = await import("./MemoryStore");
      store = createMemoryStore(TEST_DIR);

      await store.capture({ type: "learning", title: "Learning 1", content: "c1" });
      await store.capture({ type: "decision", title: "Decision 1", content: "c2" });
      await store.capture({ type: "learning", title: "Learning 2", content: "c3" });

      const results = await store.search({ type: "learning" });

      expect(results.length).toBe(2);
      expect(results.every((r: any) => r.type === "learning")).toBe(true);
    });

    test("should search by multiple types", async () => {
      const { createMemoryStore } = await import("./MemoryStore");
      store = createMemoryStore(TEST_DIR);

      await store.capture({ type: "learning", title: "L1", content: "c1" });
      await store.capture({ type: "decision", title: "D1", content: "c2" });
      await store.capture({ type: "signal", title: "S1", content: "c3" });

      const results = await store.search({ type: ["learning", "decision"] });

      expect(results.length).toBe(2);
    });

    test("should search by tags", async () => {
      const { createMemoryStore } = await import("./MemoryStore");
      store = createMemoryStore(TEST_DIR);

      await store.capture({ type: "learning", title: "T1", content: "c1", tags: ["typescript", "testing"] });
      await store.capture({ type: "learning", title: "T2", content: "c2", tags: ["python"] });
      await store.capture({ type: "learning", title: "T3", content: "c3", tags: ["typescript", "api"] });

      const results = await store.search({ tags: ["typescript"] });

      expect(results.length).toBe(2);
    });

    test("should search by tier", async () => {
      const { createMemoryStore } = await import("./MemoryStore");
      store = createMemoryStore(TEST_DIR);

      await store.capture({ type: "learning", title: "Hot", content: "c1", tier: "hot" });
      await store.capture({ type: "learning", title: "Warm", content: "c2", tier: "warm" });

      const results = await store.search({ tier: "warm" });

      expect(results.length).toBe(1);
      expect(results[0].title).toBe("Warm");
    });

    test("should search by date range", async () => {
      const { createMemoryStore } = await import("./MemoryStore");
      store = createMemoryStore(TEST_DIR);

      // Create entries (they'll have current timestamps)
      await store.capture({ type: "learning", title: "Recent", content: "c1" });

      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);

      const results = await store.search({ since: yesterday });

      expect(results.length).toBeGreaterThanOrEqual(1);
    });

    test("should search with full text", async () => {
      const { createMemoryStore } = await import("./MemoryStore");
      store = createMemoryStore(TEST_DIR);

      await store.capture({ type: "learning", title: "Pattern matching", content: "ISC convergence tracking" });
      await store.capture({ type: "learning", title: "Other topic", content: "Database optimization" });

      const results = await store.search({ fullText: "ISC" });

      expect(results.length).toBe(1);
      expect(results[0].content).toContain("ISC");
    });

    test("should limit results", async () => {
      const { createMemoryStore } = await import("./MemoryStore");
      store = createMemoryStore(TEST_DIR);

      for (let i = 0; i < 10; i++) {
        await store.capture({ type: "learning", title: `Entry ${i}`, content: `Content ${i}` });
      }

      const results = await store.search({ type: "learning", limit: 5 });

      expect(results.length).toBe(5);
    });

    test("should search by category", async () => {
      const { createMemoryStore } = await import("./MemoryStore");
      store = createMemoryStore(TEST_DIR);

      await store.capture({ type: "learning", category: "ALGORITHM", title: "Algo", content: "c1" });
      await store.capture({ type: "learning", category: "SYSTEM", title: "Sys", content: "c2" });

      const results = await store.search({ category: "ALGORITHM" });

      expect(results.length).toBe(1);
      expect(results[0].category).toBe("ALGORITHM");
    });
  });

  describe("findSimilar()", () => {
    test("should find similar content", async () => {
      const { createMemoryStore } = await import("./MemoryStore");
      store = createMemoryStore(TEST_DIR);

      await store.capture({
        type: "learning",
        title: "ISC tracking pattern",
        content: "ISC tracking convergence rolling iteration windows accuracy tracking pattern convergence",
      });

      await store.capture({
        type: "learning",
        title: "Unrelated topic",
        content: "Database indexing strategies for large tables with optimized queries",
      });

      // Use lower threshold since Jaccard works on word tokens
      const similar = await store.findSimilar("ISC tracking convergence rolling windows pattern", 0.2);

      expect(similar.length).toBeGreaterThanOrEqual(1);
      expect(similar[0].title).toContain("ISC");
    });

    test("should respect similarity threshold", async () => {
      const { createMemoryStore } = await import("./MemoryStore");
      store = createMemoryStore(TEST_DIR);

      await store.capture({
        type: "learning",
        title: "TypeScript patterns",
        content: "Using generics for type safety",
      });

      // Very high threshold should return no results for dissimilar content
      const similar = await store.findSimilar("Python decorators", 0.9);

      expect(similar.length).toBe(0);
    });
  });

  describe("update()", () => {
    test("should update entry fields", async () => {
      const { createMemoryStore } = await import("./MemoryStore");
      store = createMemoryStore(TEST_DIR);

      const entry = await store.capture({
        type: "learning",
        title: "Original title",
        content: "Original content",
      });

      const updated = await store.update(entry.id, {
        title: "Updated title",
        tags: ["new-tag"],
      });

      expect(updated.title).toBe("Updated title");
      expect(updated.tags).toContain("new-tag");
      expect(updated.content).toBe("Original content"); // Unchanged
    });

    test("should update tier", async () => {
      const { createMemoryStore } = await import("./MemoryStore");
      store = createMemoryStore(TEST_DIR);

      const entry = await store.capture({
        type: "learning",
        title: "Test",
        content: "Content",
        tier: "hot",
      });

      const updated = await store.update(entry.id, { tier: "warm" });

      expect(updated.tier).toBe("warm");
    });
  });

  describe("archive()", () => {
    test("should move entry to cold tier", async () => {
      const { createMemoryStore } = await import("./MemoryStore");
      store = createMemoryStore(TEST_DIR);

      const entry = await store.capture({
        type: "learning",
        title: "To archive",
        content: "Content",
        tier: "hot",
      });

      await store.archive(entry.id);

      const archived = await store.get(entry.id);
      expect(archived?.tier).toBe("cold");
    });
  });

  describe("cold-tier archive integrity", () => {
    test("delete of a cold entry followed by another archive keeps one record per line", async () => {
      const { createMemoryStore } = await import("./MemoryStore");
      store = createMemoryStore(TEST_DIR);
      const a = await store.capture({ type: "learning", title: "A", content: "content a", tier: "hot" });
      const b = await store.capture({ type: "learning", title: "B", content: "content b", tier: "hot" });
      const c = await store.capture({ type: "learning", title: "C", content: "content c", tier: "hot" });
      await store.archive(a.id);
      await store.archive(b.id);
      await store.delete(a.id); // cold-path delete rewrites the archive file
      await store.archive(c.id); // append after rewrite must start on a new line

      const { readdirSync } = await import("fs");
      const archiveDir = join(TEST_DIR, "archive");
      const files = readdirSync(archiveDir).filter((f: string) => f.endsWith(".jsonl"));
      expect(files.length).toBe(1);
      const raw = readFileSync(join(archiveDir, files[0]), "utf-8");
      expect(raw.endsWith("\n")).toBe(true);
      const lines = raw.split("\n").filter((l: string) => l.trim());
      expect(lines.length).toBe(2);
      for (const line of lines) expect(() => JSON.parse(line)).not.toThrow();
      expect((await store.get(c.id))?.tier).toBe("cold");
    });

    test("repairArchives() splits glued records and leaves the store readable", async () => {
      const { createMemoryStore } = await import("./MemoryStore");
      store = createMemoryStore(TEST_DIR);
      const a = await store.capture({ type: "learning", title: "A", content: "content a", tier: "hot" });
      const b = await store.capture({ type: "learning", title: "B", content: "content b", tier: "hot" });
      await store.archive(a.id);
      await store.archive(b.id);
      const { readdirSync } = await import("fs");
      const archiveDir = join(TEST_DIR, "archive");
      const file = join(archiveDir, readdirSync(archiveDir).filter((f: string) => f.endsWith(".jsonl"))[0]);
      // Reproduce the historical corruption: two records glued onto one line.
      const records = readFileSync(file, "utf-8").split("\n").filter((l: string) => l.trim());
      writeFileSync(file, records.join("") + "\n");
      await expect(store.get(a.id)).rejects.toThrow();

      const result = await store.repairArchives();
      expect(result.files).toBe(1);
      expect(result.gluedLines).toBe(1);
      expect(result.recordsRecovered).toBe(2);
      expect(result.unparseable).toBe(0);
      const lines = readFileSync(file, "utf-8").split("\n").filter((l: string) => l.trim());
      expect(lines.length).toBe(2);
      expect((await store.get(a.id))?.title).toBe("A");
      expect((await store.get(b.id))?.title).toBe("B");
    });
  });

  describe("delete()", () => {
    test("should remove entry completely", async () => {
      const { createMemoryStore } = await import("./MemoryStore");
      store = createMemoryStore(TEST_DIR);

      const entry = await store.capture({
        type: "learning",
        title: "To delete",
        content: "Content",
      });

      await store.delete(entry.id);

      const result = await store.get(entry.id);
      expect(result).toBeNull();
    });
  });

  describe("consolidate()", () => {
    test("should archive old entries", async () => {
      const { createMemoryStore } = await import("./MemoryStore");
      store = createMemoryStore(TEST_DIR);

      // Create entries
      await store.capture({
        type: "learning",
        title: "Hot entry",
        content: "Recent content",
        tier: "hot",
      });

      const result = await store.consolidate();

      expect(result).toBeDefined();
      expect(typeof result.archived).toBe("number");
      expect(typeof result.deduplicated).toBe("number");
    });

    test("should actually archive duplicate entries (non-zero deduplicated count)", async () => {
      const { createMemoryStore } = await import("./MemoryStore");
      store = createMemoryStore(TEST_DIR);

      // Force-create two entries with same content by bypassing normal dedup
      const content = "Identical content for dedup test " + Date.now();
      const e1 = await store.capture({ type: "learning", title: "Entry A", content, deduplicate: false });
      const e2 = await store.capture({ type: "learning", title: "Entry B", content, deduplicate: false });

      // Both should exist before consolidate
      expect(e1.id).not.toBe(e2.id);
      const beforeSearch = await store.search({ type: "learning" });
      expect(beforeSearch.length).toBe(2);

      const result = await store.consolidate();
      // At least one duplicate should have been archived
      expect(result.deduplicated).toBeGreaterThanOrEqual(1);

      // After consolidate, one entry should be cold (archived) and only one hot/warm
      const hotEntries = await store.search({ type: "learning", tier: "hot" });
      const warmEntries = await store.search({ type: "learning", tier: "warm" });
      const activeCount = hotEntries.length + warmEntries.length;
      expect(activeCount).toBeLessThanOrEqual(1); // Only 1 non-cold entry remains
    });
  });

  describe("deduplication", () => {
    // UPDATED for S9 (fuzzy Jaccard removed from capture() path, full-content
    // hashing): this test already exercised byte-identical content, so its
    // original assertion (all.length === 1) is unchanged by S9 — a true
    // exact duplicate is still deduped under full-content hashing (identical
    // content hashes identically regardless of prefix-vs-full truncation).
    // What's NEW here is the `deduped` flag assertion: pre-S9, capture()'s
    // return value had no way to tell a caller "you got the existing entry
    // back" versus "a fresh entry was created" other than comparing IDs by
    // hand. Additive field, does not change any other behavior.
    test("should detect duplicate content", async () => {
      const { createMemoryStore } = await import("./MemoryStore");
      store = createMemoryStore(TEST_DIR);

      const first = await store.capture({
        type: "learning",
        title: "First entry",
        content: "This is the exact content that will be duplicated",
        tags: ["test"],
      });
      expect(first.deduped).toBe(false);

      // Capture with deduplication enabled
      const duplicate = await store.capture({
        type: "learning",
        title: "Second entry",
        content: "This is the exact content that will be duplicated",
        tags: ["test"],
        deduplicate: true,
      });
      expect(duplicate.deduped).toBe(true);
      expect(duplicate.id).toBe(first.id);

      // Should return existing entry, not create new one
      const all = await store.search({ type: "learning" });
      expect(all.length).toBe(1); // Only one entry should exist
    });

    test("should not deduplicate when disabled", async () => {
      const { createMemoryStore } = await import("./MemoryStore");
      store = createMemoryStore(TEST_DIR);

      await store.capture({
        type: "learning",
        title: "First",
        content: "Same content here",
        deduplicate: false,
      });

      await store.capture({
        type: "learning",
        title: "Second",
        content: "Same content here",
        deduplicate: false,
      });

      const all = await store.search({ type: "learning" });
      expect(all.length).toBe(2);
    });
  });

  // ==========================================================================
  // S9 — exact dedup done honestly (fuzzy Jaccard removed from capture() path)
  // ==========================================================================
  //
  // Prior to S9, hashContent() hashed only content.slice(0, 500) + sorted
  // tags. Two DIFFERENT memories sharing a long identical prefix collided on
  // that hash, and capture()'s only guard against a false-positive collapse
  // was a jaccardSimilarity() check run on the hash collision: if similarity
  // was >= 0.85, the OLD entry was silently returned as if a fresh write had
  // succeeded — the "census trap." S9 hashes the FULL content, so a hash
  // match now means true byte-for-byte identity (mod tag order), and the
  // Jaccard fallback is deleted from capture() entirely (findSimilar() keeps
  // its own Jaccard use — that's an explicit query API where the CALLER
  // judges similarity, not a silent write-path decision).
  describe("S9 — exact dedup (fuzzy Jaccard removed from capture path)", () => {
    test("(1) exact duplicate (identical full content + tags, order-independent) is deduped, logs, single entry survives", async () => {
      const { createMemoryStore } = await import("./MemoryStore");
      store = createMemoryStore(TEST_DIR);

      const content =
        "S9 exact-dedup probe: identical content, tags supplied in different order across the two captures below.";

      const first = await store.capture({
        type: "learning",
        title: "First capture",
        content,
        tags: ["s9", "exact-dup"],
      });
      expect(first.deduped).toBe(false);

      const logSpy = spyOn(console, "log");
      try {
        const second = await store.capture({
          type: "learning",
          title: "Second capture (should be deduped)",
          content,
          tags: ["exact-dup", "s9"], // same tag SET, different order — sorted internally
        });

        expect(second.deduped).toBe(true);
        expect(second.id).toBe(first.id);

        // Loud, not silent: capture() must log every dedup event.
        const loggedDedup = logSpy.mock.calls.some((call) =>
          call.some((arg) => typeof arg === "string" && /dedup/i.test(arg) && arg.includes(first.id))
        );
        expect(loggedDedup).toBe(true);
      } finally {
        logSpy.mockRestore();
      }

      const all = await store.search({ type: "learning" });
      expect(all.length).toBe(1);
    });

    test("(2) HEADLINE — two entries sharing a 500+-char identical prefix but differing after it are BOTH stored", async () => {
      const { createMemoryStore } = await import("./MemoryStore");
      store = createMemoryStore(TEST_DIR);

      // Shared prefix alone is ~700 chars — well past the OLD hashContent's
      // 500-char slice boundary, so the OLD algorithm hashed these two
      // contents (same tags) IDENTICALLY, treating them as candidates for
      // the Jaccard-similarity collapse below.
      const sharedPrefix = Array.from({ length: 90 }, (_, i) => `token${i}`).join(" ");
      expect(sharedPrefix.length).toBeGreaterThan(500);

      const contentA = `${sharedPrefix} unique_tail_alpha some divergent details about approach alpha`;
      const contentB = `${sharedPrefix} unique_tail_beta some divergent details about approach beta`;
      expect(contentA).not.toBe(contentB);

      // Document the precondition that made this the OLD code's silent-loss
      // case: high Jaccard similarity (the OLD fallback's own threshold was
      // 0.85) despite genuinely different content after the shared prefix.
      const similarity = testOnlyJaccard(contentA, contentB);
      expect(similarity).toBeGreaterThanOrEqual(0.85);

      const e1 = await store.capture({
        type: "learning",
        title: "Prefix collision A",
        content: contentA,
        tags: ["s9", "headline"],
      });
      const e2 = await store.capture({
        type: "learning",
        title: "Prefix collision B",
        content: contentB,
        tags: ["s9", "headline"],
      });

      expect(e1.id).not.toBe(e2.id);
      // Neither capture is reported as deduped — OLD code would have made
      // e2.deduped-equivalent true (silently returning e1) here.
      expect(e1.deduped).toBe(false);
      expect(e2.deduped).toBe(false);

      const found = await store.search({ type: "learning", tags: ["headline"] });
      expect(found.length).toBe(2);
      const contents = found.map((e: any) => e.content).sort();
      expect(contents).toEqual([contentA, contentB].sort());
    });

    test("(3) near-duplicate content (Jaccard >= 0.85) that is NOT byte-identical is BOTH stored, at any content length", async () => {
      const { createMemoryStore } = await import("./MemoryStore");
      store = createMemoryStore(TEST_DIR);

      // Unlike test (2), this pair is short (well under the old 500-char
      // slice boundary), so even the OLD hashContent() would never have
      // collided them (short content ⇒ its "prefix" IS the full content, so
      // differing content already means differing old-style hashes). This
      // test instead documents the complementary guarantee: capture() never
      // consults Jaccard similarity in its write path at ANY content length
      // — high similarity alone is never sufficient to collapse two entries,
      // whether or not a hash collision was ever in play.
      const sharedWords = Array.from({ length: 40 }, (_, i) => `word${i}`).join(" ");
      const contentC = `${sharedWords} variant_alpha`;
      const contentD = `${sharedWords} variant_beta`;
      expect(contentC.length).toBeLessThan(500);
      expect(contentC).not.toBe(contentD);

      const similarity = testOnlyJaccard(contentC, contentD);
      expect(similarity).toBeGreaterThanOrEqual(0.85);

      const e1 = await store.capture({ type: "learning", title: "Near-dup C", content: contentC, tags: ["s9", "near-dup"] });
      const e2 = await store.capture({ type: "learning", title: "Near-dup D", content: contentD, tags: ["s9", "near-dup"] });

      expect(e1.id).not.toBe(e2.id);
      expect(e1.deduped).toBe(false);
      expect(e2.deduped).toBe(false);

      const found = await store.search({ type: "learning", tags: ["near-dup"] });
      expect(found.length).toBe(2);
    });

    test("(4) old-format (pre-S9, unversioned/prefix-hash) dedup-hashes.json is discarded loudly, without crashing capture()", async () => {
      const { createMemoryStore } = await import("./MemoryStore");

      // Write a pre-S9 dedup-hashes.json directly, bypassing the store: no
      // `version` field (the real pre-S9 shape), pointing at an entry ID
      // that doesn't even exist on disk — the worst case a migration must
      // survive without crashing.
      mkdirSync(TEST_DIR, { recursive: true });
      writeFileSync(
        join(TEST_DIR, "dedup-hashes.json"),
        JSON.stringify({ hashes: { "0123456789abcdef": "stale-pre-s9-entry-id" } })
      );

      const errorSpy = spyOn(console, "error");
      let entry: any;
      try {
        store = createMemoryStore(TEST_DIR);
        entry = await store.capture({
          type: "learning",
          title: "Post-migration capture",
          content: "Captured immediately after an old-format dedup table is discarded — must not crash.",
        });

        // Loud, not silent: the migration is logged, not silently swallowed.
        const migrationLogged = errorSpy.mock.calls.some((call) =>
          call.some(
            (arg) =>
              typeof arg === "string" &&
              /dedup-hashes\.json/i.test(arg) &&
              /(discard|stale|migrat|pre-s9|unversioned)/i.test(arg)
          )
        );
        expect(migrationLogged).toBe(true);
      } finally {
        errorSpy.mockRestore();
      }

      // No crash: the capture succeeded and is a fresh (non-deduped) entry.
      expect(entry).toBeDefined();
      expect(entry.deduped).toBe(false);

      // The dedup file on disk is now namespaced at the current version —
      // confirms the migration actually rewrote it, not just logged once.
      const rewritten = JSON.parse(readFileSync(join(TEST_DIR, "dedup-hashes.json"), "utf-8"));
      expect(typeof rewritten.version).toBe("number");
      expect(rewritten.version).toBeGreaterThanOrEqual(2);
      // The stale pre-S9 entry must NOT survive the migration into the new table.
      expect(Object.values(rewritten.hashes)).not.toContain("stale-pre-s9-entry-id");
    });
  });

  describe("getStats()", () => {
    test("should return accurate statistics", async () => {
      const { createMemoryStore } = await import("./MemoryStore");
      store = createMemoryStore(TEST_DIR);

      await store.capture({ type: "learning", title: "L1", content: "c1", tier: "hot" });
      await store.capture({ type: "learning", title: "L2", content: "c2", tier: "warm" });
      await store.capture({ type: "decision", title: "D1", content: "c3", tier: "hot" });

      const stats = await store.getStats();

      expect(stats.total).toBe(3);
      expect(stats.byType.learning).toBe(2);
      expect(stats.byType.decision).toBe(1);
      expect(stats.byTier.hot).toBe(2);
      expect(stats.byTier.warm).toBe(1);
    });
  });

  describe("rebuildIndex()", () => {
    test("should rebuild index from entries", async () => {
      const { createMemoryStore } = await import("./MemoryStore");
      store = createMemoryStore(TEST_DIR);

      await store.capture({ type: "learning", title: "Entry", content: "Content" });

      // Rebuild index
      await store.rebuildIndex();

      // Should still be searchable
      const results = await store.search({ type: "learning" });
      expect(results.length).toBe(1);
    });
  });
});

// ============================================================================
// laziness — path resolution is call-time via KayaHome, not eval-time via
// process.env.HOME (E5 regression)
// ============================================================================
//
// Every test above uses an explicit `createMemoryStore(TEST_DIR)`, which
// bypasses KAYA_HOME resolution entirely and never touches the module-level
// `memoryStore` singleton. That singleton — `export const memoryStore =
// createMemoryStore();` at the bottom of MemoryStore.ts — is what every
// real caller (QueueManager.reject/approve, GrillStamp, etc.) actually
// imports and uses. Before slice E5, that singleton resolved its entries
// directory EAGERLY, at module-evaluation (first-import) time, from
// `process.env.HOME` only — never KAYA_HOME/KAYA_DIR at all. Any test that
// sandboxed KAYA_HOME (the repo convention) but not HOME therefore still
// leaked real capture() writes into the live ~/.claude/MEMORY/entries/ tree.
// This test proves the fix: it imports the module (module-eval already ran,
// possibly under a different env, exactly mirroring the real-world failure
// mode), THEN repoints KAYA_HOME to a fresh dir, and asserts a capture()
// call made AFTER that repoint lands under the NEW KAYA_HOME — not under
// process.env.HOME.
describe("laziness — path resolution is call-time via KayaHome (E5 regression)", () => {
  test("capture() after a post-import KAYA_HOME repoint writes under KAYA_HOME, not process.env.HOME", async () => {
    const { memoryStore } = await import("./MemoryStore");

    const freshDir = mkdtempSync(join(tmpdir(), "memorystore-laziness-"));
    const originalKayaHome = process.env.KAYA_HOME;
    const originalKayaDir = process.env.KAYA_DIR;

    // Repoint AFTER the module (and its `memoryStore` singleton) has already
    // been evaluated — this is exactly the scenario the old module-scope
    // `const MEMORY_DIR = join(process.env.HOME!, ...)` broke: it resolved
    // once, ignoring KAYA_HOME entirely, and never looked at process.env
    // again.
    process.env.KAYA_HOME = freshDir;
    process.env.KAYA_DIR = freshDir;

    try {
      const uniqueContent = `E5 laziness probe ${Date.now()}-${Math.random()}`;
      const entry = await memoryStore.capture({
        type: "signal",
        title: "E5 laziness probe",
        content: uniqueContent,
        deduplicate: false,
      });

      const date = new Date(entry.timestamp);
      const monthDir = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;

      // Landed under the NEW (post-import) KAYA_HOME.
      const newEntryPath = join(freshDir, "MEMORY", "entries", monthDir, `${entry.id}.json`);
      expect(existsSync(newEntryPath)).toBe(true);
      const written = JSON.parse(readFileSync(newEntryPath, "utf-8"));
      expect(written.content).toBe(uniqueContent);

      // Did NOT land under process.env.HOME/.claude/MEMORY — the old,
      // frozen-at-import-time, HOME-only resolution. Guards against a false
      // pass (e.g. the write silently going to the real live location too).
      const staleHomeEntryPath = join(
        process.env.HOME || "",
        ".claude",
        "MEMORY",
        "entries",
        monthDir,
        `${entry.id}.json`
      );
      expect(existsSync(staleHomeEntryPath)).toBe(false);
    } finally {
      if (originalKayaHome === undefined) delete process.env.KAYA_HOME;
      else process.env.KAYA_HOME = originalKayaHome;
      if (originalKayaDir === undefined) delete process.env.KAYA_DIR;
      else process.env.KAYA_DIR = originalKayaDir;
      rmSync(freshDir, { recursive: true, force: true });
    }
  });
});

describe("MemoryStore CLI", () => {
  test("should support capture command", async () => {
    // Test CLI argument parsing
    // This will be tested via actual CLI invocation
    expect(true).toBe(true); // Placeholder
  });

  test("should support search command", async () => {
    expect(true).toBe(true); // Placeholder
  });
});
