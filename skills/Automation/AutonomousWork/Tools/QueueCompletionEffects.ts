/**
 * QueueCompletionEffects.ts — relocated from QueueSyncBridge
 *
 * The two non-trivial side-effects that fire when a WorkQueue item completes:
 * 1. Close the `manual-${itemId}` "Kaya — Needs Jm" escalation task in TaskDB.
 * 2. Sync the source LucidTask to "completed" (if payload.context.lucidTaskId set).
 *
 * Non-fatal: each effect is wrapped in its own try/catch; a failure logs but
 * never blocks the completion path (matches QueueSyncBridge fire-and-forget).
 * Idempotent: guarded by status checks, safe to call multiple times per item.
 */

/**
 * Apply the two side-effects that must fire when a work item completes:
 *   (a) Close the `manual-${itemId}` escalation task in TaskDB if still open.
 *   (b) Sync the source LucidTask (payload.context.lucidTaskId) to "completed".
 *
 * Non-fatal: errors are logged, never rethrown.
 * Idempotent: both checks guard against double-applies.
 */
export async function applyCompletionSideEffects(itemId: string): Promise<void> {
  // Side effect 1: Close the escalation LucidTask (created as `manual-${itemId}`
  // in "Kaya — Needs Jm" by NotificationDispatcher.createJmTask) — the parent
  // work item completing means the escalation is moot.
  try {
    // cross-skill-allowed: Lane-A escalation writes LucidTasks tasks by design (07-02 overhaul); seam candidate: TaskClient
    const { getTaskDB } = await import("../../../Productivity/LucidTasks/Tools/TaskDB.ts");
    const db = getTaskDB();
    const escTask = db.getTask(`manual-${itemId}`);
    if (escTask && escTask.status !== "done" && escTask.status !== "cancelled") {
      db.updateTask(`manual-${itemId}`, { status: "done" }, "WorkOrchestrator");
    }
  } catch (e) {
    console.error(
      `[applyCompletionSideEffects] escalation task close failed for ${itemId} (non-fatal): ${e instanceof Error ? e.message : e}`
    );
  }

  // Side effect 2: Sync the source LucidTask to "completed".
  // The lucidTaskId is carried in the QueueItem's payload.context, which
  // loadQueueItems reads from pipeline.db (PipelineFacade facade).
  // Called even when the queue record was already completed so a missed sync
  // self-heals on the next write-back (matches original bridge behaviour).
  try {
    // cross-skill-allowed: reads QueueRouter's approved-work/approvals/spec-pipeline stores for the lucidTaskId carried in payload.context — WorkQueue/QueueRouter share the single-store pipeline design (ADR-003)
    const { loadQueueItems } = await import("../../QueueRouter/Tools/QueueManager.ts");
    const lucidTaskId =
      (loadQueueItems("approved-work").find((i: { id: string }) => i.id === itemId)
        ?.payload?.context?.lucidTaskId as string | undefined) ??
      (loadQueueItems("approvals").find((i: { id: string }) => i.id === itemId)
        ?.payload?.context?.lucidTaskId as string | undefined) ??
      (loadQueueItems("spec-pipeline").find((i: { id: string }) => i.id === itemId)
        ?.payload?.context?.lucidTaskId as string | undefined);
    if (lucidTaskId) {
      // cross-skill-allowed: Lane-A escalation writes LucidTasks tasks by design (07-02 overhaul) — syncs the source LucidTask's status on work-item completion; seam candidate: TaskClient
      const { syncQueueStatus } = await import("../../../Productivity/LucidTasks/Tools/TaskManager.ts");
      syncQueueStatus(lucidTaskId, "completed");
    }
  } catch (e) {
    console.error(
      `[applyCompletionSideEffects] LucidTask done-sync failed for ${itemId} (non-fatal): ${e instanceof Error ? e.message : e}`
    );
  }
}
