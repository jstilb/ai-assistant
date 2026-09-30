#!/usr/bin/env bun
/**
 * QueueTaskReconciler.ts — Queue-side reconciliation against LucidTasks
 *
 * Scans spec-pipeline.jsonl and approvals.jsonl for live items linked to a
 * LucidTask — either via the item's `payload.context.lucidTaskId` or via the
 * task-side backlink (`tasks.queue_item_id` → item id; items enqueued before
 * June 2026 lack the payload stamp). For each matched item whose source
 * LucidTask is in a closed state (done, cancelled, someday), the item is
 * archived via QueueManager.archiveItemById with a reason derived from the
 * task status.
 *
 * Closed statuses queried: done, cancelled, someday
 *
 * Usage (CLI):
 *   bun skills/Automation/QueueRouter/Tools/QueueTaskReconciler.ts [--dry-run]
 *
 * Programmatic:
 *   import { reconcileQueueWithLucidTasks } from "./QueueTaskReconciler.ts";
 *   const report = await reconcileQueueWithLucidTasks({ dryRun: true });
 *
 * @module QueueTaskReconciler
 */

import { join } from "path";
import { existsSync, readFileSync } from "fs";
import { loadQueueItems, QueueManager, type QueueItem } from "./QueueManager.ts";
import { getTaskClient } from "../../../../lib/interfaces/QueueTaskIntegration.ts";
import { getKayaHome } from "../../../../lib/core/KayaHome.ts";

// ============================================================================
// Configuration
// ============================================================================

/** The JSONL queue files that may hold spec-pipeline or approval stage items. */
const RECONCILABLE_QUEUES = ["spec-pipeline", "approvals"] as const;

/** LucidTask statuses considered "closed" for reconciliation purposes. */
const CLOSED_STATUSES = ["done", "cancelled", "someday"] as const;
type ClosedStatus = (typeof CLOSED_STATUSES)[number];

/** LucidTask statuses considered "active" (mirrors the triage candidate set). */
const ACTIVE_STATUSES = ["inbox", "next", "in_progress", "waiting"] as const;
type ActiveStatus = (typeof ACTIVE_STATUSES)[number];

/** Queues where a task-side queue_item_id may legitimately point at a live item. */
const LINKABLE_QUEUES = ["spec-pipeline", "approvals", "approved-work"] as const;

/**
 * Item statuses meaning execution started or finished. An active task linked
 * to an ARCHIVED item in one of these states is never auto-cleared — work may
 * already have run, and re-triaging the task would redo it. Mirrors the
 * non-pre-execution set in QueueManager.archiveItemById.
 */
const POST_EXECUTION_STATUSES = new Set([
  "in_progress",
  "completed",
  "failed",
  "rejected",
  "approved",
]);

// ============================================================================
// Types
// ============================================================================

export interface ReconcileReport {
  /** Total queue items scanned (across spec-pipeline + approvals). */
  scanned: number;
  /** Count of items whose lucidTaskId matched a closed task. */
  matchedClosed: number;
  /** Items actually archived (or would be archived in dry-run mode). */
  archived: Array<{
    itemId: string;
    lucidTaskId: string;
    taskStatus: string;
    title: string;
  }>;
  /** Items matched to a closed task but skipped (non-pre-execution state). */
  skipped: Array<{
    itemId: string;
    reason: string;
  }>;
  /**
   * Orphaned-link direction: active tasks whose queue_item_id pointed at an
   * archived pre-execution item (or no item at all). Link cleared so the next
   * triage run re-ingests the task.
   */
  clearedLinks: Array<{
    taskId: string;
    itemId: string;
    itemLocation: string;
    title: string;
  }>;
  /**
   * Orphaned links NOT auto-cleared: the archived item reached a
   * post-execution state, so the work may already have run. Needs a human.
   */
  attention: Array<{
    taskId: string;
    itemId: string;
    reason: string;
  }>;
  /** true when running in dry-run mode (no mutations performed). */
  dryRun: boolean;
}

/** A minimal view of a closed LucidTask returned by the fetcher. */
export interface ClosedTask {
  id: string;
  status: string;
  title: string;
  /** Task-side backlink to the queue item it was enqueued as, when present. */
  queueItemId?: string | null;
}

/** A minimal view of an active LucidTask returned by the fetcher. */
export interface ActiveTask {
  id: string;
  status: string;
  title: string;
  queueItemId: string | null;
}

/** Where a task's linked queue item was found (or not). */
export type ItemLocation =
  | { found: "live" }
  | { found: "archived"; status: string }
  | { found: "missing" };

