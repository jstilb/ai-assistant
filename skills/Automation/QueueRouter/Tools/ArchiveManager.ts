/**
 * ArchiveManager.ts — ISC 610: Extracted from QueueManager.ts
 *
 * Time-based archival and restoration of queue items.
 * Wraps the archiveItems primitive from QueueManager.ts with business logic
 * about what to archive, when, and how to restore.
 *
 * Note: restore() and listArchivedItems() are NEW capabilities added by this extraction.
 * QueueManager.cleanup() archives items but they are otherwise inaccessible without
 * reading the archive file directly.
 *
 * J2: previously wired through a standalone queue-name + config I/O module
 * that had exactly one importer (this file) — that module was deleted, and
 * ArchiveManager now imports QueueManager.ts's facade exports directly.
 * Those facades are config-less (they read KAYA_HOME internally via
 * getQueuesDir()/getArchiveDir()/getStateFile()), so the config object that
 * used to thread through every call here is gone too.
 */

import { existsSync, readFileSync } from "fs";
import { join } from "path";
import {
  archiveItems,
  loadQueueItems,
  saveQueueItems,
  loadState,
  saveStateSync,
  discoverQueues,
  getArchiveDir,
  ARCHIVABLE_TERMINAL_STATUSES,
  releaseLucidTaskBacklinks,
} from "./QueueManager.ts";
import type { QueueItem } from "./QueueManager.ts";

export interface CleanupResult {
  removed: number;
  archived: number;
}

/**
 * Archive terminal items (completed/failed/rejected) older than daysOld.
 * Archived items are moved to the queue's archive JSONL (not deleted).
 *
 * Only statuses in ARCHIVABLE_TERMINAL_STATUSES are ever archived — live
 * working statuses (needs-grilling, awaiting-context, researching, …) are
 * always kept regardless of age.
 */
export async function archiveOldItems(
  daysOld: number = 30,
  deps?: { releaseBacklinks?: (items: QueueItem[]) => Promise<number> },
): Promise<CleanupResult> {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - daysOld);

  let removed = 0;
  let archived = 0;
  const queues = discoverQueues();
  const allArchived: QueueItem[] = [];

  for (const queueName of queues) {
    const items = loadQueueItems(queueName);
    const keep: QueueItem[] = [];
    const toArchive: QueueItem[] = [];

    for (const item of items) {
      if (!ARCHIVABLE_TERMINAL_STATUSES.has(item.status)) {
        keep.push(item);
        continue;
      }

      const itemDate = new Date(item.result?.completedAt || item.updated);
      if (itemDate < cutoff) {
        toArchive.push(item);
      } else {
        keep.push(item);
      }
    }

    if (toArchive.length > 0) {
      // Archive FIRST (safe on crash — worst case is duplicate in archive)
      archiveItems(queueName, toArchive);
      archived += toArchive.length;
      removed += toArchive.length;
      // Rewrite active file without archived items
      saveQueueItems(queueName, keep);
      allArchived.push(...toArchive);
    }
  }

  // Release LucidTask back-links so archived items can't orphan their tasks
  // (triage skips any task whose queue_item_id is still set).
  if (allArchived.length > 0) {
    const release = deps?.releaseBacklinks ?? releaseLucidTaskBacklinks;
    await release(allArchived);
  }

  // Record cleanup timestamp in state for debounce
  const state = loadState();
  state.lastCleanupAt = new Date().toISOString();
  saveStateSync(state);

  return { removed, archived };
}

/**
 * Restore an archived item back to its original queue.
 * This is a NEW capability — previously items were permanently inaccessible after archiving.
 */
export async function restoreArchivedItem(
  itemId: string,
): Promise<QueueItem | null> {
  const queues = discoverQueues();

  for (const queueName of queues) {
    const archivePath = join(getArchiveDir(), `${queueName}-archive.jsonl`);
    if (!existsSync(archivePath)) continue;

    const content = readFileSync(archivePath, "utf-8");
    const lines = content.trim().split("\n").filter(Boolean);
    const items = lines.map(l => {
      try { return JSON.parse(l) as QueueItem; } catch { return null; }
    }).filter((i): i is QueueItem => i !== null);

    const idx = items.findIndex(i => i.id === itemId);
    if (idx === -1) continue;

    const [restored] = items.splice(idx, 1);

    // Write back archive without the restored item
    const { writeFileSync } = await import("fs");
    writeFileSync(archivePath, items.map(i => JSON.stringify(i)).join("\n") + (items.length > 0 ? "\n" : ""));

    // Re-add to original queue preserving the archived status — forcing
    // "pending" would corrupt spec-pipeline items, whose state machine has no
    // such status (a swept needs-grilling item must come back as needs-grilling).
    restored.updated = new Date().toISOString();
    const queueItems = loadQueueItems(queueName);
    queueItems.push(restored);
    saveQueueItems(queueName, queueItems);

    return restored;
  }

  return null;
}

/**
 * List all archived items, optionally filtered by queue name.
 */
export function listArchivedItems(
  queueName?: string,
): QueueItem[] {
  const result: QueueItem[] = [];

  const queuesToCheck = queueName ? [queueName] : discoverQueues();

  for (const name of queuesToCheck) {
    const archivePath = join(getArchiveDir(), `${name}-archive.jsonl`);
    if (!existsSync(archivePath)) continue;

    try {
      const content = readFileSync(archivePath, "utf-8");
      const lines = content.trim().split("\n").filter(Boolean);
      for (const line of lines) {
        try {
          result.push(JSON.parse(line) as QueueItem);
        } catch {
          // Skip corrupt lines
        }
      }
    } catch {
      // Skip unreadable archive files
    }
  }

  return result;
}
