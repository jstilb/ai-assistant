#!/usr/bin/env bun
/**
 * JmTaskBridge.ts - Completion bridge between LucidTasks and WorkQueue
 *
 * When Jm completes a human task (via `bun TaskManager.ts done <id>`),
 * this bridge resolves the proxy WorkItem and completes the jm-tasks queue item,
 * unblocking the dependent work item for the next AutonomousWork run.
 *
 * Usage:
 *   bun JmTaskBridge.ts resolve --lucid-task-id <id>    # Main bridge command
 *   bun JmTaskBridge.ts resolve --queue-item-id <id>    # Alternate lookup
 *   bun JmTaskBridge.ts list                            # Show all pending human tasks
 */

import { parseArgs } from "util";
import { join } from "path";
import { WorkQueue } from "./WorkQueue.ts";

const KAYA_HOME = process.env.KAYA_HOME || join(process.env.HOME || "", ".claude");

// ============================================================================
// Queue Manager Integration (lazy import)
// ============================================================================

async function getQueueManager() {
  const { QueueManager } = await import("../../QueueRouter/Tools/QueueManager.ts");
  return new QueueManager();
}

// ============================================================================
// LucidTasks Integration (lazy import)
// ============================================================================

async function getLucidTaskDB() {
  const { getTaskDB } = await import("../../../Productivity/LucidTasks/Tools/TaskDB.ts");
  return getTaskDB();
}

// ============================================================================
// Commands
// ============================================================================

async function cmdResolve(lucidTaskId?: string, queueItemId?: string): Promise<void> {
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
      const { loadQueueItems, saveQueueItems } = await import("../../QueueRouter/Tools/QueueManager.ts");
      const items = loadQueueItems("approved-work");
      const idx = items.findIndex((i: { id: string }) => i.id === proxyItemId);
      if (idx !== -1 && items[idx].status !== "completed") {
        items[idx].status = "completed";
        items[idx].result = { completedAt: new Date().toISOString(), completedBy: "JmTaskBridge" };
        saveQueueItems("approved-work", items);
      }
    } catch (e) {
      // Non-fatal — approved-work sync is best-effort
      console.warn(`[JmTaskBridge] approved-work sync failed (non-fatal): ${e instanceof Error ? e.message : e}`);
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

  // Step 3: Complete the jm-tasks queue item (if we have a queueItemId)
  if (queueItemId) {
    try {
      const qm = await getQueueManager();
      await qm.complete(queueItemId, { completedBy: "jm" });
      console.log(`Queue item completed: ${queueItemId}`);
    } catch (err) {
      // Non-fatal — proxy resolution is the critical path
      console.warn(`Queue completion warning: ${err instanceof Error ? err.message : err}`);
    }
  }

  // Step 4: Log activity on the LucidTask
  if (lucidTaskId) {
    try {
      const db = await getLucidTaskDB();
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
