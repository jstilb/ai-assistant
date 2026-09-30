#!/usr/bin/env bun
/**
 * JmTaskBridge.ts - Completion bridge between LucidTasks and WorkQueue
 *
 * When Jm completes a human task (via the resolve command embedded in the
 * task description), this bridge resolves the proxy WorkItem and closes the
 * escalation LucidTask in "Kaya — Needs Jm", unblocking the dependent work
 * item for the next AutonomousWork run.
 *
 * Usage:
 *   bun JmTaskBridge.ts resolve --lucid-task-id <id>    # Main bridge command
 *   bun JmTaskBridge.ts resolve --queue-item-id <id>    # Alternate lookup
 *   bun JmTaskBridge.ts list                            # Show all pending human tasks
 */

import { parseArgs } from "util";
import { WorkQueue } from "./WorkQueue.ts";
import { sendAlert } from "../../../../lib/core/AlertGate.ts";

// ============================================================================
// LucidTasks Integration (lazy import)
// ============================================================================

async function getLucidTaskDB() {
  // cross-skill-allowed: Lane-A escalation writes LucidTasks tasks by design (07-02 overhaul) — JmTaskBridge closes/looks up escalation and per-row [Human Action] tasks on proxy resolution; seam candidate: TaskClient
  const { getTaskDB } = await import("../../../Productivity/LucidTasks/Tools/TaskDB.ts");
  return getTaskDB();
}

/**
 * Emit a digest-tier alert for sync-path failures — routed through AlertGate
 * per ADR-004 (docs/decisions/004-notification-traffic-through-alertgate.md)
 * instead of calling NotificationService directly. We never want
 * notification delivery to block proxy resolution, but we also don't want
 * the failures F-015 highlighted to keep disappearing into stderr — digest
 * tier means it surfaces in the next daily digest rather than firing a raw
 * high-priority push for what is a non-fatal, best-effort sync step.
 * sendAlert() never throws, so there's nothing left here to swallow.
 */
