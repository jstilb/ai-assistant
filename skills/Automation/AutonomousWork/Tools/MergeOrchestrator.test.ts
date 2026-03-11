/**
 * MergeOrchestrator.test.ts — Tests for branch merging orchestrator
 *
 * Covers: method name compilation, idempotency, conflict metadata,
 * skipped count accuracy.
 */

import { describe, it, expect } from "bun:test";
import { MergeOrchestrator } from "./MergeOrchestrator.ts";
import { WorkQueue, type WorkItem, type WorkItemVerification } from "./WorkQueue.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeItem(overrides: Partial<WorkItem> & { id: string }): WorkItem {
  return {
    title: `Item ${overrides.id}`,
    description: "",
    status: "pending",
    priority: "normal",
    dependencies: [],
    source: "manual",
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

const passedVerification: WorkItemVerification = {
  status: "verified",
  verifiedAt: new Date().toISOString(),
  verdict: "PASS",
  concerns: [],
  iscRowsVerified: 3,
  iscRowsTotal: 3,
  verificationCost: 0.05,
  verifiedBy: "skeptical_verifier",
  tiersExecuted: [1, 2],
};

// ---------------------------------------------------------------------------
// Instantiation (catches wrong method names at compile time)
// ---------------------------------------------------------------------------

describe("MergeOrchestrator", () => {
  it("instantiates without error", () => {
    const wq = WorkQueue._createForTesting([]);
    const mo = new MergeOrchestrator(wq);
    expect(mo).toBeDefined();
  });

  it("mergeCompleted returns zero counts on empty queue", () => {
    const wq = WorkQueue._createForTesting([]);
    const mo = new MergeOrchestrator(wq);
    const result = mo.mergeCompleted("direct");
    expect(result.merged).toBe(0);
    expect(result.conflicts).toBe(0);
    expect(result.skipped).toBe(0);
  });

  it("skips items without worktreeBranch metadata", () => {
    const wq = WorkQueue._createForTesting([
      makeItem({
        id: "a",
        status: "completed",
        verification: passedVerification,
        // no metadata.worktreeBranch
      }),
    ]);
    const mo = new MergeOrchestrator(wq);
    const result = mo.mergeCompleted("direct");
    expect(result.merged).toBe(0);
    expect(result.skipped).toBe(0); // not "merged" so not counted as skipped
  });

  it("skips non-completed items", () => {
    const wq = WorkQueue._createForTesting([
      makeItem({
        id: "a",
        status: "in_progress",
        metadata: { worktreeBranch: "feature/test" },
      }),
    ]);
    const mo = new MergeOrchestrator(wq);
    const result = mo.mergeCompleted("direct");
    expect(result.merged).toBe(0);
  });

  it("skips items without verification", () => {
    const wq = WorkQueue._createForTesting([
      makeItem({
        id: "a",
        status: "completed",
        metadata: { worktreeBranch: "feature/test" },
        // no verification
      }),
    ]);
    const mo = new MergeOrchestrator(wq);
    const result = mo.mergeCompleted("direct");
    expect(result.merged).toBe(0);
  });

  // ---------------------------------------------------------------------------
  // Idempotency
  // ---------------------------------------------------------------------------

  it("idempotency: already-merged items are skipped", () => {
    const wq = WorkQueue._createForTesting([
      makeItem({
        id: "a",
        status: "completed",
        verification: passedVerification,
        metadata: { worktreeBranch: "feature/a", mergeStatus: "merged" },
      }),
    ]);
    const mo = new MergeOrchestrator(wq);
    const result = mo.mergeCompleted("direct");
    expect(result.merged).toBe(0);
    expect(result.skipped).toBe(1); // counted as skipped because already merged
  });

  // ---------------------------------------------------------------------------
  // Skipped count accuracy
  // ---------------------------------------------------------------------------

  it("skipped count only includes already-merged items", () => {
    const wq = WorkQueue._createForTesting([
      // Already merged
      makeItem({
        id: "done1",
        status: "completed",
        verification: passedVerification,
        metadata: { worktreeBranch: "feature/done1", mergeStatus: "merged" },
      }),
      makeItem({
        id: "done2",
        status: "completed",
        verification: passedVerification,
        metadata: { worktreeBranch: "feature/done2", mergeStatus: "merged" },
      }),
      // Not eligible (no branch)
      makeItem({
        id: "pending1",
        status: "pending",
      }),
      // Not eligible (not completed)
      makeItem({
        id: "inprog1",
        status: "in_progress",
        metadata: { worktreeBranch: "feature/inprog" },
      }),
    ]);
    const mo = new MergeOrchestrator(wq);
    const result = mo.mergeCompleted("direct");
    expect(result.skipped).toBe(2); // only the 2 already-merged items
    expect(result.merged).toBe(0);
    expect(result.conflicts).toBe(0);
  });
});
