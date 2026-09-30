#!/usr/bin/env bun
/**
 * PipelineDB.test.ts — Tests for PipelineDB + PipelineRepository
 *
 * All tests pin KAYA_HOME to a fresh mkdtemp directory so they NEVER touch
 * the live ~/.kaya/runtime/pipeline.db.
 *
 * Test groups:
 *   1. Concurrent zero-lost-update (THE race proof) — strengthened: no swallowed errors,
 *      zero SQLITE_BUSY assertion, exact done count, 4-worker stress probe
 *   2. Transition matrix (legal moves succeed, illegal moves throw)
 *   3. integrity() self-audit
 *   4. Path isolation / KAYA_HOME pinning
 *   5. CRUD and list operations
 *   6. Live path safety (post-test assertion)
 */

import { describe, test, expect, beforeAll, afterAll, afterEach } from "bun:test";
import { tmpdir } from "os";
import { join } from "path";
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync } from "fs";

// ============================================================================
// KAYA_HOME isolation — set BEFORE any import that reads the env
// ============================================================================

const TEST_BASE = mkdtempSync(join(tmpdir(), "pipeline-test-"));
const TEST_KAYA_HOME = TEST_BASE;
process.env.KAYA_HOME = TEST_KAYA_HOME;

// Now safe to import repository code
import {
  defaultPipelineDbPath,
  getPipelineDb,
  resetPipelineDb,
} from "./PipelineDB.ts";
import { defaultKayaHome } from "../../../../lib/core/KayaHome.ts";

import {
  PipelineRepository,
  resetPipelineRepository,
  generatePipelineId,
  type Stage,
  type PipelineItem,
} from "./PipelineRepository.ts";

// ============================================================================
// Helpers
// ============================================================================

const LIVE_RUNTIME_PATH = join(process.env.HOME || "", ".kaya", "runtime", "pipeline.db");
function liveDbExists(): boolean { return existsSync(LIVE_RUNTIME_PATH); }
const liveDbExistedBefore = liveDbExists();

// Absolute path to PipelineRepository.ts for worker scripts
const REPO_TS_PATH = join(import.meta.dir, "PipelineRepository.ts");

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

// ============================================================================
// Lifecycle
// ============================================================================

afterAll(() => {
  resetPipelineRepository();
  try { rmSync(TEST_BASE, { recursive: true, force: true }); } catch { /* best-effort */ }
});

// ============================================================================
// Test 4: Path isolation
// ============================================================================

describe("4. Path isolation / KAYA_HOME pinning", () => {
  test("defaultPipelineDbPath() resolves under TEST_KAYA_HOME, not HOME", () => {
    const resolved = defaultPipelineDbPath();
    expect(resolved).toContain(TEST_KAYA_HOME);
    expect(resolved).not.toContain(join(process.env.HOME || "", ".kaya"));
  });

  test("getPipelineDb() creates the DB under the temp dir", () => {
    const dbPath = defaultPipelineDbPath();
    const pdb = getPipelineDb(dbPath);
    expect(existsSync(dbPath)).toBe(true);
    expect(dbPath).toContain(TEST_KAYA_HOME);
    pdb.db.exec("SELECT 1");
  });

  test("live ~/.kaya/runtime/pipeline.db is NOT created by test setup", () => {
    if (!liveDbExistedBefore) {
      expect(liveDbExists()).toBe(false);
    }
    expect(defaultPipelineDbPath()).not.toBe(LIVE_RUNTIME_PATH);
  });
});

// ============================================================================
// Test 4b: defaultPipelineDbPath() env-tier resolution
// (KAYA_HOME=repo-root cron decoy-db incident, 2026-07-02)
//
// Every Kaya launchd cron plist sets KAYA_HOME=<repo root> so tools can find
// the repo. That collided with defaultPipelineDbPath()'s old KAYA_HOME-set →
// <KAYA_HOME>/.kaya branch and silently resolved the WHOLE cron fleet onto a
// 0-item decoy db at <repo root>/.kaya/runtime/pipeline.db instead of the
// canonical ~/.kaya/runtime/pipeline.db. These tests pin/restore
// process.env.KAYA_HOME and KAYA_RUNTIME per-case (save/restore around each
// test) rather than relying on any cached singleton — defaultPipelineDbPath()
// and defaultKayaHome() are both resolved at CALL time with no
// import-hoisted cache, so per-test env mutation is safe here.
// ============================================================================

