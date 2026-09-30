/**
 * WorkOrchestrator.envblock.test.ts — Slice 2: environment-blocked items re-stage
 * for the next eligible run instead of burning the retry counter to a human-board park.
 */

import { describe, it, expect } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { WorkOrchestrator } from "./WorkOrchestrator.ts";
import { WorkQueue, type WorkItem, type WorkItemMetadata } from "./WorkQueue.ts";
// pipeline_items is the ONE store WorkQueue and QueueRouter share (ADR-003). These
// tests drive the real public WorkOrchestrator.retry() entry point against a
// file-backed WorkQueue, then need a handle to that SAME PipelineRepository singleton
// (keyed by dbPath) from outside WorkQueue to (a) simulate a concurrent QueueRouter
// write on the SAME row before calling retry(), and (b) read the raw row after retry()
// returns — wq.getItem() can't be used for that assertion: it always reconstructs from
// the embedded metadata.rawWorkItem snapshot and can't see a clobbered top-level
// metadata column either way.
// cross-skill-allowed: test-only handle to the shared PipelineRepository singleton, for the reasons above.
import { getPipelineRepository } from "../../QueueRouter/Tools/PipelineRepository.ts";
// Uses QueueRouter's REAL codec (not a hand-rolled write shape) to produce the
// simulated competing write, so retry()'s environment-block path is tested against
// the exact mergeMetadata:true call shape QueueRouter's own fixed call sites actually
// use in production — a fabricated shape would not exercise the real collision.
// cross-skill-allowed: test-only, produces a genuine QueueRouter-shaped competing write, for the reasons above.
import { queueItemToPipelineParams } from "../../QueueRouter/Tools/lib/vocabulary.ts";
// cross-skill-allowed: type-only — types makeQueueItemFixture()'s input, the fixture factory that builds the QueueItem literal fed into queueItemToPipelineParams above; erased at runtime, no cross-skill runtime dependency.
import type { QueueItem } from "../../QueueRouter/Tools/QueueManager.ts";

function makeItem(over: Partial<WorkItem> & { id: string }): WorkItem {
  return {
    title: `Item ${over.id}`, description: "", status: "in_progress", priority: "normal",
    dependencies: [], source: "manual", createdAt: new Date().toISOString(), ...over,
  };
}

function orchWith(items: WorkItem[]): { orch: WorkOrchestrator; queue: WorkQueue } {
  const queue = WorkQueue._createForTesting(items);
  const orch = WorkOrchestrator._createForTesting(queue);
  return { orch, queue };
}

describe("retry — environment block re-staging", () => {
  it("re-derives 'environment' from the reason and re-stages to pending WITHOUT consuming the retry counter", async () => {
    const { orch, queue } = orchWith([makeItem({ id: "a" })]);
    const res = await orch.retry("a", "Skeptical review: LIVE_VERIFICATION_ENVIRONMENT_BLOCK: could not run here");

    expect(res.faultClass).toBe("environment");
    expect(res.restaged).toBe(true);
    expect(res.escalated).toBe(false);

    const item = queue.getItem("a")!;
    expect(item.status).toBe("pending"); // re-staged
    expect((item.attempts ?? []).length).toBe(0); // counter NOT consumed
    expect(item.retryEligibleAfter).toBeDefined();
    expect(new Date(item.retryEligibleAfter!).getTime()).toBeGreaterThan(Date.now());
    expect((item.metadata as WorkItemMetadata).environmentBlockCount).toBe(1);
    // No human-board proxy created.
    expect(queue.getAllItems().some((i) => i.title.startsWith("REVIEW"))).toBe(false);
  });

  it("S3b: inference-unavailable PROSE alone no longer re-stages as environment (prose interpretation removed) — it is an item fault and consumes the counter", async () => {
    const { orch, queue } = orchWith([makeItem({ id: "b" })]);
    // No structured signal (no faultClass arg, no sentinel token, no environmentBlockCount):
    // the loose prose regex that used to map this to "environment" was deleted in S3b.
    const res = await orch.retry("b", "Verification inference unavailable after 3 retries");
    expect(res.faultClass).toBe("item");
    expect(res.restaged).toBeFalsy();
    expect((queue.getItem("b")!.attempts ?? []).length).toBe(1); // counter consumed
  });

  it("S3b: a STRUCTURED faultClass='environment' (e.g. from PhaseL livePassed:false) re-stages without burning the counter", async () => {
    const { orch, queue } = orchWith([makeItem({ id: "b2" })]);
    // This is the real new path: the verifier sets the structured faultClass; retry() honors it
    // regardless of the prose reason.
    const res = await orch.retry("b2", "some opaque reason text", "environment");
    expect(res.faultClass).toBe("environment");
    expect(res.restaged).toBe(true);
    expect(queue.getItem("b2")!.status).toBe("pending");
    expect((queue.getItem("b2")!.attempts ?? []).length).toBe(0); // counter NOT consumed
  });

  it("a genuine item failure still records an attempt and escalates after 3 (no regression)", async () => {
    const { orch, queue } = orchWith([makeItem({ id: "c" })]);
    await orch.retry("c", "ISC row 3: function returns stub value"); // item fault
    expect((queue.getItem("c")!.attempts ?? []).length).toBe(1);
    expect(queue.getItem("c")!.status).toBe("pending");
  });

  it("persistent environment blocks eventually escalate (bounded, never silently stuck forever)", async () => {
    const prev = process.env.KAYA_ENV_BLOCK_ESCALATE_CAP;
    process.env.KAYA_ENV_BLOCK_ESCALATE_CAP = "2";
    try {
      const { orch, queue } = orchWith([makeItem({ id: "d" })]);
      // 1st env block → re-stage (count 1)
      const r1 = await orch.retry("d", "LIVE_VERIFICATION_ENVIRONMENT_BLOCK x");
      expect(r1.escalated).toBe(false);
      expect((queue.getItem("d")!.metadata as WorkItemMetadata).environmentBlockCount).toBe(1);
      // 2nd env block → count hits cap (2) → escalate
      queue.getItem("d") && queue.updateStatus("d", "in_progress");
      const r2 = await orch.retry("d", "LIVE_VERIFICATION_ENVIRONMENT_BLOCK x");
      expect(r2.escalated).toBe(true);
      expect(r2.faultClass).toBe("environment");
      // A blocked review proxy now exists, tagged as environment.
      expect(queue.getAllItems().some((i) => i.title.includes("environment-blocked"))).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.KAYA_ENV_BLOCK_ESCALATE_CAP;
      else process.env.KAYA_ENV_BLOCK_ESCALATE_CAP = prev;
    }
  });
});

