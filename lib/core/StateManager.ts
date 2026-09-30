#!/usr/bin/env bun
/**
 * StateManager.ts - Unified State Persistence Tool
 *
 * A generic, type-safe state persistence layer that consolidates redundant
 * state management patterns across Kaya skills. Provides atomic transactions,
 * schema validation, file locking, auto-backup, and watch capabilities.
 *
 * Features:
 *   - Generic TypeScript support with full type inference
 *   - Zod schema validation on load/save
 *   - Atomic transactions with rollback on error
 *   - File locking for concurrent access safety
 *   - Auto-backup before writes (optional)
 *   - Schema versioning for migrations
 *   - Default factory pattern for fresh state
 *   - Watch/subscribe to state changes
 *
 * Usage:
 *   import { createStateManager } from "./StateManager";
 *   import { z } from "zod";
 *
 *   const QueueSchema = z.object({
 *     items: z.array(z.string()),
 *     lastUpdated: z.string(),
 *   });
 *
 *   const manager = createStateManager({
 *     path: "/path/to/state.json",
 *     schema: QueueSchema,
 *     defaults: { items: [], lastUpdated: "" },
 *     backupOnWrite: true,
 *   });
 *
 *   // Simple operations
 *   const state = await manager.load();
 *   await manager.save({ ...state, items: [...state.items, "new"] });
 *
 *   // Atomic update
 *   await manager.update(s => ({ ...s, items: [...s.items, "item"] }));
 *
 *   // Transaction with auto-rollback
 *   await manager.transaction(s => {
 *     s.items.push("item");
 *     if (s.items.length > 100) throw new Error("Queue full");
 *     return s;
 *   });
 *
 * CLI:
 *   bun run StateManager.ts --test              # Run self-test
 *   bun run StateManager.ts --demo <path>       # Demo with test file
 *
 * @module StateManager
 * @version 1.0.0
 */

import { z } from "zod";
import { join, dirname, basename } from "path";
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync, watch as fsWatch, unlinkSync, openSync, writeSync, closeSync } from "fs";

// ============================================
// TYPES
// ============================================

/**
 * Options for creating a StateManager instance
 */
export interface StateManagerOptions<T> {
  /** Absolute path to the state file */
  path: string;
  /** Zod schema for validating state */
  schema: z.ZodSchema<T>;
  /** Default state or factory function to create defaults */
  defaults: T | (() => T);
  /** Optional schema version for migrations */
  version?: number;
  /** Create backup before each write (default: false) */
  backupOnWrite?: boolean;
  /** Directory for backups (defaults to same directory as state file) */
  backupDir?: string;
  /** Lock timeout in milliseconds (default: 5000) */
  lockTimeout?: number;
  /** Maximum number of backup files to retain (default: unlimited).
   *  When set, prunes oldest backups after each new backup is created.
   *  Recommended: 5 for frequently-written state, 10 for critical state. */
  maxBackups?: number;
}

/**
 * StateManager interface for managing persistent state
 */
export interface StateManager<T> {
  /**
   * Load state from file. Returns defaults if file doesn't exist.
   * @throws If file exists but is invalid JSON or fails schema validation
   */
  load(): Promise<T>;

  /**
   * Save state to file. Validates against schema before writing.
   * @throws If state fails schema validation
   */
  save(state: T): Promise<void>;

  /**
   * Atomic update: load -> transform -> save
   * @param fn Transform function (sync or async)
   * @returns The new state after transformation
   * @throws If transform throws or validation fails (state unchanged)
   */
  update(fn: (current: T) => T | Promise<T>): Promise<T>;

  /**
   * Transaction with automatic save and rollback on error
   * @param fn Transaction function that may modify state
   * @returns Result of transaction function
   * @throws If transaction throws (state rolled back)
   */
  transaction<R>(fn: (state: T) => R | Promise<R>): Promise<R>;

  /**
   * Create a timestamped backup of current state
   * @returns Path to the backup file
   */
  backup(): Promise<string>;

  /**
   * Watch for state changes
   * @param callback Called when state changes via this manager
   * @returns Unsubscribe function
   */
  watch(callback: (state: T) => void): () => void;

  /**
   * Get the configured file path
   */
  getPath(): string;

  /**
   * Check if state file exists
   */
  exists(): Promise<boolean>;
}

// ============================================
// INTERNAL HELPERS
// ============================================

/**
 * Simple file lock implementation using lock files
 */
class FileLock {
  private lockPath: string;
  private locked = false;
  private timeout: number;

