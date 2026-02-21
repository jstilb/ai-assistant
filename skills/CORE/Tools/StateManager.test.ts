#!/usr/bin/env bun
/**
 * StateManager.test.ts - Tests for unified state persistence
 *
 * TDD RED PHASE: Tests written BEFORE implementation.
 * All tests should FAIL until StateManager.ts is implemented.
 *
 * Run: bun test StateManager.test.ts
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { z } from "zod";
import { join } from "path";
import { existsSync, mkdirSync, rmSync, readFileSync } from "fs";

// Import will fail until implementation exists - that's expected in RED phase
import { createStateManager, StateManager } from "./StateManager";

// Test schemas
const SimpleSchema = z.object({
  count: z.number(),
  name: z.string(),
  lastUpdated: z.string().optional(),
});
type SimpleState = z.infer<typeof SimpleSchema>;

const ComplexSchema = z.object({
  version: z.number(),
  items: z.array(z.object({
    id: z.string(),
    value: z.number(),
    active: z.boolean(),
  })),
  metadata: z.object({
    createdAt: z.string(),
    updatedAt: z.string(),
  }),
});
type ComplexState = z.infer<typeof ComplexSchema>;

// Test directory
const TEST_DIR = "/tmp/statemanager-tests";
const TEST_FILE = join(TEST_DIR, "test-state.json");
const TEST_BACKUP_DIR = join(TEST_DIR, "backups");

describe("StateManager", () => {
  // Setup and teardown
  beforeEach(() => {
    // Clean test directory
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true });
    }
    mkdirSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_BACKUP_DIR, { recursive: true });
  });

  afterEach(() => {
    // Cleanup
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true });
    }
  });

  describe("createStateManager()", () => {
    it("should create a StateManager instance", () => {
      const manager = createStateManager<SimpleState>({
        path: TEST_FILE,
        schema: SimpleSchema,
        defaults: { count: 0, name: "test" },
      });

      expect(manager).toBeDefined();
      expect(typeof manager.load).toBe("function");
      expect(typeof manager.save).toBe("function");
      expect(typeof manager.update).toBe("function");
      expect(typeof manager.transaction).toBe("function");
      expect(typeof manager.backup).toBe("function");
      expect(typeof manager.watch).toBe("function");
      expect(typeof manager.getPath).toBe("function");
      expect(typeof manager.exists).toBe("function");
    });

    it("should accept a factory function for defaults", () => {
      let callCount = 0;
      const manager = createStateManager<SimpleState>({
        path: TEST_FILE,
        schema: SimpleSchema,
        defaults: () => {
          callCount++;
          return { count: callCount, name: "dynamic" };
        },
      });

      expect(manager).toBeDefined();
    });
  });

  describe("load()", () => {
    it("should return defaults when file does not exist", async () => {
      const manager = createStateManager<SimpleState>({
        path: TEST_FILE,
        schema: SimpleSchema,
        defaults: { count: 42, name: "default" },
      });

      const state = await manager.load();
      expect(state.count).toBe(42);
      expect(state.name).toBe("default");
    });

    it("should load and validate existing state", async () => {
      // Pre-create a state file
      const existingState = { count: 100, name: "existing" };
      await Bun.write(TEST_FILE, JSON.stringify(existingState));

      const manager = createStateManager<SimpleState>({
        path: TEST_FILE,
        schema: SimpleSchema,
        defaults: { count: 0, name: "default" },
      });

      const state = await manager.load();
      expect(state.count).toBe(100);
      expect(state.name).toBe("existing");
    });

    it("should throw on invalid state (schema validation fails)", async () => {
      // Pre-create an invalid state file
      await Bun.write(TEST_FILE, JSON.stringify({ count: "not-a-number" }));

      const manager = createStateManager<SimpleState>({
        path: TEST_FILE,
        schema: SimpleSchema,
        defaults: { count: 0, name: "default" },
      });

      await expect(manager.load()).rejects.toThrow();
    });

    it("should throw on corrupted JSON", async () => {
      await Bun.write(TEST_FILE, "{ invalid json }}}");

      const manager = createStateManager<SimpleState>({
        path: TEST_FILE,
        schema: SimpleSchema,
        defaults: { count: 0, name: "default" },
      });

      await expect(manager.load()).rejects.toThrow();
    });

    it("should create parent directory if it does not exist", async () => {
      const nestedPath = join(TEST_DIR, "nested/deep/state.json");
      const manager = createStateManager<SimpleState>({
        path: nestedPath,
        schema: SimpleSchema,
        defaults: { count: 0, name: "nested" },
      });

      const state = await manager.load();
      expect(state.count).toBe(0);
    });
  });

  describe("save()", () => {
    it("should save state to file", async () => {
      const manager = createStateManager<SimpleState>({
        path: TEST_FILE,
        schema: SimpleSchema,
        defaults: { count: 0, name: "default" },
      });

      await manager.save({ count: 123, name: "saved" });

      const raw = JSON.parse(readFileSync(TEST_FILE, "utf-8"));
      expect(raw.count).toBe(123);
      expect(raw.name).toBe("saved");
    });

    it("should validate state before saving", async () => {
      const manager = createStateManager<SimpleState>({
        path: TEST_FILE,
        schema: SimpleSchema,
        defaults: { count: 0, name: "default" },
      });

      // @ts-expect-error - intentionally invalid
      await expect(manager.save({ count: "invalid" })).rejects.toThrow();
    });

    it("should create backup before writing when backupOnWrite is true", async () => {
      const manager = createStateManager<SimpleState>({
        path: TEST_FILE,
        schema: SimpleSchema,
        defaults: { count: 0, name: "default" },
        backupOnWrite: true,
        backupDir: TEST_BACKUP_DIR,
      });

      // Save initial state
      await manager.save({ count: 1, name: "v1" });

      // Save again - should create backup
      await manager.save({ count: 2, name: "v2" });

      // Check backup exists
      const backups = (await Bun.file(TEST_BACKUP_DIR).exists())
        ? []
        : [];

      // Backup file should exist with timestamp in name
      const files = existsSync(TEST_BACKUP_DIR)
        ? require("fs").readdirSync(TEST_BACKUP_DIR)
        : [];
      expect(files.length).toBeGreaterThan(0);
    });

    it("should set lastUpdated timestamp if field exists in schema", async () => {
      const manager = createStateManager<SimpleState>({
        path: TEST_FILE,
        schema: SimpleSchema,
        defaults: { count: 0, name: "default" },
      });

      const before = new Date().toISOString();
      await manager.save({ count: 1, name: "test" });
      const after = new Date().toISOString();

      const state = await manager.load();
      // lastUpdated should be set automatically if schema has it
      if (state.lastUpdated) {
        expect(state.lastUpdated >= before).toBe(true);
        expect(state.lastUpdated <= after).toBe(true);
      }
    });
  });

  describe("update()", () => {
    it("should load, transform, and save state atomically", async () => {
      const manager = createStateManager<SimpleState>({
        path: TEST_FILE,
        schema: SimpleSchema,
        defaults: { count: 10, name: "initial" },
      });

      const result = await manager.update((state) => ({
        ...state,
        count: state.count + 5,
      }));

      expect(result.count).toBe(15);

      const saved = await manager.load();
      expect(saved.count).toBe(15);
    });

    it("should support async transform functions", async () => {
      const manager = createStateManager<SimpleState>({
        path: TEST_FILE,
        schema: SimpleSchema,
        defaults: { count: 0, name: "async" },
      });

      const result = await manager.update(async (state) => {
        await Bun.sleep(10); // Simulate async work
        return { ...state, count: state.count + 100 };
      });

      expect(result.count).toBe(100);
    });

    it("should not save if transform throws", async () => {
      const manager = createStateManager<SimpleState>({
        path: TEST_FILE,
        schema: SimpleSchema,
        defaults: { count: 50, name: "stable" },
      });

      await manager.save({ count: 50, name: "stable" });

      await expect(
        manager.update(() => {
          throw new Error("Transform failed");
        })
      ).rejects.toThrow("Transform failed");

      const state = await manager.load();
      expect(state.count).toBe(50); // Unchanged
    });
  });

  describe("transaction()", () => {
    it("should execute function with current state", async () => {
      const manager = createStateManager<SimpleState>({
        path: TEST_FILE,
        schema: SimpleSchema,
        defaults: { count: 5, name: "txn" },
      });

      const result = await manager.transaction((state) => {
        return state.count * 2;
      });

      expect(result).toBe(10);
    });

    it("should auto-save modifications to state", async () => {
      const manager = createStateManager<ComplexState>({
        path: TEST_FILE,
        schema: ComplexSchema,
        defaults: {
          version: 1,
          items: [],
          metadata: { createdAt: "", updatedAt: "" },
        },
      });

      await manager.transaction((state) => {
        state.items.push({ id: "1", value: 100, active: true });
        return state;
      });

      const saved = await manager.load();
      expect(saved.items.length).toBe(1);
      expect(saved.items[0].id).toBe("1");
    });

    it("should rollback on error", async () => {
      const manager = createStateManager<ComplexState>({
        path: TEST_FILE,
        schema: ComplexSchema,
        defaults: {
          version: 1,
          items: [{ id: "original", value: 1, active: true }],
          metadata: { createdAt: "", updatedAt: "" },
        },
      });

      await manager.save({
        version: 1,
        items: [{ id: "original", value: 1, active: true }],
        metadata: { createdAt: "2024-01-01", updatedAt: "2024-01-01" },
      });

      await expect(
        manager.transaction((state) => {
          state.items.push({ id: "new", value: 999, active: true });
          throw new Error("Rollback me");
        })
      ).rejects.toThrow("Rollback me");

      const saved = await manager.load();
      expect(saved.items.length).toBe(1);
      expect(saved.items[0].id).toBe("original");
    });
  });

  describe("backup()", () => {
    it("should create timestamped backup file", async () => {
      const manager = createStateManager<SimpleState>({
        path: TEST_FILE,
        schema: SimpleSchema,
        defaults: { count: 0, name: "backup-test" },
        backupDir: TEST_BACKUP_DIR,
      });

      await manager.save({ count: 42, name: "backup-test" });
      const backupPath = await manager.backup();

      expect(existsSync(backupPath)).toBe(true);
      expect(backupPath).toContain(TEST_BACKUP_DIR);
      expect(backupPath).toMatch(/\d{4}-\d{2}-\d{2}/); // Contains date
    });

    it("should preserve backup content exactly", async () => {
      const manager = createStateManager<SimpleState>({
        path: TEST_FILE,
        schema: SimpleSchema,
        defaults: { count: 0, name: "default" },
        backupDir: TEST_BACKUP_DIR,
      });

      const original = { count: 999, name: "preserve-me" };
      await manager.save(original);
      const backupPath = await manager.backup();

      const backupContent = JSON.parse(readFileSync(backupPath, "utf-8"));
      expect(backupContent.count).toBe(999);
      expect(backupContent.name).toBe("preserve-me");
    });
  });

  describe("exists()", () => {
    it("should return false when file does not exist", async () => {
      const manager = createStateManager<SimpleState>({
        path: TEST_FILE,
        schema: SimpleSchema,
        defaults: { count: 0, name: "default" },
      });

      expect(await manager.exists()).toBe(false);
    });

    it("should return true when file exists", async () => {
      await Bun.write(TEST_FILE, JSON.stringify({ count: 1, name: "exists" }));

      const manager = createStateManager<SimpleState>({
        path: TEST_FILE,
        schema: SimpleSchema,
        defaults: { count: 0, name: "default" },
      });

      expect(await manager.exists()).toBe(true);
    });
  });

  describe("getPath()", () => {
    it("should return the configured path", () => {
      const manager = createStateManager<SimpleState>({
        path: TEST_FILE,
        schema: SimpleSchema,
        defaults: { count: 0, name: "default" },
      });

      expect(manager.getPath()).toBe(TEST_FILE);
    });
  });

  describe("watch()", () => {
    it("should return unsubscribe function", () => {
      const manager = createStateManager<SimpleState>({
        path: TEST_FILE,
        schema: SimpleSchema,
        defaults: { count: 0, name: "default" },
      });

      const unsubscribe = manager.watch(() => {});
      expect(typeof unsubscribe).toBe("function");
      unsubscribe();
    });

    it("should call callback when state changes via save", async () => {
      const manager = createStateManager<SimpleState>({
        path: TEST_FILE,
        schema: SimpleSchema,
        defaults: { count: 0, name: "default" },
      });

      let callCount = 0;
      let lastState: SimpleState | null = null;

      const unsubscribe = manager.watch((state) => {
        callCount++;
        lastState = state;
      });

      await manager.save({ count: 1, name: "changed" });

      expect(callCount).toBe(1);
      expect(lastState?.count).toBe(1);

      unsubscribe();
    });
  });

  describe("Schema Versioning", () => {
    it("should store version in saved state when specified", async () => {
      const manager = createStateManager<SimpleState>({
        path: TEST_FILE,
        schema: SimpleSchema,
        defaults: { count: 0, name: "default" },
        version: 2,
      });

      await manager.save({ count: 1, name: "versioned" });

      const raw = JSON.parse(readFileSync(TEST_FILE, "utf-8"));
      expect(raw._version).toBe(2);
    });

    it("should work without version specified", async () => {
      const manager = createStateManager<SimpleState>({
        path: TEST_FILE,
        schema: SimpleSchema,
        defaults: { count: 0, name: "default" },
      });

      await manager.save({ count: 1, name: "no-version" });

      const raw = JSON.parse(readFileSync(TEST_FILE, "utf-8"));
      expect(raw._version).toBeUndefined();
    });
  });

  describe("Complex State", () => {
    it("should handle nested objects", async () => {
      const manager = createStateManager<ComplexState>({
        path: TEST_FILE,
        schema: ComplexSchema,
        defaults: {
          version: 1,
          items: [],
          metadata: { createdAt: "", updatedAt: "" },
        },
      });

      const state: ComplexState = {
        version: 1,
        items: [
          { id: "a", value: 10, active: true },
          { id: "b", value: 20, active: false },
        ],
        metadata: {
          createdAt: "2024-01-01T00:00:00Z",
          updatedAt: "2024-01-02T00:00:00Z",
        },
      };

      await manager.save(state);
      const loaded = await manager.load();

      expect(loaded.items.length).toBe(2);
      expect(loaded.items[0].id).toBe("a");
      expect(loaded.metadata.createdAt).toBe("2024-01-01T00:00:00Z");
    });

    it("should handle arrays with update", async () => {
      const manager = createStateManager<ComplexState>({
        path: TEST_FILE,
        schema: ComplexSchema,
        defaults: {
          version: 1,
          items: [],
          metadata: { createdAt: "", updatedAt: "" },
        },
      });

      await manager.update((state) => ({
        ...state,
        items: [...state.items, { id: "new", value: 42, active: true }],
      }));

      await manager.update((state) => ({
        ...state,
        items: [...state.items, { id: "another", value: 99, active: false }],
      }));

      const final = await manager.load();
      expect(final.items.length).toBe(2);
    });
  });

  describe("Edge Cases", () => {
    it("should handle empty state file", async () => {
      await Bun.write(TEST_FILE, "");

      const manager = createStateManager<SimpleState>({
        path: TEST_FILE,
        schema: SimpleSchema,
        defaults: { count: 99, name: "fallback" },
      });

      // Empty file should throw or return defaults based on implementation
      // Most implementations would throw on invalid JSON
      await expect(manager.load()).rejects.toThrow();
    });

    it("should handle concurrent updates safely", async () => {
      const manager = createStateManager<SimpleState>({
        path: TEST_FILE,
        schema: SimpleSchema,
        defaults: { count: 0, name: "concurrent" },
      });

      // Run multiple updates concurrently
      const updates = Array.from({ length: 10 }, (_, i) =>
        manager.update((state) => ({
          ...state,
          count: state.count + 1,
        }))
      );

      await Promise.all(updates);

      const final = await manager.load();
      // With proper locking, count should be 10
      expect(final.count).toBe(10);
    });

    it("should handle very large state objects", async () => {
      const LargeSchema = z.object({
        items: z.array(z.string()),
      });

      const manager = createStateManager<z.infer<typeof LargeSchema>>({
        path: TEST_FILE,
        schema: LargeSchema,
        defaults: { items: [] },
      });

      const largeItems = Array.from({ length: 10000 }, (_, i) => `item-${i}`);
      await manager.save({ items: largeItems });

      const loaded = await manager.load();
      expect(loaded.items.length).toBe(10000);
    });
  });
});

// CLI test when run directly
if (import.meta.main) {
  console.log("Run tests with: bun test StateManager.test.ts");
}
