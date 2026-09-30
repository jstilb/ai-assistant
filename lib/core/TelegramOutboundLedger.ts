/**
 * TelegramOutboundLedger — persistent record of every outbound Telegram send.
 *
 * WHY (Phase A of the Kaya–Telegram voice deep-integration epic, see
 * plans/Specs/kaya-telegram-voice-deep-integration-scope.md §3-A1): outbound
 * sends (notifications, digests, alert pages, executor completions) were never
 * recorded anywhere the mobile gateway could read, so when Jm replied to a bot
 * notification ("This has been completed") Kaya had no idea what "this" was —
 * the verified first-touch adoption killer (both Aug-2026 sessions died on it).
 *
 * Every send seam that talks to the Telegram Bot API records
 * {telegram_message_id, timestamp, source, text} here; the gateway's
 * ReplyContext resolver reads it to give replies their referent.
 *
 * Seams instrumented (audit §1-A1 named the first three):
 *   - TelegramClient.sendTextMessage()      (CLI + in-process senders)
 *   - NotificationService.sendTelegram()    (AlertGate pages & all notify() traffic)
 *   - TelegramGatewayImpl.notify()
 *   - DailyBriefing DeliveryUtils.sendTelegramMessage()  (digests)
 *
 * Lives in lib/core (not the Telegram skill) because NotificationService —
 * lib/core itself — is one of the writers, and lib/core must not import from
 * skills/.
 *
 * Storage: MEMORY/TELEGRAM/outbound.jsonl under getKayaHome(), resolved at
 * CALL time (never cached at import — see SessionManager.ts's sessionsDir()
 * doc for the KAYA_HOME-pinning trap this avoids). Rotation via AppendLog at
 * 5 MB; lookups only ever target recent messages, so post-rotation misses are
 * an accepted edge (a reply still falls back to Telegram's own quoted text —
 * see ReplyContext).
 */

import { existsSync, readFileSync, statSync, openSync, readSync, closeSync } from 'fs';
import { join } from 'path';
import { getKayaHome, assertNotLiveHomeUnderTest } from './KayaHome.ts';
import { createAppendLog } from './AppendLog.ts';

export interface OutboundRecord {
  /** ISO timestamp of the send. */
  timestamp: string;
  /** Telegram's message_id for the sent message (unique per chat). */
  telegram_message_id: number;
  /** Which seam/sender produced it (e.g. "notification-service", "daily-briefing"). */
  source: string;
  /** The message text as the caller supplied it (pre-escaping), truncated. */
  text: string;
}

/** Keep ledger entries readable but bounded — replies only need the gist. */
const MAX_TEXT_CHARS = 1500;

/** Never read more than this much of the tail when resolving lookups. */
const MAX_READ_BYTES = 512 * 1024;

function ledgerPath(): string {
  return join(getKayaHome(), 'MEMORY', 'TELEGRAM', 'outbound.jsonl');
}

/**
 * Record an outbound send. Best-effort by contract: a ledger failure must
 * never break the send path that just succeeded, so all errors are logged
 * and swallowed — EXCEPT the hermetic-guard throw (NODE_ENV=test writing to
 * the live home), which must fail the offending test loudly.
 */
export function recordOutbound(entry: {
  messageId: number;
  source: string;
  text: string;
}): void {
  assertNotLiveHomeUnderTest('TelegramOutboundLedger.recordOutbound');
  try {
    const record: OutboundRecord = {
      timestamp: new Date().toISOString(),
      telegram_message_id: entry.messageId,
      source: entry.source,
      text: entry.text.length > MAX_TEXT_CHARS ? `${entry.text.slice(0, MAX_TEXT_CHARS)}…` : entry.text,
    };
    createAppendLog(ledgerPath(), { maxSizeMB: 5, maxRotatedFiles: 3 }).append(record);
  } catch (err) {
    console.error('[TelegramOutboundLedger] record failed (send already succeeded, continuing):', err);
  }
}

/**
 * Parse a Telegram Bot API sendMessage Response and record its message_id.
 * For seams that raw-fetch the API and don't otherwise read the success body.
 * Consumes the response body — callers must not need it afterwards.
 */
export async function recordOutboundFromTelegramResponse(
  response: Response,
  source: string,
  text: string,
): Promise<void> {
  try {
    const raw = (await response.json()) as { ok?: boolean; result?: { message_id?: number } };
    const messageId = raw?.result?.message_id;
    if (raw?.ok && typeof messageId === 'number') {
      recordOutbound({ messageId, source, text });
    }
  } catch (err) {
    // Body unreadable/not-JSON — the send itself already succeeded upstream.
    console.error('[TelegramOutboundLedger] could not parse send response for ledger:', err);
  }
}

/** Read the tail of the ledger (bounded), newest entry LAST. */
function readTail(): OutboundRecord[] {
  const path = ledgerPath();
  if (!existsSync(path)) return [];
  try {
    const size = statSync(path).size;
    let content: string;
    if (size > MAX_READ_BYTES) {
      const fd = openSync(path, 'r');
      try {
        const buf = Buffer.alloc(MAX_READ_BYTES);
        readSync(fd, buf, 0, MAX_READ_BYTES, size - MAX_READ_BYTES);
        content = buf.toString('utf-8');
        // Drop the (likely torn) first line of the tail window.
        content = content.slice(content.indexOf('\n') + 1);
      } finally {
        closeSync(fd);
      }
    } else {
      content = readFileSync(path, 'utf-8');
    }
    const records: OutboundRecord[] = [];
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line) as OutboundRecord;
        if (typeof parsed.telegram_message_id === 'number' && typeof parsed.text === 'string') {
          records.push(parsed);
        }
      } catch {
        // intentionally silent: torn/partial JSONL write — skip the line,
        // keep the rest (breadcrumbing would fire on every read of a file
        // whose final line is mid-append).
      }
    }
    return records;
  } catch {
    return [];
  }
}

/** Look up an outbound send by its Telegram message_id (newest match wins). */
export function findByMessageId(messageId: number): OutboundRecord | null {
  const records = readTail();
  for (let i = records.length - 1; i >= 0; i--) {
    if (records[i]!.telegram_message_id === messageId) return records[i]!;
  }
  return null;
}

/**
 * The most recent outbound sends within a time window, newest first.
 * Used for the "Jm may be reacting to a recent notification" injection when
 * an inbound message is NOT a formal Telegram reply.
 */
export function recentOutbound(opts?: {
  windowMs?: number;
  limit?: number;
  nowMs?: number;
}): OutboundRecord[] {
  const windowMs = opts?.windowMs ?? 30 * 60 * 1000;
  const limit = opts?.limit ?? 3;
  const nowMs = opts?.nowMs ?? Date.now();
  const cutoff = nowMs - windowMs;

  const records = readTail();
  const result: OutboundRecord[] = [];
  for (let i = records.length - 1; i >= 0 && result.length < limit; i--) {
    const ts = new Date(records[i]!.timestamp).getTime();
    if (Number.isNaN(ts)) continue;
    if (ts < cutoff) break; // append-only file — older entries only get older
    result.push(records[i]!);
  }
  return result;
}