  constructor(filePath: string, timeout: number) {
    this.lockPath = `${filePath}.lock`;
    this.timeout = timeout;
  }

  async acquire(): Promise<void> {
    const startTime = Date.now();

    while (true) {
      // Attempt atomic lock creation: O_CREAT|O_EXCL fails if file exists
      let acquired = false;
      try {
        // openSync with 'wx' flag = O_WRONLY|O_CREAT|O_EXCL — fails atomically if exists
        const fd = openSync(this.lockPath, 'wx');
        writeSync(fd, String(Date.now()));
        closeSync(fd);
        acquired = true;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
          // Unexpected error (e.g., EACCES, ENOENT for parent dir) — rethrow
          throw new Error(`Lock file error: ${(err as Error).message}`);
        }
        // EEXIST: lock held by another process — check if stale
      }

      if (acquired) {
        this.locked = true;
        return;
      }

      // Lock exists: check if stale
      try {
        const lockContent = readFileSync(this.lockPath, 'utf-8');
        const lockTime = parseInt(lockContent, 10);
        if (!isNaN(lockTime) && Date.now() - lockTime > this.timeout * 2) {
          // Stale lock — attempt removal. Another process may race us here;
          // if unlink succeeds, we loop back and try to acquire atomically.
          try { unlinkSync(this.lockPath); } catch { /* another process removed it */ }
        }
      } catch {
        // Lock file disappeared between our EEXIST error and this read — loop
      }

      if (Date.now() - startTime > this.timeout) {
        throw new Error(`Lock acquisition timeout after ${this.timeout}ms`);
      }

      await Bun.sleep(10);
    }
  }

  async release(): Promise<void> {
    if (this.locked && existsSync(this.lockPath)) {
      try {
        unlinkSync(this.lockPath);
      } catch {
        // Ignore - lock may have been cleaned up
      }
      this.locked = false;
    }
  }
}

/**
 * Ensure directory exists
 */
function ensureDir(dirPath: string): void {
  if (!existsSync(dirPath)) {
    mkdirSync(dirPath, { recursive: true });
  }
}

/**
 * Generate timestamped backup filename with sub-millisecond suffix for uniqueness.
 */
let _backupCounter = 0;
function generateBackupFilename(originalPath: string): string {
  const base = basename(originalPath, ".json");
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const suffix = (_backupCounter++ % 10000).toString().padStart(4, "0");
  return `${base}.${timestamp}-${suffix}.backup.json`;
}

/**
 * Deep clone an object
 */
function deepClone<T>(obj: T): T {
  return JSON.parse(JSON.stringify(obj));
}

// ============================================
// STATEMANAGER IMPLEMENTATION
// ============================================

/**
 * Internal StateManager implementation class
 */
class StateManagerImpl<T> implements StateManager<T> {
  private path: string;
  private schema: z.ZodSchema<T>;
  private defaults: T | (() => T);
  private version?: number;
  private backupOnWrite: boolean;
  private backupDir: string;
  private lockTimeout: number;
  private maxBackups?: number;
  private watchers: Set<(state: T) => void> = new Set();

  constructor(options: StateManagerOptions<T>) {
    this.path = options.path;
    this.schema = options.schema;
    this.defaults = options.defaults;
    this.version = options.version;
    this.backupOnWrite = options.backupOnWrite ?? false;
    this.backupDir = options.backupDir ?? dirname(options.path);
    this.lockTimeout = options.lockTimeout ?? 5000;
    this.maxBackups = options.maxBackups;
  }

  private getDefaults(): T {
    return typeof this.defaults === "function"
      ? (this.defaults as () => T)()
      : deepClone(this.defaults);
  }

  async load(): Promise<T> {
    ensureDir(dirname(this.path));

    if (!existsSync(this.path)) {
      return this.getDefaults();
    }

    const raw = readFileSync(this.path, "utf-8");
    if (raw.trim() === "") {
      throw new Error("State file is empty");
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      throw new Error(`Invalid JSON in state file: ${e instanceof Error ? e.message : e}`);
    }

    // Remove internal version field before validation
    const { _version, ...stateData } = parsed as Record<string, unknown>;

    // Validate against schema
    const result = this.schema.safeParse(stateData);
    if (!result.success) {
      throw new Error(`State validation failed: ${result.error.message}`);
    }

    return result.data;
  }

