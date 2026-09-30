#!/usr/bin/env bun
/**
 * PipelineDB.ts — SQLite Database Layer for the Unified Pipeline State Store
 *
 * Provides the transactional SQLite foundation for Kaya's autonomous-work pipeline.
 * Replaces three diverging JSON/JSONL file stores (WorkQueue, QueueManager, approval
 * queue) with a single WAL-mode SQLite database that eliminates last-writer-wins
 * race conditions on concurrent cron+session writes.
 *
 * Database: <KAYA_HOME>/.kaya/runtime/pipeline.db
 * Mode:     WAL (Write-Ahead Logging) for concurrent-access safety
 * Pattern:  mirrors TaskDB.ts exactly (busy_timeout → WAL → foreign_keys → schema)
 *
 * @module PipelineDB
 */

import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { defaultKayaHome } from "../../../../lib/core/KayaHome.ts";

// ============================================================================
// Path Resolution
// ============================================================================

/**
 * Resolved at CALL time, not module load.
 *
 * Test files repoint KAYA_HOME at temp dirs before importing; a load-time const
 * would capture whichever env happened to be set first in a shared-process test
 * run and silently route writes into the live DB (same bug as TaskDB pre-fix).
 *
 * Resolution rules — three tiers, checked in order:
 *
 *   1. KAYA_RUNTIME set → <KAYA_RUNTIME>/pipeline.db. Wins outright, matching
 *      runtimeDir()'s existing contract in lib/core/KayaHome.ts.
 *
 *   2. KAYA_HOME set AND equal to defaultKayaHome() (the real ~/.claude, i.e.
 *      the SAME value getKayaHome() would return with no env override —
 *      the production repo root) → treated as UNSET, falls through to
 *      ~/.kaya/runtime/pipeline.db.
 *      WHY: every Kaya launchd cron plist sets KAYA_HOME=<repo root> purely so
 *      tools can find the repo, NOT to relocate the out-of-repo runtime store
 *      (runtimeDir()'s docstring: "Out-of-repo so no branch checkout ... every
 *      concurrent worktree session + cron shares one live store"). Before this
 *      fix, that env collision silently resolved the WHOLE cron fleet onto a
 *      0-item decoy db at <repo root>/.kaya/runtime/pipeline.db, completely
 *      disconnected from the canonical ~/.kaya/runtime/pipeline.db that
 *      interactive sessions (KAYA_HOME unset) correctly resolve. Confirmed
 *      live 2026-07-02: WaitingOnJmNotifier cron's checkpoint sinceId was
 *      stuck at 0 across runs while 4 events existed in the canonical db, and
 *      the decoy's WAL -shm file was touched at exactly the cron cadence.
 *
 *   3. Any OTHER KAYA_HOME value (test scratch dirs, clone fixtures) keeps the
 *      original <KAYA_HOME>/.kaya/runtime/pipeline.db behavior — hundreds of
 *      existing tests pin KAYA_HOME for db isolation and depend on this.
 *
 * Tests pin KAYA_HOME to a mkdtemp dir, so the live ~/.kaya/runtime/ is
 * never touched during test runs.
 */
export function defaultPipelineDbPath(): string {
  if (process.env.KAYA_RUNTIME) {
    return join(process.env.KAYA_RUNTIME, "pipeline.db");
  }
  const envHome = process.env.KAYA_HOME;
  const isRepoRootCollision = envHome !== undefined && envHome === defaultKayaHome();
  const base = envHome && !isRepoRootCollision
    ? join(envHome, ".kaya")
    : join(process.env.HOME || "", ".kaya");
  return join(base, "runtime", "pipeline.db");
}

// ============================================================================
// BUSY Retry Helper (mirrors TaskDB.withRetry exactly)
// ============================================================================

/**
 * Wraps a synchronous SQLite operation with exponential backoff retry on SQLITE_BUSY.
 * Statement-level retry: avoids re-executing business logic (notifications, side effects)
 * that live in the command layer above this module.
 */
export function withRetry<T>(fn: () => T, maxRetries = 5): T {
  let lastErr: unknown;
  for (let i = 0; i < maxRetries; i++) {
    try {
      return fn();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes("SQLITE_BUSY")) throw err;
      lastErr = err;
      Bun.sleepSync(50 * Math.pow(2, i));
    }
  }
  throw lastErr;
}

// ============================================================================
// Schema
// ============================================================================

