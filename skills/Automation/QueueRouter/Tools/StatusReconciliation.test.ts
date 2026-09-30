#!/usr/bin/env bun
/**
 * StatusReconciliation.test.ts — Verifies that pipelineItemToQueueItem derives
 * the displayed status from pi.stage, not from the stale rawQueueItem.status.
 *
 * TDD: Case 1 must FAIL (RED) against unfixed code, then PASS (GREEN) after the fix.
 *
 * Hermetic-DB pattern: KAYA_HOME is pinned to a temp dir BEFORE any import
 * that reads the env — mirrors PipelineDB.test.ts:27-29.
 */

import { describe, test, expect, afterAll } from "bun:test";
import { pinKayaHome, restoreKayaHome } from "../../../../lib/test/pinKayaHome.ts";

// ============================================================================
// KAYA_HOME isolation — set BEFORE any import that reads the env
// ============================================================================

const TEST_BASE = pinKayaHome("status-recon-test-");

// Now safe to import pipeline code
import {
  PipelineRepository,
  resetPipelineRepository,
  generatePipelineId,
  type Stage,
} from "./PipelineRepository.ts";
import {
  pipelineItemToQueueItem,
  deriveStage,
} from "./PipelineFacade.ts";
import { defaultPipelineDbPath } from "./PipelineDB.ts";
import type { QueueItemStatus } from "./QueueManager.ts";

// stageToQueueStatus is added by the S0+S1 fix. Against unfixed code it will be
// undefined, causing case 3 to fail in RED. The cast through unknown is warranted
// (test probe for a function that does not yet exist).
import * as PipelineFacade from "./PipelineFacade.ts";
type StageToQsType = (stage: Stage, queue: string) => QueueItemStatus;
const stageToQueueStatus = (
  PipelineFacade as unknown as { stageToQueueStatus?: StageToQsType }
).stageToQueueStatus;

// ============================================================================
// Lifecycle
// ============================================================================

afterAll(async () => {
  resetPipelineRepository();
  await restoreKayaHome();
});

// ============================================================================
// Helpers
// ============================================================================

function getRepo(): PipelineRepository {
  return new PipelineRepository(defaultPipelineDbPath());
}

/** Seed a pipeline_items row with the given stage and a stale rawQueueItem.status */
function seedRow(
  stage: Stage,
  queue: string,
  staleStatus: string = "pending",
): string {
  const repo = getRepo();
  const id = generatePipelineId();
  const now = new Date().toISOString();

  repo.upsert({
    id,
    title: `Test ${stage}`,
    description: "",
    stage,
    priority: 2,
    queue,
    source: "test",
    type: "task",
    created_at: now,
    updated_at: now,
    dependencies: [],
    attempts: [],
    isc_rows: [],
    progress: {},
    context: {},
    metadata: {
      // Stale frozen status — what the bug preserves across stage changes
      rawQueueItem: {
        id,
        status: staleStatus,
        queue,
        payload: { title: `Test ${stage}`, description: "" },
        priority: 2,
        source: "test",
        type: "task",
        created: now,
        updated: now,
      },
    },
  });

  return id;
}

// ============================================================================
// Case 1: Bug proof — blocked stage must not surface as "pending"
//
// RED against unfixed code (pipelineItemToQueueItem returns rawQueueItem verbatim)
// GREEN after fix (status is derived from pi.stage via stageToQueueStatus)
// ============================================================================

describe("1. Bug proof: stage=blocked must not display as pending", () => {
  test("blocked stage in approved-work overrides stale rawQueueItem.status=pending", () => {
    const repo = getRepo();
    const id = seedRow("blocked", "approved-work", "pending");

    const pi = repo.get(id);
    expect(pi).not.toBeNull();

    const qi = pipelineItemToQueueItem(pi!);
    expect(qi).not.toBeNull();

    // The projected status must NOT be the stale "pending"
    expect(qi!.status).not.toBe("pending");

    // And it must round-trip back to "blocked" through deriveStage
    expect(deriveStage(qi!.status, "approved-work")).toBe("blocked");
  });
});

// ============================================================================
// Case 2: Stage round-trip invariant across all approved-work stages
//
// For each Stage that approved-work uses, seed a row at that stage with a
// stale rawQueueItem.status="pending" and verify the round-trip holds.
// ============================================================================

describe("2. Stage round-trip invariant for approved-work", () => {
  const approvedWorkStages: Stage[] = [
    "approved",
    "in-progress",
    "partial",
    "needs-review",
    "blocked",
    "done",
    "failed",
    "rejected",
  ];

  for (const stage of approvedWorkStages) {
    test(`stage=${stage} round-trips through deriveStage`, () => {
      const repo = getRepo();
      const id = seedRow(stage, "approved-work", "pending");

      const pi = repo.get(id);
      expect(pi).not.toBeNull();

      const qi = pipelineItemToQueueItem(pi!);
      expect(qi).not.toBeNull();

      // Acceptance invariant: deriveStage(displayedStatus, queue) === pi.stage
      expect(deriveStage(qi!.status, "approved-work")).toBe(stage);
    });
  }
});

// ============================================================================
// Case 3: Bijection of stageToQueueStatus
//
// For every Stage a queue uses, verify: deriveStage(stageToQueueStatus(s, q), q) === s
// This fails (function undefined) against unfixed code, passes after fix.
// ============================================================================

describe("3. stageToQueueStatus is a verified left-inverse of deriveStage", () => {
  test("stageToQueueStatus is exported from PipelineFacade", () => {
    expect(typeof stageToQueueStatus).toBe("function");
  });

  const queueStages: Array<[string, Stage[]]> = [
    [
      "approved-work",
      [
        "approved",
        "in-progress",
        "partial",
        "needs-review",
        "blocked",
        "done",
        "failed",
        "rejected",
        // "archived" intentionally excluded: it maps to "completed" (same as "done")
        // and archived items are excluded from list() results, so the bijection does
        // not need to hold for "archived".
      ],
    ],
    [
      "approvals",
      // A2b: full real status vocabulary, not just the "awaiting-approval"
      // value that used to be the only one deriveStage produced. See
      // ApprovalsStageClamp.test.ts for the corruption-vector regression test.
      ["awaiting-approval", "approved", "rejected", "done", "failed"],
    ],
    [
      "spec-pipeline",
      [
        "intake",
        "needs-grilling",
        "researching",
        "generating-spec",
        "revision-needed",
        "escalated",
      ],
    ],
  ];

  for (const [queue, stages] of queueStages) {
    for (const stage of stages) {
      test(`stageToQueueStatus(${stage}, ${queue}) round-trips through deriveStage`, () => {
        if (!stageToQueueStatus) {
          throw new Error(
            "stageToQueueStatus not exported from PipelineFacade.ts — fix not applied"
          );
        }
        const displayStatus = stageToQueueStatus(stage, queue);
        const derivedStage = deriveStage(displayStatus, queue);
        expect(derivedStage).toBe(stage);
      });
    }
  }
});