  async save(state: T): Promise<void> {
    // Validate before saving
    const result = this.schema.safeParse(state);
    if (!result.success) {
      throw new Error(`State validation failed: ${result.error.message}`);
    }

    ensureDir(dirname(this.path));

    // Create backup if enabled and file exists
    if (this.backupOnWrite && existsSync(this.path)) {
      await this.backup();
    }

    // Prepare state with version if specified
    const stateToSave = { ...state } as T & { _version?: number; lastUpdated?: string };
    if (this.version !== undefined) {
      stateToSave._version = this.version;
    }

    // Auto-set lastUpdated if field exists and is string type
    if ("lastUpdated" in stateToSave && typeof stateToSave.lastUpdated === "string") {
      stateToSave.lastUpdated = new Date().toISOString();
    }

    // Acquire lock for writing
    const lock = new FileLock(this.path, this.lockTimeout);
    try {
      await lock.acquire();
      writeFileSync(this.path, JSON.stringify(stateToSave, null, 2));
    } finally {
      await lock.release();
    }

    // Notify watchers
    this.notifyWatchers(result.data);
  }

  async update(fn: (current: T) => T | Promise<T>): Promise<T> {
    const lock = new FileLock(this.path, this.lockTimeout);

    try {
      await lock.acquire();

      // Load current state
      const current = await this.loadUnlocked();

      // Transform
      let newState: T;
      try {
        newState = await fn(current);
      } catch (e) {
        throw e; // Don't save if transform fails
      }

      // Validate and save
      const result = this.schema.safeParse(newState);
      if (!result.success) {
        throw new Error(`State validation failed: ${result.error.message}`);
      }

      // Backup if enabled and file exists
      if (this.backupOnWrite && existsSync(this.path)) {
        await this.backupUnlocked();
      }

      // Prepare state with version
      const stateToSave = { ...newState } as T & { _version?: number; lastUpdated?: string };
      if (this.version !== undefined) {
        stateToSave._version = this.version;
      }

      // Auto-set lastUpdated
      if ("lastUpdated" in stateToSave && typeof stateToSave.lastUpdated === "string") {
        stateToSave.lastUpdated = new Date().toISOString();
      }

      writeFileSync(this.path, JSON.stringify(stateToSave, null, 2));

      // Notify watchers
      this.notifyWatchers(result.data);

      return result.data;
    } finally {
      await lock.release();
    }
  }

  async transaction<R>(fn: (state: T) => R | Promise<R>): Promise<R> {
    const lock = new FileLock(this.path, this.lockTimeout);

    try {
      await lock.acquire();

      // Load current state and create backup
      const original = await this.loadUnlocked();
      const workingCopy = deepClone(original);

      let result: R;
      try {
        result = await fn(workingCopy);
      } catch (e) {
        // Transaction failed - don't save (rollback)
        throw e;
      }

      // Save if result is an object that could be state
      if (result !== null && result !== undefined && typeof result === "object" && !Array.isArray(result)) {
        const resultValidation = this.schema.safeParse(result);
        if (resultValidation.success) {
          // Result is valid state — save it
          const stateToSave = { ...result } as T & { _version?: number; lastUpdated?: string };
          if (this.version !== undefined) {
            stateToSave._version = this.version;
          }

          if ("lastUpdated" in stateToSave && typeof stateToSave.lastUpdated === "string") {
            stateToSave.lastUpdated = new Date().toISOString();
          }

          if (this.backupOnWrite && existsSync(this.path)) {
            await this.backupUnlocked();
          }

          writeFileSync(this.path, JSON.stringify(stateToSave, null, 2));
          this.notifyWatchers(resultValidation.data);
        } else {
          // Transaction returned a modified object that fails schema — this is a data integrity error.
          // Throw explicitly so callers know the write did not happen.
          throw new Error(
            `transaction() result failed schema validation and was not saved. ` +
            `Validation error: ${resultValidation.error.message}. ` +
            `If your transaction intentionally returns a non-state value, ensure it is a primitive, ` +
            `array, or null rather than an object with the same shape as state.`
          );
        }
      }

      return result;
    } finally {
      await lock.release();
    }
  }

  async backup(): Promise<string> {
    const lock = new FileLock(this.path, this.lockTimeout);
    try {
      await lock.acquire();
      return await this.backupUnlocked();
    } finally {
      await lock.release();
    }
  }

  private async backupUnlocked(): Promise<string> {
    ensureDir(this.backupDir);

    if (!existsSync(this.path)) {
      throw new Error("Cannot backup: state file does not exist");
    }

    const backupFilename = generateBackupFilename(this.path);
    const backupPath = join(this.backupDir, backupFilename);

    const content = readFileSync(this.path, "utf-8");
    writeFileSync(backupPath, content);

    // Prune old backups if maxBackups is set
    if (this.maxBackups !== undefined) {
      this.pruneBackups();
    }

    return backupPath;
  }

