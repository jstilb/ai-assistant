#!/usr/bin/env bun
/**
 * PipelineConcurrencyStress.test.ts — Multi-process concurrency stress test for
 * transition() + pipeline_events (slice A-close)
 *
 * Follows the Bun.spawn-worker stress idiom established in PipelineDB.test.ts
 * ("Test 1: Concurrent zero-lost-update"): real OS processes, not just async
 * interleavings within one process, so BEGIN IMMEDIATE + withRetry are exercised
 * against genuine cross-process SQLITE_BUSY contention.
 *
 * All tests pin KAYA_HOME to a fresh mkdtemp directory so they NEVER touch
 * the live ~/.kaya/runtime/pipeline.db.
 *
 * Test groups:
 *   1. N workers, N DISTINCT items, one legal transition each
 *        → exactly N event rows total, every item's stage correct, zero
 *          SQLITE_BUSY errors surfaced (withRetry absorbs contention)
 *   2. N workers racing the SAME item through the SAME legal transition
 *      (intake → researching; researching has no self-loop, so a second
 *      "→ researching" attempt after the first lands is illegal)
 *        → exactly ONE winner, the rest throw a clean "illegal transition"
 *          error (never a leaked SQLITE_BUSY / partial write), and exactly
 *          ONE event row exists for that item
 */

import { describe, test, expect, afterAll } from "bun:test";
import { tmpdir } from "os";
import { join } from "path";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "fs";

// ============================================================================
// KAYA_HOME isolation — set BEFORE any import that reads the env
// ============================================================================

const TEST_BASE = mkdtempSync(join(tmpdir(), "pipeline-concurrency-stress-"));
const ORIGINAL_KAYA_HOME = process.env.KAYA_HOME;
process.env.KAYA_HOME = TEST_BASE;

// Now safe to import repository code
import { PipelineRepository, resetPipelineRepository } from "./PipelineRepository.ts";
import { resetPipelineDb } from "./PipelineDB.ts";

// Absolute path to PipelineRepository.ts for worker scripts
const REPO_TS_PATH = join(import.meta.dir, "PipelineRepository.ts");

const WORKER_COUNT = 8;

afterAll(() => {
  resetPipelineRepository();
  // Restore KAYA_HOME — bun runs all test files in one process, so leaving it
  // pointed at the (deleted) temp dir poisons every later suite in the run.
  if (ORIGINAL_KAYA_HOME === undefined) delete process.env.KAYA_HOME;
  else process.env.KAYA_HOME = ORIGINAL_KAYA_HOME;
  try { rmSync(TEST_BASE, { recursive: true, force: true }); } catch { /* best-effort */ }
});

// ============================================================================
// 1. N distinct items, N workers, one legal transition each
// ============================================================================

