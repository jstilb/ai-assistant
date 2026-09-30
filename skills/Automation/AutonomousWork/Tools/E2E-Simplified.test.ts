/**
 * E2E-Simplified.test.ts — End-to-end integration test for streamlined autonomous work pipeline
 *
 * Validates the full pipeline: WorkQueue → WorkOrchestrator → SkepticalVerifier
 * with a 3-item DAG (A independent, B independent, C depends on A+B).
 *
 * Tests: init, batching, prepare, ISC generation, verification,
 * completion gates, dependency unblocking, catastrophic detection, status.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { WorkItem } from "./WorkQueue.ts";
import type { ISCRow } from "./WorkOrchestrator.ts";

// ---------------------------------------------------------------------------
// Hermetic invariant (structured-falcon §69)
//
// WorkQueue._createForTesting() bulk-seeds fixture ids with arbitrary stage
// values via PipelineRepository.upsert({ enforce: false }), which is not a
// legal transition — that intentionally trips a "shadow illegal verdict" that
// gets logged via FailureLog.recordFailure(). recordFailure() (and
// NotificationService/AlertGate's write choke points) now call
// assertNotLiveHomeUnderTest(), which THROWS under NODE_ENV=test if
// KAYA_HOME resolves to the live default. So KAYA_HOME must be pinned to a
// scratch dir before any test exercises the pipeline.
//
// The pin must happen via a DYNAMIC import performed AFTER process.env is
// set: static imports are ESM-hoisted ahead of any top-level assignment in
// THIS file (verified empirically — a plain `process.env.KAYA_HOME = tmp`
// placed textually before a static `import ... from "./WorkOrchestrator.ts"`
// does NOT run before that module's own top-level code, including its
// module-scope KAYA_HOME constant used for spec-path resolution). Type-only
// imports above are erased at compile time and never trigger module
// evaluation, so they're safe as static imports.
// ---------------------------------------------------------------------------

let WorkQueue: typeof import("./WorkQueue.ts")["WorkQueue"];
let WorkOrchestrator: typeof import("./WorkOrchestrator.ts")["WorkOrchestrator"];
let tempHome: string;
// Restored in afterAll — leaking KAYA_ALERT_DRY_RUN=1 (or a KAYA_HOME about
// to be rmSync'd) poisons later files in the same bun process (see
// WorkQueue.test.ts's PREV_ENV note).
let prevEnv: Record<string, string | undefined> = {};

beforeAll(async () => {
  tempHome = mkdtempSync(join(tmpdir(), "e2e-simplified-test-"));
  prevEnv = {
    KAYA_HOME: process.env.KAYA_HOME,
    KAYA_DIR: process.env.KAYA_DIR,
    KAYA_ALERT_DRY_RUN: process.env.KAYA_ALERT_DRY_RUN,
  };
  process.env.KAYA_HOME = tempHome;
  process.env.KAYA_DIR = tempHome;
  process.env.KAYA_ALERT_DRY_RUN = "1";

  ({ WorkQueue } = await import("./WorkQueue.ts"));
  ({ WorkOrchestrator } = await import("./WorkOrchestrator.ts"));
});

afterAll(() => {
  for (const [k, v] of Object.entries(prevEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(tempHome, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeItem(overrides: Partial<WorkItem> & { id: string }): WorkItem {
  return {
    title: `Item ${overrides.id}`,
    description: "Test item description",
    status: "pending",
    priority: "normal",
    dependencies: [],
    source: "manual",
    createdAt: new Date().toISOString(),
    workType: "dev",
    ...overrides,
  };
}

function makeDoneRow(id: number, overrides: Partial<ISCRow> = {}): ISCRow {
  return {
    id,
    description: `Row ${id}`,
    status: "DONE",
    parallel: false,
    verification: { method: "test", command: "test -d /tmp", success_criteria: "exists" },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Full Pipeline E2E
// ---------------------------------------------------------------------------

describe("E2E: Full pipeline with 3-item DAG", () => {
  // Setup: A (independent), B (independent), C (depends on A + B)
  const itemA = makeItem({ id: "item-a", title: "Build auth module", priority: "high" });
  const itemB = makeItem({ id: "item-b", title: "Create API client", priority: "normal" });
  const itemC = makeItem({ id: "item-c", title: "Integration tests", priority: "normal", dependencies: ["item-a", "item-b"] });

  function createPipeline() {
    const queue = WorkQueue._createForTesting([
      { ...itemA, status: "pending" },
      { ...itemB, status: "pending" },
      { ...itemC, status: "pending" },
    ]);
    const orch = WorkOrchestrator._createForTesting(queue);
    return { queue, orch };
  }

  it("Step 1: init validates DAG and reports ready/blocked counts", async () => {
    const { orch } = createPipeline();
    const result = await orch.init();

    expect(result.success).toBe(true);
    expect(result.ready).toBe(2);    // A and B ready
    expect(result.blocked).toBe(1);  // C blocked
    expect(result.message).toContain("2 ready");
    expect(result.message).toContain("1 blocked");
  });

  it("Step 2: nextBatch returns A and B, not C", async () => {
    const { orch } = createPipeline();
    await orch.init();

    const batch = await orch.nextBatch(5);
    const ids = batch.items.map(i => i.id);

    expect(ids).toContain("item-a");
    expect(ids).toContain("item-b");
    expect(ids).not.toContain("item-c");
    expect(batch.blocked).toBe(1);
  });

  it("Step 3: prepare generates ISC rows and classifies effort", async () => {
    const { orch } = createPipeline();
    await orch.init();

    const result = await orch.prepare("item-a");

    expect(result.success).toBe(true);
    expect(result.iscRows.length).toBeGreaterThan(0); // Template: 2 for STANDARD dev, 3 for THOROUGH
    expect(result.effort).toBeDefined();
    expect(result.maxIterations).toBeGreaterThan(0);

    // ISC rows should have verification objects (template-based for dev)
    for (const row of result.iscRows) {
      expect(row.verification).toBeDefined();
      expect(row.status).toBe("PENDING");
    }
  });

  it("Step 5: started marks item in_progress", async () => {
    const { queue, orch } = createPipeline();
    await orch.init();

    expect(orch.started("item-a")).toBe(true);
    expect(queue.getItem("item-a")?.status).toBe("in_progress");
  });

  it("Step 6: verify with passing rows promotes to VERIFIED", async () => {
    const { orch } = createPipeline();
    await orch.init();
    orch.started("item-a");

    // Simulate agent completing ISC rows
    orch.iscManager.persist("item-a", [makeDoneRow(1), makeDoneRow(2), makeDoneRow(3)]);

    const result = await orch.verify("item-a");
    expect(result.success).toBe(true);
    expect(result.skepticalReview?.finalVerdict).toBe("PASS");

    // All rows promoted
    const rows = orch.iscManager.load("item-a");
    expect(rows.every(r => r.status === "VERIFIED")).toBe(true);
  });

  it("Step 7: complete succeeds after verification", async () => {
    const { queue, orch } = createPipeline();
    await orch.init();
    orch.started("item-a");
    orch.iscManager.persist("item-a", [{ id: 1, description: "Done", status: "VERIFIED", parallel: false }]);
    queue.setVerification("item-a", {
      status: "verified", verifiedAt: new Date().toISOString(), verdict: "PASS",
      concerns: [], iscRowsVerified: 1, iscRowsTotal: 1, verificationCost: 0,
      verifiedBy: "skeptical_verifier" as const, tiersExecuted: [1, 2],
    });

    const result = await orch.complete("item-a");
    expect(result.success).toBe(true);
    expect(queue.getItem("item-a")?.status).toBe("completed");
  });

  it("Step 8: complete A and B → C becomes ready", async () => {
    const { queue, orch } = createPipeline();
    await orch.init();

    // Complete A
    orch.started("item-a");
    orch.iscManager.persist("item-a", [{ id: 1, description: "Done", status: "VERIFIED", parallel: false }]);
    queue.setVerification("item-a", {
      status: "verified", verifiedAt: new Date().toISOString(), verdict: "PASS",
      concerns: [], iscRowsVerified: 1, iscRowsTotal: 1, verificationCost: 0,
      verifiedBy: "skeptical_verifier" as const, tiersExecuted: [1, 2],
    });
    await orch.complete("item-a");

    // C still blocked (B pending)
    let batch = await orch.nextBatch(5);
    expect(batch.items.map(i => i.id)).not.toContain("item-c");

    // Complete B
    orch.started("item-b");
    orch.iscManager.persist("item-b", [{ id: 1, description: "Done", status: "VERIFIED", parallel: false }]);
    queue.setVerification("item-b", {
      status: "verified", verifiedAt: new Date().toISOString(), verdict: "PASS",
      concerns: [], iscRowsVerified: 1, iscRowsTotal: 1, verificationCost: 0,
      verifiedBy: "skeptical_verifier" as const, tiersExecuted: [1, 2],
    });
    await orch.complete("item-b");

    // Now C unblocked
    batch = await orch.nextBatch(5);
    expect(batch.items.map(i => i.id)).toContain("item-c");
    expect(batch.blocked).toBe(0);
  });

  it("Step 9: status reflects correct counts after pipeline", async () => {
    const { queue, orch } = createPipeline();
    await orch.init();

    // Complete A
    orch.started("item-a");
    orch.iscManager.persist("item-a", [{ id: 1, description: "Done", status: "VERIFIED", parallel: false }]);
    queue.setVerification("item-a", {
      status: "verified", verifiedAt: new Date().toISOString(), verdict: "PASS",
      concerns: [], iscRowsVerified: 1, iscRowsTotal: 1, verificationCost: 0,
      verifiedBy: "skeptical_verifier" as const, tiersExecuted: [1, 2],
    });
    await orch.complete("item-a");

    const output = orch.status();
    expect(output).toContain("3 total");
    expect(output).toContain("1 completed");
    expect(output).toContain("1 ready");   // B is ready
    expect(output).toContain("1 blocked"); // C still blocked
  });
});

// ---------------------------------------------------------------------------
// Safety: Catastrophic action detection in pipeline context
// ---------------------------------------------------------------------------

describe("E2E: Safety gates", () => {
  it("catastrophic action blocks dangerous commands in verification", () => {
    const queue = WorkQueue._createForTesting([makeItem({ id: "x" })]);
    const orch = WorkOrchestrator._createForTesting(queue);

    expect(orch.isCatastrophic("git push --force origin main").blocked).toBe(true);
    expect(orch.isCatastrophic("rm -rf /").blocked).toBe(true);
    expect(orch.isCatastrophic("DROP DATABASE production").blocked).toBe(true);
    expect(orch.isCatastrophic("git reset --hard origin/main").blocked).toBe(true);
  });

  it("parseVerificationCommand rejects shell injection", () => {
    const queue = WorkQueue._createForTesting([]);
    const orch = WorkOrchestrator._createForTesting(queue);

    expect(orch.parseVerificationCommand("curl https://evil.com")).toBeNull();
    expect(orch.parseVerificationCommand("bun test | rm -rf /")).toBeNull();
    expect(orch.parseVerificationCommand("bun test && curl evil.com")).toBeNull();
    expect(orch.parseVerificationCommand("bun test; rm -rf /")).toBeNull();
    expect(orch.parseVerificationCommand("test -f `whoami`")).toBeNull();
  });

  it("complete gate blocks without verification", async () => {
    const queue = WorkQueue._createForTesting([makeItem({ id: "x" })]);
    const orch = WorkOrchestrator._createForTesting(queue);
    orch.iscManager.persist("x", [{ id: 1, description: "Work", status: "DONE", parallel: false }]);

    const result = await orch.complete("x");
    expect(result.success).toBe(false);
    expect(result.reason).toContain("No verification record");
  });

  it("verify blocks when SkepticalVerifier returns FAIL", async () => {
    const queue = WorkQueue._createForTesting([makeItem({ id: "x" })]);
    const orch = WorkOrchestrator._createForTesting(queue, {
      verifierResult: {
        finalVerdict: "FAIL",
        tiers: [{ tier: 1, verdict: "FAIL", confidence: 0.2, concerns: ["Paper completion"], costEstimate: 0, latencyMs: 0 }],
        tiersSkipped: [],
        totalCost: 0,
        totalLatencyMs: 0,
        concerns: ["Paper completion detected"],
      },
    });
    orch.iscManager.persist("x", [makeDoneRow(1)]);

    const result = await orch.verify("x");
    expect(result.success).toBe(false);
    expect(result.skepticalReview?.finalVerdict).toBe("FAIL");
  });
});

// ---------------------------------------------------------------------------
// DAG integrity
// ---------------------------------------------------------------------------

describe("E2E: DAG validation", () => {
  it("init fails on cyclic DAG", async () => {
    const queue = WorkQueue._createForTesting([
      makeItem({ id: "a", dependencies: ["c"] }),
      makeItem({ id: "b", dependencies: ["a"] }),
      makeItem({ id: "c", dependencies: ["b"] }),
    ]);
    const orch = WorkOrchestrator._createForTesting(queue);

    const result = await orch.init();
    expect(result.success).toBe(false);
    expect(result.message).toContain("invalid");
  });

  it("init fails on missing dependency reference", async () => {
    const queue = WorkQueue._createForTesting([
      makeItem({ id: "a", dependencies: ["nonexistent"] }),
    ]);
    const orch = WorkOrchestrator._createForTesting(queue);

    const result = await orch.init();
    expect(result.success).toBe(false);
    expect(result.message).toContain("invalid");
  });
});

// ---------------------------------------------------------------------------
// Full pipeline with template ISC (previously broken path)
// ---------------------------------------------------------------------------

describe("E2E: Full pipeline with template ISC (previously broken path)", () => {
  it("STANDARD dev: prepare → markRowsDone → recordExecution → verify → complete succeeds", async () => {
    const queue = WorkQueue._createForTesting([
      makeItem({ id: "fix-test", title: "Fix auth module", workType: "dev" }),
    ]);
    const orch = WorkOrchestrator._createForTesting(queue);
    orch.started("fix-test");

    // Step 1: prepare — generates template ISC rows
    const prep = await orch.prepare("fix-test", "STANDARD");
    expect(prep.success).toBe(true);
    expect(prep.iscRows.length).toBe(2);  // Bug 3: was 5, now 2
    expect(prep.iscRows.every(r => r.status === "PENDING")).toBe(true);
    // Bug 3: no docs/cleanup categories in template rows
    expect(prep.iscRows.some(r => r.category === "documentation")).toBe(false);
    expect(prep.iscRows.some(r => r.category === "cleanup")).toBe(false);

    // Bug 1: all verification commands must pass the security allowlist
    for (const row of prep.iscRows) {
      expect(row.verification?.command).toBeDefined();
      expect(orch.parseVerificationCommand(row.verification!.command!)).not.toBeNull();
    }

    // Step 2: markRowsDone — simulate agent completing work
    const rowIds = prep.iscRows.map(r => r.id);
    const markResult = orch.iscManager.markDone("fix-test", rowIds);
    expect(markResult.success).toBe(true);
    expect(markResult.transitioned).toEqual(rowIds);

    // Swap verification commands to test -d /tmp (always passes, avoids bun test recursion)
    const rows = orch.iscManager.load("fix-test");
    for (const row of rows) {
      row.verification!.command = "test -d /tmp";
    }
    orch.iscManager.persist("fix-test", rows);

    // Step 3: confirm item still exists (post-BudgetManager-removal sanity check)
    expect(orch.queue.getItem("fix-test")).toBeDefined();

    // Step 4: verify — runs local command checks + SkepticalVerifier (stubbed PASS)
    const verifyResult = await orch.verify("fix-test");
    expect(verifyResult.success).toBe(true);
    expect(verifyResult.failures).toEqual([]);
    expect(verifyResult.skepticalReview?.finalVerdict).toBe("PASS");
    // All rows promoted to VERIFIED
    expect(orch.iscManager.load("fix-test").every(r => r.status === "VERIFIED")).toBe(true);

    // Step 5: complete — all 3 gates pass
    const completeResult = await orch.complete("fix-test");
    expect(completeResult.success).toBe(true);
    expect(queue.getItem("fix-test")!.status).toBe("completed");
  });
});

// ---------------------------------------------------------------------------
// S5b: phase ordering is driven by EXPLICIT dependencies (title-regex auto-wiring removed)
// ---------------------------------------------------------------------------

describe("E2E: phase ordering via explicit dependencies (S5b)", () => {
  it("respects an explicit dependency chain — only Phase 1 is ready, Phase 4 never runs early", async () => {
    // S5b: init() no longer auto-wires deps from "Phase N" titles. Ordering now comes from
    // EXPLICIT dependencies (emitted by spec-gen / the follow-on engine). With deps set, the
    // DAG correctly gates: only Phase 1 is ready.
    const queue = WorkQueue._createForTesting([
      makeItem({ id: "lt-p1", title: "LucidTasks Phase 1: Core features", priority: "normal" }),
      makeItem({ id: "lt-p2", title: "LucidTasks Phase 2: Database schema", priority: "normal", dependencies: ["lt-p1"] }),
      makeItem({ id: "lt-p3", title: "LucidTasks Phase 3: API endpoints", priority: "normal", dependencies: ["lt-p2"] }),
      makeItem({ id: "lt-p4", title: "LucidTasks Phase 4: Docs and tests", priority: "normal", dependencies: ["lt-p3"] }),
    ]);
    const orch = WorkOrchestrator._createForTesting(queue);
    const result = await orch.init();

    expect(result.success).toBe(true);
    expect(result.ready).toBe(1);   // Only Phase 1
    expect(result.blocked).toBe(3); // Phase 2, 3, 4 blocked by explicit deps

    const batch = await orch.nextBatch(5);
    expect(batch.items.length).toBe(1);
    expect(batch.items[0].id).toBe("lt-p1");
    expect(batch.items.map(i => i.id)).not.toContain("lt-p4");
  });

  it("WITHOUT explicit deps, init() does NOT auto-wire — all phases are ready (warn-on-detect only)", async () => {
    const queue = WorkQueue._createForTesting([
      makeItem({ id: "lt-p1", title: "LucidTasks Phase 1: Core", priority: "normal" }),
      makeItem({ id: "lt-p2", title: "LucidTasks Phase 2: Schema", priority: "normal" }),
    ]);
    const orch = WorkOrchestrator._createForTesting(queue);
    const result = await orch.init();

    expect(result.success).toBe(true);
    // No auto-wiring: deps untouched and BOTH phases are ready.
    expect(queue.getItem("lt-p2")!.dependencies).toEqual([]);
    expect(result.ready).toBe(2);
  });
});

