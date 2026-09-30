#!/usr/bin/env bun
/**
 * PipelineFacade.ts — Shared facade logic for QueueItem ↔ PipelineRepository
 *
 * pipeline.db (SQLite, via PipelineRepository) is the sole authoritative store
 * for queue items — no JSONL shadow write, no JSONL-based discovery. This module
 * turns queue operations (loadQueueItems / saveQueueItems / appendQueueItem) into
 * thin wrappers over the transactional SQLite PipelineRepository.
 *
 * QueueManager.ts (queue-name-only signatures) imports and delegates to these
 * helpers — ArchiveManager.ts uses QueueManager.ts's facade exports directly
 * (the former parallel queue-name + config calling convention module was
 * deleted in J2, having had exactly one importer). This ensures pipeline.db
 * stays authoritative and in sync regardless of caller, preventing the
 * divergence bug where ArchiveManager once bypassed pipeline.db by writing
 * through that standalone module directly.
 *
 * The one remaining JSONL write (saveQueueItemsImpl's archive append) is a
 * separate audit trail for archived items, not a shadow of the live store — see
 * its inline comment.
 *
 * Config → pipeline.db path resolution:
 *   Always uses getPipelineRepository() (the canonical singleton resolved via
 *   defaultPipelineDbPath()). The queuesDir param is still accepted by the facade
 *   impl functions for call-site compatibility; it is NOT used to pick the db or
 *   for any other data access.
 *
 * @module PipelineFacade
 */

import {
  existsSync,
  readFileSync,
} from "fs";
import { join } from "path";
import { createAppendLog, type AppendLog } from "../../../../lib/core/AppendLog.ts";
import { getPipelineRepository } from "./PipelineRepository.ts";
import type { QueueItem } from "./QueueManager.ts";
import {
  VALID_STAGES,
  deriveStage,
  stageToQueueStatus,
  queueItemToPipelineParams,
  pipelineItemToQueueItem,
} from "./lib/vocabulary.ts";

// ============================================================================
// QueueItem ↔ PipelineItem codec + stage derivation (S9: moved to
// lib/vocabulary.ts; re-exported here for existing importers of this module).
// ============================================================================

export {
  VALID_STAGES,
  deriveStage,
  stageToQueueStatus,
  queueItemToPipelineParams,
  pipelineItemToQueueItem,
};

// ============================================================================
// Config → pipeline.db path resolution
// ============================================================================

/**
 * Get the canonical PipelineRepository singleton.
 *
 * The queuesDir argument is accepted for call-site compatibility only (the
 * facade impl functions no longer use it for any data access), but it is
 * NEVER used to derive the db path. The db path is always resolved via
 * defaultPipelineDbPath() so that:
 *   - prod (KAYA_HOME unset): ~/.kaya/runtime/pipeline.db  ← one canonical store
 *   - tests (KAYA_HOME pinned): <tmpdir>/.kaya/runtime/pipeline.db  ← hermetic
 *
 * Previously, this function derived a separate db path from queuesDir, which
 * caused a two-database split in prod when KAYA_HOME was unset (S1.5 fix).
 */
export function getRepoForQueuesDir(_queuesDir?: string): ReturnType<typeof getPipelineRepository> {
  return getPipelineRepository();
}

// ============================================================================
// Core facade operations (path-parameterized)
// ============================================================================

// archivePath varies per queueName — cache one AppendLog per path.
const archiveLogs = new Map<string, AppendLog>();
function getArchiveLog(path: string): AppendLog {
  let log = archiveLogs.get(path);
  if (!log) {
    log = createAppendLog(path);
    archiveLogs.set(path, log);
  }
  return log;
}

/**
 * Core implementation of loadQueueItems, parameterized by queuesDir.
 *
 * Serves active (non-archived) rows from pipeline.db (the sole authoritative store).
 * The queuesDir param is accepted for call-site compatibility but is not used
 * for data access — pipeline.db is resolved via getRepoForQueuesDir().
 */
export function loadQueueItemsImpl(
  queueName: string,
  queuesDir: string,
): QueueItem[] {
  const repo = getRepoForQueuesDir(queuesDir);

  // Serve active (non-archived) rows
  const activeRows = repo.list({ queue: queueName });
  return activeRows.map(pipelineItemToQueueItem).filter((i): i is QueueItem => i !== null);
}

/**
 * Core implementation of saveQueueItems, parameterized by paths.
 *
 * PRIMARY: Upserts all provided items into pipeline.db. Archives absentees
 * (existing active rows not in the new set) rather than hard-deleting.
 * pipeline.db is the sole authoritative store — no JSONL shadow write.
 *
 * { enforce: false }: this is the whole-queue re-save path — callers pass the
 * FULL queue array back (often unmodified for most items), so this repeatedly
 * re-upserts items whose in-memory stage may not track the DB's stage-crossing
 * legality rules. Forcing enforce here would turn a benign re-save into a thrown
 * error for any item whose queue-derived stage isn't a legal crossing from its
 * current DB stage. Kept on shadow semantics post-flip (audited, see
 * PipelineRepository.upsert() docstring).
 */
