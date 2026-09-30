#!/usr/bin/env bun
/**
 * ApprovalNudge.ts — Headless nudge script for stale approval items.
 *
 * For each approvals item with a draft spec that has been waiting >48h,
 * sends a per-item inline-keyboard nudge to Telegram via sendApprovalNudge.
 * Each item is nudged at most once per 72h (AlertGate per-item state) —
 * the old version re-nudged every stale item on every run.
 *
 * Items whose linked LucidTask is already closed (done/cancelled/someday —
 * the same set and link resolution QueueTaskReconciler uses) are archived
 * instead of nudged: work finished outside the pipeline never closed its
 * approvals item, so the nudge kept asking Jm to approve completed work.
 * If the closed-task lookup fails, the run throws rather than nudging blind.
 *
 * Degrades gracefully if token/chatId missing (logs, doesn't crash).
 * Importing this module is safe — the CLI only runs under import.meta.main.
 */
import { loadQueueItems, QueueManager } from "./QueueManager.ts";
import { fetchClosedTasksFromCLI, type ClosedTask } from "./QueueTaskReconciler.ts";
import { getAlertGate, type AlertGate } from "../../../../lib/core/AlertGate.ts";
import type { QueueItem } from "./QueueManager.ts";

const STALE_AFTER_MS = 48 * 60 * 60 * 1000;
const RENUDGE_COOLDOWN_MS = 72 * 60 * 60 * 1000;

interface TelegramSecrets {
  bot_token?: string;
  chat_id?: string;
}

async function loadSecrets(): Promise<TelegramSecrets | null> {
  try {
    const { getKayaHome } = await import("../../../../lib/core/KayaHome.ts");
    const home = getKayaHome();
    const secrets = await Bun.file(`${home}/secrets.json`).json() as Record<string, unknown>;
    const tg = secrets.telegram as TelegramSecrets | undefined;
    return tg ?? null;
  } catch {
    return null;
  }
}

export interface ApprovalNudgeDeps {
  loadItems?: () => QueueItem[];
  sendNudge?: (item: QueueItem) => Promise<void>;
  fetchClosedTasks?: () => Promise<ClosedTask[]>;
  archiveItem?: (itemId: string, reason: string) => Promise<{ archived: boolean; reason?: string }>;
  gate?: AlertGate;
  now?: () => number;
}

export async function runApprovalNudge(deps: ApprovalNudgeDeps = {}): Promise<void> {
  const loadItems = deps.loadItems ?? (() => loadQueueItems("approvals"));
  const gate = deps.gate ?? getAlertGate();
  const now = deps.now ?? Date.now;

  let sendNudge = deps.sendNudge;
  if (!sendNudge) {
    const secrets = await loadSecrets();
    if (!secrets?.bot_token || !secrets?.chat_id) {
      console.log("[ApprovalNudge] telegram secrets missing — skipping nudge");
      return;
    }
    // cross-skill-allowed: ADR-004 bot lane (approvals surface)
    const { sendApprovalNudge } = await import("../../../Communication/Telegram/Server/handlers/approvals.ts");
    const token = secrets.bot_token;
    const chatId = secrets.chat_id;
    sendNudge = (item) => sendApprovalNudge(token, chatId, item);
  }

  const cutoff = new Date(now() - STALE_AFTER_MS);
  const stale = loadItems().filter((i) =>
    (i.status === "pending" || i.status === "awaiting_approval") &&
    i.spec?.status === "draft" &&
    new Date(i.created) < cutoff
  );

  if (stale.length === 0) {
    console.log("[ApprovalNudge] No stale approval items with draft specs — nothing to nudge");
    return;
  }

  // Link resolution mirrors QueueTaskReconciler: item-side payload stamp
  // first, then the task-side queue_item_id backlink.
  const closedTasks = await (deps.fetchClosedTasks ?? fetchClosedTasksFromCLI)();
  const closedById = new Map(closedTasks.map((t) => [t.id, t]));
  const closedByItemId = new Map(
    closedTasks.filter((t) => t.queueItemId).map((t) => [t.queueItemId as string, t]),
  );
  const archiveItem = deps.archiveItem ??
    ((itemId: string, reason: string) => new QueueManager().archiveItemById(itemId, reason));

  const open: QueueItem[] = [];
  for (const item of stale) {
    const lucidTaskId = item.payload.context?.lucidTaskId;
    const closed = (typeof lucidTaskId === "string" ? closedById.get(lucidTaskId) : undefined) ??
      closedByItemId.get(item.id);
    if (!closed) {
      open.push(item);
      continue;
    }
    const result = await archiveItem(item.id, `source task ${closed.status}`);
    if (result.archived) {
      console.log(`[ApprovalNudge] Archived (task ${closed.id} ${closed.status}): ${item.id} "${item.payload.title}"`);
    } else {
      console.error(`[ApprovalNudge] Task ${closed.id} is ${closed.status} but archive refused for ${item.id}: ${result.reason ?? "unknown"} — not nudging`);
    }
  }

  for (const item of open) {
    const gateKey = `approval-nudge-${item.id}`;
    if (!gate.shouldPage(gateKey, { cooldownMs: RENUDGE_COOLDOWN_MS })) {
      console.log(`[ApprovalNudge] On cooldown, skipping: ${item.id}`);
      continue;
    }
    try {
      await sendNudge(item);
      // Stamp only after a successful send so failures retry next run.
      gate.recordPaged(gateKey);
      console.log(`[ApprovalNudge] Nudged: ${item.id} "${item.payload.title}"`);
    } catch (err) {
      console.error(`[ApprovalNudge] Failed to nudge item ${item.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

if (import.meta.main) {
  // Wire the QueueRouter <-> LucidTasks seam — fetchClosedTasksFromCLI needs a
  // registered TaskClient (lib/interfaces/QueueTaskIntegration.ts).
  await import("../../../../bin/wire-queue-task-integration.ts");
  await runApprovalNudge();
}
