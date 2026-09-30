/**
 * WorkOrchestrator.followon.test.ts — Slice 4: loop/epic continuation.
 * When a loop verifies+completes, the next follow-on loop is auto-enqueued, gated.
 */

import { describe, it, expect } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { WorkOrchestrator } from "./WorkOrchestrator.ts";
import { WorkQueue, type WorkItem, type WorkItemMetadata } from "./WorkQueue.ts";
import { deriveFollowOnFromSpec, type InferFn, type FollowOnLoop } from "./FollowOnLoops.ts";
import type { InferenceResult } from "../../../../lib/core/Inference.ts";

function makeItem(over: Partial<WorkItem> & { id: string }): WorkItem {
  return {
    title: `Item ${over.id}`, description: "", status: "completed", priority: "normal",
    dependencies: [], source: "manual", createdAt: new Date().toISOString(), ...over,
  };
}

function orchWith(items: WorkItem[]): { orch: WorkOrchestrator; queue: WorkQueue } {
  const queue = WorkQueue._createForTesting(items);
  return { orch: WorkOrchestrator._createForTesting(queue), queue };
}

// Guard for the structured-declaration path: when item.metadata.followOnLoops is
// present, the LLM comprehension fallback must NOT be consulted at all.
const NEVER_DERIVE = async (): Promise<FollowOnLoop[]> => {
  throw new Error("deriveFn must not be called when structured followOnLoops are present");
};