export function saveQueueItemsImpl(
  queueName: string,
  items: QueueItem[],
  queuesDir: string,
  archiveDir: string,
): void {
  const repo = getRepoForQueuesDir(queuesDir);

  // PRIMARY: Upsert all provided items into pipeline.db
  const newIds = new Set(items.map(i => i.id));
  for (const item of items) {
    // mergeMetadata: true — queueItemToPipelineParams reconstructs metadata
    // from a fixed, partial key set (rawQueueItem/projectName/.../reviewNotes,
    // see its docstring). Wholesale-replacing on every whole-queue resave blew
    // away foreign metadata keys another producer wrote (e.g. WorkQueue's
    // rawWorkItem/comprehendedSpec/workSurface/verificationHistory) for every
    // OTHER item in the array, not just the one that actually changed
    // (fable-remediation b1/b2).
    repo.upsert(queueItemToPipelineParams(item), { enforce: false, mergeMetadata: true });
  }

  // Archive absentees: active rows in this queue not present in the new set
  const activeRows = repo.list({ queue: queueName });
  const absentees = activeRows.filter(r => !newIds.has(r.id));
  if (absentees.length > 0) {
    const absenteeQueueItems: QueueItem[] = [];
    for (const r of absentees) {
      repo.archive(r.id);
      const qi = pipelineItemToQueueItem(r);
      if (qi) absenteeQueueItems.push(qi);
    }
    if (absenteeQueueItems.length > 0) {
      // Write to JSONL archive for audit trail — dedup by ID to prevent double-entries.
      // ArchiveManager.archiveOldItems() calls archiveItems() (its own JSONL append)
      // BEFORE calling saveQueueItems(keep). Without dedup, the same item would appear
      // twice in *-archive.jsonl (once from archiveItems, once from here), which breaks
      // listArchivedItems() and restoreArchivedItem() callers that expect unique entries.
      const archivePath = join(archiveDir, `${queueName}-archive.jsonl`);

      // Read existing archive IDs (if file exists) to skip already-present entries
      const alreadyArchivedIds = new Set<string>();
      if (existsSync(archivePath)) {
        try {
          const existingContent = readFileSync(archivePath, "utf-8");
          for (const line of existingContent.trim().split("\n").filter(Boolean)) {
            try {
              const parsed = JSON.parse(line) as { id?: string };
              if (parsed.id) alreadyArchivedIds.add(parsed.id);
            } catch { /* skip corrupt lines */ }
          }
        } catch { /* non-fatal: if file unreadable, write all */ }
      }

      const toAppend = absenteeQueueItems.filter(i => !alreadyArchivedIds.has(i.id));
      if (toAppend.length > 0) {
        const archiveLog = getArchiveLog(archivePath);
        for (const item of toAppend) archiveLog.append(item);
      }
    }
  }
}

/**
 * Core implementation of appendQueueItem, parameterized by queuesDir.
 *
 * Upserts the item into pipeline.db (the sole authoritative store).
 * The queuesDir param is accepted for call-site compatibility but is not used
 * for data access — no JSONL shadow write.
 *
 * { enforce: false }: appendQueueItem is mostly used for genuinely new items
 * (unaffected by enforce — new-item creation is always legal), but two
 * QueueManager callers deliberately reuse an existing item's id to move it
 * cross-queue while bypassing the canonical transition check —
 * rejectToSpecPipeline() ("awaiting-approval" -> "escalated" at revisionCount
 * >= 3) and rejectToGrill() ("awaiting-approval" -> "needs-grilling"), both of
 * which are illegal per ALLOWED_TRANSITIONS by design (see their docstrings:
 * "Bypass the canonical transition check — this is an external transfer...").
 * Kept on shadow semantics post-flip so those call sites don't regress.
 */
export function appendQueueItemImpl(
  queueName: string,
  item: QueueItem,
  queuesDir: string,
): void {
  const repo = getRepoForQueuesDir(queuesDir);
  // mergeMetadata: true — same codec as saveQueueItemsImpl (queueItemToPipelineParams),
  // same fixed-partial-key-set rationale. For genuinely new items existingItem is
  // null so this is a no-op; for the two reuse-an-existing-id transfer callers
  // (rejectToSpecPipeline/rejectToGrill, see docstring above) it preserves
  // whatever foreign metadata the row already carried instead of wiping it.
  repo.upsert(queueItemToPipelineParams(item), { enforce: false, mergeMetadata: true });
}
