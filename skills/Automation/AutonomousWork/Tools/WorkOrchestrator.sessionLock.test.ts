/**
 * WorkOrchestrator.sessionLock.test.ts — E2: interactive-session-lock respect at
 * reportDone's auto-merge step.
 *
 * Prior bug: WorkOrchestrator.ts:311 hardcoded `skipSessionLock: true` on every
 * completion, unconditionally bypassing Integrator's interactive-session-lock defer
 * (Integrator.ts checkInteractiveSessionLock / _mergeItemCore ~line 321-328). Tolerable
 * when only an attended human ran report-done; unsafe once HeadlessWorkDriver runs it
 * unattended nightly — an active Jm interactive session's uncommitted work could race a
 * background merge's working-tree sync.
 *
 * Fix: reportDone(itemId, agentResults, opts) accepts { skipSessionLock?: boolean },
 * DEFAULT false (lock-respecting), threaded through CompletionPipeline's
 * CompletionOpts.skipSessionLock into Integrator.mergeItem's own opts.skipSessionLock.
 * Only an explicit opt-in (WorkOrchestratorCLI's --interactive-session flag, used by the
 * attended Orchestrate.md Executive flow) sets it true.
 *
 * These tests exercise the REAL Integrator — WorkOrchestrator always constructs
 * `new Integrator(this.queue)` internally (no DI seam) — against a scratch KAYA_HOME so
 * the lock file lives at <scratch>/MEMORY/STATE/interactive-session.lock, never the live
 * one. `metadata.worktreeBranch` is a synthetic nonexistent-branch name: when the lock
 * check is bypassed/absent, Integrator's `detectConflict` runs a real but READ-ONLY
 * `git merge-base`/`git merge-tree` lookup against THIS repo, finds no such ref, and
 * safely reports "conflict" without ever attempting a real merge/push/commit. No
 * production files, refs, or the live interactive-session.lock are ever touched.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join as joinPath } from "path";

const tempHome = mkdtempSync(joinPath(tmpdir(), "wo-sessionlock-test-"));
const ORIGINAL_KAYA_HOME = process.env.KAYA_HOME;
process.env.KAYA_HOME = tempHome;

beforeAll(async () => {
});

afterAll(async () => {
  if (ORIGINAL_KAYA_HOME === undefined) delete process.env.KAYA_HOME;
  else process.env.KAYA_HOME = ORIGINAL_KAYA_HOME;
  rmSync(tempHome, { recursive: true, force: true });
});

import { WorkOrchestrator, type ISCRow } from "./WorkOrchestrator.ts";
import { WorkQueue, type WorkItem } from "./WorkQueue.ts";
import type { SkepticalReviewResult } from "./SkepticalVerifier.ts";

const PASS_REVIEW: SkepticalReviewResult = {
  finalVerdict: "PASS",
  tiers: [{ tier: 1, verdict: "PASS", confidence: 1, concerns: [], costEstimate: 0, latencyMs: 0 }],
  tiersSkipped: [],
  totalCost: 0,
  totalLatencyMs: 0,
  concerns: [],
};

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
    effort: "STANDARD",
    workType: "dev",
  };
}

function makeRow(id: number): ISCRow {
  return {
    id,
    description: `Row ${id}`,
    status: "PENDING",
    parallel: false,
    verification: { method: "test", command: "test -d /tmp", success_criteria: "exists" },
  };
}

/** Fresh, valid interactive-session.lock at the scratch KAYA_HOME. `ageMs` backdates
 *  the file's mtime so callers can also exercise Integrator's existing >2h staleness
 *  check (checkInteractiveSessionLock returns null for stale locks). */
function writeLockFile(ageMs = 0): string {
  const dir = joinPath(tempHome, "MEMORY", "STATE");
  mkdirSync(dir, { recursive: true });
  const lockPath = joinPath(dir, "interactive-session.lock");
  writeFileSync(lockPath, JSON.stringify({ sessionId: "test-session", startedAt: new Date().toISOString(), pid: 12345 }));
  if (ageMs > 0) {
    const past = new Date(Date.now() - ageMs);
    utimesSync(lockPath, past, past);
  }
  return lockPath;
}

/** Sets up one item ready to reach reportDone's "completed" outcome with a synthetic
 *  worktreeBranch (never a real ref) so the merge step reaches Integrator's session-lock
 *  check without ever attempting a real git merge/push. */
function setupItem(id: string): WorkOrchestrator {
  const queue = WorkQueue._createForTesting([makeItem(id)]);
  const orch = WorkOrchestrator._createForTesting(queue, { verifierResult: PASS_REVIEW });
  orch.iscManager.persist(id, [makeRow(1)]);
  queue.setMetadata(id, { worktreeBranch: `__nonexistent_test_branch_${id}_${Date.now()}__` });
  return orch;
}

describe("WorkOrchestrator.reportDone — interactive-session-lock respect (E2)", () => {
  it("DEFAULT (no opts): fresh lock present → merge deferred, reportDone still succeeds", async () => {
    writeLockFile();
    const orch = setupItem("lock-default");

    const result = await orch.reportDone("lock-default", { completedRowIds: [1] });

    expect(result.success).toBe(true);
    const item = orch.queue.getItem("lock-default");
    expect(item?.status).toBe("completed");
    expect(item?.metadata?.mergeStatus).toBe("deferred");
    expect(String(item?.metadata?.mergeReason ?? "")).toContain("interactive session active");
  });

  it("explicit opt-in (skipSessionLock:true): fresh lock present → lock bypassed, merge attempted (not deferred)", async () => {
    writeLockFile();
    const orch = setupItem("lock-optin");

    const result = await orch.reportDone("lock-optin", { completedRowIds: [1] }, { skipSessionLock: true });

    expect(result.success).toBe(true);
    const item = orch.queue.getItem("lock-optin");
    expect(item?.metadata?.mergeStatus).not.toBe("deferred");
  });

  it("stale lock (>2h old): DEFAULT opts → treated as absent, merge proceeds (not deferred)", async () => {
    writeLockFile(3 * 60 * 60 * 1000); // 3h old — past Integrator's 2h staleness threshold
    const orch = setupItem("lock-stale");

    const result = await orch.reportDone("lock-stale", { completedRowIds: [1] });

    expect(result.success).toBe(true);
    const item = orch.queue.getItem("lock-stale");
    expect(item?.metadata?.mergeStatus).not.toBe("deferred");
  });

  it("DEFAULT (no opts): no lock file at all → merge proceeds (not deferred)", async () => {
    // No writeLockFile() call — scratch KAYA_HOME has no interactive-session.lock.
    const orch = setupItem("lock-absent");

    const result = await orch.reportDone("lock-absent", { completedRowIds: [1] });

    expect(result.success).toBe(true);
    const item = orch.queue.getItem("lock-absent");
    expect(item?.metadata?.mergeStatus).not.toBe("deferred");
  });
});
