/**
 * CompletionPipeline.test.ts — integration tests using real WorkQueue + real ISCManager.
 *
 * Test posture (per Jm's preference):
 *   - Real WorkQueue via WorkQueue._createForTesting (in-memory state file).
 *   - Real ISCManager wrapping the queue.
 *   - No mocks of pipeline dependencies. Stages exercise actual storage paths.
 *   - Assertions through observed return values + observed queue/metadata state.
 *
 * KAYA_HOME isolation: several tests use a raw (unpatched) NotificationDispatcher
 * whose createJmTask/createHumanProxies write to TaskDB. TaskDB computes its DB
 * path lazily (dynamic import at first call), so pointing KAYA_HOME at a temp dir
 * here keeps those writes off the live task board. Historic leak from this file:
 * the "Manual steps: Item a/e/g" garbage on the live system.
 */

import { describe, it, expect, beforeAll, afterAll, spyOn } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join as joinPath } from "path";

const tempHome = mkdtempSync(joinPath(tmpdir(), "cp-test-"));
const ORIGINAL_KAYA_HOME = process.env.KAYA_HOME;
process.env.KAYA_HOME = tempHome;

// reportDone stages reach TaskDB through applyCompletionSideEffects (not the dispatcher),
// so drop any singleton pinned by an earlier file and re-resolve under tempHome.
beforeAll(async () => {
  // cross-skill-allowed: test isolation — resets the LucidTasks TaskDB singleton (resetTaskDB convention) before exercising the real cross-skill completion side effects
  const { resetTaskDB } = await import("../../../Productivity/LucidTasks/Tools/TaskDB.ts");
  resetTaskDB({ forgetPath: true });
});

afterAll(async () => {
  // Restore env for later files in shared-process runs — leaving a deleted
  // temp dir in KAYA_HOME breaks every subsequent path resolution.
  if (ORIGINAL_KAYA_HOME === undefined) delete process.env.KAYA_HOME;
  else process.env.KAYA_HOME = ORIGINAL_KAYA_HOME;
  // cross-skill-allowed: test isolation — resets the LucidTasks TaskDB singleton (resetTaskDB convention) so later test files re-resolve a clean path
  const { resetTaskDB } = await import("../../../Productivity/LucidTasks/Tools/TaskDB.ts");
  resetTaskDB({ forgetPath: true });
  rmSync(tempHome, { recursive: true, force: true });
});
import { CompletionPipeline, precondition, attachEvidence, markRowsDone, verifyAndAudit, triagePending, commitCompletion, mergeIfPossible, emitTraces, type AgentResults, type CompletionDeps, type StageCtx, type VerifyResult } from "./CompletionPipeline.ts";
import { WorkQueue, type WorkItem, type WorkItemVerification } from "./WorkQueue.ts";
import { ISCManager } from "./ISCManager.ts";
import { TransitionGuard } from "./TransitionGuard.ts";
import { NotificationDispatcher } from "./NotificationDispatcher.ts";
import type { SkepticalReviewResult } from "./SkepticalVerifier.ts";
import type { FaultClass, ISCRow } from "./WorkOrchestrator.ts";

const PASS_REVIEW: SkepticalReviewResult = {
  finalVerdict: "PASS",
  tiers: [
    { tier: 1, verdict: "PASS", confidence: 1.0, concerns: [], costEstimate: 0, latencyMs: 0 },
    { tier: 2, verdict: "PASS", confidence: 0.95, concerns: [], costEstimate: 0.01, latencyMs: 100 },
  ],
  tiersSkipped: [],
  totalCost: 0.01,
  totalLatencyMs: 100,
  concerns: [],
};

const FAIL_REVIEW: SkepticalReviewResult = {
  finalVerdict: "FAIL",
  tiers: [
    { tier: 1, verdict: "FAIL", confidence: 0.9, concerns: ["tier 1 concern"], costEstimate: 0, latencyMs: 0 },
  ],
  tiersSkipped: [],
  totalCost: 0,
  totalLatencyMs: 0,
  concerns: ["tier 1 concern"],
};

interface NotificationCalls {
  needsReview: Array<{ itemId: string; verdict: string; concerns: string[] }>;
  jmTask: Array<{ itemId: string; descriptions: string }>;
  humanProxies: Array<{ itemId: string; humanRows: ISCRow[]; returnIds: string[] }>;
}

/**
 * Real NotificationDispatcher with overrides that record calls instead of
 * dispatching. Pattern preferred over stubbing — keeps the real type/instance
 * while making side effects observable.
 */
