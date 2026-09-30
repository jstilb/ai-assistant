#!/usr/bin/env bun
/**
 * PipelineEvents.test.ts — Tests for the pipeline_events append-only audit table (slice A1)
 *
 * All tests pin KAYA_HOME to a fresh mkdtemp directory so they NEVER touch
 * the live ~/.kaya/runtime/pipeline.db.
 *
 * Test groups:
 *   1. Fresh DB → pipeline_events exists with the right columns + indexes
 *   2. transition() writes exactly one event row (from/to/actor/note/ts) inside its tx
 *   3. Atomicity — a failed event insert rolls back the stage update in the same tx
 *   4. Illegal transition throws AND writes no event row
 *   5. Existing-db upgrade path — old schema (no pipeline_events) picks up the table on
 *      reopen via initSchema(), with existing pipeline_items rows intact
 */

import { describe, test, expect, afterAll } from "bun:test";
import { join } from "path";
import { mkdirSync } from "fs";
import { Database } from "bun:sqlite";
import { pinKayaHome, restoreKayaHome } from "../../../../lib/test/pinKayaHome.ts";

// ============================================================================
// KAYA_HOME isolation — set BEFORE any import that reads the env
// ============================================================================

const TEST_BASE = pinKayaHome("pipeline-events-test-");

// Now safe to import repository code
import { PipelineDB, getPipelineDb, resetPipelineDb } from "./PipelineDB.ts";
import {
  PipelineRepository,
  resetPipelineRepository,
  generatePipelineId,
  type PipelineItem,
  type Stage,
} from "./PipelineRepository.ts";

// ============================================================================
// Helpers
// ============================================================================

function makeItem(overrides: Partial<PipelineItem> & { id?: string } = {}): Partial<PipelineItem> & { id: string } {
  return {
    id: generatePipelineId(),
    title: "Test Item",
    description: "A test pipeline item",
    stage: "intake" as Stage,
    priority: 2,
    dependencies: [],
    metadata: {},
    context: {},
    attempts: [],
    progress: {},
    isc_rows: [],
    ...overrides,
  };
}

interface EventRow {
  id: number;
  item_id: string;
  from_stage: string | null;
  to_stage: string;
  actor: string;
  note: string | null;
  ts: string;
}

// ============================================================================
// Lifecycle
// ============================================================================

afterAll(async () => {
  resetPipelineRepository();
  await restoreKayaHome();
});

// ============================================================================
// 1. Schema
// ============================================================================

describe("1. pipeline_events — schema on fresh db", () => {
  const dbPath = join(TEST_BASE, ".kaya", "runtime", "pipeline-events-schema.db");

  test("fresh db creates pipeline_events with the right columns", () => {
    const pdb = new PipelineDB(dbPath);
    const cols = pdb.db.prepare("PRAGMA table_info(pipeline_events)").all() as Array<{
      name: string;
      notnull: number;
    }>;
    const names = cols.map((c) => c.name).sort();
    expect(names).toEqual(["actor", "from_stage", "id", "item_id", "note", "to_stage", "ts"].sort());

    const byName = Object.fromEntries(cols.map((c) => [c.name, c]));
    expect(byName.item_id.notnull).toBe(1);
    expect(byName.to_stage.notnull).toBe(1);
    expect(byName.actor.notnull).toBe(1);
    expect(byName.ts.notnull).toBe(1);
    expect(byName.from_stage.notnull).toBe(0);
    expect(byName.note.notnull).toBe(0);

    pdb.close();
  });

  test("fresh db creates the item_id and ts indexes", () => {
    const pdb = getPipelineDb(dbPath);
    const indexes = pdb.db.prepare("PRAGMA index_list(pipeline_events)").all() as Array<{ name: string }>;
    expect(indexes.some((i) => i.name === "idx_pipeline_events_item_id")).toBe(true);
    expect(indexes.some((i) => i.name === "idx_pipeline_events_ts")).toBe(true);
  });

  afterAll(() => { resetPipelineDb(dbPath); });
});

// ============================================================================
// 2-4. transition() writes
// ============================================================================

