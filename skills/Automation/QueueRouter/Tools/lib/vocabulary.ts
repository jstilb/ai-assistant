#!/usr/bin/env bun
/**
 * vocabulary.ts — Canonical WorkItem / QueueItem ↔ PipelineItem field-mapping codecs.
 *
 * pipeline.db (via PipelineRepository) is the ONE store. WorkQueue.ts (WorkItem
 * vocabulary) and QueueManager.ts / PipelineFacade.ts (QueueItem vocabulary) are
 * thin facades over it. This module is the SINGLE place each facade's field
 * mapping to/from the canonical PipelineItem columns is implemented and tested.
 *
 * Extracted (slice S9) from:
 *   - WorkQueue.ts:      workItemToPipelineParams / pipelineItemToWorkItem
 *                         (plus the WORK_STATUS_TO_STAGE / STAGE_TO_WORK_STATUS
 *                         and priority codecs they depend on)
 *   - PipelineFacade.ts: queueItemToPipelineParams / pipelineItemToQueueItem
 *                         (plus deriveStage / stageToQueueStatus / VALID_STAGES)
 *
 * ...to replace the hand-maintained "FIELD MAPPING TABLE" comment that used to
 * sit at the top of PipelineRepository.ts — a plain-English description of
 * these same mappings with no mechanism to catch drift from the code that
 * actually implemented them. This file IS the mapping now; both facades
 * import the converters from here, and PipelineRepository.ts just points here.
 *
 * Pure functions and lookup tables only — no I/O, no db handles, no imports of
 * the PipelineRepository class (only its `PipelineItem` / `Stage` types).
 *
 * @module vocabulary
 */

import type { PipelineItem, Stage } from "../PipelineRepository.ts";
import type {
  WorkItem,
  WorkStatus,
  Priority as WorkPriority,
  WorkItemMetadata,
  WorkItemAttempt,
  WorkItemVerification,
} from "../../../AutonomousWork/Tools/WorkQueue.ts"; // cross-skill-allowed: type-only codec — vocabulary.ts IS the WorkItem↔PipelineItem translation layer (ADR-003); erased at runtime
import type { QueueItem, QueueItemStatus } from "../QueueManager.ts";
import type { TaskStatus } from "../../../../Productivity/LucidTasks/Tools/TaskDB.ts"; // cross-skill-allowed: type-only QueueItem→LucidTask status codec; erased at runtime

export const QUEUE_STATUS_TO_LUCID_TASK_STATUS: Readonly<Record<string, TaskStatus | undefined>> = {
  approved: "next",
  pending: "next",
  in_progress: "in_progress",
  completed: "done",
};

// ============================================================================
// WorkItem ↔ PipelineItem codec
// ============================================================================

// ----------------------------------------------------------------------------
// WorkStatus ↔ Stage codec
//
// WorkQueue operates on WorkStatus strings; PipelineRepository stores Stage strings.
// Mapping:
//   pending      → "approved"      (execution-stage items are pre-approved work)
//   in_progress  → "in-progress"
//   completed    → "done"
//   partial      → "partial"
//   failed       → "failed"
//   blocked      → "blocked"
//   needs_review → "needs-review"
// ----------------------------------------------------------------------------

export const WORK_STATUS_TO_STAGE: Record<WorkStatus, Stage> = {
  pending:      "approved",
  in_progress:  "in-progress",
  completed:    "done",
  partial:      "partial",
  failed:       "failed",
  blocked:      "blocked",
  needs_review: "needs-review",
};

export const STAGE_TO_WORK_STATUS: Partial<Record<Stage, WorkStatus>> = {
  "approved":     "pending",
  "in-progress":  "in_progress",
  "done":         "completed",
  "partial":      "partial",
  "failed":       "failed",
  "blocked":      "blocked",
  "needs-review": "needs_review",
};

// ----------------------------------------------------------------------------
// WorkItem priority codec
//
// WorkItem priority: "low" | "normal" | "high" | "critical"
// PipelineItem priority: 1 (highest) | 2 | 3 (lowest)
// ----------------------------------------------------------------------------

export const WORK_PRIORITY_TO_PIPELINE_PRIORITY: Record<WorkPriority, 1 | 2 | 3> = {
  critical: 1,
  high:     1,
  normal:   2,
  low:      3,
};

export const PIPELINE_PRIORITY_TO_WORK_PRIORITY: Record<1 | 2 | 3, WorkPriority> = {
  1: "high",   // critical is preserved in rawWorkItem; 1→high is the fallback
  2: "normal",
  3: "low",
};