/** Injectable deps — used in tests to avoid real subprocess spawning. */
export interface ReconcileDeps {
  /**
   * Async function that returns ALL closed tasks.
   * In production this spawns TaskManager CLI; in tests it returns fixture data.
   */
  fetchClosedTasks?: () => Promise<ClosedTask[]>;
  /** Async function that returns ALL active tasks (for the orphaned-link pass). */
  fetchActiveTasks?: () => Promise<ActiveTask[]>;
  /** Clears tasks.queue_item_id on a task. Returns true on success. */
  clearTaskLink?: (taskId: string) => Promise<boolean>;
  /** Returns archived item statuses by item id (for the orphaned-link pass). */
  loadArchivedStatuses?: () => Map<string, string>;
}

// ============================================================================
// Pure decision: what to do with an active task's queue link
// ============================================================================

/**
 * Decide the action for an active task's queue_item_id based on where the
 * linked item was found.
 *
 *   live                          → leave   (link is healthy)
 *   missing                       → clear   (dangling id; re-triage the task)
 *   archived + pre-execution      → clear   (item was swept while task active —
 *                                            e.g. task closed then reopened;
 *                                            re-triage re-parks it with a fresh brief)
 *   archived + post-execution     → attention (work may have run; human decides)
 *
 * Pure function — no I/O, fully unit-testable.
 */
export function decideOrphanLinkAction(
  loc: ItemLocation
): "leave" | "clear" | "attention" {
  if (loc.found === "live") return "leave";
  if (loc.found === "missing") return "clear";
  return POST_EXECUTION_STATUSES.has(loc.status) ? "attention" : "clear";
}

// ============================================================================
// Production fetcher (spawns TaskManager CLI)
// ============================================================================

/**
 * Fetch closed tasks from LucidTasks via the registered TaskClient
 * (lib/interfaces/QueueTaskIntegration.ts — in-process, no subprocess spawn).
 * Queries done, cancelled, and someday in parallel to minimise latency.
 */
export async function fetchClosedTasksFromCLI(): Promise<ClosedTask[]> {
  const client = getTaskClient();
  if (!client) {
    console.error(
      "[QueueTaskReconciler] No TaskClient registered — cannot fetch closed tasks from " +
      "LucidTasks. Import bin/wire-queue-task-integration.ts before calling reconcileQueueWithLucidTasks.",
    );
    throw new Error("QueueTaskReconciler: TaskClient not registered — cannot fetch closed tasks");
  }

  const fetchStatus = async (status: ClosedStatus): Promise<ClosedTask[]> => {
    const rows = await client.listTasksByStatus(status);
    return rows.map((r) => ({
      id: r.id,
      status,
      title: r.title,
      queueItemId: r.queueItemId,
    }));
  };

  const batches = await Promise.all(CLOSED_STATUSES.map((s) => fetchStatus(s)));
  return batches.flat();
}

/**
 * Fetch active tasks from LucidTasks via the registered TaskClient (same
 * pattern as fetchClosedTasksFromCLI, over the active status set).
 */
async function fetchActiveTasksFromCLI(): Promise<ActiveTask[]> {
  const client = getTaskClient();
  if (!client) {
    console.error(
      "[QueueTaskReconciler] No TaskClient registered — cannot fetch active tasks from " +
      "LucidTasks. Import bin/wire-queue-task-integration.ts before calling reconcileQueueWithLucidTasks.",
    );
    throw new Error("QueueTaskReconciler: TaskClient not registered — cannot fetch active tasks");
  }

  const fetchStatus = async (status: ActiveStatus): Promise<ActiveTask[]> => {
    const rows = await client.listTasksByStatus(status);
    return rows.map((r) => ({
      id: r.id,
      status,
      title: r.title,
      queueItemId: r.queueItemId,
    }));
  };

  const batches = await Promise.all(ACTIVE_STATUSES.map((s) => fetchStatus(s)));
  return batches.flat();
}

/**
 * Clear tasks.queue_item_id via the registered TaskClient so the next triage
 * run re-ingests the task.
 */
async function clearTaskLinkViaCLI(taskId: string): Promise<boolean> {
  const client = getTaskClient();
  if (!client) {
    console.error(
      "[QueueTaskReconciler] No TaskClient registered — cannot clear queue_item_id link " +
      `for task ${taskId}. Import bin/wire-queue-task-integration.ts before calling reconcileQueueWithLucidTasks.`,
    );
    return false;
  }
  return client.updateTaskQueueLink(taskId, null);
}

/**
 * Read archived item statuses from MEMORY/QUEUES/archive/{queue}-archive.jsonl
 * for every linkable queue. Last entry wins for duplicate ids.
 */
function loadArchivedStatusesFromDisk(): Map<string, string> {
  const byId = new Map<string, string>();
  const archiveDir = join(getKayaHome(), "MEMORY/QUEUES/archive");
  for (const queueName of LINKABLE_QUEUES) {
    const path = join(archiveDir, `${queueName}-archive.jsonl`);
    if (!existsSync(path)) continue;
    const lines = readFileSync(path, "utf-8").split("\n");
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const item = JSON.parse(line) as { id?: string; status?: string };
        if (item.id) byId.set(item.id, item.status ?? "unknown");
      } catch {
        // Skip malformed archive lines — best-effort scan
      }
    }
  }
  return byId;
}