describe("4b. defaultPipelineDbPath() env-tier resolution (decoy-db fix)", () => {
  const REPO_ROOT_KAYA_HOME = defaultKayaHome();
  const savedKayaHome = process.env.KAYA_HOME;
  const savedKayaRuntime = process.env.KAYA_RUNTIME;

  afterEach(() => {
    if (savedKayaHome !== undefined) {
      process.env.KAYA_HOME = savedKayaHome;
    } else {
      delete process.env.KAYA_HOME;
    }
    if (savedKayaRuntime !== undefined) {
      process.env.KAYA_RUNTIME = savedKayaRuntime;
    } else {
      delete process.env.KAYA_RUNTIME;
    }
  });

  test("(a) KAYA_HOME=<repo root, matching defaultKayaHome()> is treated as unset -> resolves under $HOME/.kaya", () => {
    process.env.KAYA_HOME = REPO_ROOT_KAYA_HOME;
    delete process.env.KAYA_RUNTIME;

    const resolved = defaultPipelineDbPath();

    expect(resolved).toBe(join(process.env.HOME || "", ".kaya", "runtime", "pipeline.db"));
    expect(resolved).not.toContain(REPO_ROOT_KAYA_HOME);
  });

  test("(b) KAYA_HOME=<scratch dir> keeps existing pinning behavior -> resolves under scratch/.kaya", () => {
    process.env.KAYA_HOME = TEST_KAYA_HOME;
    delete process.env.KAYA_RUNTIME;

    const resolved = defaultPipelineDbPath();

    expect(resolved).toBe(join(TEST_KAYA_HOME, ".kaya", "runtime", "pipeline.db"));
  });

  test("(c) KAYA_RUNTIME wins over both a repo-root KAYA_HOME and a scratch KAYA_HOME", () => {
    const runtimeDir = join(TEST_BASE, "runtime-override");
    process.env.KAYA_RUNTIME = runtimeDir;

    process.env.KAYA_HOME = REPO_ROOT_KAYA_HOME;
    expect(defaultPipelineDbPath()).toBe(join(runtimeDir, "pipeline.db"));

    process.env.KAYA_HOME = TEST_KAYA_HOME;
    expect(defaultPipelineDbPath()).toBe(join(runtimeDir, "pipeline.db"));
  });
});

// ============================================================================
// Test 2: Transition matrix
// ============================================================================

describe("2. Transition matrix", () => {
  let repo: PipelineRepository;
  const dbPath = join(TEST_BASE, ".kaya", "runtime", "pipeline-transitions.db");

  beforeAll(() => {
    mkdirSync(join(TEST_BASE, ".kaya", "runtime"), { recursive: true });
    repo = new PipelineRepository(dbPath);
  });

  afterAll(() => { resetPipelineDb(dbPath); });

  test("legal: intake → intake (self-loop for metadata updates)", () => {
    const item = repo.upsert(makeItem({ stage: "intake" }));
    const result = repo.transition(item.id, "intake");
    expect(result.stage).toBe("intake");
  });

  test("legal: intake → in-progress", () => {
    const item = repo.upsert(makeItem({ stage: "intake" }));
    const result = repo.transition(item.id, "in-progress");
    expect(result.stage).toBe("in-progress");
    expect(result.started_at).toBeTruthy();
  });

  test("legal: intake → researching", () => {
    const item = repo.upsert(makeItem({ stage: "intake" }));
    const result = repo.transition(item.id, "researching");
    expect(result.stage).toBe("researching");
  });

  test("legal: intake → needs-grilling", () => {
    const item = repo.upsert(makeItem({ stage: "intake" }));
    const result = repo.transition(item.id, "needs-grilling");
    expect(result.stage).toBe("needs-grilling");
  });

  test("legal: researching → generating-spec", () => {
    const item = repo.upsert(makeItem({ stage: "researching" }));
    const result = repo.transition(item.id, "generating-spec");
    expect(result.stage).toBe("generating-spec");
  });

  test("legal: generating-spec → awaiting-approval", () => {
    const item = repo.upsert(makeItem({ stage: "generating-spec" }));
    const result = repo.transition(item.id, "awaiting-approval");
    expect(result.stage).toBe("awaiting-approval");
  });

  test("legal: awaiting-approval → approved", () => {
    const item = repo.upsert(makeItem({ stage: "awaiting-approval" }));
    const result = repo.transition(item.id, "approved");
    expect(result.stage).toBe("approved");
  });

  test("legal: approved → in-progress", () => {
    const item = repo.upsert(makeItem({ stage: "approved" }));
    const result = repo.transition(item.id, "in-progress");
    expect(result.stage).toBe("in-progress");
    expect(result.started_at).toBeTruthy();
  });

  test("legal: in-progress → done", () => {
    const item = repo.upsert(makeItem({ stage: "in-progress" }));
    const result = repo.transition(item.id, "done");
    expect(result.stage).toBe("done");
    expect(result.completed_at).toBeTruthy();
  });

  test("legal: in-progress → partial → in-progress", () => {
    const item = repo.upsert(makeItem({ stage: "in-progress" }));
    const partial = repo.transition(item.id, "partial");
    expect(partial.stage).toBe("partial");
    const resumed = repo.transition(item.id, "in-progress");
    expect(resumed.stage).toBe("in-progress");
  });

  test("legal: blocked → intake (resumeBlocked)", () => {
    const item = repo.upsert(makeItem({ stage: "blocked" }));
    const result = repo.transition(item.id, "intake");
    expect(result.stage).toBe("intake");
  });

  test("legal: failed → intake (retry)", () => {
    const item = repo.upsert(makeItem({ stage: "failed" }));
    const result = repo.transition(item.id, "intake");
    expect(result.stage).toBe("intake");
  });

  test("legal: needs-grilling self-loop (idempotent re-park)", () => {
    const item = repo.upsert(makeItem({ stage: "needs-grilling" }));
    const result = repo.transition(item.id, "needs-grilling");
    expect(result.stage).toBe("needs-grilling");
  });

  test("legal: done → archived", () => {
    const item = repo.upsert(makeItem({ stage: "done" }));
    const result = repo.transition(item.id, "archived");
    expect(result.stage).toBe("archived");
  });

  // Illegal transitions
  test("illegal: done → in-progress throws", () => {
    const item = repo.upsert(makeItem({ stage: "done" }));
    expect(() => repo.transition(item.id, "in-progress")).toThrow(/illegal transition "done" → "in-progress"/);
  });

  test("illegal: rejected → in-progress throws", () => {
    const item = repo.upsert(makeItem({ stage: "rejected" }));
    expect(() => repo.transition(item.id, "in-progress")).toThrow(/illegal transition "rejected" → "in-progress"/);
  });

  test("illegal: archived → intake throws", () => {
    const item = repo.upsert(makeItem({ stage: "archived" }));
    expect(() => repo.transition(item.id, "intake")).toThrow(/illegal transition "archived" → "intake"/);
  });

  test("illegal: escalated → in-progress throws", () => {
    const item = repo.upsert(makeItem({ stage: "escalated" }));
    expect(() => repo.transition(item.id, "in-progress")).toThrow(/illegal transition "escalated" → "in-progress"/);
  });

  test("illegal: generating-spec → done throws", () => {
    const item = repo.upsert(makeItem({ stage: "generating-spec" }));
    expect(() => repo.transition(item.id, "done")).toThrow(/illegal transition "generating-spec" → "done"/);
  });

  test("transition for non-existent id throws", () => {
    expect(() => repo.transition("nonexistent-id-xyz", "in-progress")).toThrow(/item not found/);
  });

  test("patch fields are applied atomically with stage change", () => {
    const item = repo.upsert(makeItem({ stage: "in-progress" }));
    const result = repo.transition(item.id, "done", {
      patch: { result: "Build completed successfully" },
    });
    expect(result.stage).toBe("done");
    expect(result.result).toBe("Build completed successfully");
  });
});