/**
 * Convert a WorkItem into PipelineRepository upsert params.
 * The full WorkItem is stored in metadata.rawWorkItem for faithful round-tripping.
 */
export function workItemToPipelineParams(
  item: WorkItem,
): Partial<PipelineItem> & { id: string } {
  const stage = WORK_STATUS_TO_STAGE[item.status] ?? "approved";
  const priority = WORK_PRIORITY_TO_PIPELINE_PRIORITY[item.priority] ?? 2;
  return {
    id: item.id,
    stage,
    priority,
    source: item.source,
    title: item.title,
    description: item.description,
    created_at: item.createdAt,
    dependencies: item.dependencies,
    started_at: item.startedAt,
    completed_at: item.completedAt,
    result: item.result,
    error: item.error,
    spec_path: item.specPath,
    project_path: item.projectPath,
    output_path: item.outputPath,
    worktree_path: item.metadata?.worktreePath as string | undefined,
    worktree_branch: item.metadata?.worktreeBranch as string | undefined,
    retry_eligible_after: item.retryEligibleAfter,
    verification: item.verification as PipelineItem["verification"],
    attempts: (item.attempts ?? []) as unknown[],
    isc_rows: (item.metadata?.iscRows ?? []) as unknown[],
    progress: {
      phasesCompleted: item.completedPhases,
      totalPhases: item.totalPhases,
    },
    metadata: {
      rawWorkItem: item,
      effort: item.effort,
      workType: item.workType,
      testStrategyPath: item.testStrategyPath,
      humanTaskRef: item.humanTaskRef,
      surface: item.surface,
      ...(item.metadata ?? {}),
    },
    context: {},
  };
}

/**
 * Reconstruct a WorkItem from a PipelineItem row.
 * Uses metadata.rawWorkItem for exact fidelity.
 */
export function pipelineItemToWorkItem(pi: PipelineItem): WorkItem {
  // Prefer the full rawWorkItem stored in metadata for perfect round-tripping
  const raw = pi.metadata?.rawWorkItem;
  const workItem: WorkItem =
    raw &&
    typeof raw === "object" &&
    typeof (raw as WorkItem).id === "string" &&
    typeof (raw as WorkItem).title === "string"
      ? (raw as WorkItem)
      : {
          // Fallback: reconstruct from first-class columns
          id: pi.id,
          title: pi.title,
          description: pi.description,
          priority: PIPELINE_PRIORITY_TO_WORK_PRIORITY[(pi.priority as 1 | 2 | 3)] ?? "normal",
          status: STAGE_TO_WORK_STATUS[pi.stage] ?? "pending",
          dependencies: pi.dependencies ?? [],
          source: (pi.source as "approval_queue" | "manual") ?? "manual",
          createdAt: pi.created_at,
          startedAt: pi.started_at,
          completedAt: pi.completed_at,
          result: pi.result,
          error: pi.error,
          specPath: pi.spec_path,
          projectPath: pi.project_path,
          outputPath: pi.output_path,
          retryEligibleAfter: pi.retry_eligible_after,
          verification: pi.verification as WorkItemVerification | undefined,
          attempts: pi.attempts as WorkItemAttempt[] | undefined,
          metadata: pi.metadata as WorkItemMetadata | undefined,
        };

  // F3: mergeStatus vocabulary unification — legacy rows (written before this slice)
  // may still carry metadata.mergeStatus === "pending_human". Normalize on read so
  // every WorkItem consumer sees the canonical "pending_approval" value without a
  // live pipeline.db migration. Idempotent (no-op once the underlying row is
  // eventually rewritten) and covers both the rawWorkItem round-trip and fallback
  // branches above since it runs on the final workItem.metadata either way.
  if ((workItem.metadata?.mergeStatus as string | undefined) === "pending_human") {
    workItem.metadata = { ...workItem.metadata, mergeStatus: "pending_approval" };
  }

  return workItem;
}

// ============================================================================
// QueueItem ↔ PipelineItem codec
// ============================================================================

/** All valid Stage values — used for fallback mapping in unknown queues */
export const VALID_STAGES = new Set<string>([
  "intake", "needs-grilling", "researching", "generating-spec",
  "revision-needed", "escalated", "awaiting-approval", "approved",
  "in-progress", "partial", "needs-review", "blocked",
  "done", "failed", "rejected", "archived",
]);

