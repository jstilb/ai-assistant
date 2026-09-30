#!/usr/bin/env bun
/**
 * PipelineUpsertGuard.test.ts — Tests for transition-aware upsert() (ENFORCE MODE, default)
 *
 * upsert() (skills/Automation/QueueRouter/Tools/PipelineRepository.ts) historically wrote
 * any stage value with zero validation — the only enforcement point was transition().
 * Slice A2 made upsert() transition-AWARE in SHADOW mode (log-but-allow). A clean shadow
 * cycle in production (zero production-id shadow entries in failure-log.jsonl) cleared the
 * way to flip the default to ENFORCE:
 *
 *   - Same-stage patch            → always legal, no event, no log (ubiquitous re-save path)
 *   - New-item creation           → always legal, writes a creation event (from_stage NULL)
 *   - Legal stage-crossing        → proceeds, writes an event (note: "shadow-legal")
 *   - Illegal stage-crossing      → ENFORCE (default): rolls back + throws, no write, no event
 *                                  → SHADOW (opt-out via KAYA_PIPELINE_TRANSITION_ENFORCE=0 or
 *                                    { enforce: false }): still writes (zero regression),
 *                                    logs via recordFailure, writes an event (note: "shadow-illegal")
 *                                  → explicit { enforce: ... } always wins over the env var.
 *
 * All tests pin KAYA_HOME to a fresh mkdtemp directory so they NEVER touch the live
 * ~/.kaya/runtime/pipeline.db or the live failure-log.jsonl.
 */

import { describe, test, expect, afterAll, afterEach } from "bun:test";
import { join } from "path";
import { existsSync, readFileSync } from "fs";
import { pinKayaHome, restoreKayaHome } from "../../../../lib/test/pinKayaHome.ts";

// ============================================================================
// KAYA_HOME isolation — set BEFORE any import that reads the env
// ============================================================================

const TEST_BASE = pinKayaHome("pipeline-upsert-guard-test-");

// Now safe to import repository code
import {
  PipelineRepository,
  resetPipelineRepository,
  generatePipelineId,
  type PipelineItem,
  type Stage,
} from "./PipelineRepository.ts";
import { resetPipelineDb } from "./PipelineDB.ts";

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

// failure-log.jsonl lives directly under KAYA_HOME (NOT under KAYA_HOME/.kaya —
// that's the pipeline.db root; a different convention, see PipelineIntegrity.ts).
const FAILURE_LOG_PATH = join(TEST_BASE, "MEMORY", "MONITORING", "failure-log.jsonl");

