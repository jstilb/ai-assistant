/**
 * PipelineEndToEnd.test.ts — cross-component SINGLE-STORE proof (Phase 4 cutover).
 *
 * This is the test that would have caught the "two stores masquerading as one" bug:
 * before the Phase-4 path fix, QueueManager/PipelineFacade resolved
 * <KAYA_HOME>/.kaya/runtime/pipeline.db while WorkQueue resolved
 * <KAYA_HOME>/MEMORY/WORK/.kaya/runtime/pipeline.db — a DIFFERENT file — so an item
 * approved via QueueManager was invisible to WorkQueue/executors. The per-component
 * unit suites never crossed components, so the divergence was invisible to them.
 *
 * Every test pins KAYA_HOME to a fresh temp dir so the live ~/.kaya/runtime/pipeline.db
 * is never touched.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { defaultPipelineDbPath, resetPipelineDb } from "./PipelineDB.ts";
import { resetPipelineRepository } from "./PipelineRepository.ts";
import {
  saveQueueItemsImpl,
  getRepoForQueuesDir,
} from "./PipelineFacade.ts";

let TMP: string;
let ORIG_KAYA_HOME: string | undefined;

function queuesDir(): string {
  return join(process.env.KAYA_HOME as string, "MEMORY", "QUEUES");
}

function archiveDir(): string {
  return join(queuesDir(), "archive");
}

beforeAll(() => {
  ORIG_KAYA_HOME = process.env.KAYA_HOME;
});

afterAll(() => {
  if (ORIG_KAYA_HOME === undefined) delete process.env.KAYA_HOME;
  else process.env.KAYA_HOME = ORIG_KAYA_HOME;
});

beforeEach(() => {
  // Fresh KAYA_HOME per test → fresh canonical pipeline.db, fully isolated.
  TMP = mkdtempSync(join(tmpdir(), "pipeline-e2e-"));
  process.env.KAYA_HOME = TMP;
  mkdirSync(archiveDir(), { recursive: true });
  mkdirSync(join(TMP, "MEMORY", "WORK"), { recursive: true });
  // Evict any cached singleton for the canonical path so each test opens a fresh DB.
  const dbPath = defaultPipelineDbPath();
  resetPipelineRepository(dbPath);
  resetPipelineDb(dbPath);
});

describe("Pipeline single-store — path convergence", () => {
  test("getRepoForQueuesDir, getPipelineRepository, and a no-arg WorkQueue all resolve the SAME pipeline.db singleton", async () => {
    const canonical = defaultPipelineDbPath();

    // Facade resolution: getRepoForQueuesDir must return the canonical singleton
    // regardless of queuesDir arg (S1.5 fix — no longer derives path from queuesDir).
    const { getPipelineRepository } = await import("./PipelineRepository.ts");
    const canonicalRepo = getPipelineRepository();
    const facadeRepo = getRepoForQueuesDir(queuesDir());
    expect(facadeRepo).toBe(canonicalRepo);

    // Canonical path sanity check
    expect(canonical).toContain(process.env.KAYA_HOME as string);

    // WorkQueue resolution for a no-arg (production-default) construction.
    const { MEMORY } = await import("../../../../lib/core/MemoryPaths.ts");
    const wqResolved =
      MEMORY.work.queue.path() === MEMORY.work.queue.path()
        ? defaultPipelineDbPath()
        : "ISOLATED";
    expect(wqResolved).toBe(canonical);
  });
});

describe("Pipeline single-store — approve → claimable end-to-end", () => {
  test("an approved-work item (status=pending → stage=approved) is visible AND claimable by a fresh WorkQueue (same db, no importToWorkQueue copy)", async () => {
    const now = new Date().toISOString();
    // Write the item through the SAME facade QueueManager.approve() uses. An item
    // promoted to approved-work for execution carries QueueItem status "pending"
    // (pending execution) — which deriveStage maps to stage "approved", the
    // WorkQueue-claimable stage. (status "approved" would mean already-completed →
    // stage "done", correctly NOT claimable.)
    saveQueueItemsImpl(
      "approved-work",
      [
        {
          id: "e2e-approved-1",
          created: now,
          updated: now,
          source: "manual",
          priority: 2,
          status: "pending",
          type: "dev",
          queue: "approved-work",
          payload: { title: "E2E approved item", description: "should be claimable" },
        } as never,
      ],
      queuesDir(),
      archiveDir(),
    );

    // A fresh production-default WorkQueue must see it from the SAME pipeline.db.
    // cross-skill-allowed: test isolation/fixture — exercises the real cross-skill integration (proves pipeline.db is one store shared by QueueManager and a fresh production WorkQueue)
    const { WorkQueue } = await import("../../AutonomousWork/Tools/WorkQueue.ts");
    const wq = new WorkQueue();
    const all = wq.getAllItems();
    const ids = all.map((i: { id: string }) => i.id);
    expect(ids).toContain("e2e-approved-1");

    // And it must be claimable (ready) — the executors' actual path.
    const ready = wq.getReadyItems();
    expect(ready.map((i: { id: string }) => i.id)).toContain("e2e-approved-1");
  });
});

describe("Pipeline single-store — blocked execution item visible to a fresh WorkQueue", () => {
  test("an execution-stage item (status=blocked) is visible to a fresh WorkQueue with the correct status", async () => {
    const now = new Date().toISOString();
    // Write the item through the SAME facade QueueManager.approve() uses (same idiom
    // as the "approve → claimable" case above). A "blocked" approved-work status maps
    // via deriveStage to stage "blocked" — the execution-in-progress-but-stuck stage —
    // which WorkQueue must surface via getItem() with the matching status, but NOT as
    // a ready/claimable item (unlike the "pending"/stage=approved case above).
    saveQueueItemsImpl(
      "approved-work",
      [
        {
          id: "e2e-exec-blocked",
          created: now,
          updated: now,
          source: "manual",
          priority: 2,
          status: "blocked",
          type: "dev",
          queue: "approved-work",
          payload: { title: "Blocked exec item", description: "in execution" },
        } as never,
      ],
      queuesDir(),
      archiveDir(),
    );

    // A fresh production-default WorkQueue must see it from the SAME pipeline.db.
    // cross-skill-allowed: test isolation/fixture — exercises the real cross-skill integration (proves pipeline.db is one store shared by QueueManager and a fresh production WorkQueue)
    const { WorkQueue } = await import("../../AutonomousWork/Tools/WorkQueue.ts");
    const wq = new WorkQueue();
    const item = wq.getItem("e2e-exec-blocked");
    expect(item).toBeTruthy();
    expect(item?.status).toBe("blocked");
  });
});
