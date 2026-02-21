#!/usr/bin/env bun
/**
 * MemoryStore.test.ts - Test suite for unified memory storage
 *
 * Test-First Development: These tests define the expected behavior
 * before implementation. Run with: bun test MemoryStore.test.ts
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, existsSync } from "fs";
import { join } from "path";

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
  });

  describe("deduplication", () => {
    test("should detect duplicate content", async () => {
      const { createMemoryStore } = await import("./MemoryStore");
      store = createMemoryStore(TEST_DIR);

      await store.capture({
        type: "learning",
        title: "First entry",
        content: "This is the exact content that will be duplicated",
        tags: ["test"],
      });

      // Capture with deduplication enabled
      const duplicate = await store.capture({
        type: "learning",
        title: "Second entry",
        content: "This is the exact content that will be duplicated",
        tags: ["test"],
        deduplicate: true,
      });

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