// ============================================================================
// Core reconciler
// ============================================================================

/**
 * Reconcile queue items against LucidTasks closed-task set.
 *
 * @param opts.dryRun  - When true, report what would be done without mutating queues.
 * @param deps         - Injectable dependencies (for testing).
 */
export async function reconcileQueueWithLucidTasks(
  opts: { dryRun?: boolean } = {},
  deps: ReconcileDeps = {},
): Promise<ReconcileReport> {
  const dryRun = opts.dryRun ?? false;
  const fetchClosed = deps.fetchClosedTasks ?? fetchClosedTasksFromCLI;
  const fetchActive = deps.fetchActiveTasks ?? fetchActiveTasksFromCLI;
  const clearLink = deps.clearTaskLink ?? clearTaskLinkViaCLI;
  const loadArchived = deps.loadArchivedStatuses ?? loadArchivedStatusesFromDisk;

  // Collect live items from the reconcilable queues.
  const liveItems: QueueItem[] = [];
  for (const queueName of RECONCILABLE_QUEUES) {
    liveItems.push(...loadQueueItems(queueName));
  }

  const report: ReconcileReport = {
    scanned: liveItems.length,
    matchedClosed: 0,
    archived: [],
    skipped: [],
    clearedLinks: [],
    attention: [],
    dryRun,
  };

  if (liveItems.length === 0) {
    await reconcileOrphanedLinks(report, { dryRun, fetchActive, clearLink, loadArchived });
    return report;
  }

  // Fetch all closed tasks and build lookup maps for both link directions:
  // item-side (payload.context.lucidTaskId) and task-side (tasks.queue_item_id).
  const closedTasks = await fetchClosed();
  const closedById = new Map<string, ClosedTask>(closedTasks.map((t) => [t.id, t]));
  const closedByQueueItemId = new Map<string, ClosedTask>();
  for (const t of closedTasks) {
    if (t.queueItemId) closedByQueueItemId.set(t.queueItemId, t);
  }

  const qm = new QueueManager();

  for (const item of liveItems) {
    const payloadLucidId = item.payload.context?.lucidTaskId;
    const closedTask =
      (typeof payloadLucidId === "string" ? closedById.get(payloadLucidId) : undefined) ??
      closedByQueueItemId.get(item.id);
    if (!closedTask) continue;

    const lucidTaskId = closedTask.id;
    report.matchedClosed++;
    const archiveReason = `source task ${closedTask.status}`;

    if (dryRun) {
      // Determine whether archival would succeed by checking pre-execution eligibility.
      const wouldBeRefused =
        item.queue === "approved-work" ||
        ["in_progress", "completed", "failed", "rejected", "approved"].includes(item.status);

      if (wouldBeRefused) {
        report.skipped.push({
          itemId: item.id,
          reason: `[dry-run] would skip — non-pre-execution state (queue: ${item.queue}, status: ${item.status})`,
        });
      } else {
        report.archived.push({
          itemId: item.id,
          lucidTaskId,
          taskStatus: closedTask.status,
          title: item.payload.title,
        });
      }
      continue;
    }

    // Live mode — attempt the archive.
    const result = await qm.archiveItemById(item.id, archiveReason);
    if (result.archived) {
      report.archived.push({
        itemId: item.id,
        lucidTaskId,
        taskStatus: closedTask.status,
        title: item.payload.title,
      });
    } else {
      report.skipped.push({
        itemId: item.id,
        reason: result.reason ?? `archiveItemById returned archived:false`,
      });
    }
  }

  await reconcileOrphanedLinks(report, { dryRun, fetchActive, clearLink, loadArchived });
  return report;
}

/**
 * Phase 2 — orphaned task-side links.
 *
 * Scans ACTIVE tasks carrying a queue_item_id and resolves where that item
 * lives. Items archived in a pre-execution state while their task is still
 * active (e.g. task closed → reverse-sync archived the item → task reopened)
 * leave the task permanently invisible to triage: the backlink excludes it
 * from candidates, but no live queue item exists. Clearing the link lets the
 * next hourly triage re-ingest the task with a fresh verdict and brief.
 */