/**
 * Derive a unified pipeline Stage from a QueueItem's status + queue name.
 *
 * Mapping rules:
 *   spec-pipeline:   awaiting-context → intake; all others map directly if valid
 *   approvals:       awaiting_approval/pending → awaiting-approval; approved →
 *                    approved; rejected → rejected; completed → done; failed →
 *                    failed (real status vocabulary confirmed against a live
 *                    pipeline.db clone — see ApprovalsStageClamp.test.ts)
 *   approved-work:   pending → approved; in_progress → in-progress;
 *                    completed/approved → done; and so on
 *   unknown queues:  status used if it's a valid Stage, else "intake"
 */
export function deriveStage(status: string, queueName: string): Stage {
  if (queueName === "spec-pipeline") {
    if (status === "awaiting-context") return "intake";
    if (VALID_STAGES.has(status)) return status as Stage;
    return "intake";
  }
  if (queueName === "approvals") {
    switch (status) {
      // "pending" is not the normal creation status (SpecPipelineRunner's
      // transfer() explicitly sets "awaiting_approval"), but QueueManager.add()
      // falls back to "pending" when a routing rule resolves requiresApproval
      // to false yet the caller still forces queue="approvals" — treat it as
      // the same "not yet reviewed" state.
      case "awaiting_approval":
      case "pending":
        return "awaiting-approval";
      case "approved": return "approved";           // QueueManager.approve() (pre-transfer)
      case "rejected": return "rejected";            // QueueManager.reject()
      case "completed": return "done";               // QueueManager.complete()
      case "failed": return "failed";                // QueueManager.fail()
      default:
        if (VALID_STAGES.has(status)) return status as Stage;
        return "awaiting-approval";
    }
  }
  if (queueName === "approved-work") {
    switch (status) {
      case "pending": return "approved";
      case "in_progress": return "in-progress";
      case "partial": return "partial";
      case "needs_review": return "needs-review";
      case "blocked": return "blocked";
      case "completed":
      case "approved": return "done";
      case "failed": return "failed";
      case "rejected": return "rejected";
      default:
        if (VALID_STAGES.has(status)) return status as Stage;
        return "approved";
    }
  }
  // Unknown queue: use status if it's already a valid Stage, else "intake"
  if (VALID_STAGES.has(status)) return status as Stage;
  return "intake";
}

/**
 * Derive the user-facing QueueItemStatus from a pipeline Stage and queue name.
 *
 * This is the left-inverse of deriveStage: for every Stage s and queue q that
 * the queue uses, deriveStage(stageToQueueStatus(s, q), q) === s.
 *
 * Used by pipelineItemToQueueItem so the READ projection always reflects the
 * authoritative pi.stage, not the stale metadata.rawQueueItem.status.
 */
export function stageToQueueStatus(stage: Stage, queueName: string): QueueItemStatus {
  if (queueName === "approved-work") {
    switch (stage) {
      case "approved":      return "pending";        // deriveStage("pending","approved-work") === "approved"
      case "in-progress":   return "in_progress";
      case "partial":       return "partial";
      case "needs-review":  return "needs_review";
      case "blocked":       return "blocked";
      case "done":          return "completed";      // deriveStage("completed",...) === "done"
      case "failed":        return "failed";
      case "rejected":      return "rejected";
      case "archived":      return "completed";
      default:              return stage as QueueItemStatus;
    }
  }
  if (queueName === "approvals") {
    switch (stage) {
      case "awaiting-approval": return "awaiting_approval"; // deriveStage("awaiting_approval","approvals") === "awaiting-approval"
      case "approved":          return "approved";          // deriveStage("approved","approvals") === "approved"
      case "rejected":          return "rejected";          // deriveStage("rejected","approvals") === "rejected"
      case "done":              return "completed";          // deriveStage("completed","approvals") === "done"
      case "failed":            return "failed";            // deriveStage("failed","approvals") === "failed"
      // "archived" parity with approved-work above — never hit via deriveStage
      // (archive() sets stage through transition(), not upsert) and list()
      // excludes archived rows, so this arm is defensive only.
      case "archived":          return "completed";
      default:                 return stage as QueueItemStatus;
    }
  }
  if (queueName === "spec-pipeline") {
    if (stage === "intake") return "awaiting-context";
    // needs-grilling/researching/generating-spec/revision-needed/escalated are identity
    return stage as QueueItemStatus;
  }
  // Unknown queue
  if (stage === "intake") return "pending";
  return stage as QueueItemStatus;
}

/**
 * Convert a QueueItem into PipelineRepository upsert params.
 * The full QueueItem is stored in metadata.rawQueueItem for faithful round-tripping.
 */