describe("enqueueNextFollowOn", () => {
  it("enqueues the next loop, gated on the completed item, carrying the remainder (structured wins, no deriveFn call)", async () => {
    const { orch, queue } = orchWith([makeItem({
      id: "loop1", title: "Canvas Loop 1",
      metadata: {
        followOnLoops: [
          { title: "Canvas Loop 2", specPath: "/abs/loop2.md" },
          { title: "Canvas Loop 3" },
          { title: "Canvas Loop 4" },
        ],
      },
    })]);

    // NEVER_DERIVE throws if consulted — proves structured loops short-circuit comprehension.
    const res = await orch.enqueueNextFollowOn("loop1", NEVER_DERIVE);
    expect(res.enqueued).toBe(true);
    expect(res.remaining).toBe(2);

    const all = queue.getAllItems();
    const newItem = all.find((i) => i.id === res.newItemId)!;
    expect(newItem.title).toBe("Canvas Loop 2");
    expect(newItem.specPath).toBe("/abs/loop2.md");
    expect(newItem.dependencies).toEqual(["loop1"]); // sequential gating
    expect(newItem.status).toBe("pending");
    // The remainder rides on the new item — only ONE follow-on enqueued at a time.
    expect((newItem.metadata as WorkItemMetadata).followOnLoops).toEqual([
      { title: "Canvas Loop 3" },
      { title: "Canvas Loop 4" },
    ]);
    // Origin threaded for epic traceability.
    expect((newItem.metadata as WorkItemMetadata).epicOriginItemId).toBe("loop1");
  });

  it("is idempotent — a second call does not enqueue a duplicate", async () => {
    const { orch, queue } = orchWith([makeItem({
      id: "loop1", metadata: { followOnLoops: [{ title: "Loop 2" }] },
    })]);
    const r1 = await orch.enqueueNextFollowOn("loop1", NEVER_DERIVE);
    expect(r1.enqueued).toBe(true);
    const r2 = await orch.enqueueNextFollowOn("loop1", NEVER_DERIVE);
    expect(r2.enqueued).toBe(false);
    expect(r2.reason).toBe("already enqueued");
    expect(queue.getAllItems().filter((i) => i.title === "Loop 2").length).toBe(1);
    expect((queue.getItem("loop1")!.metadata as WorkItemMetadata).followOnEnqueued).toBe(true);
  });

  it("no-ops when there are no follow-on loops declared", async () => {
    const { orch } = orchWith([makeItem({ id: "solo" })]);
    const res = await orch.enqueueNextFollowOn("solo", async () => []);
    expect(res.enqueued).toBe(false);
    expect(res.reason).toBe("no follow-on loops declared");
  });

  it("returns not-found for an unknown item id", async () => {
    const { orch } = orchWith([makeItem({ id: "solo" })]);
    const res = await orch.enqueueNextFollowOn("nope", NEVER_DERIVE);
    expect(res.enqueued).toBe(false);
    expect(res.reason).toBe("item not found");
  });

  // DoD round-trip: a multi-phase spec that DEFERS later phases → on completion the
  // deferred phases land back in the queue automatically (not orphaned). Exercises the
  // REAL deriveFollowOnFromSpec (LLM comprehension) feeding the REAL enqueue plumbing;
  // only the model call itself is faked so the test is deterministic.
  it("re-queues a deferred phase read from the item's spec (no structured metadata)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "followon-rt-"));
    const specPath = join(dir, "scheduler-spec.md");
    writeFileSync(
      specPath,
      `# KayaScheduler\n\n## 6. Implementation Approach\nPhase 1 — daily planner (built now).\n\n` +
        `## Follow-On Loops\n- KayaScheduler Phase 2 — recurring demand | spec: ${join(dir, "phase2.md")}\n` +
        `- KayaScheduler Phase 3 — learning loop\n`,
    );

    try {
      // Item built from the spec — Phase 1 done, NO pre-declared structured stubs.
      const { orch, queue } = orchWith([makeItem({ id: "sched1", title: "KayaScheduler Phase 1", specPath })]);

      // Fake the model: it reads the spec and reports the two deferred phases.
      let promptSawSpec = false;
      const infer: InferFn = async ({ userPrompt }) => {
        promptSawSpec = userPrompt.includes("KayaScheduler Phase 2 — recurring demand");
        return {
          success: true, level: "fast",
          output: JSON.stringify([
            { title: "KayaScheduler Phase 2 — recurring demand", specPath: join(dir, "phase2.md") },
            { title: "KayaScheduler Phase 3 — learning loop" },
          ]),
        } as InferenceResult;
      };

      const res = await orch.enqueueNextFollowOn("sched1", (sp, c) => deriveFollowOnFromSpec(sp, { ...c, infer }));

      expect(promptSawSpec).toBe(true); // comprehension actually read the spec
      expect(res.enqueued).toBe(true);
      expect(res.remaining).toBe(1);

      const newItem = queue.getAllItems().find((i) => i.id === res.newItemId)!;
      expect(newItem.title).toBe("KayaScheduler Phase 2 — recurring demand");
      expect(newItem.specPath).toBe(join(dir, "phase2.md"));
      expect(newItem.dependencies).toEqual(["sched1"]); // sequential gating
      expect(newItem.status).toBe("pending");
      // The remaining deferred phase rides on the new item — one enqueued at a time.
      expect((newItem.metadata as WorkItemMetadata).followOnLoops).toEqual([
        { title: "KayaScheduler Phase 3 — learning loop" },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not re-queue when comprehension finds nothing deferred (fully delivered spec)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "followon-none-"));
    const specPath = join(dir, "single.md");
    writeFileSync(specPath, "# Single-phase spec\n\nDelivers everything in one build.\n");
    try {
      const { orch } = orchWith([makeItem({ id: "solo2", specPath })]);
      const infer: InferFn = async () => ({ success: true, output: "[]", level: "fast" } as InferenceResult);
      const res = await orch.enqueueNextFollowOn("solo2", (sp, c) => deriveFollowOnFromSpec(sp, { ...c, infer }));
      expect(res.enqueued).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("sequential gating: the next loop is NOT ready until the prior loop is completed", async () => {
    // loop1 still in_progress → its follow-on must not be releasable.
    const { orch, queue } = orchWith([makeItem({
      id: "loop1", status: "in_progress", metadata: { followOnLoops: [{ title: "Loop 2" }] },
    })]);
    await orch.enqueueNextFollowOn("loop1");
    const ready = queue.getReadyItems().map((i) => i.title);
    expect(ready).not.toContain("Loop 2"); // dep (loop1) not completed → DAG-blocked

    // Once loop1 completes (after verification), the follow-on becomes ready.
    queue.setVerification("loop1", {
      status: "verified", verifiedAt: new Date().toISOString(), verdict: "PASS", concerns: [],
      iscRowsVerified: 1, iscRowsTotal: 1, verificationCost: 0, verifiedBy: "skeptical_verifier", tiersExecuted: [1, 2],
    });
    queue.updateStatus("loop1", "completed");
    expect(queue.getReadyItems().map((i) => i.title)).toContain("Loop 2");
  });
});