describe("1. N workers × N distinct items — one legal transition each", () => {
  const DB_PATH = join(TEST_BASE, ".kaya", "runtime", "stress-distinct.db");
  const SCRIPT_PATH = join(TEST_BASE, "distinct-worker.ts");
  const itemIds = Array.from({ length: WORKER_COUNT }, (_, i) => `dist-item-${i}`);

  test(`${WORKER_COUNT} concurrent workers, ${WORKER_COUNT} distinct items: exactly ${WORKER_COUNT} events, correct stages, zero BUSY`, async () => {
    mkdirSync(join(TEST_BASE, ".kaya", "runtime"), { recursive: true });

    // Pre-seed items via raw SQL (NOT repo.upsert) so no "creation" events exist
    // yet — this makes "exactly N event rows total" an unambiguous assertion
    // about the workers' transitions alone, not conflated with upsert()'s A2
    // creation-event side effect.
    const seedRepo = new PipelineRepository(DB_PATH);
    const rawDb = (seedRepo as unknown as { db: import("bun:sqlite").Database }).db;
    const insertStmt = rawDb.prepare(
      "INSERT INTO pipeline_items (id, stage, title) VALUES (?, 'intake', ?)"
    );
    for (const id of itemIds) insertStmt.run(id, `Distinct stress item ${id}`);

    const eventsBeforeSpawn = (rawDb.prepare("SELECT COUNT(*) AS c FROM pipeline_events").get() as { c: number }).c;
    expect(eventsBeforeSpawn).toBe(0); // sanity: raw-SQL seeding writes no events

    resetPipelineDb(DB_PATH); // release the parent's handle before workers open their own

    // Worker: one process, one item, one legal transition (intake → researching).
    // NO try/catch — any thrown error (including a leaked SQLITE_BUSY) exits
    // the worker non-zero, which the test below asserts against.
    writeFileSync(SCRIPT_PATH, [
      "#!/usr/bin/env bun",
      `import { PipelineRepository } from ${JSON.stringify(REPO_TS_PATH)};`,
      "",
      "const dbPath = process.argv[2];",
      "const itemId = process.argv[3];",
      "const workerId = parseInt(process.argv[4] ?? '0');",
      "",
      "const repo = new PipelineRepository(dbPath);",
      "const t0 = performance.now();",
      "const result = repo.transition(itemId, 'researching', { actor: `dist-worker-${workerId}` });",
      "const durationMs = performance.now() - t0;",
      "",
      "console.log(JSON.stringify({ workerId, itemId, stage: result.stage, durationMs }));",
    ].join("\n"));

    const wallStart = performance.now();
    const workers = itemIds.map((id, i) =>
      Bun.spawn(["bun", SCRIPT_PATH, DB_PATH, id, String(i)], { stdout: "pipe", stderr: "pipe" })
    );

    const results = await Promise.all(
      workers.map(async (proc, i) => {
        const exitCode = await proc.exited;
        const stdout = await new Response(proc.stdout).text();
        const stderr = await new Response(proc.stderr).text();
        return { exitCode, stdout, stderr, workerId: i };
      })
    );
    const wallMs = performance.now() - wallStart;

    // STRONG ASSERTION: all workers exit 0 — a non-zero exit means an error
    // (e.g. a leaked SQLITE_BUSY) escaped withRetry inside transition().
    for (const r of results) {
      if (r.exitCode !== 0) console.error(`Worker ${r.workerId} stderr:\n${r.stderr}`);
      expect(r.exitCode).toBe(0);
    }

    // STRONG ASSERTION: zero SQLITE_BUSY / "database is locked" in any stderr.
    for (const r of results) {
      expect(r.stderr).not.toContain("database is locked");
      expect(r.stderr).not.toContain("SQLITE_BUSY");
    }

    const parsed = results.map((r) => JSON.parse(r.stdout.trim().split("\n").pop() as string) as {
      workerId: number; itemId: string; stage: string; durationMs: number;
    });

    // Every worker reports it landed on "researching".
    expect(parsed.every((p) => p.stage === "researching")).toBe(true);

    const verifyRepo = new PipelineRepository(DB_PATH);
    const verifyDb = (verifyRepo as unknown as { db: import("bun:sqlite").Database }).db;

    // STRONG ASSERTION: exactly N event rows total (one per worker's transition;
    // recall items were seeded via raw SQL, so no creation events pre-exist).
    const eventCount = (verifyDb.prepare("SELECT COUNT(*) AS c FROM pipeline_events").get() as { c: number }).c;
    expect(eventCount).toBe(WORKER_COUNT);

    // Every event is a legal intake→researching row for one of our seeded items.
    const eventRows = verifyDb.prepare("SELECT item_id, from_stage, to_stage FROM pipeline_events").all() as
      Array<{ item_id: string; from_stage: string; to_stage: string }>;
    for (const row of eventRows) {
      expect(itemIds).toContain(row.item_id);
      expect(row.from_stage).toBe("intake");
      expect(row.to_stage).toBe("researching");
    }
    // No two events share an item_id (each item transitioned exactly once).
    expect(new Set(eventRows.map((r) => r.item_id)).size).toBe(WORKER_COUNT);

    // STRONG ASSERTION: every item's stage is correct in pipeline_items.
    for (const id of itemIds) {
      const item = verifyRepo.get(id);
      expect(item?.stage).toBe("researching");
    }

    const durations = parsed.map((p) => p.durationMs);
    console.log(
      `Distinct-item stress PASSED: ${WORKER_COUNT} workers × 1 item each, ` +
      `wall=${wallMs.toFixed(1)}ms, per-worker durations(ms)=[${durations.map((d) => d.toFixed(1)).join(", ")}], ` +
      `events=${eventCount} (expected ${WORKER_COUNT}), 0 BUSY escapes`
    );

    resetPipelineDb(DB_PATH);
  }, 60_000);
});

// ============================================================================
// 2. N workers racing the SAME item through the SAME legal transition
// ============================================================================