// ============================================================================
// Test 3: integrity()
// ============================================================================

describe("3. integrity()", () => {
  let repo: PipelineRepository;
  const dbPath = join(TEST_BASE, ".kaya", "runtime", "pipeline-integrity.db");

  beforeAll(() => {
    mkdirSync(join(TEST_BASE, ".kaya", "runtime"), { recursive: true });
    repo = new PipelineRepository(dbPath);
  });

  afterAll(() => { resetPipelineDb(dbPath); });

  test("empty store passes integrity", () => {
    const report = repo.integrity();
    expect(report.ok).toBe(true);
    expect(report.errors).toHaveLength(0);
  });

  test("well-formed store passes integrity", () => {
    const a = repo.upsert(makeItem({ stage: "done", started_at: new Date().toISOString() }));
    repo.upsert({
      ...a,
      verification: {
        status: "verified",
        verifiedAt: new Date().toISOString(),
        verdict: "PASS",
        concerns: [],
        iscRowsVerified: 1,
        iscRowsTotal: 1,
        verificationCost: 0,
        verifiedBy: "skeptical_verifier",
        tiersExecuted: [1, 2],
      },
    });
    repo.upsert(makeItem({ stage: "in-progress", started_at: new Date().toISOString() }));
    const report = repo.integrity();
    expect(report.ok).toBe(true);
    expect(report.errors).toHaveLength(0);
  });

  test("in-progress with null started_at is reported as error", () => {
    const id = generatePipelineId();
    repo.upsert({ id, stage: "in-progress", started_at: new Date().toISOString() });
    // Corrupt directly via raw SQL
    repo["db"].prepare("UPDATE pipeline_items SET started_at = NULL WHERE id = ?").run(id);

    const report = repo.integrity();
    expect(report.ok).toBe(false);
    expect(report.errors.some((e) => e.includes(id) && e.includes("started_at"))).toBe(true);
  });

  test("missing dependency ref is reported as error", () => {
    const id = generatePipelineId();
    const ghostDepId = "nonexistent-dep-12345";
    repo.upsert({ id, stage: "in-progress", dependencies: [ghostDepId], started_at: new Date().toISOString() });

    const report = repo.integrity();
    expect(report.ok).toBe(false);
    expect(report.errors.some((e) => e.includes(ghostDepId))).toBe(true);
  });

  test("done item without verification is a warning (not error)", () => {
    const isolatedPath = join(TEST_BASE, ".kaya", "runtime", "pipeline-integrity-warn.db");
    const isoRepo = new PipelineRepository(isolatedPath);
    const id = generatePipelineId();
    isoRepo.upsert({ id, stage: "done", started_at: new Date().toISOString() });

    const report = isoRepo.integrity();
    expect(report.warnings.some((w) => w.includes(id) && w.includes("verification"))).toBe(true);
    expect(report.ok).toBe(true); // warnings don't block ok

    resetPipelineDb(isolatedPath);
  });

  test("integrity stats report correct total and byStage counts", () => {
    const isolatedPath = join(TEST_BASE, ".kaya", "runtime", "pipeline-integrity-stats.db");
    const isoRepo = new PipelineRepository(isolatedPath);

    isoRepo.upsert(makeItem({ stage: "intake" }));
    isoRepo.upsert(makeItem({ stage: "intake" }));
    isoRepo.upsert(makeItem({ stage: "in-progress", started_at: new Date().toISOString() }));

    const report = isoRepo.integrity();
    expect(report.stats.total).toBeGreaterThanOrEqual(3);
    expect(report.stats.byStage["intake"]).toBeGreaterThanOrEqual(2);
    expect(report.stats.byStage["in-progress"]).toBeGreaterThanOrEqual(1);

    resetPipelineDb(isolatedPath);
  });
});