function recordingDispatcher(
  queue: WorkQueue,
  proxyIdsToReturn: string[] = [],
): { dispatcher: NotificationDispatcher; calls: NotificationCalls } {
  const calls: NotificationCalls = { needsReview: [], jmTask: [], humanProxies: [] };
  const dispatcher = new NotificationDispatcher({ queue });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (dispatcher as any).emitNeedsReviewNotification = (
    itemId: string,
    _title: string,
    verdict: string,
    concerns: string[],
  ) => {
    calls.needsReview.push({ itemId, verdict, concerns });
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (dispatcher as any).createJmTask = async (itemId: string, _title: string, descriptions: string) => {
    calls.jmTask.push({ itemId, descriptions });
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (dispatcher as any).createHumanProxies = async (itemId: string, _title: string, humanRows: ISCRow[]) => {
    const ids = proxyIdsToReturn.length > 0 ? proxyIdsToReturn : humanRows.map((r) => `proxy-${itemId}-${r.id}`);
    calls.humanProxies.push({ itemId, humanRows, returnIds: ids });
    return ids;
  };
  return { dispatcher, calls };
}

function makeItem(id: string): WorkItem {
  return {
    id,
    title: `Item ${id}`,
    description: "",
    status: "in_progress",
    priority: "normal",
    dependencies: [],
    source: "manual",
    createdAt: new Date().toISOString(),
  };
}

function makeRow(id: number, status: ISCRow["status"]): ISCRow {
  return {
    id,
    description: `Row ${id}`,
    status,
    parallel: false,
  };
}

interface InsightPayload {
  source: string;
  type: string;
  title: string;
  content: string;
  tags: string[];
  metadata: Record<string, unknown>;
}

interface SetupOpts {
  verify?: (itemId: string) => Promise<VerifyResult>;
  cleanupWorktree?: (itemId: string) => Promise<void>;
  classifyFailure?: (concerns: string, failures: ISCRow[]) => FaultClass;
  notificationDispatcher?: NotificationDispatcher;
  resolveStaleReviewProxies?: (itemId: string) => void;
  complete?: (itemId: string) => Promise<{ success: boolean; reason?: string }>;
  mergeItem?: (itemId: string) => { merged: boolean; prUrl?: string; reason?: string };
  emitCompletion?: (itemId: string, label: string) => void;
  emitInsight?: (insight: InsightPayload) => Promise<void>;
  runEvaluatorPipeline?: (itemId: string) => Promise<void>;
}

const defaultPassingVerify = async (_id: string): Promise<VerifyResult> => ({
  success: true,
  failures: [],
  skepticalReview: PASS_REVIEW,
});

const defaultPassingComplete = async (_id: string): Promise<{ success: boolean; reason?: string }> => ({
  success: true,
});

const defaultMergeItemSkipped = (_id: string): { merged: boolean; prUrl?: string; reason?: string } => ({
  merged: false,
});

const defaultEmitCompletion = (_id: string, _label: string): void => {};

const defaultEmitInsight = async (_insight: InsightPayload): Promise<void> => {};

const defaultRunEvaluatorPipeline = async (_id: string): Promise<void> => {};

function setup(itemId: string, rows: ISCRow[] | null, opts: SetupOpts = {}) {
  const queue = WorkQueue._createForTesting([makeItem(itemId)]);
  const iscManager = new ISCManager(queue);
  if (rows) iscManager.persist(itemId, rows);
  const guard = new TransitionGuard(queue, "/dev/null");
  // Default to a recording dispatcher — the real createJmTask/createHumanProxies
  // write to TaskDB, and a raw dispatcher here is how test fixtures ("Manual
  // steps: Item a") leaked onto the live board in shared-process runs.
  const dispatcher = opts.notificationDispatcher ?? recordingDispatcher(queue).dispatcher;
  const deps: CompletionDeps = {
    queue,
    iscManager,
    verify: opts.verify ?? defaultPassingVerify,
    guard,
    notificationDispatcher: dispatcher,
    cleanupWorktree: opts.cleanupWorktree ?? (async () => {}),
    classifyFailure: opts.classifyFailure ?? (() => "item"),
    resolveStaleReviewProxies: opts.resolveStaleReviewProxies ?? (() => {}),
    complete: opts.complete ?? defaultPassingComplete,
    mergeItem: opts.mergeItem ?? defaultMergeItemSkipped,
    emitCompletion: opts.emitCompletion ?? defaultEmitCompletion,
    emitInsight: opts.emitInsight ?? defaultEmitInsight,
    runEvaluatorPipeline: opts.runEvaluatorPipeline ?? defaultRunEvaluatorPipeline,
  };
  const pipeline = new CompletionPipeline(deps);
  return { queue, iscManager, guard, dispatcher, deps, pipeline };
}

function makeCtx(itemId: string, queue: WorkQueue, iscManager: ISCManager, results: AgentResults): StageCtx {
  return {
    itemId,
    item: queue.getItem(itemId),
    iscRows: iscManager.load(itemId),
    results,
    opts: {},
  };
}

const emptyResults: AgentResults = { completedRowIds: [] };

describe("CompletionPipeline.precondition (F-004)", () => {
  it("rejects when every ISC row is EXECUTION_FAILED", async () => {
    const { pipeline } = setup("a", [
      makeRow(1, "EXECUTION_FAILED"),
      makeRow(2, "EXECUTION_FAILED"),
      makeRow(3, "EXECUTION_FAILED"),
    ]);

    const result = await pipeline.run("a", emptyResults);

    expect(result.kind).toBe("rejected");
    if (result.kind !== "rejected") return;
    expect(result.verdict).toBe("FAIL");
    expect(result.faultClass).toBe("infrastructure");
    expect(result.reason).toContain("EXECUTION_FAILED");
    expect(result.reason).toContain("re-run prepare");
  });

  it("does NOT reject when at least one row is non-EXECUTION_FAILED", async () => {
    const { pipeline } = setup("b", [
      makeRow(1, "EXECUTION_FAILED"),
      makeRow(2, "DONE"),
    ]);

    const result = await pipeline.run("b", emptyResults);

    // Pipeline runs all stages and emitTraces terminates "completed".
    expect(result.kind).toBe("completed");
  });

  it("does NOT fire when ISC rows are missing entirely (stage-level)", () => {
    // Direct stage call so later stages don't influence the assertion.
    const { queue, iscManager, deps } = setup("c", null);
    const ctx = makeCtx("c", queue, iscManager, emptyResults);

    const result = precondition(ctx, deps);

    // No rows means precondition is silent — later stages decide.
    expect((result as { kind: string }).kind).toBe("continue");
  });

  it("rejects with the exact reason text used by the legacy code path", async () => {
    const { pipeline } = setup("d", [makeRow(1, "EXECUTION_FAILED")]);

    const result = await pipeline.run("d", emptyResults);

    expect(result.kind).toBe("rejected");
    if (result.kind !== "rejected") return;
    expect(result.reason).toBe(
      "All ISC rows are EXECUTION_FAILED — work item produced no verifiable outcomes. Fix the spec and re-run prepare.",
    );
  });

  it("does not mutate ISC rows or item metadata", async () => {
    const { pipeline, iscManager, queue } = setup("e", [
      makeRow(1, "EXECUTION_FAILED"),
      makeRow(2, "EXECUTION_FAILED"),
    ]);
    const before = JSON.stringify(iscManager.load("e"));
    const itemBefore = JSON.stringify(queue.getItem("e"));

    await pipeline.run("e", emptyResults);

    expect(JSON.stringify(iscManager.load("e"))).toBe(before);
    expect(JSON.stringify(queue.getItem("e"))).toBe(itemBefore);
  });
});

describe("CompletionPipeline.attachEvidence", () => {
  it("persists adversarialConcerns to WorkItem metadata", async () => {
    const { pipeline, queue } = setup("a", [makeRow(1, "DONE")]);

    const result = await pipeline.run("a", {
      completedRowIds: [1],
      adversarialConcerns: ["Could the API key leak?", "What about timeouts?"],
    });

    expect(result.kind).toBe("completed");
    const meta = queue.getItem("a")?.metadata as Record<string, unknown> | undefined;
    expect(meta?.adversarialConcerns).toEqual(["Could the API key leak?", "What about timeouts?"]);
  });

  it("truncates executionLog to the last 20 entries", async () => {
    const { pipeline, queue } = setup("b", [makeRow(1, "DONE")]);
    const log = Array.from({ length: 35 }, (_, i) => `step-${i}`);

    await pipeline.run("b", { completedRowIds: [1], executionLog: log });

    const meta = queue.getItem("b")?.metadata as Record<string, unknown> | undefined;
    expect((meta?.executionLog as string[]).length).toBe(20);
    expect((meta?.executionLog as string[])[0]).toBe("step-15");
    expect((meta?.executionLog as string[])[19]).toBe("step-34");
  });

  it("attaches per-row evidence to matching ISC rows", async () => {
    const { pipeline, iscManager } = setup("c", [
      makeRow(1, "DONE"),
      makeRow(2, "DONE"),
    ]);

    await pipeline.run("c", {
      completedRowIds: [1, 2],
      rowEvidence: {
        1: { files: ["src/a.ts"], commands: ["bun test"], summary: "Added handler" },
        2: { summary: "Updated tests" },
      },
    });

    const rows = iscManager.load("c");
    expect(rows.find((r) => r.id === 1)?.evidence).toEqual({
      files: ["src/a.ts"],
      commands: ["bun test"],
      summary: "Added handler",
    });
    expect(rows.find((r) => r.id === 2)?.evidence).toEqual({ summary: "Updated tests" });
  });

  it("ignores evidence for non-existent row IDs without throwing", async () => {
    const { pipeline, iscManager } = setup("d", [makeRow(1, "DONE")]);

    await pipeline.run("d", {
      completedRowIds: [1],
      rowEvidence: { 99: { summary: "ghost" } },
    });

    const rows = iscManager.load("d");
    expect(rows[0].evidence).toBeUndefined();
  });

  it("is a no-op when no evidence fields are provided", async () => {
    const { pipeline, queue, iscManager } = setup("e", [makeRow(1, "DONE")]);
    const itemBefore = JSON.stringify(queue.getItem("e"));
    const rowsBefore = JSON.stringify(iscManager.load("e"));

    await pipeline.run("e", emptyResults);

    expect(JSON.stringify(queue.getItem("e"))).toBe(itemBefore);
    expect(JSON.stringify(iscManager.load("e"))).toBe(rowsBefore);
  });

  it("skips per-row evidence when no ISC rows exist (stage-level)", async () => {
    // Direct stage call: with no rows, attachEvidence drops rowEvidence silently.
    const { queue, iscManager, deps } = setup("f", null);
    const ctx = makeCtx("f", queue, iscManager, {
      completedRowIds: [],
      rowEvidence: { 1: { summary: "stranded" } },
    });

    const result = await attachEvidence(ctx, deps);

    expect((result as { kind: string }).kind).toBe("continue");
    const meta = queue.getItem("f")?.metadata as Record<string, unknown> | undefined;
    expect(meta?.iscRows).toBeUndefined();
  });
});

describe("CompletionPipeline.markRowsDone", () => {
  // Stage-level direct calls so triagePending (Slice 5) doesn't reject PENDING rows
  // that this test intentionally leaves behind.
  it("transitions specified rows from PENDING to DONE", async () => {
    const { iscManager, deps } = setup("a", [
      makeRow(1, "PENDING"),
      makeRow(2, "PENDING"),
      makeRow(3, "PENDING"),
    ]);
    const ctx = makeCtx("a", deps.queue, iscManager, { completedRowIds: [1, 2] });

    const result = await markRowsDone(ctx, deps);

    expect((result as { kind: string }).kind).toBe("continue");
    const rows = iscManager.load("a");
    expect(rows.find((r) => r.id === 1)?.status).toBe("DONE");
    expect(rows.find((r) => r.id === 2)?.status).toBe("DONE");
    expect(rows.find((r) => r.id === 3)?.status).toBe("PENDING"); // not in completedRowIds
  });

  it("does not transition DONE or VERIFIED rows", async () => {
    const { iscManager, deps } = setup("b", [
      makeRow(1, "VERIFIED"),
      makeRow(2, "DONE"),
    ]);
    const ctx = makeCtx("b", deps.queue, iscManager, { completedRowIds: [1, 2] });

    await markRowsDone(ctx, deps);

    const rows = iscManager.load("b");
    expect(rows.find((r) => r.id === 1)?.status).toBe("VERIFIED"); // preserved
    expect(rows.find((r) => r.id === 2)?.status).toBe("DONE"); // preserved
  });

  it("terminates with infrastructure fault when no ISC rows exist", async () => {
    // Item exists but has no ISC rows (e.g., prepare was never run)
    const { pipeline } = setup("c", null);

    const result = await pipeline.run("c", { completedRowIds: [1, 2] });

    expect(result.kind).toBe("rejected");
    if (result.kind !== "rejected") return;
    expect(result.faultClass).toBe("infrastructure");
    expect(result.reason).toContain("markRowsDone failed");
    expect(result.reason).toContain("run prepare first");
  });

  it("is a no-op when completedRowIds is empty", async () => {
    const { iscManager, deps } = setup("d", [
      makeRow(1, "PENDING"),
      makeRow(2, "PENDING"),
    ]);
    const before = JSON.stringify(iscManager.load("d"));
    const ctx = makeCtx("d", deps.queue, iscManager, { completedRowIds: [] });

    const result = await markRowsDone(ctx, deps);

    expect((result as { kind: string }).kind).toBe("continue");
    expect(JSON.stringify(iscManager.load("d"))).toBe(before);
  });
});

describe("CompletionPipeline.verifyAndAudit", () => {
  it("on verify success returns continue with verifyResult and fires no notifications", async () => {
    const { calls, dispatcher } = recordingDispatcher(WorkQueue._createForTesting([]));
    const { queue, iscManager, deps } = setup("a", [makeRow(1, "DONE")], {
      verify: async () => ({ success: true, failures: [], skepticalReview: PASS_REVIEW }),
      notificationDispatcher: dispatcher,
    });

    const ctx = makeCtx("a", queue, iscManager, { completedRowIds: [1] });
    const result = await verifyAndAudit(ctx, deps);

    expect(result.kind).toBe("continue");
    if (result.kind !== "continue") return;
    expect(result.ctxPatch?.verifyResult?.success).toBe(true);
    expect(result.ctxPatch?.verifyResult?.skepticalReview).toBe(PASS_REVIEW);
    expect(calls.needsReview.length).toBe(0);
    expect(calls.jmTask.length).toBe(0);
  });

  it("on verify failure terminates with rejected, populates skepticalReview, and includes faultClass", async () => {
    let cleanupCalled = false;
    const failures: ISCRow[] = [
      { id: 1, description: "missing test", status: "PENDING", parallel: false },
    ];
    const { dispatcher } = recordingDispatcher(WorkQueue._createForTesting([]));
    const { pipeline } = setup("b", [makeRow(1, "DONE")], {
      verify: async () => ({ success: false, failures, skepticalReview: FAIL_REVIEW }),
      cleanupWorktree: async () => { cleanupCalled = true; },
      classifyFailure: () => "item",
      notificationDispatcher: dispatcher,
    });

    const result = await pipeline.run("b", { completedRowIds: [1] });

    expect(result.kind).toBe("rejected");
    if (result.kind !== "rejected") return;
    expect(result.verdict).toBe("FAIL");
    expect(result.faultClass).toBe("item");
    expect(result.skepticalReview).toBe(FAIL_REVIEW);
    expect(result.reason).toBe("Verification failed: missing test");
    expect(cleanupCalled).toBe(true);
  });

  it("creates jm-task when attemptCount < 2", async () => {
    const queue = WorkQueue._createForTesting([makeItem("c")]);
    const iscManager = new ISCManager(queue);
    iscManager.persist("c", [makeRow(1, "DONE")]);
    const { dispatcher, calls } = recordingDispatcher(queue);
    const guard = new TransitionGuard(queue, "/dev/null");
    const deps: CompletionDeps = {
      queue,
      iscManager,
      verify: async () => ({
        success: false,
        failures: [{ id: 1, description: "broken assertion", status: "PENDING", parallel: false }],
        skepticalReview: FAIL_REVIEW,
      }),
      guard,
      notificationDispatcher: dispatcher,
      cleanupWorktree: async () => {},
      classifyFailure: () => "item",
    };
    const pipeline = new CompletionPipeline(deps);

    await pipeline.run("c", { completedRowIds: [1] });

    expect(calls.jmTask.length).toBe(1);
    expect(calls.jmTask[0].itemId).toBe("c");
    expect(calls.jmTask[0].descriptions).toContain("[FAIL] Verification failed");
    expect(calls.jmTask[0].descriptions).toContain("- broken assertion");
  });

  it("does NOT create jm-task when attemptCount >= 2 (escalation handles its own)", async () => {
    const item = makeItem("d");
    item.attempts = [
      { attemptNumber: 1, startedAt: new Date().toISOString(), endedAt: new Date().toISOString(), error: "first", strategy: "standard", iscRowsCompleted: 0, iscRowsTotal: 1 },
      { attemptNumber: 2, startedAt: new Date().toISOString(), endedAt: new Date().toISOString(), error: "second", strategy: "standard", iscRowsCompleted: 0, iscRowsTotal: 1 },
    ];
    const queue = WorkQueue._createForTesting([item]);
    const iscManager = new ISCManager(queue);
    iscManager.persist("d", [makeRow(1, "DONE")]);
    const { dispatcher, calls } = recordingDispatcher(queue);
    const guard = new TransitionGuard(queue, "/dev/null");
    const deps: CompletionDeps = {
      queue,
      iscManager,
      verify: async () => ({
        success: false,
        failures: [{ id: 1, description: "still broken", status: "PENDING", parallel: false }],
        skepticalReview: FAIL_REVIEW,
      }),
      guard,
      notificationDispatcher: dispatcher,
      cleanupWorktree: async () => {},
      classifyFailure: () => "item",
    };
    const pipeline = new CompletionPipeline(deps);

    await pipeline.run("d", { completedRowIds: [1] });

    expect(calls.needsReview.length).toBe(1);
    expect(calls.jmTask.length).toBe(0);
  });

  it("calls cleanupWorktree on verify failure", async () => {
    const cleanupCalls: string[] = [];
    const { pipeline } = setup("e", [makeRow(1, "DONE")], {
      verify: async () => ({
        success: false,
        failures: [{ id: 1, description: "fail", status: "PENDING", parallel: false }],
        skepticalReview: FAIL_REVIEW,
      }),
      cleanupWorktree: async (id) => { cleanupCalls.push(id); },
    });

    await pipeline.run("e", { completedRowIds: [1] });

    expect(cleanupCalls).toEqual(["e"]);
  });

  it("audit log entry carries adversarialConcerns from agentResults", async () => {
    const queue = WorkQueue._createForTesting([makeItem("f")]);
    const iscManager = new ISCManager(queue);
    iscManager.persist("f", [makeRow(1, "DONE")]);
    const auditEntries: Array<Record<string, unknown>> = [];
    const guard = new TransitionGuard(queue, "/dev/null");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (guard as any).appendAuditLog = (entry: Record<string, unknown>) => { auditEntries.push(entry); };
    const deps: CompletionDeps = {
      queue,
      iscManager,
      verify: async () => ({ success: true, failures: [], skepticalReview: PASS_REVIEW }),
      guard,
      notificationDispatcher: recordingDispatcher(queue).dispatcher,
      cleanupWorktree: async () => {},
      classifyFailure: () => "item",
    };

    const ctx = makeCtx("f", queue, iscManager, {
      completedRowIds: [1],
      adversarialConcerns: ["What about race conditions?", "Could the lock leak?"],
    });
    await verifyAndAudit(ctx, deps);

    expect(auditEntries.length).toBe(1);
    expect(auditEntries[0].adversarialConcerns).toEqual([
      "What about race conditions?",
      "Could the lock leak?",
    ]);
    expect(auditEntries[0].verdict).toBe("PASS");
    expect(auditEntries[0].iscRowSummary).toEqual(["1:DONE"]);
  });

  it("invokes classifyFailure with joined concerns string and failures array", async () => {
    const calls: Array<{ concerns: string; failureCount: number }> = [];
    const failures: ISCRow[] = [
      { id: 1, description: "concern A", status: "PENDING", parallel: false },
      { id: 2, description: "concern B", status: "PENDING", parallel: false },
    ];
    const { pipeline } = setup("g", [makeRow(1, "DONE")], {
      verify: async () => ({ success: false, failures, skepticalReview: FAIL_REVIEW }),
      classifyFailure: (concerns, fs) => {
        calls.push({ concerns, failureCount: fs.length });
        return "infrastructure";
      },
    });

    const result = await pipeline.run("g", { completedRowIds: [1] });

    expect(calls.length).toBe(1);
    expect(calls[0].concerns).toBe("concern A; concern B");
    expect(calls[0].failureCount).toBe(2);
    expect(result.kind).toBe("rejected");
    if (result.kind !== "rejected") return;
    expect(result.faultClass).toBe("infrastructure");
  });
});

describe("CompletionPipeline.resolveStaleProxies", () => {
  it("invokes the resolver capability with the itemId and continues unconditionally", async () => {
    const calls: string[] = [];
    // Run the full pipeline through to triagePending continue (no PENDING rows)
    const { pipeline } = setup("a", [makeRow(1, "DONE")], {
      resolveStaleReviewProxies: (id) => { calls.push(id); },
    });

    const result = await pipeline.run("a", { completedRowIds: [1] });

    expect(result.kind).toBe("completed");
    expect(calls).toEqual(["a"]);
  });

  it("still fires when triagePending will terminate blocked-on-human", async () => {
    const calls: string[] = [];
    const { dispatcher } = recordingDispatcher(WorkQueue._createForTesting([]));
    const { pipeline } = setup(
      "b",
      [{ id: 1, description: "needs human", status: "PENDING", parallel: false, disposition: "human-required" }],
      {
        resolveStaleReviewProxies: (id) => { calls.push(id); },
        notificationDispatcher: dispatcher,
      },
    );

    const result = await pipeline.run("b", { completedRowIds: [] });

    expect(result.kind).toBe("blocked-on-human");
    expect(calls).toEqual(["b"]);
  });
});

describe("CompletionPipeline.triagePending", () => {
  it("continues when no PENDING rows remain", async () => {
    const { iscManager, deps } = setup("a", [
      { id: 1, description: "verified work", status: "VERIFIED", parallel: false },
    ]);
    const ctx: StageCtx = {
      itemId: "a",
      item: deps.queue.getItem("a"),
      iscRows: iscManager.load("a"),
      results: { completedRowIds: [] },
      opts: {},
      verifyResult: { success: true, failures: [], skepticalReview: PASS_REVIEW },
    };

    const result = await triagePending(ctx, deps);

    expect((result as { kind: string }).kind).toBe("continue");
  });

  it("rejects with FAIL + faultClass=item when any PENDING row is incomplete-automatable", async () => {
    const { dispatcher } = recordingDispatcher(WorkQueue._createForTesting([]));
    const { pipeline } = setup(
      "b",
      [
        { id: 1, description: "verified", status: "VERIFIED", parallel: false },
        { id: 2, description: "should have run", status: "PENDING", parallel: false },
        { id: 3, description: "needs human", status: "PENDING", parallel: false, disposition: "human-required" },
      ],
      { notificationDispatcher: dispatcher },
    );

    const result = await pipeline.run("b", { completedRowIds: [] });

    expect(result.kind).toBe("rejected");
    if (result.kind !== "rejected") return;
    expect(result.verdict).toBe("FAIL");
    expect(result.faultClass).toBe("item");
    expect(result.reason).toContain("1 automatable ISC row(s) still PENDING");
    expect(result.reason).toContain("- ISC #2: should have run");
    expect(result.skepticalReview).toBe(PASS_REVIEW);
  });

  it("returns blocked-on-human with proxyIds when only human-required PENDING rows remain", async () => {
    const queue = WorkQueue._createForTesting([makeItem("c")]);
    const iscManager = new ISCManager(queue);
    iscManager.persist("c", [
      { id: 1, description: "verified work", status: "VERIFIED", parallel: false },
      { id: 2, description: "manual cleanup", status: "PENDING", parallel: false, disposition: "human-required" },
    ]);
    const { dispatcher, calls } = recordingDispatcher(queue, ["proxy-c-2"]);
    const guard = new TransitionGuard(queue, "/dev/null");
    const deps: CompletionDeps = {
      queue,
      iscManager,
      verify: defaultPassingVerify,
      guard,
      notificationDispatcher: dispatcher,
      cleanupWorktree: async () => {},
      classifyFailure: () => "item",
      resolveStaleReviewProxies: () => {},
    };
    const pipeline = new CompletionPipeline(deps);

    const result = await pipeline.run("c", { completedRowIds: [] });

    expect(result.kind).toBe("blocked-on-human");
    if (result.kind !== "blocked-on-human") return;
    expect(result.humanRows.map((r) => r.id)).toEqual([2]);
    expect(result.proxyIds).toEqual(["proxy-c-2"]);
    expect(calls.humanProxies.length).toBe(1);
    // Per-row [Human Action] LucidTasks in "Kaya — Needs Jm" cover the human
    // routing; the old parent-level escalation task would be a duplicate.
    expect(calls.jmTask.length).toBe(0);
  });

  it("marks the item blocked and writes manualRows + humanProxyIds metadata", async () => {
    const queue = WorkQueue._createForTesting([makeItem("d")]);
    const iscManager = new ISCManager(queue);
    iscManager.persist("d", [
      { id: 1, description: "manual A", status: "PENDING", parallel: false, disposition: "human-required" },
      { id: 2, description: "manual B", status: "PENDING", parallel: false, disposition: "human-required" },
    ]);
    const { dispatcher } = recordingDispatcher(queue, ["proxy-d-1", "proxy-d-2"]);
    const guard = new TransitionGuard(queue, "/dev/null");
    const deps: CompletionDeps = {
      queue,
      iscManager,
      verify: defaultPassingVerify,
      guard,
      notificationDispatcher: dispatcher,
      cleanupWorktree: async () => {},
      classifyFailure: () => "item",
      resolveStaleReviewProxies: () => {},
    };
    const pipeline = new CompletionPipeline(deps);

    await pipeline.run("d", { completedRowIds: [] });

    const item = queue.getItem("d");
    expect(item?.status).toBe("blocked");
    const meta = item?.metadata as Record<string, unknown> | undefined;
    expect(meta?.manualRows).toEqual([
      { id: 1, description: "manual A" },
      { id: 2, description: "manual B" },
    ]);
    expect(meta?.humanProxyIds).toEqual(["proxy-d-1", "proxy-d-2"]);
  });

  it("appends an audit log entry summarizing the human-required routing", async () => {
    const queue = WorkQueue._createForTesting([makeItem("e")]);
    const iscManager = new ISCManager(queue);
    iscManager.persist("e", [
      { id: 1, description: "verified", status: "VERIFIED", parallel: false },
      { id: 2, description: "manual fix", status: "PENDING", parallel: false, disposition: "human-required" },
    ]);
    const { dispatcher } = recordingDispatcher(queue, ["proxy-e-2"]);
    const guard = new TransitionGuard(queue, "/dev/null");
    const auditEntries: Array<Record<string, unknown>> = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (guard as any).appendAuditLog = (entry: Record<string, unknown>) => { auditEntries.push(entry); };
    const deps: CompletionDeps = {
      queue,
      iscManager,
      verify: defaultPassingVerify,
      guard,
      notificationDispatcher: dispatcher,
      cleanupWorktree: async () => {},
      classifyFailure: () => "item",
      resolveStaleReviewProxies: () => {},
    };
    const pipeline = new CompletionPipeline(deps);

    await pipeline.run("e", { completedRowIds: [] });

    // Two entries: one from verifyAndAudit (PASS verdict, post-verify), one from triagePending (human-required summary)
    expect(auditEntries.length).toBe(2);
    const triageEntry = auditEntries[1];
    expect(triageEntry.verdict).toBe("PASS");
    expect((triageEntry.concerns as string[])[0]).toContain("1 human-required row(s) remain: #2");
    expect((triageEntry.concerns as string[])[0]).toContain("Created 1 HUMAN proxies");
    expect(triageEntry.iscRowSummary).toEqual(["1:VERIFIED", "2:PENDING"]);
  });

  it("does not invoke createHumanProxies when only incomplete-automatable rows are pending", async () => {
    const queue = WorkQueue._createForTesting([makeItem("f")]);
    const iscManager = new ISCManager(queue);
    iscManager.persist("f", [
      { id: 1, description: "should be done", status: "PENDING", parallel: false },
    ]);
    const { dispatcher, calls } = recordingDispatcher(queue);
    const guard = new TransitionGuard(queue, "/dev/null");
    const deps: CompletionDeps = {
      queue,
      iscManager,
      verify: defaultPassingVerify,
      guard,
      notificationDispatcher: dispatcher,
      cleanupWorktree: async () => {},
      classifyFailure: () => "item",
      resolveStaleReviewProxies: () => {},
    };
    const pipeline = new CompletionPipeline(deps);

    await pipeline.run("f", { completedRowIds: [] });

    expect(calls.humanProxies.length).toBe(0);
    expect(calls.jmTask.length).toBe(0);
  });
});

describe("CompletionPipeline.commitCompletion", () => {
  function recordingComplete(result: { success: boolean; reason?: string }): {
    fn: (id: string) => Promise<{ success: boolean; reason?: string }>;
    calls: string[];
  } {
    const calls: string[] = [];
    const fn = async (id: string) => {
      calls.push(id);
      return result;
    };
    return { fn, calls };
  }

  it("on complete success reaches completed terminal, calls deps.complete, and writes no commit-completion audit entry", async () => {
    const queue = WorkQueue._createForTesting([makeItem("a")]);
    const iscManager = new ISCManager(queue);
    iscManager.persist("a", [{ id: 1, description: "row", status: "VERIFIED", parallel: false }]);
    const auditEntries: Array<Record<string, unknown>> = [];
    const guard = new TransitionGuard(queue, "/dev/null");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (guard as any).appendAuditLog = (entry: Record<string, unknown>) => { auditEntries.push(entry); };
    const { fn, calls } = recordingComplete({ success: true });
    const deps: CompletionDeps = {
      queue,
      iscManager,
      verify: defaultPassingVerify,
      guard,
      notificationDispatcher: recordingDispatcher(queue).dispatcher,
      cleanupWorktree: async () => {},
      classifyFailure: () => "item",
      resolveStaleReviewProxies: () => {},
      complete: fn,
      mergeItem: defaultMergeItemSkipped,
      emitCompletion: defaultEmitCompletion,
      emitInsight: defaultEmitInsight,
      runEvaluatorPipeline: defaultRunEvaluatorPipeline,
    };
    const pipeline = new CompletionPipeline(deps);

    const result = await pipeline.run("a", { completedRowIds: [] });

    expect(result.kind).toBe("completed");
    expect(calls).toEqual(["a"]);
    // verifyAndAudit emits one PASS entry on success; commitCompletion emits none on success
    expect(auditEntries.length).toBe(1);
    expect(auditEntries[0].verdict).toBe("PASS");
  });

  it("on complete failure terminates rejected with FAIL + faultClass=item + skepticalReview", async () => {
    const { fn } = recordingComplete({ success: false, reason: "Tier 1 code checks did not execute" });
    const { pipeline } = setup("b", [{ id: 1, description: "row", status: "VERIFIED", parallel: false }], {
      complete: fn,
    });

    const result = await pipeline.run("b", { completedRowIds: [] });

    expect(result.kind).toBe("rejected");
    if (result.kind !== "rejected") return;
    expect(result.verdict).toBe("FAIL");
    expect(result.faultClass).toBe("item");
    expect(result.reason).toBe("Completion gate rejected: Tier 1 code checks did not execute");
    expect(result.skepticalReview).toBe(PASS_REVIEW);
  });

  it("appends audit log entry with verdict FAIL, concerns, tiers, cost, iscRowSummary, failureReason", async () => {
    const queue = WorkQueue._createForTesting([makeItem("c")]);
    const iscManager = new ISCManager(queue);
    iscManager.persist("c", [
      { id: 1, description: "row 1", status: "VERIFIED", parallel: false },
      { id: 2, description: "row 2", status: "DONE", parallel: false },
    ]);
    const auditEntries: Array<Record<string, unknown>> = [];
    const guard = new TransitionGuard(queue, "/dev/null");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (guard as any).appendAuditLog = (entry: Record<string, unknown>) => { auditEntries.push(entry); };
    const { fn } = recordingComplete({ success: false, reason: "spec parsing error" });
    const deps: CompletionDeps = {
      queue,
      iscManager,
      verify: defaultPassingVerify,
      guard,
      notificationDispatcher: recordingDispatcher(queue).dispatcher,
      cleanupWorktree: async () => {},
      classifyFailure: () => "item",
      resolveStaleReviewProxies: () => {},
      complete: fn,
    };
    const pipeline = new CompletionPipeline(deps);

    await pipeline.run("c", { completedRowIds: [] });

    // Two audit entries: verifyAndAudit (PASS), commitCompletion (FAIL)
    expect(auditEntries.length).toBe(2);
    const failEntry = auditEntries[1];
    expect(failEntry.verdict).toBe("FAIL");
    expect(failEntry.itemId).toBe("c");
    expect(failEntry.itemTitle).toBe("Item c");
    expect(failEntry.concerns).toEqual(["Completion gate rejected: spec parsing error"]);
    expect(failEntry.tiersExecuted).toEqual([1, 2]);
    expect(failEntry.verificationCost).toBe(0.01);
    expect(failEntry.iscRowSummary).toEqual(["1:VERIFIED", "2:DONE"]);
    expect(failEntry.failureReason).toBe("spec parsing error");
  });

  it("does NOT append a commit-completion audit entry on success", async () => {
    const queue = WorkQueue._createForTesting([makeItem("d")]);
    const iscManager = new ISCManager(queue);
    iscManager.persist("d", [{ id: 1, description: "row", status: "VERIFIED", parallel: false }]);
    const auditEntries: Array<Record<string, unknown>> = [];
    const guard = new TransitionGuard(queue, "/dev/null");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (guard as any).appendAuditLog = (entry: Record<string, unknown>) => { auditEntries.push(entry); };
    const { fn } = recordingComplete({ success: true });
    const deps: CompletionDeps = {
      queue,
      iscManager,
      verify: defaultPassingVerify,
      guard,
      notificationDispatcher: recordingDispatcher(queue).dispatcher,
      cleanupWorktree: async () => {},
      classifyFailure: () => "item",
      resolveStaleReviewProxies: () => {},
      complete: fn,
      mergeItem: defaultMergeItemSkipped,
      emitCompletion: defaultEmitCompletion,
      emitInsight: defaultEmitInsight,
      runEvaluatorPipeline: defaultRunEvaluatorPipeline,
    };
    const pipeline = new CompletionPipeline(deps);

    await pipeline.run("d", { completedRowIds: [] });

    // Only the verifyAndAudit PASS entry, no commit-completion entry on success
    expect(auditEntries.length).toBe(1);
    expect(auditEntries[0].verdict).toBe("PASS");
  });

  it("uses an empty iscRowSummary when no ISC rows exist (defensive)", async () => {
    // Direct stage call so attachEvidence/markRowsDone don't reject the no-rows case
    const queue = WorkQueue._createForTesting([makeItem("e")]);
    const iscManager = new ISCManager(queue);
    const auditEntries: Array<Record<string, unknown>> = [];
    const guard = new TransitionGuard(queue, "/dev/null");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (guard as any).appendAuditLog = (entry: Record<string, unknown>) => { auditEntries.push(entry); };
    const { fn } = recordingComplete({ success: false, reason: "no rows somehow" });
    const deps: CompletionDeps = {
      queue,
      iscManager,
      verify: defaultPassingVerify,
      guard,
      notificationDispatcher: recordingDispatcher(queue).dispatcher,
      cleanupWorktree: async () => {},
      classifyFailure: () => "item",
      resolveStaleReviewProxies: () => {},
      complete: fn,
    };
    const ctx: StageCtx = {
      itemId: "e",
      item: queue.getItem("e"),
      iscRows: [],
      results: { completedRowIds: [] },
      opts: {},
      verifyResult: { success: true, failures: [], skepticalReview: PASS_REVIEW },
    };

    const result = await commitCompletion(ctx, deps);

    expect((result as { kind: string }).kind).toBe("terminate");
    expect(auditEntries.length).toBe(1);
    expect(auditEntries[0].iscRowSummary).toEqual([]);
  });

  it("uses an undefined reason gracefully when complete returns no reason", async () => {
    const { fn } = recordingComplete({ success: false });
    const { pipeline } = setup("f", [{ id: 1, description: "row", status: "VERIFIED", parallel: false }], {
      complete: fn,
    });

    const result = await pipeline.run("f", { completedRowIds: [] });

    expect(result.kind).toBe("rejected");
    if (result.kind !== "rejected") return;
    expect(result.reason).toBe("Completion gate rejected: unknown");
  });
});

describe("CompletionPipeline.mergeIfPossible", () => {
  it("on merged === true writes mergeStatus + prUrl and outcome.mergeStatus is 'merged'", async () => {
    const { pipeline, queue } = setup("a", [{ id: 1, description: "row", status: "VERIFIED", parallel: false }], {
      mergeItem: () => ({ merged: true, prUrl: "https://github.com/[user]/repo/pull/42" }),
    });

    const result = await pipeline.run("a", { completedRowIds: [] });

    expect(result.kind).toBe("completed");
    if (result.kind !== "completed") return;
    expect(result.mergeStatus).toBe("merged");
    const meta = queue.getItem("a")?.metadata as Record<string, unknown> | undefined;
    expect(meta?.mergeStatus).toBe("merged");
    expect(meta?.prUrl).toBe("https://github.com/[user]/repo/pull/42");
  });

  // workqueue-metadata-clobber-20260730 round 3: production's real mergeItem wiring
  // (WorkOrchestrator.ts's mergeItem callback hardcodes Integrator strategy "direct")
  // returns { merged: true } with NO prUrl property at all — only the "pr" strategy's
  // ghCreatePr() path sets it (Integrator.ts:386 vs :409). Before this fix,
  // `prUrl: result.prUrl` passed `undefined` unconditionally, which routed through
  // setMetadata's loud-skip path and fired console.error on every successful
  // production auto-merge — the hottest completion path in the file. Regression: a
  // direct-strategy ("no prUrl on the result") completion must emit ZERO console.error.
  it("on merged === true with NO prUrl (the real 'direct' strategy shape) writes mergeStatus alone and emits ZERO console.error", async () => {
    const { pipeline, queue } = setup("f-direct", [{ id: 1, description: "row", status: "VERIFIED", parallel: false }], {
      mergeItem: () => ({ merged: true }), // exactly Integrator.ts:409's direct-success return — no prUrl key
    });

    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      const result = await pipeline.run("f-direct", { completedRowIds: [] });

      expect(result.kind).toBe("completed");
      if (result.kind !== "completed") return;
      expect(result.mergeStatus).toBe("merged");
      const meta = queue.getItem("f-direct")?.metadata as Record<string, unknown> | undefined;
      expect(meta?.mergeStatus).toBe("merged");
      expect("prUrl" in (meta ?? {})).toBe(false); // omitted, not set to undefined

      expect(errorSpy).not.toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("on merged === false with reason writes pending_approval + mergeReason", async () => {
    const { pipeline, queue } = setup("b", [{ id: 1, description: "row", status: "VERIFIED", parallel: false }], {
      mergeItem: () => ({ merged: false, reason: "Merge conflict detected" }),
    });

    const result = await pipeline.run("b", { completedRowIds: [] });

    expect(result.kind).toBe("completed");
    if (result.kind !== "completed") return;
    expect(result.mergeStatus).toBe("pending_approval");
    const meta = queue.getItem("b")?.metadata as Record<string, unknown> | undefined;
    expect(meta?.mergeStatus).toBe("pending_approval");
    expect(meta?.mergeReason).toBe("Merge conflict detected");
  });

  it("on merged === false without reason writes no merge metadata and outcome.mergeStatus is 'skipped'", async () => {
    const { pipeline, queue } = setup("c", [{ id: 1, description: "row", status: "VERIFIED", parallel: false }], {
      mergeItem: () => ({ merged: false }),
    });

    const result = await pipeline.run("c", { completedRowIds: [] });

    expect(result.kind).toBe("completed");
    if (result.kind !== "completed") return;
    expect(result.mergeStatus).toBe("skipped");
    const meta = queue.getItem("c")?.metadata as Record<string, unknown> | undefined;
    expect(meta?.mergeStatus).toBeUndefined();
    expect(meta?.mergeReason).toBeUndefined();
    expect(meta?.prUrl).toBeUndefined();
  });

  it("on thrown exception logs warning and still terminates completed with mergeStatus 'skipped'", async () => {
    const { pipeline, queue } = setup("d", [{ id: 1, description: "row", status: "VERIFIED", parallel: false }], {
      mergeItem: () => { throw new Error("gh CLI exploded"); },
    });

    const result = await pipeline.run("d", { completedRowIds: [] });

    expect(result.kind).toBe("completed");
    if (result.kind !== "completed") return;
    expect(result.mergeStatus).toBe("skipped");
    const meta = queue.getItem("d")?.metadata as Record<string, unknown> | undefined;
    expect(meta?.mergeStatus).toBeUndefined();
  });

  it("ctx.mergeStatus from the stage carries forward into emitTraces' completed outcome", async () => {
    let capturedMergeStatus: "merged" | "pending_approval" | "skipped" | undefined;
    const { queue, iscManager, deps } = setup("e", [{ id: 1, description: "row", status: "VERIFIED", parallel: false }], {
      mergeItem: () => ({ merged: true, prUrl: "https://example.com/pr" }),
    });
    const ctx: StageCtx = {
      itemId: "e",
      item: queue.getItem("e"),
      iscRows: iscManager.load("e"),
      results: { completedRowIds: [] },
      opts: {},
      verifyResult: { success: true, failures: [], skepticalReview: PASS_REVIEW },
    };

    const mergeResult = await mergeIfPossible(ctx, deps);
    expect(mergeResult.kind).toBe("continue");
    if (mergeResult.kind !== "continue") return;
    capturedMergeStatus = mergeResult.ctxPatch?.mergeStatus;
    expect(capturedMergeStatus).toBe("merged");

    const ctxAfterMerge: StageCtx = { ...ctx, ...(mergeResult.ctxPatch ?? {}) };
    const emitResult = await emitTraces(ctxAfterMerge, deps);
    expect(emitResult.kind).toBe("terminate");
    if (emitResult.kind !== "terminate") return;
    expect(emitResult.outcome.kind).toBe("completed");
    if (emitResult.outcome.kind !== "completed") return;
    expect(emitResult.outcome.mergeStatus).toBe("merged");
  });

  // E2: WorkOrchestrator.ts:311 used to hardcode skipSessionLock:true on every
  // completion, unconditionally bypassing the Integrator's interactive-session-lock
  // defer (Integrator.ts:148-194/321-328). The fix threads a caller-controlled
  // CompletionOpts.skipSessionLock through ctx.opts into deps.mergeItem's second
  // argument — DEFAULT false (lock-respecting) unless the caller (an explicit
  // interactive opt-in) sets it true.
  it("forwards ctx.opts.skipSessionLock:true to deps.mergeItem's second argument", async () => {
    let captured: boolean | undefined | "not-called" = "not-called";
    const { pipeline } = setup("g", [{ id: 1, description: "row", status: "VERIFIED", parallel: false }], {
      mergeItem: ((_id: string, skipSessionLock?: boolean) => {
        captured = skipSessionLock;
        return { merged: false };
      }) as unknown as (itemId: string) => { merged: boolean; prUrl?: string; reason?: string },
    });

    await pipeline.run("g", { completedRowIds: [] }, { skipSessionLock: true });

    expect(captured).toBe(true);
  });

  it("forwards ctx.opts.skipSessionLock:undefined (no opts) to deps.mergeItem — never silently defaults to true", async () => {
    let captured: boolean | undefined | "not-called" = "not-called";
    const { pipeline } = setup("h", [{ id: 1, description: "row", status: "VERIFIED", parallel: false }], {
      mergeItem: ((_id: string, skipSessionLock?: boolean) => {
        captured = skipSessionLock;
        return { merged: false };
      }) as unknown as (itemId: string) => { merged: boolean; prUrl?: string; reason?: string },
    });

    await pipeline.run("h", { completedRowIds: [] });

    expect(captured).toBeUndefined();
  });
});

describe("CompletionPipeline.emitTraces", () => {
  function recordingTraceDeps() {
    const completionCalls: Array<{ id: string; label: string }> = [];
    const insightCalls: InsightPayload[] = [];
    const evaluatorCalls: string[] = [];
    return {
      completionCalls,
      insightCalls,
      evaluatorCalls,
      emitCompletion: (id: string, label: string) => { completionCalls.push({ id, label }); },
      emitInsight: async (insight: InsightPayload) => { insightCalls.push(insight); },
      runEvaluatorPipeline: async (id: string) => { evaluatorCalls.push(id); },
    };
  }

  it("calls emitCompletion, emitInsight, runEvaluatorPipeline and terminates completed", async () => {
    const rec = recordingTraceDeps();
    const { pipeline } = setup("a", [{ id: 1, description: "row", status: "VERIFIED", parallel: false }], {
      emitCompletion: rec.emitCompletion,
      emitInsight: rec.emitInsight,
      runEvaluatorPipeline: rec.runEvaluatorPipeline,
    });

    const result = await pipeline.run("a", { completedRowIds: [] });

    expect(result.kind).toBe("completed");
    expect(rec.completionCalls.length).toBe(1);
    expect(rec.completionCalls[0]).toEqual({ id: "a", label: "executive" });
    expect(rec.insightCalls.length).toBe(1);
    expect(rec.insightCalls[0].source).toBe("AutonomousWork");
    expect(rec.insightCalls[0].tags).toEqual(["work-completion", "pass"]);
    expect(rec.evaluatorCalls).toEqual(["a"]);
  });

  it("swallows emitInsight rejection and still terminates completed", async () => {
    const { pipeline } = setup("b", [{ id: 1, description: "row", status: "VERIFIED", parallel: false }], {
      emitInsight: () => Promise.reject(new Error("insight bus down")),
    });

    const result = await pipeline.run("b", { completedRowIds: [] });

    expect(result.kind).toBe("completed");
    // Wait a microtask so the rejected promise's .catch() runs without unhandled-rejection noise.
    await Promise.resolve();
  });

  it("swallows runEvaluatorPipeline rejection and still terminates completed", async () => {
    const { pipeline } = setup("c", [{ id: 1, description: "row", status: "VERIFIED", parallel: false }], {
      runEvaluatorPipeline: () => Promise.reject(new Error("eval pipeline broke")),
    });

    const result = await pipeline.run("c", { completedRowIds: [] });

    expect(result.kind).toBe("completed");
    await Promise.resolve();
  });

  it("completed outcome carries skepticalReview from ctx.verifyResult", async () => {
    const { queue, iscManager, deps } = setup("d", [{ id: 1, description: "row", status: "VERIFIED", parallel: false }]);
    const ctx: StageCtx = {
      itemId: "d",
      item: queue.getItem("d"),
      iscRows: iscManager.load("d"),
      results: { completedRowIds: [] },
      opts: {},
      verifyResult: { success: true, failures: [], skepticalReview: PASS_REVIEW },
      mergeStatus: "skipped",
    };

    const result = await emitTraces(ctx, deps);

    expect(result.kind).toBe("terminate");
    if (result.kind !== "terminate") return;
    expect(result.outcome.kind).toBe("completed");
    if (result.outcome.kind !== "completed") return;
    expect(result.outcome.skepticalReview).toBe(PASS_REVIEW);
  });

  it("completed outcome carries ctx.mergeStatus through to the terminal", async () => {
    const { queue, iscManager, deps } = setup("e", [{ id: 1, description: "row", status: "VERIFIED", parallel: false }]);
    const ctx: StageCtx = {
      itemId: "e",
      item: queue.getItem("e"),
      iscRows: iscManager.load("e"),
      results: { completedRowIds: [] },
      opts: {},
      verifyResult: { success: true, failures: [], skepticalReview: PASS_REVIEW },
      mergeStatus: "pending_approval",
    };

    const result = await emitTraces(ctx, deps);

    expect(result.kind).toBe("terminate");
    if (result.kind !== "terminate") return;
    expect(result.outcome.kind).toBe("completed");
    if (result.outcome.kind !== "completed") return;
    expect(result.outcome.mergeStatus).toBe("pending_approval");
  });
});
