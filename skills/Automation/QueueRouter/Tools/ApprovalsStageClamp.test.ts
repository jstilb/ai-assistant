#!/usr/bin/env bun
/**
 * ApprovalsStageClamp.test.ts — Regression guard for slice A2b: deriveStage()/
 * stageToQueueStatus() must be a true left-inverse for the "approvals" queue.
 *
 * BUG (pre-fix): deriveStage() collapsed EVERY approvals-queue status to
 * "awaiting-approval" unconditionally, and stageToQueueStatus() collapsed every
 * approvals-queue stage back to "awaiting_approval" unconditionally. Consequence:
 * any whole-queue loadQueueItemsImpl -> saveQueueItemsImpl round-trip of the
 * approvals queue (the exact shape of SpecPipelineRunner.ts:1528's spec->approvals
 * metadata re-save and WorkOrchestratorCLI.ts:104/:123's daily orchestrator-init
 * self-heal) silently clamped every done/rejected item's stage back to
 * "awaiting-approval" via upsert()'s shadow-illegal-but-still-writes path.
 * Live corruption confirmed on a production clone: 36 rows (17 done + 19
 * rejected) one save away from being clamped.
 *
 * Hermetic: KAYA_HOME pinned to a fresh mkdtemp dir before any pipeline import.
 * Never touches live ~/.kaya.
 */

import { describe, test, expect, afterAll } from "bun:test";
import { join } from "path";
import { mkdirSync, existsSync, readFileSync } from "fs";
import type { Database } from "bun:sqlite";
import { pinKayaHome, restoreKayaHome } from "../../../../lib/test/pinKayaHome.ts";

// ============================================================================
// KAYA_HOME isolation — set BEFORE any import that reads the env
// ============================================================================

const TEST_BASE = pinKayaHome("approvals-stage-clamp-test-");

// Now safe to import pipeline code (all KAYA_HOME reads are at call time)
import {
  loadQueueItemsImpl,
  saveQueueItemsImpl,
  appendQueueItemImpl,
  deriveStage,
  stageToQueueStatus,
} from "./PipelineFacade.ts";
import {
  getPipelineRepository,
  resetPipelineRepository,
  generatePipelineId,
  STAGES,
  type Stage,
} from "./PipelineRepository.ts";
import type { QueueItem, QueueItemStatus } from "./QueueManager.ts";

// ============================================================================
// Helpers
// ============================================================================

const QUEUES_DIR = join(TEST_BASE, "MEMORY", "QUEUES");
const ARCHIVE_DIR = join(QUEUES_DIR, "archive");
mkdirSync(QUEUES_DIR, { recursive: true });

// failure-log.jsonl lives directly under KAYA_HOME (not under KAYA_HOME/.kaya) —
// mirrors PipelineUpsertGuard.test.ts's FAILURE_LOG_PATH convention.
const FAILURE_LOG_PATH = join(TEST_BASE, "MEMORY", "MONITORING", "failure-log.jsonl");

