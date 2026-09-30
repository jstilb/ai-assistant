/**
 * OrphanRecovery.ts — Extracted from WorkOrchestrator.ts
 *
 * ISC 605: Orphan recovery logic extracted from WorkOrchestrator god object.
 *
 * Detects and recovers stale in_progress items via three paths:
 * - Path 1: Verified but never completed → complete()
 * - Path 2: Stale >4h with no verification → reset to pending
 * - Path 3: Stale >4h with non-PASS verification → retry()
 *
 * Also surfaces stale blocked items (>7 days) via notifications.
 */

import type { WorkQueue, WorkItemMetadata } from "./WorkQueue.ts";
import type { ISCManager } from "./ISCManager.ts";
import type { TransitionGuard } from "./TransitionGuard.ts";
import type { NotificationDispatcher } from "./NotificationDispatcher.ts";
import type { FaultClass } from "./WorkOrchestrator.ts";

// ============================================================================
// Types
// ============================================================================

export interface OrphanRecoveryDeps {
  queue: WorkQueue;
  iscManager: ISCManager;
  guard: TransitionGuard;
  notifier: NotificationDispatcher;
  /** Sync complete path — must not require async verification */
  completeSync: (itemId: string, result: string) => { success: boolean; reason?: string };
  /** Async retry path for escalation */
  retry: (itemId: string, error: string, faultClass?: FaultClass) => Promise<{ retried: boolean; escalated: boolean }>;
  /**
   * ISC 4: Stall threshold for event-inactivity detection (Path 4).
   * Items with metadata.lastEventAt older than this are moved to blocked.
   * Defaults to 30 minutes if not provided.
   */
  stallThresholdMs?: number;
}

// ============================================================================
// OrphanRecovery Function
// ============================================================================

/**
 * Recover stale items. Returns count of items recovered.
 *
 * Recovery paths:
 * - B2: Surface stale blocked items (>7 days) via notification (no auto-expire)
 * - Path 1: Verified but never completed → completeSync()
 * - Path 2: Stale in_progress >4h with no verification → reset to pending
 * - Path 3: Stale in_progress >4h with non-PASS verification → retry()
 */
export async function recoverOrphanedItems(deps: OrphanRecoveryDeps): Promise<number> {
  const STALE_THRESHOLD_MS = 4 * 60 * 60 * 1000; // 4 hours (Path 2/3 fallback)
  const HUMAN_PENDING_STALE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
  /** ISC 4: Event-inactivity stall threshold for Path 4 (default 30 min) */
  const EVENT_INACTIVITY_THRESHOLD_MS = deps.stallThresholdMs ?? 30 * 60 * 1000;
  const now = Date.now();
  let recovered = 0;

  // B2: Surface stale blocked items (does NOT auto-expire — just notifies)
  for (const item of deps.queue.getAllItems()) {
    if (item.status !== "blocked") continue;
    const createdAt = item.humanTaskRef?.createdAt ?? item.createdAt;
    if (!createdAt) continue;
    const createdMs = new Date(createdAt).getTime();
    if (now - createdMs > HUMAN_PENDING_STALE_MS) {
      const daysSince = Math.floor((now - createdMs) / (24 * 60 * 60 * 1000));
      deps.notifier.emitNeedsReviewNotification(
        item.id,
        item.title,
        "STALE",
        [`blocked item is ${daysSince} days old — needs Jm attention`]
      );
    }
  }

  for (const item of deps.queue.getAllItems()) {
    if (item.status !== "in_progress") continue;

    // Path 1: Verified but never completed — route through complete() for provenance checks
    if (
      item.verification?.status === "verified" &&
      item.verification.verdict === "PASS"
    ) {
      const rows = deps.iscManager.load(item.id);
      if (rows.length > 0 && rows.every(r => r.status === "VERIFIED")) {
        const completeResult = deps.completeSync(item.id, "Auto-completed by orphan recovery (verified but never completed)");
        if (completeResult.success) {
          recovered++;
        }
        continue;
      }
    }

    // Path 4 (ISC 4): Event-inactivity stall — item has lastEventAt older than threshold.
    // This runs BEFORE Path 2/3 (which use createdAt/startedAt) so that agents that heartbeat
    // are caught early (30m) while legacy items without heartbeat fall through to the 4h path.
    if (item.metadata?.lastEventAt) {
      const lastEventMs = new Date(item.metadata.lastEventAt as string).getTime();
      if (now - lastEventMs > EVENT_INACTIVITY_THRESHOLD_MS) {
        // Stamp stallReason before transitioning to blocked.
        // Use setItemMetadata if available (real WorkQueue), or setMetadata, or direct mutation (test mocks).
        const queueWithMeta = deps.queue as { setItemMetadata?: (id: string, meta: Record<string, unknown>) => void; setMetadata?: (id: string, meta: Record<string, unknown>) => void };
        if (typeof queueWithMeta.setItemMetadata === "function") {
          queueWithMeta.setItemMetadata(item.id, { stallReason: "event_inactivity" });
        } else if (typeof queueWithMeta.setMetadata === "function") {
          queueWithMeta.setMetadata(item.id, { stallReason: "event_inactivity" });
        } else {
          // Fallback: mutate in-memory (test mocks that lack metadata methods)
          if (!item.metadata) item.metadata = {};
          (item.metadata as Record<string, unknown>).stallReason = "event_inactivity";
        }
        deps.queue.updateStatus(item.id, "blocked");
        deps.notifier.emitNeedsReviewNotification(
          item.id,
          item.title,
          "STALE",
          [`event-inactivity stall: lastEventAt is ${Math.round((now - lastEventMs) / 60000)}m ago (threshold: ${Math.round(EVENT_INACTIVITY_THRESHOLD_MS / 60000)}m)`]
        );
        recovered++;
        continue;
      }
    }

    // Path 2: Stale with no verification (items lacking lastEventAt — legacy fallback at 4h)
    if (item.startedAt) {
      const startedMs = new Date(item.startedAt).getTime();
      if (now - startedMs > STALE_THRESHOLD_MS && !item.verification) {
        deps.queue.resetToPending(item.id, "Orphan recovery: stale in_progress >4h with no verification");
        recovered++;
        continue;
      }
    }

    // Path 3: Stale in_progress with non-PASS verification (dead zone fix — M3)
    // Routes through retry() for consistent strategy escalation, guard logging, and proxy creation
    if (item.startedAt && item.verification) {
      const startedMs = new Date(item.startedAt).getTime();
      if (now - startedMs > STALE_THRESHOLD_MS &&
          (item.verification.status === "needs_review" || item.verification.status === "failed")) {
        const recoveryError = `Orphan recovery: stale >4h with verification.status="${item.verification.status}"`;
        // S3b: derive a STRUCTURED faultClass from item metadata instead of leaving
        // retry() to re-derive it from the prose recoveryError string.
        const meta = item.metadata as WorkItemMetadata | undefined;
        const derivedFault: FaultClass | undefined =
          (((meta?.environmentBlockCount as number) ?? 0) > 0) ? "environment"
          : ((meta?.infraErrors?.length ?? 0) > 0) ? "infrastructure"
          : undefined;
        await deps.retry(item.id, recoveryError, derivedFault);
        recovered++;
        continue;
      }
    }
  }

  return recovered;
}