describe("WorkQueue.restagePending", () => {
  it("re-stages to pending with cooldown and does not push an attempt", () => {
    const queue = WorkQueue._createForTesting([makeItem({ id: "e" })]);
    const updated = queue.restagePending("e", 5000);
    expect(updated?.status).toBe("pending");
    expect((queue.getItem("e")!.attempts ?? []).length).toBe(0);
    expect(new Date(queue.getItem("e")!.retryEligibleAfter!).getTime()).toBeGreaterThan(Date.now());
  });
});

// ---------------------------------------------------------------------------
// Cross-writer metadata clobber, environment-block retry with NO error text
// (workqueue-metadata-clobber-20260730, round 2)
//
// Reproduces the exact production shape: `retry <id>` from the CLI with no
// [err] argument (WorkOrchestratorCLI.ts:275 — `orch.retry(id, positionals[2])`,
// positionals[2] undefined) on an item that was already environment-blocked
// once. Before the round-2 fix, WorkOrchestrator.ts:939/945-948 passed the
// unguarded `error` (undefined) straight into setMetadata()'s
// `lastEnvironmentBlockReason` field — silently DELETING the key instead of
// recording it (setMetadata used to treat `undefined` as "delete"), and the
// undefined-triggered delete branch forced a wholesale metadata write that
// re-exposed the round-1 cross-writer clobber (a concurrent QueueRouter
// metadata key on the same row would be lost too).
//
// Driven through the real public API (WorkOrchestrator.retry(), the same path
// the CLI uses) against a real WorkQueue + PipelineRepository on a scratch
// file-backed DB — not repo.upsert() directly (which bypasses persistItem()
// and would validate nothing about this fix) and not mocks.
//
// Assertions read the RAW DB row via repo.get(), never wq.getItem() — the
// latter always reconstructs from the embedded metadata.rawWorkItem snapshot
// (see pipelineItemToWorkItem() in lib/vocabulary.ts), so it cannot detect a
// clobbered top-level metadata column either way.
// ---------------------------------------------------------------------------

function makeQueueItemFixture(overrides: Partial<QueueItem> & { id: string }): QueueItem {
  const now = new Date().toISOString();
  return {
    created: now,
    updated: now,
    source: "test",
    priority: 2,
    status: "pending",
    type: "task",
    queue: "approved-work",
    payload: { title: `Queue item ${overrides.id}`, description: "" },
    ...overrides,
  };
}