describe("2. N workers racing the SAME item through the SAME legal transition", () => {
  const DB_PATH = join(TEST_BASE, ".kaya", "runtime", "stress-race-same-item.db");
  const SCRIPT_PATH = join(TEST_BASE, "race-same-item-worker.ts");
  const RACE_ITEM_ID = "race-item-0";

  test(
    `${WORKER_COUNT} workers racing intake→researching on ONE item: exactly 1 winner, ` +
    `clean thrown errors for the rest (not BUSY, not partial write), exactly 1 event row`,
    async () => {
      mkdirSync(join(TEST_BASE, ".kaya", "runtime"), { recursive: true });

      // Pre-seed ONE item via raw SQL — zero pre-existing events, so "exactly 1
      // event row" after the race is an unambiguous assertion.
      const seedRepo = new PipelineRepository(DB_PATH);
      const rawDb = (seedRepo as unknown as { db: import("bun:sqlite").Database }).db;
      rawDb.prepare("INSERT INTO pipeline_items (id, stage, title) VALUES (?, 'intake', ?)")
        .run(RACE_ITEM_ID, "Race stress item");
      resetPipelineDb(DB_PATH);

      // Worker: every worker attempts the SAME transition (intake → researching)
      // on the SAME item. Only the first to acquire the BEGIN IMMEDIATE lock
      // sees fromStage="intake" (legal); every subsequent worker sees
      // fromStage="researching", and "researching" has no self-loop in
      // ALLOWED_TRANSITIONS, so their attempt is illegal and transition()
      // throws BEFORE any write. The error is caught here (not left to crash
      // the worker) so the test can inspect its exact message.
      writeFileSync(SCRIPT_PATH, [
        "#!/usr/bin/env bun",
        `import { PipelineRepository } from ${JSON.stringify(REPO_TS_PATH)};`,
        "",
        "const dbPath = process.argv[2];",
        "const itemId = process.argv[3];",
        "const workerId = parseInt(process.argv[4] ?? '0');",
        "",
        "const repo = new PipelineRepository(dbPath);",
        "const t0 = performance.now();",
        "let success = false;",
        "let errorMessage: string | null = null;",
        "try {",
        "  repo.transition(itemId, 'researching', { actor: `race-worker-${workerId}` });",
        "  success = true;",
        "} catch (err) {",
        "  errorMessage = err instanceof Error ? err.message : String(err);",
        "}",
        "const durationMs = performance.now() - t0;",
        "",
        "console.log(JSON.stringify({ workerId, success, errorMessage, durationMs }));",
      ].join("\n"));

      const wallStart = performance.now();
      const workers = Array.from({ length: WORKER_COUNT }, (_, i) =>
        Bun.spawn(["bun", SCRIPT_PATH, DB_PATH, RACE_ITEM_ID, String(i)], { stdout: "pipe", stderr: "pipe" })
      );

      const results = await Promise.all(
        workers.map(async (proc, i) => {
          const exitCode = await proc.exited;
          const stdout = await new Response(proc.stdout).text();
          const stderr = await new Response(proc.stderr).text();
          return { exitCode, stdout, stderr, workerId: i };
        })
      );
      const wallMs = performance.now() - wallStart;

      // Every worker's script catches its own error, so ALL processes should
      // exit 0 regardless of whether their transition() call won or lost.
      for (const r of results) {
        if (r.exitCode !== 0) console.error(`Worker ${r.workerId} stderr:\n${r.stderr}`);
        expect(r.exitCode).toBe(0);
      }

      const parsed = results.map((r) => JSON.parse(r.stdout.trim().split("\n").pop() as string) as {
        workerId: number; success: boolean; errorMessage: string | null; durationMs: number;
      });

      const winners = parsed.filter((p) => p.success);
      const losers = parsed.filter((p) => !p.success);

      // STRONG ASSERTION: exactly one winner.
      if (winners.length !== 1) console.error("Winners:", JSON.stringify(winners));
      expect(winners.length).toBe(1);
      expect(losers.length).toBe(WORKER_COUNT - 1);

      // STRONG ASSERTION: every loser's failure is a CLEAN thrown "illegal
      // transition" error — never a leaked SQLITE_BUSY (which would indicate
      // withRetry gave up rather than the guard cleanly rejecting a re-entry).
      for (const loser of losers) {
        expect(loser.errorMessage).toBeTruthy();
        expect(loser.errorMessage).toMatch(/illegal transition "researching" → "researching"/);
        expect(loser.errorMessage).not.toContain("database is locked");
        expect(loser.errorMessage).not.toContain("SQLITE_BUSY");
      }

      const verifyRepo = new PipelineRepository(DB_PATH);
      const verifyDb = (verifyRepo as unknown as { db: import("bun:sqlite").Database }).db;

      // STRONG ASSERTION: no partial write — the item landed cleanly on
      // "researching" (the winner's target), nothing in between.
      const item = verifyRepo.get(RACE_ITEM_ID);
      expect(item?.stage).toBe("researching");

      // STRONG ASSERTION: exactly ONE event row exists for the item — losers'
      // transactions rolled back before the INSERT INTO pipeline_events ever
      // ran, so only the winner's event landed.
      const eventRows = verifyDb.prepare("SELECT * FROM pipeline_events WHERE item_id = ?").all(RACE_ITEM_ID) as
        Array<{ id: number; from_stage: string; to_stage: string; actor: string }>;
      expect(eventRows.length).toBe(1);
      expect(eventRows[0].from_stage).toBe("intake");
      expect(eventRows[0].to_stage).toBe("researching");

      const durations = parsed.map((p) => p.durationMs);
      console.log(
        `Same-item race PASSED: ${WORKER_COUNT} workers raced 1 item, wall=${wallMs.toFixed(1)}ms, ` +
        `winner=worker-${winners[0].workerId}, per-worker durations(ms)=[${durations.map((d) => d.toFixed(1)).join(", ")}], ` +
        `event_rows=${eventRows.length} (expected 1), 0 BUSY leaks, 0 partial writes`
      );

      resetPipelineDb(DB_PATH);
    },
    60_000
  );
});