export async function alertSyncFailure(stage: string, err: unknown): Promise<void> {
  const detail = err instanceof Error ? err.message : String(err);
  console.warn(`[JmTaskBridge] ${stage} failed (non-fatal): ${detail}`);
  await sendAlert(`JmTaskBridge ${stage} failed: ${detail}`, {
    key: `jm-task-bridge-${stage.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
    tier: "digest",
  });
}

// ============================================================================
// Commands
// ============================================================================

export async function cmdResolve(lucidTaskId?: string, queueItemId?: string): Promise<void> {
  const wq = new WorkQueue();

  // Step 1: Find the proxy WorkItem by lucidTaskId or queueItemId
  let proxyItemId: string | undefined;

  if (lucidTaskId) {
    // Look up the LucidTask to get its queue_item_id
    const db = await getLucidTaskDB();
    const task = db.getTask(lucidTaskId);
    if (!task) {
      console.error(`LucidTask not found: ${lucidTaskId}`);
      process.exit(1);
    }
    queueItemId = task.queue_item_id || undefined;

    // Find the proxy item in WorkQueue by matching humanTaskRef.lucidTaskId
    const blockedItems = wq.getBlockedItems();
    const proxy = blockedItems.find(i => i.humanTaskRef?.lucidTaskId === lucidTaskId);
    if (proxy) {
      proxyItemId = proxy.id;
      // Per-row [Human Action] tasks deliberately carry no queue_item_id (it
      // would arm the reverse-sync archive hook); the parent work item id
      // lives on the proxy instead.
      queueItemId = queueItemId ?? proxy.humanTaskRef?.queueItemId;
    }

    // If no proxy found via humanTaskRef, try via queueItemId in the queue context
    if (!proxyItemId && queueItemId) {
      const proxy2 = blockedItems.find(i => i.humanTaskRef?.queueItemId === queueItemId);
      if (proxy2) proxyItemId = proxy2.id;
    }

    db.close();
  } else if (queueItemId) {
    // Find the proxy by matching humanTaskRef.queueItemId
    const blockedItems = wq.getBlockedItems();
    const proxy = blockedItems.find(i => i.humanTaskRef?.queueItemId === queueItemId);
    if (proxy) {
      proxyItemId = proxy.id;
    }
  }

  if (!proxyItemId) {
    console.error("No blocked item found for the given ID");
    process.exit(1);
  }

  // Step 2: Resolve the proxy WorkItem
  try {
    const resolved = wq.resolveBlocked(proxyItemId);
    if (!resolved) {
      console.error(`Failed to resolve proxy: ${proxyItemId}`);
      process.exit(1);
    }
    console.log(`Proxy resolved: ${resolved.id} → completed`);

    // Sync proxy completion to approved-work JSONL (L2)
    try {
      // cross-skill-allowed: syncs proxy completion into QueueRouter's approved-work store (L2) — WorkQueue/QueueRouter share the single-store pipeline design (ADR-003)
      const { loadQueueItems, saveQueueItems } = await import("../../QueueRouter/Tools/QueueManager.ts");
      const items = loadQueueItems("approved-work");
      const idx = items.findIndex((i: { id: string }) => i.id === proxyItemId);
      if (idx !== -1 && items[idx].status !== "completed") {
        items[idx].status = "completed";
        items[idx].result = { completedAt: new Date().toISOString(), completedBy: "JmTaskBridge" };
        saveQueueItems("approved-work", items);
      }
    } catch (e) {
      // Non-fatal — approved-work sync is best-effort, but we must not swallow
      // (F-015): silent warn caused the original 22-stale-items incident.
      await alertSyncFailure("approved-work sync", e);
    }

    // Find what items this proxy was blocking
    const allItems = wq.getAllItems();
    const unblockedItems = allItems.filter(item =>
      item.dependencies.includes(resolved.id) &&
      item.status === "pending"
    );
    if (unblockedItems.length > 0) {
      // Check if they're now ready (all deps completed)
      for (const item of unblockedItems) {
        const allDepsMet = item.dependencies.every(depId => {
          const dep = wq.getItem(depId);
          return dep?.status === "completed";
        });
        if (allDepsMet) {
          console.log(`  Unblocked: ${item.id} — ${item.title}`);
        }
      }
    }
  } catch (err) {
    console.error(`Proxy resolution failed: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }

  // Step 3: Close the escalation LucidTask (if we have a queueItemId)
  // Escalation tasks are created with ID `manual-${workItemId}` by createJmTask
  // (NotificationDispatcher) in the "Kaya — Needs Jm" project. The queueItemId
  // here is the parent work item ID (from the proxy's humanTaskRef or CLI arg).
  if (queueItemId) {
    try {
      const db = await getLucidTaskDB();
      const escTaskId = `manual-${queueItemId}`;
      const escTask = db.getTask(escTaskId);
      if (escTask && escTask.status !== "done" && escTask.status !== "cancelled") {
        db.updateTask(escTaskId, { status: "done" }, "JmTaskBridge");
        console.log(`Escalation task closed: ${escTaskId}`);
      }
      db.close();
    } catch (err) {
      // Non-fatal — proxy resolution is the critical path, but not silent.
      await alertSyncFailure("escalation task close", err);
    }
  }

  // Step 4: Close the per-row [Human Action] LucidTask and log activity.
  // The resolve command only runs once the human action is complete, so the
  // task is done — leaving it open would strand it on the board.
  if (lucidTaskId) {
    try {
      const db = await getLucidTaskDB();
      const task = db.getTask(lucidTaskId);
      if (task && task.status !== "done" && task.status !== "cancelled") {
        db.updateTask(lucidTaskId, { status: "done" }, "JmTaskBridge");
        console.log(`Human action task closed: ${lucidTaskId}`);
      }
      db.logActivity(
        lucidTaskId,
        "work_unblocked",
        JSON.stringify({ proxyItemId, queueItemId }),
        "bridge"
      );
      db.close();
    } catch {
      // Non-fatal
    }
  }
}

async function cmdList(): Promise<void> {
  const wq = new WorkQueue();
  const blockedItems = wq.getBlockedItems();

  if (blockedItems.length === 0) {
    console.log("No blocked tasks");
    return;
  }

  console.log(`Blocked Tasks (${blockedItems.length}):\n`);
  for (const item of blockedItems) {
    const ref = item.humanTaskRef;
    console.log(`  ${item.id}`);
    console.log(`    Title:     ${item.title}`);
    if (ref) {
      console.log(`    LucidTask: ${ref.lucidTaskId}`);
      console.log(`    Queue:     ${ref.queueItemId}`);
      console.log(`    Guide:     ${ref.guideFilePath}`);
      console.log(`    Created:   ${ref.createdAt}`);
    }

    // Show what this blocks
    const allItems = wq.getAllItems();
    const blockedBy = allItems.filter(i => i.dependencies.includes(item.id));
    if (blockedBy.length > 0) {
      console.log(`    Blocks:`);
      for (const blocked of blockedBy) {
        console.log(`      - ${blocked.id}  ${blocked.title}`);
      }
    }
    console.log("");
  }
}

// ============================================================================
// CLI
// ============================================================================

function main() {
  const { values, positionals } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      help: { type: "boolean", short: "h" },
      "lucid-task-id": { type: "string" },
      "queue-item-id": { type: "string" },
    },
    allowPositionals: true,
  });

  const cmd = positionals[0];

  if (values.help || !cmd) {
    console.log(`
JmTaskBridge — Completion bridge between LucidTasks and WorkQueue

Commands:
  resolve --lucid-task-id <id>    Resolve human task by LucidTask ID
  resolve --queue-item-id <id>    Resolve human task by queue item ID
  list                            Show all pending human tasks with blocked items
`);
    return;
  }

  switch (cmd) {
    case "resolve": {
      const lucidTaskId = values["lucid-task-id"];
      const queueItemId = values["queue-item-id"];
      if (!lucidTaskId && !queueItemId) {
        console.error("Either --lucid-task-id or --queue-item-id required");
        process.exit(1);
      }
      cmdResolve(lucidTaskId, queueItemId).catch(err => {
        console.error(`Bridge error: ${err instanceof Error ? err.message : err}`);
        process.exit(1);
      });
      break;
    }

    case "list": {
      cmdList().catch(err => {
        console.error(`List error: ${err instanceof Error ? err.message : err}`);
        process.exit(1);
      });
      break;
    }

    default:
      console.error(`Unknown command: ${cmd}. Use --help.`);
      process.exit(1);
  }
}

if (import.meta.main) main();