describe("WorkOrchestrator.retry() environment-block path — cross-writer metadata", () => {
  it("retry with no error text preserves a concurrently-written QueueRouter key AND records (not deletes) lastEnvironmentBlockReason", async () => {
    const base = mkdtempSync(join(tmpdir(), "wo-envblock-clobber-"));
    try {
      const dir = join(base, "store");
      mkdirSync(dir, { recursive: true });
      const statePath = join(dir, "wq.json");
      const dbPath = join(dir, ".kaya", "runtime", "pipeline.db");

      // Real, file-backed WorkQueue (not _createForTesting's shared :memory: DB,
      // which can't be reached from outside to simulate a second writer) —
      // constructing it first initializes the getPipelineRepository singleton
      // for this dbPath; the repo handle below resolves to that SAME cached
      // instance, exactly how production shares one connection per db path
      // between WorkQueue and QueueRouter (ADR-003).
      const queue = new WorkQueue(statePath);
      const repo = getPipelineRepository(dbPath);
      const orch = WorkOrchestrator._createForTesting(queue);

      const item = queue.addItem({
        title: "t", description: "", priority: "normal", dependencies: [], source: "manual",
        status: "in_progress",
        // Prior environment block: makes classifyFailure() deterministically
        // return "environment" (rule 3: persistent env-block recorded in
        // metadata) without needing sentinel-token prose or a structured
        // faultClass arg — the exact classification path a bare `retry <id>`
        // with no [err] takes on a previously-blocked item in production.
        metadata: { environmentBlockCount: 1 },
      });

      // Simulate QueueRouter's real write shape on the SAME row.
      repo.upsert(
        queueItemToPipelineParams(makeQueueItemFixture({
          id: item.id, queue: "approved-work", status: "in_progress",
          project: { name: "acme-corp", path: "/tmp/acme" },
        })),
        { mergeMetadata: true, actor: "QueueRouter-sim" }
      );
      expect(repo.get(item.id)?.metadata.projectName).toBe("acme-corp"); // sanity

      // The exact CLI repro: no error argument.
      const res = await orch.retry(item.id);
      expect(res.faultClass).toBe("environment");
      expect(res.restaged).toBe(true);

      const row = repo.get(item.id);
      expect(row?.metadata.projectName).toBe("acme-corp"); // survived
      expect(row?.metadata.lastEnvironmentBlockReason).toBe("environment block"); // recorded, not deleted/absent
      expect("lastEnvironmentBlockReason" in (row?.metadata ?? {})).toBe(true);
      expect(row?.metadata.environmentBlockCount).toBe(2);
      expect(row?.stage).toBe("approved"); // re-staged to pending (WorkStatus) === approved (Stage)
    } finally {
      try { rmSync(base, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  });

  it("companion: retry with no error text on the ESCALATE branch (:939, count >= cap) also preserves a concurrent QueueRouter key AND records (not deletes) lastEnvironmentBlockReason", async () => {
    const prevCap = process.env.KAYA_ENV_BLOCK_ESCALATE_CAP;
    process.env.KAYA_ENV_BLOCK_ESCALATE_CAP = "2"; // small cap so ONE more block escalates
    const base = mkdtempSync(join(tmpdir(), "wo-envblock-clobber-escalate-"));
    try {
      const dir = join(base, "store");
      mkdirSync(dir, { recursive: true });
      const statePath = join(dir, "wq.json");
      const dbPath = join(dir, ".kaya", "runtime", "pipeline.db");

      const queue = new WorkQueue(statePath);
      const repo = getPipelineRepository(dbPath);
      const orch = WorkOrchestrator._createForTesting(queue);

      const item = queue.addItem({
        title: "t", description: "", priority: "normal", dependencies: [], source: "manual",
        status: "in_progress",
        // With cap=2, one more block (count becomes 2) hits the escalate branch (:920-941).
        metadata: { environmentBlockCount: 1 },
      });

      repo.upsert(
        queueItemToPipelineParams(makeQueueItemFixture({
          id: item.id, queue: "approved-work", status: "in_progress",
          project: { name: "acme-corp", path: "/tmp/acme" },
        })),
        { mergeMetadata: true, actor: "QueueRouter-sim" }
      );
      expect(repo.get(item.id)?.metadata.projectName).toBe("acme-corp"); // sanity

      // Exact CLI repro, no error argument — this time landing on the escalate branch.
      const res = await orch.retry(item.id);
      expect(res.faultClass).toBe("environment");
      expect(res.escalated).toBe(true);

      const row = repo.get(item.id);
      expect(row?.metadata.projectName).toBe("acme-corp"); // survived
      expect(row?.metadata.lastEnvironmentBlockReason).toBe("environment block"); // recorded, not deleted/absent
      expect("lastEnvironmentBlockReason" in (row?.metadata ?? {})).toBe(true);
      expect(row?.metadata.environmentBlockCount).toBe(2);
    } finally {
      if (prevCap === undefined) delete process.env.KAYA_ENV_BLOCK_ESCALATE_CAP;
      else process.env.KAYA_ENV_BLOCK_ESCALATE_CAP = prevCap;
      try { rmSync(base, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  });
});