describe("2-4. pipeline_events — transition() writes", () => {
  const dbPath = join(TEST_BASE, ".kaya", "runtime", "pipeline-events-transition.db");
  const repo = new PipelineRepository(dbPath);

  afterAll(() => { resetPipelineDb(dbPath); });

  // Slice A2 made upsert() ALSO write an event (a "creation" event, from_stage
  // NULL) for every new item — makeItem()+upsert() below always creates a new
  // item, so it now writes its own event before transition() runs. These tests
  // are about transition()'s writes specifically, so queries scope to
  // "from_stage IS NOT NULL" (transition() always sets a non-null from_stage;
  // only upsert()'s creation events have a null one) to isolate that from the
  // separate, already-covered-by-PipelineUpsertGuard.test.ts creation event.

  test("legal transition writes exactly one event row with correct from/to/actor/note/ts", () => {
    const item = repo.upsert(makeItem({ stage: "intake" }));
    const before = Date.now();

    const result = repo.transition(item.id, "researching", { actor: "test-actor", note: "unit test" });
    expect(result.stage).toBe("researching");

    const rawDb = getPipelineDb(dbPath).db;
    const rows = rawDb
      .prepare("SELECT * FROM pipeline_events WHERE item_id = ? AND from_stage IS NOT NULL")
      .all(item.id) as EventRow[];

    expect(rows.length).toBe(1);
    expect(rows[0].from_stage).toBe("intake");
    expect(rows[0].to_stage).toBe("researching");
    expect(rows[0].actor).toBe("test-actor");
    expect(rows[0].note).toBe("unit test");
    expect(new Date(rows[0].ts).getTime()).toBeGreaterThanOrEqual(before - 1000);
  });

  test("actor defaults to 'unknown' and note to null when not provided", () => {
    const item = repo.upsert(makeItem({ stage: "intake" }));
    repo.transition(item.id, "researching");

    const rawDb = getPipelineDb(dbPath).db;
    const row = rawDb
      .prepare("SELECT actor, note FROM pipeline_events WHERE item_id = ? AND from_stage IS NOT NULL")
      .get(item.id) as { actor: string; note: string | null };

    expect(row.actor).toBe("unknown");
    expect(row.note).toBeNull();
  });

  test("illegal transition throws AND writes no event row", () => {
    const item = repo.upsert(makeItem({ stage: "done" }));
    expect(() => repo.transition(item.id, "in-progress")).toThrow(/illegal transition "done" → "in-progress"/);

    const rawDb = getPipelineDb(dbPath).db;
    const rows = rawDb.prepare("SELECT * FROM pipeline_events WHERE item_id = ? AND from_stage IS NOT NULL").all(item.id);
    expect(rows.length).toBe(0);

    // Stage must be unchanged too
    const reread = repo.get(item.id);
    expect(reread?.stage).toBe("done");
  });

  test("atomicity: a failed event insert rolls back the stage update in the same tx", () => {
    const item = repo.upsert(makeItem({ stage: "intake" }));
    const rawDb = getPipelineDb(dbPath).db;

    // Test-only seam: force the INSERT INTO pipeline_events to fail via a trigger,
    // simulating a failure that occurs AFTER the pipeline_items UPDATE has already
    // run inside transition()'s BEGIN IMMEDIATE tx. If both writes are truly atomic,
    // the whole transaction (including the already-executed UPDATE) must roll back.
    rawDb.exec(`
      CREATE TRIGGER IF NOT EXISTS test_events_fail_trigger
      BEFORE INSERT ON pipeline_events
      WHEN NEW.actor = '__TEST_FORCE_FAIL__'
      BEGIN
        SELECT RAISE(ABORT, 'SIMULATED_FAILURE_FOR_ATOMICITY_TEST');
      END;
    `);

    try {
      expect(() =>
        repo.transition(item.id, "researching", { actor: "__TEST_FORCE_FAIL__" })
      ).toThrow(/SIMULATED_FAILURE_FOR_ATOMICITY_TEST/);
    } finally {
      rawDb.exec("DROP TRIGGER IF EXISTS test_events_fail_trigger");
    }

    // The pipeline_items UPDATE that ran before the failed INSERT must have
    // been rolled back — stage is still "intake", not "researching".
    const reread = repo.get(item.id);
    expect(reread?.stage).toBe("intake");

    // And no event row should have landed either.
    const rows = rawDb.prepare("SELECT * FROM pipeline_events WHERE item_id = ? AND from_stage IS NOT NULL").all(item.id);
    expect(rows.length).toBe(0);
  });
});

// ============================================================================
// 5. Existing-db upgrade path
// ============================================================================

describe("5. pipeline_events — existing-db upgrade path", () => {
  const dbPath = join(TEST_BASE, ".kaya", "runtime", "pipeline-events-upgrade.db");

  test("old-schema db (no pipeline_events) gains the table on reopen; existing rows intact", () => {
    mkdirSync(join(TEST_BASE, ".kaya", "runtime"), { recursive: true });

    // Simulate a pre-slice-A1 database: only pipeline_items, no pipeline_events table.
    const oldDb = new Database(dbPath);
    oldDb.exec("PRAGMA journal_mode=WAL");
    oldDb.exec(`
      CREATE TABLE IF NOT EXISTS pipeline_items (
        id TEXT PRIMARY KEY,
        stage TEXT NOT NULL DEFAULT 'intake',
        priority INTEGER NOT NULL DEFAULT 2,
        source TEXT, type TEXT, queue TEXT,
        title TEXT NOT NULL DEFAULT '',
        description TEXT NOT NULL DEFAULT '',
        lucid_task_id TEXT,
        spec_id TEXT, spec_path TEXT, spec_status TEXT, spec_approved_at TEXT, spec_approved_by TEXT,
        dependencies TEXT NOT NULL DEFAULT '[]',
        started_at TEXT, completed_at TEXT, result TEXT, error TEXT,
        verification TEXT,
        project_path TEXT, output_path TEXT, worktree_path TEXT, worktree_branch TEXT,
        retry_eligible_after TEXT,
        metadata TEXT NOT NULL DEFAULT '{}',
        context TEXT NOT NULL DEFAULT '{}',
        attempts TEXT NOT NULL DEFAULT '[]',
        progress TEXT NOT NULL DEFAULT '{}',
        isc_rows TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
    oldDb.exec(`
      INSERT INTO pipeline_items (id, stage, title, description)
      VALUES ('pre-existing-1', 'intake', 'Pre-existing item', 'Should survive schema upgrade')
    `);

    const tablesBefore = oldDb.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>;
    expect(tablesBefore.some((t) => t.name === "pipeline_events")).toBe(false);
    oldDb.close();

    // Reopen through the real production code path — initSchema() must add
    // pipeline_events via CREATE TABLE IF NOT EXISTS with zero migration ceremony.
    const pdb = new PipelineDB(dbPath);
    const tablesAfter = pdb.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>;
    expect(tablesAfter.some((t) => t.name === "pipeline_events")).toBe(true);

    const row = pdb.db
      .prepare("SELECT * FROM pipeline_items WHERE id = ?")
      .get("pre-existing-1") as { id: string; title: string; description: string } | null;
    expect(row).not.toBeNull();
    expect(row?.title).toBe("Pre-existing item");
    expect(row?.description).toBe("Should survive schema upgrade");

    pdb.close();
  });
});