async function reconcileOrphanedLinks(
  report: ReconcileReport,
  ctx: {
    dryRun: boolean;
    fetchActive: () => Promise<ActiveTask[]>;
    clearLink: (taskId: string) => Promise<boolean>;
    loadArchived: () => Map<string, string>;
  },
): Promise<void> {
  // Non-fatal: a failure here (e.g. TaskManager unavailable) must not discard
  // the closed-task pass results already in the report. Warn and return.
  let activeTasks: ActiveTask[];
  try {
    activeTasks = await ctx.fetchActive();
  } catch (err) {
    console.warn(
      `[reconcile] orphaned-link pass skipped — could not list active tasks: ${err instanceof Error ? err.message : String(err)}`
    );
    return;
  }
  const loadArchived = ctx.loadArchived;
  const linked = activeTasks.filter((t) => t.queueItemId);
  if (linked.length === 0) return;

  // Live item ids across every queue the link may legitimately point at.
  // Loaded AFTER the closed-task pass so items archived this run count as archived.
  const liveIds = new Set<string>();
  for (const queueName of LINKABLE_QUEUES) {
    for (const item of loadQueueItems(queueName)) {
      liveIds.add(item.id);
    }
  }
  const archivedById = loadArchived();

  for (const task of linked) {
    const itemId = task.queueItemId!;
    const loc: ItemLocation = liveIds.has(itemId)
      ? { found: "live" }
      : archivedById.has(itemId)
        ? { found: "archived", status: archivedById.get(itemId)! }
        : { found: "missing" };

    const action = decideOrphanLinkAction(loc);
    if (action === "leave") continue;

    if (action === "attention") {
      report.attention.push({
        taskId: task.id,
        itemId,
        reason: `linked item archived at post-execution status "${(loc as { status: string }).status}" — work may have run; close the task or relink manually`,
      });
      continue;
    }

    // action === "clear"
    const locationLabel = loc.found === "archived"
      ? `archived (${(loc as { status: string }).status})`
      : "missing";

    if (ctx.dryRun) {
      report.clearedLinks.push({
        taskId: task.id,
        itemId,
        itemLocation: `[dry-run] ${locationLabel}`,
        title: task.title,
      });
      continue;
    }

    const ok = await ctx.clearLink(task.id);
    if (ok) {
      report.clearedLinks.push({
        taskId: task.id,
        itemId,
        itemLocation: locationLabel,
        title: task.title,
      });
    } else {
      report.attention.push({
        taskId: task.id,
        itemId,
        reason: "failed to clear queue_item_id via TaskManager CLI",
      });
    }
  }
}

// ============================================================================
// CLI entry point
// ============================================================================

if (import.meta.main) {
  // Wire the QueueRouter <-> LucidTasks seam before reconciling — the fetch
  // functions above need a registered TaskClient (lib/interfaces/QueueTaskIntegration.ts).
  await import("../../../../bin/wire-queue-task-integration.ts");

  const dryRun = process.argv.includes("--dry-run");

  console.log(`QueueTaskReconciler — ${dryRun ? "DRY RUN" : "LIVE"}`);
  console.log("Querying closed LucidTasks and scanning queue items...\n");

  try {
    const report = await reconcileQueueWithLucidTasks({ dryRun });

    console.log(`Scanned:       ${report.scanned} live queue items`);
    console.log(`Matched closed: ${report.matchedClosed}`);
    console.log(`Archived:      ${report.archived.length}`);
    console.log(`Skipped:       ${report.skipped.length}`);
    console.log(`Cleared links: ${report.clearedLinks.length}`);
    console.log(`Attention:     ${report.attention.length}`);
    console.log(`Mode:          ${report.dryRun ? "dry-run (no changes made)" : "live"}`);

    if (report.archived.length > 0) {
      console.log("\nArchived items:");
      for (const entry of report.archived) {
        const prefix = dryRun ? "[would archive]" : "[archived]";
        console.log(`  ${prefix} ${entry.itemId}  lucid:${entry.lucidTaskId}  taskStatus:${entry.taskStatus}`);
        console.log(`           title: ${entry.title}`);
      }
    }

    if (report.skipped.length > 0) {
      console.log("\nSkipped items:");
      for (const entry of report.skipped) {
        console.log(`  [skipped] ${entry.itemId}  reason: ${entry.reason}`);
      }
    }

    if (report.clearedLinks.length > 0) {
      console.log("\nCleared task links (task will be re-triaged next run):");
      for (const entry of report.clearedLinks) {
        console.log(`  [cleared] task:${entry.taskId}  item:${entry.itemId}  was: ${entry.itemLocation}`);
        console.log(`           title: ${entry.title}`);
      }
    }

    if (report.attention.length > 0) {
      console.log("\nNeeds human attention:");
      for (const entry of report.attention) {
        console.log(`  [attention] task:${entry.taskId}  item:${entry.itemId}`);
        console.log(`           ${entry.reason}`);
      }
    }

    if (
      report.archived.length === 0 && report.skipped.length === 0 &&
      report.clearedLinks.length === 0 && report.attention.length === 0
    ) {
      console.log("\nNo orphaned items found — queues are consistent with LucidTasks.");
    }
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