function readFailureLogLines(): Array<{ source: string; context: Record<string, unknown> }> {
  if (!existsSync(FAILURE_LOG_PATH)) return [];
  return readFileSync(FAILURE_LOG_PATH, "utf-8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

function makeApprovalsItem(status: QueueItemStatus, title: string): QueueItem {
  const now = new Date().toISOString();
  return {
    id: generatePipelineId(),
    created: now,
    updated: now,
    source: "test",
    priority: 2,
    status,
    type: "task",
    queue: "approvals",
    payload: { title, description: "" },
  };
}

// ============================================================================
// Lifecycle
// ============================================================================

afterAll(async () => {
  resetPipelineRepository();
  await restoreKayaHome();
});

// ============================================================================
// 1. Mapping table — deriveStage for the real approvals status vocabulary
//
// Vocabulary confirmed against a live pipeline.db clone (see PipelineFacade.ts
// deriveStage docstring) and the QueueManager.ts write paths that touch the
// approvals queue: SpecPipelineRunner transfer() sets "awaiting_approval";
// QueueManager.approve() sets "approved"; QueueManager.reject() sets "rejected";
// QueueManager.complete()/fail() (usable on any queue) set "completed"/"failed".
// ============================================================================

describe("1. deriveStage(status, 'approvals') maps the real status vocabulary", () => {
  const cases: Array<[QueueItemStatus, Stage]> = [
    ["awaiting_approval", "awaiting-approval"],
    ["approved", "approved"],
    ["rejected", "rejected"],
    ["completed", "done"],
    ["failed", "failed"],
  ];
  for (const [status, expected] of cases) {
    test(`"${status}" -> "${expected}"`, () => {
      expect(deriveStage(status, "approvals")).toBe(expected);
    });
  }
});

// ============================================================================
// 2. Table-driven bijection over the FULL STAGES list (not just the values
//    observed in the live clone). For stages approvals never produces, the
//    round-trip is not asserted (mirrors the "archived" exclusion already
//    established for approved-work in StatusReconciliation.test.ts — archive()
//    sets stage via transition(), never via deriveStage, and list() excludes
//    archived rows, so the bijection is never exercised for it in practice).
// ============================================================================

describe("2. stageToQueueStatus/deriveStage bijection over the full STAGES list", () => {
  const APPROVALS_STAGES = new Set<Stage>([
    "awaiting-approval",
    "approved",
    "rejected",
    "done",
    "failed",
  ]);

  for (const stage of STAGES) {
    const relevant = APPROVALS_STAGES.has(stage);
    test(`stage="${stage}" (${relevant ? "used by approvals — must round-trip" : "not used by approvals — skipped"})`, () => {
      if (!relevant) return;
      const status = stageToQueueStatus(stage, "approvals");
      expect(deriveStage(status, "approvals")).toBe(stage);
    });
  }
});

// ============================================================================
// 3. The actual corruption vector: a whole-queue loadQueueItemsImpl ->
//    saveQueueItemsImpl round-trip (SpecPipelineRunner.ts:1528,
//    WorkOrchestratorCLI.ts:104/:123 shape) must not clamp terminal stages
//    back to awaiting-approval, and must produce zero new pipeline_events /
//    zero new failure-log lines for already-terminal items.
// ============================================================================

describe("3. whole-queue round-trip preserves terminal approvals stages", () => {
  test("done + rejected + awaiting-approval items survive a full-queue re-save unchanged", () => {
    const repo = getPipelineRepository();

    const doneItem = makeApprovalsItem("completed", "done item");
    const rejectedItem = makeApprovalsItem("rejected", "rejected item");
    const pendingItem = makeApprovalsItem("awaiting_approval", "pending item");

    appendQueueItemImpl("approvals", doneItem, QUEUES_DIR);
    appendQueueItemImpl("approvals", rejectedItem, QUEUES_DIR);
    appendQueueItemImpl("approvals", pendingItem, QUEUES_DIR);

    // Sanity: creation wrote the correct initial stage for each.
    expect(repo.get(doneItem.id)?.stage).toBe("done");
    expect(repo.get(rejectedItem.id)?.stage).toBe("rejected");
    expect(repo.get(pendingItem.id)?.stage).toBe("awaiting-approval");

    const rawDb = (repo as unknown as { db: Database }).db;
    const eventCount = (id: string): number =>
      (rawDb.prepare("SELECT COUNT(*) as c FROM pipeline_events WHERE item_id = ?").get(id) as { c: number }).c;

    const before = {
      done: eventCount(doneItem.id),
      rejected: eventCount(rejectedItem.id),
      pending: eventCount(pendingItem.id),
    };
    const failureLinesBefore = readFailureLogLines().length;

    // Reproduce the exact corruption vector: load the whole queue, then save
    // the exact same items straight back.
    const items = loadQueueItemsImpl("approvals", QUEUES_DIR);
    saveQueueItemsImpl("approvals", items, QUEUES_DIR, ARCHIVE_DIR);

    expect(repo.get(doneItem.id)?.stage).toBe("done");
    expect(repo.get(rejectedItem.id)?.stage).toBe("rejected");
    expect(repo.get(pendingItem.id)?.stage).toBe("awaiting-approval");

    expect(eventCount(doneItem.id)).toBe(before.done);
    expect(eventCount(rejectedItem.id)).toBe(before.rejected);
    expect(eventCount(pendingItem.id)).toBe(before.pending);

    expect(readFailureLogLines().length).toBe(failureLinesBefore);
  });
});