const PIPELINE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS pipeline_items (
    -- Identity
    id TEXT PRIMARY KEY,

    -- Stage (unified pipeline state machine)
    stage TEXT NOT NULL DEFAULT 'intake'
      CHECK(stage IN (
        'intake',
        'needs-grilling',
        'researching',
        'generating-spec',
        'revision-needed',
        'escalated',
        'awaiting-approval',
        'approved',
        'in-progress',
        'partial',
        'needs-review',
        'blocked',
        'done',
        'failed',
        'rejected',
        'archived'
      )),

    -- Scheduling / classification
    priority INTEGER NOT NULL DEFAULT 2 CHECK(priority BETWEEN 1 AND 3),
    source   TEXT,
    type     TEXT,
    queue    TEXT,
    title    TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',

    -- LucidTask cross-reference
    lucid_task_id TEXT,

    -- Spec linkage (first-class: queryable without JSON parsing)
    spec_id         TEXT,
    spec_path       TEXT,
    spec_status     TEXT,
    spec_approved_at TEXT,
    spec_approved_by TEXT,

    -- Dependency graph (JSON array of pipeline_item ids)
    dependencies TEXT NOT NULL DEFAULT '[]',

    -- Execution tracking
    started_at   TEXT,
    completed_at TEXT,
    result       TEXT,
    error        TEXT,

    -- Verification state (JSON blob — WorkItemVerification shape)
    verification TEXT,

    -- Work execution metadata
    project_path   TEXT,
    output_path    TEXT,
    worktree_path  TEXT,
    worktree_branch TEXT,

    -- Retry / cooldown
    retry_eligible_after TEXT,

    -- Opaque JSON blobs (parsed by callers; not query-filtered)
    metadata  TEXT NOT NULL DEFAULT '{}',
    context   TEXT NOT NULL DEFAULT '{}',
    attempts  TEXT NOT NULL DEFAULT '[]',
    progress  TEXT NOT NULL DEFAULT '{}',
    isc_rows  TEXT NOT NULL DEFAULT '[]',

    -- Audit
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_pipeline_stage    ON pipeline_items(stage);
  CREATE INDEX IF NOT EXISTS idx_pipeline_priority ON pipeline_items(priority);
  CREATE INDEX IF NOT EXISTS idx_pipeline_lucid    ON pipeline_items(lucid_task_id);
  CREATE INDEX IF NOT EXISTS idx_pipeline_spec_id  ON pipeline_items(spec_id);

  -- Append-only audit trail of every stage transition. Written transactionally
  -- by PipelineRepository.transition() — same BEGIN IMMEDIATE tx as the stage
  -- update on pipeline_items, so a transition and its event row always land
  -- (or roll back) together. from_stage is nullable to leave room for a future
  -- creation-event writer (upsert()); to_stage/actor/ts are always known.
  CREATE TABLE IF NOT EXISTS pipeline_events (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    item_id    TEXT NOT NULL,
    from_stage TEXT,
    to_stage   TEXT NOT NULL,
    actor      TEXT NOT NULL,
    note       TEXT,
    ts         TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_pipeline_events_item_id ON pipeline_events(item_id);
  CREATE INDEX IF NOT EXISTS idx_pipeline_events_ts      ON pipeline_events(ts);
`;

// Idempotent column additions for future migrations
// Add new columns here as the schema evolves — they're applied with a try/catch
// that ignores "duplicate column name" errors, so it's safe to run on every open.
const MIGRATION_COLUMNS: string[] = [
  // format: "table.column TYPE"
  // e.g. "pipeline_items.new_col TEXT"
  // (none yet — placeholder for future migrations)
];

// ============================================================================
// PipelineDB Class
// ============================================================================

export class PipelineDB {
  readonly db: Database;
  readonly path: string;

  constructor(dbPath: string = defaultPipelineDbPath()) {
    this.path = dbPath;

    if (dbPath !== ":memory:") {
      const dir = dirname(dbPath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
    }

    // Open the DB. The WAL switch below requires an exclusive lock; if the DB is
    // already in WAL mode (common case for an existing DB), `PRAGMA journal_mode=WAL`
    // is a no-op and returns "wal" without needing exclusive access. On a BRAND NEW
    // file, the switch needs exclusivity — so callers should ensure the DB is
    // initialized by a single process before concurrent workers open it.
    //
    // Retry pattern: set busy_timeout FIRST (TaskDB pattern), then attempt the WAL
    // switch with exponential backoff. Each retry closes + reopens the connection
    // because SQLITE_BUSY on PRAGMA journal_mode can leave the handle in a state
    // where retrying the same connection always fails immediately.
    let _db = new Database(dbPath);
    _db.exec("PRAGMA busy_timeout=8000");

    let walSet = false;
    for (let attempt = 0; attempt < 20 && !walSet; attempt++) {
      try {
        _db.exec("PRAGMA journal_mode=WAL");
        walSet = true;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!msg.includes("SQLITE_BUSY")) {
          _db.close();
          throw err;
        }
        _db.close();
        Bun.sleepSync(25 + 25 * attempt);
        _db = new Database(dbPath);
        _db.exec("PRAGMA busy_timeout=8000");
      }
    }
    if (!walSet) {
      _db.close();
      throw new Error("PipelineDB: could not set WAL mode after 20 retries");
    }

    this.db = _db;
    this.db.exec("PRAGMA foreign_keys=ON");
    this.db.exec("PRAGMA synchronous=NORMAL"); // safe with WAL; faster than FULL

    this.initSchema();
  }

  private initSchema(): void {
    this.db.exec(PIPELINE_SCHEMA);

    // Idempotent column migrations — "duplicate column name" is silently swallowed
    for (const colDef of MIGRATION_COLUMNS) {
      const [table, rest] = colDef.split(".");
      try {
        this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${rest}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!msg.includes("duplicate column name")) {
          throw new Error(`Schema migration failed for "${colDef}": ${msg}`);
        }
      }
    }
  }

  close(): void {
    this.db.close();
  }
}

// ============================================================================
// Singleton (keyed by resolved path, like TaskDB.getTaskDB)
// ============================================================================

const _instances = new Map<string, PipelineDB>();

/**
 * Returns a singleton PipelineDB keyed by resolved path.
 * Pinned at call time (not module load) — tests repoint KAYA_HOME before calling.
 */
export function getPipelineDb(dbPath?: string): PipelineDB {
  const resolvedPath = dbPath ?? defaultPipelineDbPath();
  let inst = _instances.get(resolvedPath);
  if (!inst) {
    inst = new PipelineDB(resolvedPath);
    _instances.set(resolvedPath, inst);
  }
  return inst;
}

/**
 * Close and evict the singleton for a given path.
 * Used by tests in afterAll to release file handles on the temp DB.
 */
export function resetPipelineDb(dbPath?: string): void {
  const resolvedPath = dbPath ?? defaultPipelineDbPath();
  const inst = _instances.get(resolvedPath);
  _instances.delete(resolvedPath);
  if (inst) {
    try {
      inst.close();
    } catch {
      /* handle may already be invalid */
    }
  }
}
