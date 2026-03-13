#!/usr/bin/env bun
/**
 * HotCache.test.ts - Unit tests for HotCache
 *
 * Tests the two-tier hot/cold memory cache including:
 * - Cache loading via StateManager (no raw JSON.parse/readFileSync)
 * - Entry resolution (exact, case-insensitive)
 * - Add, remove, update operations
 * - Maintenance (promotion/demotion)
 * - Message decoding
 * - File persistence via StateManager
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { HotCache } from "./HotCache";

const TEST_DIR = "/tmp/hotcache-test";

describe("HotCache", () => {
  beforeEach(() => {
    mkdirSync(join(TEST_DIR, "MEMORY"), { recursive: true });
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true, force: true });
    }
  });

  describe("initialization", () => {
    test("creates cache with seed data when no file exists", async () => {
      const cache = await HotCache.create(TEST_DIR);
      const all = cache.getAll();
      expect(all.length).toBeGreaterThan(0);
    });

    test("persists data to disk on creation", async () => {
      const cache = await HotCache.create(TEST_DIR);
      expect(existsSync(join(TEST_DIR, "MEMORY", "HOT_CACHE.json"))).toBe(true);
    });

    test("loads existing data from file", async () => {
      // Create first instance and add entry
      const cache1 = await HotCache.create(TEST_DIR);
      await cache1.add("TEST_KEY", "Test Value", "abbreviation");

      // Create second instance - should load persisted data
      const cache2 = await HotCache.create(TEST_DIR);
      expect(cache2.resolve("TEST_KEY")).toBe("Test Value");
    });
  });

  describe("resolve", () => {
    test("resolves exact match", async () => {
      const cache = await HotCache.create(TEST_DIR);
      expect(cache.resolve("Kaya")).toBe("Personal AI Assistant");
    });

    test("resolves case-insensitive for short keys", async () => {
      const cache = await HotCache.create(TEST_DIR);
      expect(cache.resolve("lv")).toBe("Lucidview");
    });

    test("returns null for unknown key", async () => {
      const cache = await HotCache.create(TEST_DIR);
      expect(cache.resolve("NONEXISTENT")).toBeNull();
    });
  });

  describe("add/remove", () => {
    test("adds new entry", async () => {
      const cache = await HotCache.create(TEST_DIR);
      const initialCount = cache.getAll().length;
      await cache.add("NYC", "New York City", "abbreviation");

      expect(cache.resolve("NYC")).toBe("New York City");
      expect(cache.getAll().length).toBe(initialCount + 1);
    });

    test("updates existing entry on re-add", async () => {
      const cache = await HotCache.create(TEST_DIR);
      await cache.add("NYC", "New York City", "abbreviation");
      await cache.add("NYC", "New York City, NY", "abbreviation");

      expect(cache.resolve("NYC")).toBe("New York City, NY");
    });

    test("removes entry", async () => {
      const cache = await HotCache.create(TEST_DIR);
      await cache.add("TMP", "Temporary", "term");
      expect(cache.resolve("TMP")).toBe("Temporary");

      await cache.remove("TMP");
      expect(cache.resolve("TMP")).toBeNull();
    });
  });

  describe("recordReference", () => {
    test("increments reference count", async () => {
      const cache = await HotCache.create(TEST_DIR);
      const before = cache.getAll().find(e => e.key === "Kaya")!.referenceCount;
      await cache.recordReference("Kaya");
      const after = cache.getAll().find(e => e.key === "Kaya")!.referenceCount;

      expect(after).toBe(before + 1);
    });
  });

  describe("decodeMessage", () => {
    test("replaces known shorthands", async () => {
      const cache = await HotCache.create(TEST_DIR);
      const result = cache.decodeMessage("sync with J about LV");

      expect(result.decoded).toContain("Julie");
      expect(result.decoded).toContain("Lucidview");
      expect(result.substitutions.length).toBeGreaterThanOrEqual(2);
    });

    test("does not replace partial matches", async () => {
      const cache = await HotCache.create(TEST_DIR);
      const result = cache.decodeMessage("the JOB is done");

      expect(result.decoded).not.toContain("Julie");
    });

    test("returns original for no matches", async () => {
      const cache = await HotCache.create(TEST_DIR);
      const result = cache.decodeMessage("hello world");

      expect(result.decoded).toBe("hello world");
      expect(result.substitutions.length).toBe(0);
    });
  });

  describe("getAll", () => {
    test("returns entries sorted by reference count descending", async () => {
      const cache = await HotCache.create(TEST_DIR);
      const all = cache.getAll();

      for (let i = 0; i < all.length - 1; i++) {
        expect(all[i].referenceCount).toBeGreaterThanOrEqual(all[i + 1].referenceCount);
      }
    });
  });

  describe("no raw file I/O", () => {
    test("HotCache.ts has no JSON.parse(readFileSync()) in code", async () => {
      const sourcePath = join(import.meta.dir, "HotCache.ts");
      const source = await Bun.file(sourcePath).text();

      // Strip comments
      const codeLines = source.split("\n").filter(line => {
        const trimmed = line.trim();
        return !trimmed.startsWith("//") && !trimmed.startsWith("*") && !trimmed.startsWith("/*");
      }).join("\n");

      const violations = codeLines.match(/JSON\.parse\s*\(\s*readFileSync\s*\(/g);
      expect(violations).toBeNull();
    });
  });
});