function readFailureLogLines(): Array<{ source: string; context: Record<string, unknown> }> {
  if (!existsSync(FAILURE_LOG_PATH)) return [];
  return readFileSync(FAILURE_LOG_PATH, "utf-8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

// ============================================================================
// Lifecycle
// ============================================================================

afterAll(async () => {
  resetPipelineRepository();
  await restoreKayaHome();
});

afterEach(() => {
  delete process.env.KAYA_PIPELINE_TRANSITION_ENFORCE;
});

// ============================================================================
// 1. Same-stage patches — always legal, no event, no log
// ============================================================================

describe("1. same-stage upsert (patch)", () => {
  const dbPath = join(TEST_BASE, ".kaya", "runtime", "upsert-guard-samestage.db");
  const repo = new PipelineRepository(dbPath);
  afterAll(() => resetPipelineDb(dbPath));

  test("patching a stage with NO self-loop entry in ALLOWED_TRANSITIONS succeeds with no event", () => {
    // revision-needed has no self-loop in ALLOWED_TRANSITIONS — this is the exact
    // shape of saveQueueItemsImpl's ubiquitous re-save-the-whole-queue pattern.
    const item = repo.upsert(makeItem({ stage: "revision-needed", title: "v1" }));
    expect(item.stage).toBe("revision-needed");

    const rawDb = (repo as unknown as { db: import("bun:sqlite").Database }).db;
    const eventsAfterCreate = rawDb.prepare("SELECT * FROM pipeline_events WHERE item_id = ?").all(item.id) as EventRow[];
    expect(eventsAfterCreate.length).toBe(1); // the creation event only

    const patched = repo.upsert({ id: item.id, stage: "revision-needed", title: "v2" });
    expect(patched.stage).toBe("revision-needed");
    expect(patched.title).toBe("v2");

    const eventsAfterPatch = rawDb.prepare("SELECT * FROM pipeline_events WHERE item_id = ?").all(item.id) as EventRow[];
    expect(eventsAfterPatch.length).toBe(1); // unchanged — no new event from the patch

    expect(readFailureLogLines().length).toBe(0);
  });

  test("patching with stage omitted entirely (defaults to existing stage) writes no event", () => {
    const item = repo.upsert(makeItem({ stage: "needs-review", title: "v1" }));
    const rawDb = (repo as unknown as { db: import("bun:sqlite").Database }).db;
    const before = rawDb.prepare("SELECT * FROM pipeline_events WHERE item_id = ?").all(item.id) as EventRow[];

    const patched = repo.upsert({ id: item.id, title: "v2" }); // no `stage` key at all
    expect(patched.stage).toBe("needs-review");
    expect(patched.title).toBe("v2");

    const after = rawDb.prepare("SELECT * FROM pipeline_events WHERE item_id = ?").all(item.id) as EventRow[];
    expect(after.length).toBe(before.length);
  });
});

// ============================================================================
// 2. New-item creation — always legal, writes a creation event
// ============================================================================

describe("2. new-item creation event", () => {
  const dbPath = join(TEST_BASE, ".kaya", "runtime", "upsert-guard-creation.db");
  const repo = new PipelineRepository(dbPath);
  afterAll(() => resetPipelineDb(dbPath));

  test("creating a new item writes one event with from_stage NULL, to_stage = initial stage", () => {
    const item = repo.upsert(makeItem({ stage: "approved" }));

    const rawDb = (repo as unknown as { db: import("bun:sqlite").Database }).db;
    const rows = rawDb.prepare("SELECT * FROM pipeline_events WHERE item_id = ?").all(item.id) as EventRow[];
    expect(rows.length).toBe(1);
    expect(rows[0].from_stage).toBeNull();
    expect(rows[0].to_stage).toBe("approved");
    expect(rows[0].note).toBe("creation");
  });

  test("creation event actor defaults to 'upsert' and is overridable", () => {
    const item1 = repo.upsert(makeItem({ stage: "intake" }));
    const rawDb = (repo as unknown as { db: import("bun:sqlite").Database }).db;
    const row1 = rawDb.prepare("SELECT actor FROM pipeline_events WHERE item_id = ?").get(item1.id) as { actor: string };
    expect(row1.actor).toBe("upsert");

    const item2 = repo.upsert(makeItem({ stage: "intake" }), { actor: "spec-pipeline-facade" });
    const row2 = rawDb.prepare("SELECT actor FROM pipeline_events WHERE item_id = ?").get(item2.id) as { actor: string };
    expect(row2.actor).toBe("spec-pipeline-facade");
  });
});

// ============================================================================
// 3. Legal stage-crossing — writes an event, note "shadow-legal"
// ============================================================================

describe("3. legal stage-crossing via upsert", () => {
  const dbPath = join(TEST_BASE, ".kaya", "runtime", "upsert-guard-legal.db");
  const repo = new PipelineRepository(dbPath);
  afterAll(() => resetPipelineDb(dbPath));

  test("intake -> researching (legal) proceeds and writes a shadow-legal event", () => {
    const item = repo.upsert(makeItem({ stage: "intake" }));
    const crossed = repo.upsert({ id: item.id, stage: "researching" });
    expect(crossed.stage).toBe("researching");

    const rawDb = (repo as unknown as { db: import("bun:sqlite").Database }).db;
    const rows = rawDb.prepare("SELECT * FROM pipeline_events WHERE item_id = ? AND from_stage IS NOT NULL").all(item.id) as EventRow[];
    expect(rows.length).toBe(1);
    expect(rows[0].from_stage).toBe("intake");
    expect(rows[0].to_stage).toBe("researching");
    expect(rows[0].note).toBe("shadow-legal");
    expect(rows[0].actor).toBe("upsert");

    expect(readFailureLogLines().length).toBe(0);
  });
});

// ============================================================================
// 4. Illegal stage-crossing — ENFORCE mode (default)
// ============================================================================

describe("4. illegal stage-crossing via upsert — enforce mode (default)", () => {
  const dbPath = join(TEST_BASE, ".kaya", "runtime", "upsert-guard-enforce-default.db");
  const repo = new PipelineRepository(dbPath);
  afterAll(() => resetPipelineDb(dbPath));

  test("done -> in-progress (illegal) throws by default, performs no write, writes no event, logs nothing", () => {
    const item = repo.upsert(makeItem({ stage: "done" }));
    const before = readFailureLogLines().length;

    expect(() => repo.upsert({ id: item.id, stage: "in-progress" }))
      .toThrow(/illegal transition "done" → "in-progress"/);

    const reread = repo.get(item.id);
    expect(reread?.stage).toBe("done"); // unchanged — rolled back

    const rawDb = (repo as unknown as { db: import("bun:sqlite").Database }).db;
    const rows = rawDb.prepare("SELECT * FROM pipeline_events WHERE item_id = ? AND from_stage IS NOT NULL").all(item.id) as EventRow[];
    expect(rows.length).toBe(0);

    // Enforce mode throws instead of logging — recordFailure is a shadow-mode-only path.
    expect(readFailureLogLines().length).toBe(before);
  });
});

// ============================================================================
// 5. Illegal stage-crossing — SHADOW mode (opt-out) + option/env precedence
// ============================================================================

describe("5. illegal stage-crossing via upsert — shadow opt-out + precedence", () => {
  const dbPath = join(TEST_BASE, ".kaya", "runtime", "upsert-guard-shadow-optout.db");
  const repo = new PipelineRepository(dbPath);
  afterAll(() => resetPipelineDb(dbPath));

  test("option override { enforce: false } opts into shadow mode: still writes (zero regression), logs, and records a shadow-illegal event", () => {
    const item = repo.upsert(makeItem({ stage: "done" }));
    const before = readFailureLogLines().length;

    const crossed = repo.upsert({ id: item.id, stage: "in-progress" }, { enforce: false });
    expect(crossed.stage).toBe("in-progress");

    const rawDb = (repo as unknown as { db: import("bun:sqlite").Database }).db;
    const rows = rawDb.prepare("SELECT * FROM pipeline_events WHERE item_id = ? AND from_stage IS NOT NULL").all(item.id) as EventRow[];
    expect(rows.length).toBe(1);
    expect(rows[0].from_stage).toBe("done");
    expect(rows[0].to_stage).toBe("in-progress");
    expect(rows[0].note).toBe("shadow-illegal");

    const lines = readFailureLogLines();
    expect(lines.length).toBe(before + 1);
    const entry = lines[lines.length - 1];
    expect(entry.source).toBe("PipelineRepository.upsert.shadow");
    expect(entry.context.id).toBe(item.id);
    expect(entry.context.from).toBe("done");
    expect(entry.context.to).toBe("in-progress");
  });

  test("env var KAYA_PIPELINE_TRANSITION_ENFORCE=0 restores shadow mode with no option override (emergency escape hatch)", () => {
    const item = repo.upsert(makeItem({ stage: "done" }));
    process.env.KAYA_PIPELINE_TRANSITION_ENFORCE = "0";

    const crossed = repo.upsert({ id: item.id, stage: "in-progress" });
    expect(crossed.stage).toBe("in-progress"); // shadow mode: write still proceeds

    const reread = repo.get(item.id);
    expect(reread?.stage).toBe("in-progress");
  });

  test("explicit { enforce: true } overrides env var KAYA_PIPELINE_TRANSITION_ENFORCE=0 (enforce wins)", () => {
    const item = repo.upsert(makeItem({ stage: "done" }));
    process.env.KAYA_PIPELINE_TRANSITION_ENFORCE = "0";

    expect(() => repo.upsert({ id: item.id, stage: "in-progress" }, { enforce: true }))
      .toThrow(/illegal transition "done" → "in-progress"/);

    const reread = repo.get(item.id);
    expect(reread?.stage).toBe("done"); // unchanged
  });

  test("explicit { enforce: false } overrides env var KAYA_PIPELINE_TRANSITION_ENFORCE=1 (shadow wins)", () => {
    const item = repo.upsert(makeItem({ stage: "done" }));
    process.env.KAYA_PIPELINE_TRANSITION_ENFORCE = "1";

    const crossed = repo.upsert({ id: item.id, stage: "in-progress" }, { enforce: false });
    expect(crossed.stage).toBe("in-progress"); // shadow mode: write still proceeds
  });

  test("enforce mode (default) does not block legal crossings", () => {
    const item = repo.upsert(makeItem({ stage: "intake" }));
    const crossed = repo.upsert({ id: item.id, stage: "researching" });
    expect(crossed.stage).toBe("researching");

    const rawDb = (repo as unknown as { db: import("bun:sqlite").Database }).db;
    const rows = rawDb.prepare("SELECT * FROM pipeline_events WHERE item_id = ? AND from_stage IS NOT NULL").all(item.id) as EventRow[];
    expect(rows.length).toBe(1);
    expect(rows[0].note).toBe("shadow-legal");
  });
});

// ============================================================================
// 6. Live path safety
// ============================================================================

describe("6. live path safety", () => {
  test("failure log used in this file lives under the pinned TEST_BASE, not live KAYA_HOME", () => {
    expect(FAILURE_LOG_PATH.startsWith(TEST_BASE)).toBe(true);
    expect(TEST_BASE).not.toBe(process.env.HOME);
  });
});
