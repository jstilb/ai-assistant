#!/usr/bin/env bun
/**
 * SkipDigestSender.ts
 *
 * Per-run Skip Digest for the KayaTaskClassifier triage pipeline (ISC-3).
 *
 * After a spec-daily triage run, any tasks that received a `skip` Disposition
 * (non-Kaya, low-confidence or — formerly — not-executable) are collected and
 * sent as a single Telegram message with inline Promote / Dismiss buttons.
 *
 * Callbacks:
 *   gp:promote:<taskId>  → parkForGrill(taskId)
 *   gp:dismiss:<taskId>  → append confirmed-discard entry to dismiss-ledger.jsonl
 *
 * The Dismiss button does NOT touch the LucidTask itself — it only records
 * that Kaya will not assist with this task.
 */

import { join } from "path";
// cross-skill-allowed: ADR-004 sanctioned conversational/bot lane
import { sendTextMessage } from "../../Communication/Telegram/Tools/TelegramClient.ts";
import { createAppendLog, type AppendLog } from "../../../lib/core/AppendLog.ts";
import { getKayaHome } from "../../../lib/core/KayaHome.ts";

// ============================================================================
// Public constants — consumed by TelegramBot to register gp:* handlers
// ============================================================================

export const GP_PROMOTE_PREFIX = "gp:promote:";
export const GP_DISMISS_PREFIX = "gp:dismiss:";

// ledgerPath varies per call (test callers pass overrides) — cache one AppendLog per path.
const dismissLedgerLogs = new Map<string, AppendLog>();
function getDismissLedgerLog(path: string): AppendLog {
  let log = dismissLedgerLogs.get(path);
  if (!log) {
    log = createAppendLog(path);
    dismissLedgerLogs.set(path, log);
  }
  return log;
}

// ============================================================================
// Types
// ============================================================================

export interface SkipRecord {
  taskId: string;
  title: string;
  reasoning: string;
}

export interface SendSkipDigestResult {
  sent: boolean;
  messageId?: number;
  skipsCount: number;
}

// ============================================================================
// KAYA_HOME helper
// ============================================================================

function getDefaultLedgerPath(): string {
  return join(getKayaHome(), "MEMORY/AUTOINFO/dismiss-ledger.jsonl");
}

// ============================================================================
// sendSkipDigest — sends a single Telegram message per triage run
// ============================================================================

/**
 * Send a per-run Skip Digest to Telegram.
 *
 * Sends ONE message listing every skip with reasoning and inline
 * Promote/Dismiss buttons per skip. If skips is empty, does nothing
 * and returns { sent: false, skipsCount: 0 }.
 *
 * @param skips  Array of skip records from the triage run
 * @returns      Result indicating whether a message was sent
 */
export async function sendSkipDigest(
  skips: SkipRecord[]
): Promise<SendSkipDigestResult> {
  if (skips.length === 0) {
    return { sent: false, skipsCount: 0 };
  }

  // Build message text
  const lines: string[] = [
    `📋 *Skip Digest* — ${skips.length} task${skips.length === 1 ? "" : "s"} skipped this run`,
    "",
  ];
  for (const s of skips) {
    lines.push(`• *${escapeMarkdown(s.title.slice(0, 60))}*`);
    lines.push(`  _${escapeMarkdown(s.reasoning.slice(0, 120))}_`);
    lines.push("");
  }
  lines.push("Use buttons below to Promote (park for grill) or Dismiss each skip.");

  const text = lines.join("\n");

  // Build inline keyboard — one row per skip: [Promote] [Dismiss]
  const inline_keyboard = skips.map((s) => [
    {
      text: `✅ Promote: ${s.title.slice(0, 20)}`,
      callback_data: `${GP_PROMOTE_PREFIX}${s.taskId}`,
    },
    {
      text: `❌ Dismiss`,
      callback_data: `${GP_DISMISS_PREFIX}${s.taskId}`,
    },
  ]);

  const result = await sendTextMessage(text, {
    parseMode: "MarkdownV2",
    replyMarkup: { inline_keyboard },
  });

  if (!result.ok) {
    console.warn(`[SkipDigestSender] Telegram sendMessage failed: ${result.description}`);
    return { sent: false, skipsCount: skips.length };
  }

  return { sent: true, messageId: result.messageId, skipsCount: skips.length };
}

// ============================================================================
// handlePromote — park a skipped task for grilling
// ============================================================================

/**
 * Promote a skipped task to the needs-grilling queue.
 *
 * Thin wrapper over QueueManager.parkForGrill. The Telegram callback handler
 * in TelegramBot.ts calls this when the user presses the Promote button.
 *
 * @param taskId   The LucidTask ID to promote
 */
export async function handlePromote(taskId: string): Promise<void> {
  const { QueueManager } = await import("./Tools/QueueManager.ts");
  const qm = new QueueManager();

  // Find the spec-pipeline item linked to this LucidTask
  const allItems = qm.listAll?.() ?? [];
  const linked = allItems.find(
    (i) =>
      (i.context as Record<string, unknown> | undefined)?.lucidTaskId === taskId ||
      i.title?.includes(taskId)
  );

  if (!linked) {
    console.warn(`[SkipDigestSender] handlePromote: no queue item found for taskId=${taskId}`);
    return;
  }

  await qm.parkForGrill(linked.id, {
    missing: ["Promoted from Skip Digest by Jm"],
    suggested_questions: ["What is the scope and expected output?"],
    verdict: "not-executable",
    reasoning: "Promoted via Skip Digest Promote button",
  });
}

// ============================================================================
// handleDismiss — write confirmed-discard ledger entry
// ============================================================================

/**
 * Record a confirmed discard in the dismiss ledger.
 *
 * Does NOT touch the LucidTask (no status change, no delete, no cancel).
 * Only records that Kaya will not assist with this task.
 *
 * @param taskId      LucidTask ID
 * @param title       Task title
 * @param reasoning   Classifier reasoning for the skip
 * @param ledgerPath  Path to the JSONL ledger file (defaults to MEMORY/AUTOINFO/dismiss-ledger.jsonl)
 */
export async function handleDismiss(
  taskId: string,
  title: string,
  reasoning: string,
  ledgerPath?: string
): Promise<void> {
  const path = ledgerPath ?? getDefaultLedgerPath();

  const entry = {
    taskId,
    title,
    reasoning,
    dismissedAt: new Date().toISOString(),
  };

  getDismissLedgerLog(path).append(entry);
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Escape special characters for Telegram MarkdownV2.
 */
function escapeMarkdown(text: string): string {
  return text.replace(/[_*[\]()~`>#+=|{}.!-]/g, "\\$&");
}