  /** Prune backup files, keeping only the `maxBackups` newest. Best-effort: ignores race errors. */
  private pruneBackups(): void {
    if (this.maxBackups === undefined) return;

    const base = basename(this.path, ".json");
    // Escape special regex chars in basename
    const escapedBase = base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const backupPattern = new RegExp(`^${escapedBase}\\..*\\.backup\\.json$`);

    let allFiles: string[];
    try {
      allFiles = readdirSync(this.backupDir);
    } catch {
      return; // backup dir doesn't exist yet — no-op
    }

    const backupFiles = allFiles
      .filter(f => backupPattern.test(f))
      .map(f => {
        const fullPath = join(this.backupDir, f);
        let mtime = 0;
        try { mtime = statSync(fullPath).mtime.getTime(); } catch { /* ignore */ }
        return { name: f, path: fullPath, mtime };
      })
      .sort((a, b) => b.mtime - a.mtime); // newest first

    const toDelete = backupFiles.slice(this.maxBackups);
    for (const file of toDelete) {
      try { unlinkSync(file.path); } catch { /* ignore race — another process may have removed it */ }
    }
  }

  private async loadUnlocked(): Promise<T> {
    ensureDir(dirname(this.path));

    if (!existsSync(this.path)) {
      return this.getDefaults();
    }

    const raw = readFileSync(this.path, "utf-8");
    if (raw.trim() === "") {
      return this.getDefaults();
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return this.getDefaults();
    }

    const { _version, ...stateData } = parsed as Record<string, unknown>;
    const result = this.schema.safeParse(stateData);

    return result.success ? result.data : this.getDefaults();
  }

  watch(callback: (state: T) => void): () => void {
    this.watchers.add(callback);
    return () => {
      this.watchers.delete(callback);
    };
  }

  private notifyWatchers(state: T): void {
    for (const watcher of this.watchers) {
      try {
        watcher(state);
      } catch (e) {
        console.error("Watcher error:", e);
      }
    }
  }

  getPath(): string {
    return this.path;
  }

  async exists(): Promise<boolean> {
    return existsSync(this.path);
  }
}

// ============================================
// FACTORY FUNCTION
// ============================================

/**
 * Create a new StateManager instance
 *
 * @param options Configuration options
 * @returns StateManager instance
 *
 * @example
 * ```typescript
 * import { z } from "zod";
 * import { createStateManager } from "./StateManager";
 *
 * const QueueSchema = z.object({
 *   items: z.array(z.string()),
 *   count: z.number(),
 * });
 *
 * const manager = createStateManager({
 *   path: "/path/to/queue.json",
 *   schema: QueueSchema,
 *   defaults: { items: [], count: 0 },
 *   backupOnWrite: true,
 * });
 *
 * // Use the manager
 * const state = await manager.load();
 * await manager.update(s => ({ ...s, count: s.count + 1 }));
 * ```
 */
export function createStateManager<T>(options: StateManagerOptions<T>): StateManager<T> {
  return new StateManagerImpl(options);
}

// ============================================
// CLI INTERFACE
// ============================================