// ============================================================================
// Test 1: Concurrent zero-lost-update (THE race proof) — STRENGTHENED
//
// FIX 4: Workers do NOT swallow errors. Every transition call propagates throws.
// A single SQLITE_BUSY escape means the worker exits non-zero → test fails.
// Assertions: zero SQLITE_BUSY in stderr, exact done count, zero in-progress.
// ============================================================================

describe("1. Concurrent zero-lost-update (race proof) — strengthened", () => {
  const RACE_DB_PATH = join(TEST_BASE, ".kaya", "runtime", "pipeline-race.db");
  const WORKER_COUNT = 3;
  const ITEMS_PER_WORKER = 10;
  const WORKER_SCRIPT = join(TEST_BASE, "race-worker.ts");

  beforeAll(() => {
    mkdirSync(join(TEST_BASE, ".kaya", "runtime"), { recursive: true });

    // PRE-INITIALIZE the DB (single-process WAL setup) before workers open it.
    // bun:sqlite's PRAGMA journal_mode=WAL needs an exclusive OS lock on first open;
    // 3 processes racing for a brand-new file can't all win. Pre-init here means
    // workers open an already-WAL-mode file where PRAGMA journal_mode=WAL is a no-op.
    // PHASE-4 MIGRATOR NOTE: The migrator must do the same before spawning workers.
    const preInitRepo = new PipelineRepository(RACE_DB_PATH);
    preInitRepo["db"].exec("SELECT 1");
    resetPipelineDb(RACE_DB_PATH);

    // Worker: each worker owns disjoint item IDs (no cross-worker lock contention on upserts).
    // NO try/catch on transitions — errors propagate and exit the worker non-zero.
    // This is the STRENGTHENED version: any SQLITE_BUSY escape = test fails.
    writeFileSync(WORKER_SCRIPT, [
      "#!/usr/bin/env bun",
      `import { PipelineRepository } from ${JSON.stringify(REPO_TS_PATH)};`,
      "",
      "const workerId = parseInt(process.argv[2] ?? '0');",
      "const dbPath = process.argv[3];",
      "const itemCount = parseInt(process.argv[4] ?? '10');",
      "",
      "const repo = new PipelineRepository(dbPath);",
      "const ids: string[] = [];",
      "",
      "// Phase 1: Insert (disjoint IDs — no cross-worker insert contention)",
      "for (let i = 0; i < itemCount; i++) {",
      "  const id = `w${workerId}-item-${i}`;",
      "  ids.push(id);",
      "  // withRetry inside upsert handles transient BUSY; if it escapes, we exit non-zero",
      "  repo.upsert({ id, title: `Worker ${workerId} Item ${i}`, stage: 'intake', priority: 2,",
      "    dependencies: [], metadata: { workerId, itemIndex: i }, context: {}, attempts: [], progress: {}, isc_rows: [] });",
      "}",
      "",
      "// Phase 2: intake → in-progress (NO try/catch — must succeed)",
      "for (const id of ids) {",
      "  repo.transition(id, 'in-progress');",
      "}",
      "",
      "// Phase 3: in-progress → done (NO try/catch — must succeed)",
      "for (const id of ids) {",
      "  repo.transition(id, 'done', {",
      "    patch: {",
      "      result: `Worker ${workerId} done`,",
      "      verification: { status: 'verified', verifiedAt: new Date().toISOString(),",
      "        verdict: 'PASS', concerns: [], iscRowsVerified: 1, iscRowsTotal: 1,",
      "        verificationCost: 0, verifiedBy: 'skeptical_verifier', tiersExecuted: [1] },",
      "    },",
      "  });",
      "}",
      "",
      "console.log(JSON.stringify({ workerId, ids, done: itemCount }));",
    ].join("\n"));
  });

  test("3 concurrent workers: zero lost rows, zero BUSY drops, exact done count", async () => {
    const workers = Array.from({ length: WORKER_COUNT }, (_, i) =>
      Bun.spawn(
        ["bun", WORKER_SCRIPT, String(i), RACE_DB_PATH, String(ITEMS_PER_WORKER)],
        { stdout: "pipe", stderr: "pipe" }
      )
    );

    const results = await Promise.all(
      workers.map(async (proc, i) => {
        const exitCode = await proc.exited;
        const stdout = await new Response(proc.stdout).text();
        const stderr = await new Response(proc.stderr).text();
        return { exitCode, stdout, stderr, workerId: i };
      })
    );

    // STRONG ASSERTION 1: All workers exit 0 — any non-zero means SQLITE_BUSY escaped withRetry
    for (const r of results) {
      if (r.exitCode !== 0) console.error(`Worker ${r.workerId} stderr:\n${r.stderr}`);
      expect(r.exitCode).toBe(0);
    }

    // STRONG ASSERTION 2: Zero "database is locked" in any worker's stderr
    // With BEGIN IMMEDIATE + busy_timeout=8000, BUSY must never reach the caller
    for (const r of results) {
      if (r.stderr.includes("database is locked")) {
        console.error(`Worker ${r.workerId} saw SQLITE_BUSY:\n${r.stderr}`);
      }
      expect(r.stderr).not.toContain("database is locked");
    }

    // Parse all IDs from worker output
    const allIds: string[] = [];
    for (const { stdout } of results) {
      for (const line of stdout.trim().split("\n")) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line) as { workerId: number; ids: string[]; done: number };
          allIds.push(...parsed.ids);
        } catch { /* skip */ }
      }
    }

    const expectedTotal = WORKER_COUNT * ITEMS_PER_WORKER;
    expect(allIds).toHaveLength(expectedTotal);

    const raceRepo = new PipelineRepository(RACE_DB_PATH);

    // STRONG ASSERTION 3: Zero lost rows
    const missingIds: string[] = [];
    for (const id of allIds) {
      if (!raceRepo.get(id)) missingIds.push(id);
    }
    if (missingIds.length > 0) console.error("LOST ROWS:", missingIds);
    expect(missingIds).toHaveLength(0);

    // STRONG ASSERTION 4: Exact stage counts
    const allItems = raceRepo.list({ includeArchived: false });
    const stageMap: Record<string, number> = {};
    for (const item of allItems) stageMap[item.stage] = (stageMap[item.stage] ?? 0) + 1;

    const doneCount = stageMap["done"] ?? 0;
    const inProgressCount = stageMap["in-progress"] ?? 0;
    const intakeCount = stageMap["intake"] ?? 0;

    if (doneCount !== expectedTotal) console.error(`Stage distribution: ${JSON.stringify(stageMap)}`);

    expect(doneCount).toBe(expectedTotal);   // all items must reach done
    expect(inProgressCount).toBe(0);         // no items stuck in-progress
    expect(intakeCount).toBe(0);             // no items stuck in intake

    console.log(`Race proof PASSED: ${WORKER_COUNT} workers × ${ITEMS_PER_WORKER} = ${expectedTotal} items, ${doneCount} done (100%, 0 BUSY drops)`);

    resetPipelineDb(RACE_DB_PATH);
  }, 60_000);

  // 4-worker stress probe (coordinator-requested adversarial verification)
  test("4-worker stress probe: disjoint items, intake→in-progress→done, zero BUSY drops", async () => {
    const STRESS_DB_PATH = join(TEST_BASE, ".kaya", "runtime", "pipeline-stress.db");
    const STRESS_WORKER_COUNT = 4;
    const STRESS_ITEMS_PER_WORKER = 10;
    const STRESS_SCRIPT = join(TEST_BASE, "stress-worker.ts");

    // Pre-initialize
    const stressInitRepo = new PipelineRepository(STRESS_DB_PATH);
    stressInitRepo["db"].exec("SELECT 1");
    resetPipelineDb(STRESS_DB_PATH);

    // Stress worker: same disjoint-item pattern, but counts BUSY drops explicitly
    // so we can report the exact number (expected: 0)
    writeFileSync(STRESS_SCRIPT, [
      "#!/usr/bin/env bun",
      `import { PipelineRepository } from ${JSON.stringify(REPO_TS_PATH)};`,
      "",
      "const workerId = parseInt(process.argv[2] ?? '0');",
      "const dbPath = process.argv[3];",
      "const itemCount = parseInt(process.argv[4] ?? '10');",
      "",
      "let attempts = 0; let successes = 0; let busyDrops = 0;",
      "const repo = new PipelineRepository(dbPath);",
      "const ids: string[] = [];",
      "",
      "for (let i = 0; i < itemCount; i++) {",
      "  const id = `stress-w${workerId}-${i}`;",
      "  ids.push(id);",
      "  attempts++;",
      "  repo.upsert({ id, title: `Stress W${workerId} ${i}`, stage: 'intake', priority: 2,",
      "    metadata: {}, context: {}, attempts: [], progress: {}, isc_rows: [], dependencies: [] });",
      "  successes++;",
      "}",
      "",
      "for (const id of ids) {",
      "  attempts++;",
      "  try {",
      "    repo.transition(id, 'in-progress');",
      "    successes++;",
      "  } catch (err) {",
      "    const msg = err instanceof Error ? err.message : String(err);",
      "    if (msg.includes('database is locked') || msg.includes('SQLITE_BUSY')) {",
      "      busyDrops++;",
      "      process.stderr.write(`BUSY on in-progress: ${id}\\n`);",
      "    } else { throw err; }",
      "  }",
      "}",
      "",
      "for (const id of ids) {",
      "  const item = repo.get(id);",
      "  if (item?.stage !== 'in-progress') continue;",
      "  attempts++;",
      "  try {",
      "    repo.transition(id, 'done');",
      "    successes++;",
      "  } catch (err) {",
      "    const msg = err instanceof Error ? err.message : String(err);",
      "    if (msg.includes('database is locked') || msg.includes('SQLITE_BUSY')) {",
      "      busyDrops++;",
      "      process.stderr.write(`BUSY on done: ${id}\\n`);",
      "    } else { throw err; }",
      "  }",
      "}",
      "",
      "console.log(JSON.stringify({ workerId, ids, attempts, successes, busyDrops }));",
    ].join("\n"));

    const stressWorkers = Array.from({ length: STRESS_WORKER_COUNT }, (_, i) =>
      Bun.spawn(
        ["bun", STRESS_SCRIPT, String(i), STRESS_DB_PATH, String(STRESS_ITEMS_PER_WORKER)],
        { stdout: "pipe", stderr: "pipe" }
      )
    );

    const stressResults = await Promise.all(
      stressWorkers.map(async (proc, i) => {
        const exitCode = await proc.exited;
        const stdout = await new Response(proc.stdout).text();
        const stderr = await new Response(proc.stderr).text();
        return { exitCode, stdout, stderr, workerId: i };
      })
    );

    for (const r of stressResults) {
      if (r.exitCode !== 0) console.error(`Stress worker ${r.workerId}:\n${r.stderr}`);
      expect(r.exitCode).toBe(0);
    }

    let totalAttempts = 0, totalSuccesses = 0, totalBusyDrops = 0;
    const allStressIds: string[] = [];

    for (const { stdout } of stressResults) {
      for (const line of stdout.trim().split("\n")) {
        if (!line.trim()) continue;
        try {
          const p = JSON.parse(line) as { workerId: number; ids: string[]; attempts: number; successes: number; busyDrops: number };
          totalAttempts += p.attempts;
          totalSuccesses += p.successes;
          totalBusyDrops += p.busyDrops;
          allStressIds.push(...p.ids);
        } catch { /* skip */ }
      }
    }

    const stressRepo = new PipelineRepository(STRESS_DB_PATH);
    const stageMap: Record<string, number> = {};
    for (const id of allStressIds) {
      const item = stressRepo.get(id);
      if (item) stageMap[item.stage] = (stageMap[item.stage] ?? 0) + 1;
    }

    const expectedItemCount = STRESS_WORKER_COUNT * STRESS_ITEMS_PER_WORKER;
    const doneCount = stageMap["done"] ?? 0;
    const successRate = totalAttempts > 0 ? (totalSuccesses / totalAttempts * 100).toFixed(1) : "0";

    console.log(`Stress probe: ${STRESS_WORKER_COUNT} workers × ${STRESS_ITEMS_PER_WORKER} = ${expectedItemCount} items`);
    console.log(`  attempts=${totalAttempts} successes=${totalSuccesses} BUSY_drops=${totalBusyDrops}`);
    console.log(`  success_rate=${successRate}% done=${doneCount}/${expectedItemCount}`);
    console.log(`  stage_map=${JSON.stringify(stageMap)}`);

    if (totalBusyDrops > 0) console.error(`STRESS PROBE: ${totalBusyDrops} SQLITE_BUSY drops — durability broken`);
    expect(totalBusyDrops).toBe(0);
    expect(doneCount).toBe(expectedItemCount);

    resetPipelineDb(STRESS_DB_PATH);
  }, 60_000);

  // claimBatch concurrent safety test
  test("claimBatch with BEGIN IMMEDIATE prevents double-claims", async () => {
    const batchDbPath = join(TEST_BASE, ".kaya", "runtime", "pipeline-claim-race.db");
    const batchRepo = new PipelineRepository(batchDbPath);

    for (let i = 0; i < 10; i++) {
      batchRepo.upsert(makeItem({ stage: "approved" }));
    }
    resetPipelineDb(batchDbPath);

    const claimWorkerScript = join(TEST_BASE, "claim-worker.ts");
    writeFileSync(claimWorkerScript, [
      "#!/usr/bin/env bun",
      `import { PipelineRepository } from ${JSON.stringify(REPO_TS_PATH)};`,
      "const dbPath = process.argv[2];",
      "const repo = new PipelineRepository(dbPath);",
      "const claimed = repo.claimBatch(5, 'approved', 'in-progress');",
      "console.log(JSON.stringify(claimed.map((i: { id: string }) => i.id)));",
    ].join("\n"));

    const claimers = Array.from({ length: 3 }, () =>
      Bun.spawn(["bun", claimWorkerScript, batchDbPath], { stdout: "pipe", stderr: "pipe" })
    );

    const claimResults = await Promise.all(
      claimers.map(async (proc, i) => {
        const exitCode = await proc.exited;
        const stdout = await new Response(proc.stdout).text();
        const stderr = await new Response(proc.stderr).text();
        if (stderr.trim()) console.error(`[Claimer ${i} stderr]:`, stderr.trim());
        return { exitCode, stdout };
      })
    );

    for (const r of claimResults) expect(r.exitCode).toBe(0);

    const allClaimedIds: string[] = [];
    for (const { stdout } of claimResults) {
      for (const line of stdout.trim().split("\n")) {
        if (!line.trim()) continue;
        try { allClaimedIds.push(...(JSON.parse(line) as string[])); } catch { /* skip */ }
      }
    }

    const uniqueClaimedIds = new Set(allClaimedIds);
    expect(uniqueClaimedIds.size).toBe(allClaimedIds.length);
    expect(allClaimedIds.length).toBeLessThanOrEqual(10);
    console.log(`claimBatch race: ${allClaimedIds.length} claims, ${uniqueClaimedIds.size} unique (0 double-claims)`);

    resetPipelineDb(batchDbPath);
  }, 30_000);

  // claimByIds concurrent safety test (Phase 3 atomic claim)
  // 4 concurrent processes each call claimByIds on the SAME overlapping candidate set
  // (all 30 items). Every item must be claimed by exactly one process.
  test("claimByIds with BEGIN IMMEDIATE + compare-and-swap: 4 processes, ZERO double-claims", async () => {
    const CLAIM_BY_IDS_DB = join(TEST_BASE, ".kaya", "runtime", "pipeline-claim-by-ids.db");
    const TOTAL_ITEMS = 30;
    const CLAIMER_COUNT = 4;
    const ITEMS_PER_CLAIMER = 20; // each claimer tries to claim 20 of the 30

    // Pre-seed items in "approved" stage (the WorkQueue "pending" → "approved" mapping)
    const seedRepo = new PipelineRepository(CLAIM_BY_IDS_DB);
    const seededIds: string[] = [];
    for (let i = 0; i < TOTAL_ITEMS; i++) {
      const id = `claim-by-ids-item-${String(i).padStart(3, "0")}`;
      seedRepo.upsert(makeItem({ id, stage: "approved" }));
      seededIds.push(id);
    }
    resetPipelineDb(CLAIM_BY_IDS_DB);

    // Worker: receives the full candidate list, calls claimByIds with the first ITEMS_PER_CLAIMER ids
    const claimByIdsWorkerScript = join(TEST_BASE, "claim-by-ids-worker.ts");
    writeFileSync(claimByIdsWorkerScript, [
      "#!/usr/bin/env bun",
      `import { PipelineRepository } from ${JSON.stringify(REPO_TS_PATH)};`,
      "const dbPath = process.argv[2];",
      "const candidateIds: string[] = JSON.parse(process.argv[3] ?? '[]');",
      "const repo = new PipelineRepository(dbPath);",
      "const claimed = repo.claimByIds(candidateIds, 'approved', 'in-progress');",
      "console.log(JSON.stringify(claimed.map((i: { id: string }) => i.id)));",
    ].join("\n"));

    // Each process gets the SAME full candidate list (simulates the concurrent
    // double-claim scenario the verifier found in Phase 3's non-atomic claim).
    const candidateIds = seededIds.slice(0, ITEMS_PER_CLAIMER);

    const claimers = Array.from({ length: CLAIMER_COUNT }, () =>
      Bun.spawn(
        ["bun", claimByIdsWorkerScript, CLAIM_BY_IDS_DB, JSON.stringify(candidateIds)],
        { stdout: "pipe", stderr: "pipe" }
      )
    );

    const claimResults = await Promise.all(
      claimers.map(async (proc, i) => {
        const exitCode = await proc.exited;
        const stdout = await new Response(proc.stdout).text();
        const stderr = await new Response(proc.stderr).text();
        if (stderr.trim()) console.error(`[claimByIds claimer ${i} stderr]:`, stderr.trim());
        return { exitCode, stdout };
      })
    );

    for (const r of claimResults) expect(r.exitCode).toBe(0);

    const allClaimedIds: string[] = [];
    for (const { stdout } of claimResults) {
      for (const line of stdout.trim().split("\n")) {
        if (!line.trim()) continue;
        try { allClaimedIds.push(...(JSON.parse(line) as string[])); } catch { /* skip */ }
      }
    }

    const uniqueClaimedIds = new Set(allClaimedIds);

    // Zero double-claims: every claimed id must appear exactly once across all processes
    const doubleClaims = allClaimedIds.filter(id => {
      let count = 0;
      for (const c of allClaimedIds) { if (c === id) count++; }
      return count > 1;
    });
    if (doubleClaims.length > 0) {
      console.error(`DOUBLE-CLAIMS DETECTED (${doubleClaims.length}): ${[...new Set(doubleClaims)].join(", ")}`);
    }

    expect(doubleClaims).toHaveLength(0);
    // Each candidate item is claimed by at most one process
    expect(uniqueClaimedIds.size).toBe(allClaimedIds.length);
    // Total claimed ≤ TOTAL_ITEMS (can't claim more than what exists)
    expect(allClaimedIds.length).toBeLessThanOrEqual(TOTAL_ITEMS);

    // Verify DB is consistent: claimed ids are in-progress, remainder in approved
    const verifyRepo = new PipelineRepository(CLAIM_BY_IDS_DB);
    const inProgress = verifyRepo.list({ stage: "in-progress" });
    expect(inProgress.length).toBe(uniqueClaimedIds.size);
    for (const item of inProgress) {
      expect(uniqueClaimedIds.has(item.id)).toBe(true);
    }

    console.log(`claimByIds race: ${CLAIMER_COUNT} processes × ${ITEMS_PER_CLAIMER} candidates each = ` +
      `${allClaimedIds.length} total claimed, ${uniqueClaimedIds.size} unique (0 double-claims)`);

    resetPipelineDb(CLAIM_BY_IDS_DB);
  }, 30_000);
});