export function queueItemToPipelineParams(
  item: QueueItem
): Partial<PipelineItem> & { id: string } {
  const stage = deriveStage(item.status, item.queue);
  const context = (item.payload?.context ?? {}) as Record<string, unknown>;
  // lucid_task_id is a first-class, indexed column (idx_pipeline_lucid in
  // PipelineDB.ts) that PipelineRepository.upsert() has always accepted — but
  // until A5 this codec never populated it, so every row's LucidTask
  // cross-reference lived only inside the opaque context JSON blob. Extract
  // defensively: only a non-empty string counts, anything else (missing,
  // null, number, empty string) is treated as absent rather than thrown on.
  const lucidTaskId =
    typeof context.lucidTaskId === "string" && context.lucidTaskId.length > 0
      ? context.lucidTaskId
      : undefined;
  return {
    id: item.id,
    stage,
    priority: item.priority as 1 | 2 | 3,
    source: item.source,
    type: item.type,
    queue: item.queue,
    title: item.payload?.title ?? "",
    description: item.payload?.description ?? "",
    lucid_task_id: lucidTaskId,
    created_at: item.created,
    updated_at: item.updated,
    project_path: item.project?.path,
    spec_id: item.spec?.id,
    spec_path: item.spec?.path,
    spec_status: item.spec?.status,
    spec_approved_at: item.spec?.approvedAt,
    spec_approved_by: item.spec?.approvedBy,
    result: item.result?.output !== undefined ? JSON.stringify(item.result.output) : undefined,
    error: item.result?.error,
    completed_at: item.result?.completedAt ?? item.result?.approvedAt,
    metadata: {
      rawQueueItem: item,
      // First-class copies of a few high-value fields for querying:
      projectName: item.project?.name,
      projectGitRemote: item.project?.gitRemote,
      assignedAgent: item.routing?.assignedAgent,
      approver: item.routing?.approver,
      sourceQueue: item.routing?.sourceQueue,
      targetQueue: item.routing?.targetQueue,
      reviewNotes: item.result?.reviewNotes,
    },
    context,
    progress: (item.progress ?? {}) as Record<string, unknown>,
    // Omitted (not []) — QueueItem has no field for these, so this codec has no
    // source of truth. [] is not undefined, so it used to blow away whatever
    // WorkQueue's codec had legitimately written. Omitting lets upsert()'s
    // `item.X ?? existingItem?.X` and transition()'s skip-undefined-patch-fields
    // preserve the existing row (fable-remediation b1/b2).
  };
}

/**
 * Queues for which stage→status derivation is reliable (deriveStage is the left-inverse).
 * For unknown queues, deriveStage is lossy (e.g. "completed" → "intake") so we preserve
 * the rawQueueItem.status rather than projecting through the lossy stage.
 */
const KNOWN_QUEUES_WITH_RELIABLE_STAGE = new Set(["approved-work", "approvals", "spec-pipeline"]);

/**
 * Reconstruct a QueueItem from a PipelineItem row.
 * Uses metadata.rawQueueItem for exact fidelity.
 */
export function pipelineItemToQueueItem(pi: PipelineItem | null): QueueItem | null {
  if (!pi) return null;
  const raw = pi.metadata?.rawQueueItem;
  if (raw && typeof raw === "object" && typeof (raw as QueueItem).payload?.title === "string") {
    const queue = (raw as QueueItem).queue ?? pi.queue ?? "";
    if (KNOWN_QUEUES_WITH_RELIABLE_STAGE.has(queue)) {
      // Override status from the authoritative pi.stage — rawQueueItem.status may be
      // stale (frozen at write time; stage may have advanced since then).
      return {
        ...(raw as QueueItem),
        status: stageToQueueStatus(pi.stage, queue),
      };
    }
    // Unknown queue: deriveStage is lossy for some statuses (e.g. "completed" → "intake"),
    // so preserve rawQueueItem.status to avoid corrupting terminal status values.
    return raw as QueueItem;
  }
  // Fallback reconstruction (for items created outside the facade)
  return {
    id: pi.id,
    created: pi.created_at,
    updated: pi.updated_at,
    source: pi.source ?? "unknown",
    priority: pi.priority as 1 | 2 | 3,
    status: stageToQueueStatus(pi.stage, pi.queue ?? ""),
    type: pi.type ?? "task",
    queue: pi.queue ?? "",
    payload: { title: pi.title, description: pi.description },
  };
}