async function runSelfTest(): Promise<void> {
  const TEST_DIR = "/tmp/statemanager-self-test";
  const TEST_FILE = join(TEST_DIR, "test-state.json");

  console.log("Running StateManager self-test...\n");

  // Setup
  if (existsSync(TEST_DIR)) {
    const fs = await import("fs");
    fs.rmSync(TEST_DIR, { recursive: true });
  }
  mkdirSync(TEST_DIR, { recursive: true });

  const TestSchema = z.object({
    count: z.number(),
    items: z.array(z.string()),
    lastUpdated: z.string().optional(),
  });

  const manager = createStateManager({
    path: TEST_FILE,
    schema: TestSchema,
    defaults: { count: 0, items: [] },
    version: 1,
    backupOnWrite: true,
    backupDir: join(TEST_DIR, "backups"),
  });

  let passed = 0;
  let failed = 0;

  const test = async (name: string, fn: () => Promise<void>) => {
    try {
      await fn();
      console.log(`  [PASS] ${name}`);
      passed++;
    } catch (e) {
      console.log(`  [FAIL] ${name}`);
      console.log(`         ${e instanceof Error ? e.message : e}`);
      failed++;
    }
  };

  // Tests
  await test("load() returns defaults when file missing", async () => {
    const state = await manager.load();
    if (state.count !== 0) throw new Error(`Expected count=0, got ${state.count}`);
    if (state.items.length !== 0) throw new Error("Expected empty items");
  });

  await test("save() writes state to file", async () => {
    await manager.save({ count: 42, items: ["a", "b"] });
    const state = await manager.load();
    if (state.count !== 42) throw new Error(`Expected count=42, got ${state.count}`);
    if (state.items.length !== 2) throw new Error("Expected 2 items");
  });

  await test("update() transforms state atomically", async () => {
    const result = await manager.update((s) => ({
      ...s,
      count: s.count + 10,
      items: [...s.items, "c"],
    }));
    if (result.count !== 52) throw new Error(`Expected count=52, got ${result.count}`);
    if (result.items.length !== 3) throw new Error("Expected 3 items");
  });

  await test("transaction() saves modified state", async () => {
    await manager.transaction((s) => {
      s.items.push("d");
      return s;
    });
    const state = await manager.load();
    if (!state.items.includes("d")) throw new Error("Item 'd' not found");
  });

  await test("backup() creates timestamped backup", async () => {
    const backupPath = await manager.backup();
    if (!existsSync(backupPath)) throw new Error("Backup file not created");
    if (!backupPath.includes("backup")) throw new Error("Backup path incorrect");
  });

  await test("exists() returns correct status", async () => {
    if (!(await manager.exists())) throw new Error("File should exist");
  });

  await test("getPath() returns configured path", async () => {
    if (manager.getPath() !== TEST_FILE) throw new Error("Path mismatch");
  });

  await test("watch() notifies on save", async () => {
    let notified = false;
    const unsub = manager.watch(() => {
      notified = true;
    });
    await manager.save({ count: 100, items: [] });
    unsub();
    if (!notified) throw new Error("Watcher not notified");
  });

  await test("version is stored in file", async () => {
    const raw = JSON.parse(readFileSync(TEST_FILE, "utf-8"));
    if (raw._version !== 1) throw new Error(`Expected _version=1, got ${raw._version}`);
  });

  // Cleanup
  const fs = await import("fs");
  fs.rmSync(TEST_DIR, { recursive: true });

  // Summary
  console.log(`\nResults: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

async function runDemo(path: string): Promise<void> {
  console.log(`Demo: Managing state at ${path}\n`);

  const DemoSchema = z.object({
    counter: z.number(),
    messages: z.array(z.string()),
  });

  const manager = createStateManager({
    path,
    schema: DemoSchema,
    defaults: { counter: 0, messages: [] },
  });

  console.log("1. Loading state...");
  const initial = await manager.load();
  console.log(`   Current state: ${JSON.stringify(initial)}`);

  console.log("\n2. Updating counter...");
  const updated = await manager.update((s) => ({
    ...s,
    counter: s.counter + 1,
    messages: [...s.messages, `Updated at ${new Date().toISOString()}`],
  }));
  console.log(`   New state: ${JSON.stringify(updated)}`);

  console.log("\n3. State persisted to:", manager.getPath());
}

// CLI handling
if (import.meta.main) {
  const args = process.argv.slice(2);

  if (args.includes("--help") || args.includes("-h")) {
    console.log(`
StateManager - Unified State Persistence Tool

Usage:
  bun run StateManager.ts --test           Run self-tests
  bun run StateManager.ts --demo <path>    Demo with a test file
  bun run StateManager.ts --help           Show this help

Features:
  - Generic TypeScript with Zod schema validation
  - Atomic transactions with rollback
  - File locking for concurrent access
  - Auto-backup on write
  - Schema versioning support
  - Watch/subscribe to changes

Example usage in code:
  import { createStateManager } from "./StateManager";
  import { z } from "zod";

  const schema = z.object({ count: z.number() });
  const manager = createStateManager({
    path: "/path/to/state.json",
    schema,
    defaults: { count: 0 },
  });

  const state = await manager.load();
  await manager.update(s => ({ count: s.count + 1 }));
`);
    process.exit(0);
  }

  if (args.includes("--test")) {
    await runSelfTest();
  } else if (args.includes("--demo")) {
    const pathIndex = args.indexOf("--demo") + 1;
    const demoPath = args[pathIndex] || "/tmp/statemanager-demo.json";
    await runDemo(demoPath);
  } else {
    console.log("Use --help for usage information.");
    console.log("Use --test to run self-tests.");
  }
}