// ============================================================================
// Test 5: CRUD and list operations
// ============================================================================

describe("5. CRUD and list operations", () => {
  let repo: PipelineRepository;
  const dbPath = join(TEST_BASE, ".kaya", "runtime", "pipeline-crud.db");

  beforeAll(() => {
    mkdirSync(join(TEST_BASE, ".kaya", "runtime"), { recursive: true });
    repo = new PipelineRepository(dbPath);
  });

  afterAll(() => { resetPipelineDb(dbPath); });

  test("upsert creates a new item and get retrieves it", () => {
    const id = generatePipelineId();
    const upserted = repo.upsert({ id, title: "My Item", stage: "intake", priority: 1 });
    expect(upserted.id).toBe(id);
    expect(upserted.stage).toBe("intake");
    expect(upserted.priority).toBe(1);
    const fetched = repo.get(id);
    expect(fetched).not.toBeNull();
    expect(fetched!.id).toBe(id);
  });

  test("upsert on existing id updates fields", () => {
    const id = generatePipelineId();
    repo.upsert({ id, title: "Original", stage: "intake" });
    const updated = repo.upsert({ id, title: "Updated" });
    expect(updated.title).toBe("Updated");
    expect(updated.stage).toBe("intake");
  });

  test("get returns null for non-existent id", () => {
    expect(repo.get("no-such-id")).toBeNull();
  });

  test("list returns items excluding archived by default", () => {
    const active = repo.upsert(makeItem({ stage: "intake" }));
    const archived = repo.upsert(makeItem({ stage: "archived" }));
    const items = repo.list();
    const ids = items.map((i) => i.id);
    expect(ids).toContain(active.id);
    expect(ids).not.toContain(archived.id);
  });

  test("list with includeArchived=true includes archived items", () => {
    const archived = repo.upsert(makeItem({ stage: "archived" }));
    const items = repo.list({ includeArchived: true });
    expect(items.map((i) => i.id)).toContain(archived.id);
  });

  test("list filters by stage", () => {
    const a = repo.upsert(makeItem({ stage: "intake" }));
    const b = repo.upsert(makeItem({ stage: "researching" }));
    const intakeItems = repo.list({ stage: "intake" });
    const intakeIds = intakeItems.map((i) => i.id);
    expect(intakeIds).toContain(a.id);
    expect(intakeIds).not.toContain(b.id);
  });

  test("list filters by multiple stages", () => {
    const a = repo.upsert(makeItem({ stage: "intake" }));
    const b = repo.upsert(makeItem({ stage: "researching" }));
    const c = repo.upsert(makeItem({ stage: "done" }));
    const items = repo.list({ stage: ["intake", "researching"] });
    const ids = items.map((i) => i.id);
    expect(ids).toContain(a.id);
    expect(ids).toContain(b.id);
    expect(ids).not.toContain(c.id);
  });

  test("archive() transitions item to archived stage", () => {
    const item = repo.upsert(makeItem({ stage: "done" }));
    const archived = repo.archive(item.id);
    expect(archived.stage).toBe("archived");
  });

  test("remove() hard-deletes an item", () => {
    const item = repo.upsert(makeItem({ stage: "intake" }));
    expect(repo.remove(item.id)).toBe(true);
    expect(repo.get(item.id)).toBeNull();
  });

  test("remove() returns false for non-existent id", () => {
    expect(repo.remove("non-existent-xyz")).toBe(false);
  });

  test("JSON blob fields round-trip correctly", () => {
    const id = generatePipelineId();
    const metadata = { key: "value", nested: { a: 1 } };
    const context = { source: "test" };
    const attempts = [{ attemptNumber: 1, startedAt: "2024-01-01" }];
    repo.upsert({ id, stage: "intake", metadata, context, attempts });
    const fetched = repo.get(id)!;
    expect(fetched.metadata).toEqual(metadata);
    expect(fetched.context).toEqual(context);
    expect(fetched.attempts).toEqual(attempts);
  });

  test("dependencies array is stored and retrieved correctly", () => {
    const depItem = repo.upsert(makeItem({ stage: "done" }));
    const dependentItem = repo.upsert(makeItem({ stage: "intake", dependencies: [depItem.id] }));
    const fetched = repo.get(dependentItem.id)!;
    expect(fetched.dependencies).toEqual([depItem.id]);
  });
});

// ============================================================================
// Test 6: Live path safety
// ============================================================================

describe("6. Live path safety (post-test assertion)", () => {
  test("live ~/.kaya/runtime/pipeline.db was NOT created by these tests", () => {
    if (!liveDbExistedBefore) {
      expect(liveDbExists()).toBe(false);
    } else {
      expect(defaultPipelineDbPath()).not.toBe(LIVE_RUNTIME_PATH);
    }
  });
});
