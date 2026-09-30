#!/usr/bin/env bun
/**
 * QueueTaskIntegrationAdapter.ts — QueueRouter-side implementation of the
 * QueueRouter <-> LucidTasks seam (lib/interfaces/QueueTaskIntegration.ts).
 *
 * Implements `QueueClient` over the real QueueManager (in-process — no
 * subprocess spawn). Both operations are thin pass-throughs onto existing
 * QueueManager methods (archiveItemById / add) — this file adds no new
 * business logic, it only projects QueueManager's shapes onto the seam's
 * minimal QueueClient contract.
 *
 * `registerQueueClient()` is the one-line composition-root call — imported
 * (for its side effect) by bin/wire-queue-task-integration.ts, which
 * entrypoints import before they touch anything that needs the seam.
 *
 * @module QueueTaskIntegrationAdapter
 */

import { QueueManager } from "./QueueManager.ts";
import {
  setQueueClient,
  type QueueClient,
  type QueueClientArchiveResult,
} from "../../../../lib/interfaces/QueueTaskIntegration.ts";

export const queueClientAdapter: QueueClient = {
  async archiveItemById(itemId: string, reason: string): Promise<QueueClientArchiveResult> {
    const qm = new QueueManager();
    const result = await qm.archiveItemById(itemId, reason);
    return { archived: result.archived, reason: result.reason };
  },

  async enqueueItem(
    payload: { title: string; description: string; context?: Record<string, unknown> },
    options?: { source?: string; priority?: 1 | 2 | 3 },
  ): Promise<string> {
    const qm = new QueueManager();
    return qm.add(payload, { source: options?.source, priority: options?.priority });
  },
};

/** Register queueClientAdapter into the shared QueueTaskIntegration registry. */
export function registerQueueClient(): void {
  setQueueClient(queueClientAdapter);
}
