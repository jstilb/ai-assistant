#!/usr/bin/env bun
/**
 * ============================================================================
 * NotificationService - Unified notification service for Kaya
 * ============================================================================
 *
 * PURPOSE:
 * Replaces 50+ scattered curl commands across 12+ skills with a single,
 * robust notification service supporting multiple channels, batching,
 * retry logic, health checks, and offline queuing.
 *
 * USAGE:
 *   // Simple fire-and-forget (most common)
 *   notifySync("Starting daily maintenance workflow");
 *
 *   // With options
 *   await notify("Completed security audit", {
 *     channel: 'telegram',
 *     priority: 'high',
 *   });
 *
 *   // Batch multiple messages
 *   await service.batch(["Step 1 complete", "Step 2 complete", "Step 3 complete"]);
 *
 *   // Custom instance
 *   const service = createNotificationService({
 *     defaultChannel: 'telegram',
 *     batchWindowMs: 100
 *   });
 *
 * CLI:
 *   bun run NotificationService.ts --test "Hello world"
 *   bun run NotificationService.ts --health
 *   bun run NotificationService.ts --channel telegram "Telegram notification"
 *
 * CHANNELS:
 *   - log: record to MEMORY/NOTIFICATIONS/notifications.jsonl only (default)
 *   - discord: Discord webhook
 *   - telegram: Telegram Bot API
 *   - email: Gmail MCP (future)
 *
 * NOTE: the 'voice' channel (local ElevenLabs voice server, localhost:8888,
 * launchd com.kaya.voice-server) was REMOVED on 2026-09-29 at Jm's decision.
 * It used to be the default, so a notify() with no channel was spoken aloud
 * in the terminal. That default is now 'log': ambient progress chatter
 * ("Task added: ...", "Running content pipeline...") is recorded, not pushed
 * to the phone. Anything Jm must see passes channel: 'telegram' explicitly
 * or goes through AlertGate (lib/core/AlertGate.ts), which owns paging policy.
 *
 * NOTE: the 'push' (ntfy.sh) channel was REMOVED entirely (B6, 2026-07-20,
 * Jm's explicit decision) — CRITICAL alerts were silently dying there
 * (dead push channel = CRITICAL secrets alert NEVER delivered; see
 * MEMORY/AutoMaintenance/remediation.jsonl / the SystemHealth digest
 * investigation). Revival is foreclosed; do not re-add it.
 *
 * ============================================================================
 */

import { join } from "node:path";
import { kayaHomePath, assertNotLiveHomeUnderTest } from "./KayaHome.ts";
import { loadSettings as loadCanonicalSettings } from "./ConfigLoader.ts";
import { createAppendLog } from "./AppendLog.ts";
import { recordOutbound } from "./TelegramOutboundLedger.ts";
import { telegramCall } from "./TelegramTransport.ts";

// ============================================================================
// Types
// ============================================================================

/**
 * Notification channel types
 */
export type NotificationChannel = "log" | "discord" | "email" | "telegram";

/**
 * Priority levels affecting routing and display
 */
export type NotificationPriority = "low" | "normal" | "high" | "critical";

/**
 * Options for individual notifications
 */
export interface NotifyOptions {
  /** Target channel (default: log) */
  channel?: NotificationChannel;
  /** Priority level */
  priority?: NotificationPriority;
  /** Enable fallback to other channels on failure */
  fallback?: boolean;
  /** Number of retries (default: 3) */
  retry?: number;
  /** Timeout in milliseconds (default: 5000) */
  timeout?: number;
  /** Agent name for title */
  agentName?: string;
}

/**
 * Service configuration
 */
export interface NotificationConfig {
  /** Discord webhook URL */
  discordWebhook?: string;
  /** Default channel (default: log) */
  defaultChannel?: NotificationChannel;
  /** Batch window in ms (default: 50) */
  batchWindowMs?: number;
  /** Max retries (default: 3) */
  maxRetries?: number;
  /** Default agent name */
  defaultAgentName?: string;
}

/**
 * The notification service interface
 */
export interface NotificationService {
  /**
   * Send notification with async/await.
   * Resolves `true` when a channel accepted the message, `false` when every
   * channel attempt (including retries/fallback) failed and the message was
   * dead-lettered to the in-memory queue. Never throws for delivery failure
   * — callers that need failure to be fatal must check the resolved value.
   */
  notify(message: string, options?: NotifyOptions): Promise<boolean>;
  /** Fire-and-forget notification (non-blocking) */
  notifySync(message: string, options?: NotifyOptions): void;
  /** Batch multiple messages into one notification */
  batch(messages: string[], options?: NotifyOptions): Promise<void>;
  /** Check if a channel is healthy */
  isServiceHealthy(channel?: NotificationChannel): Promise<boolean>;
  /** Get count of queued notifications */
  getQueuedCount(): number;
  /** Flush queued notifications */
  flush(): Promise<void>;
}

/**
 * Internal queue item
 */
interface QueueItem {
  message: string;
  options: NotifyOptions;
  timestamp: number;
  retries: number;
}

// ============================================================================
// Helpers
// ============================================================================
//
// NOTE: All Kaya-home-derived paths below (settings.json, the notifications
// log dir) are resolved at CALL time via kayaHomePath(), never
// cached in a module-scope const. Bun caches modules on first import, so a
// module-scope `const X = join(homedir(), ...)` freezes to whatever
// KAYA_HOME/KAYA_DIR was set at the FIRST import across the whole process —
// any later test (or long-lived process) that repoints KAYA_HOME after this
// module has already been imported once would silently keep writing to the
// original (possibly real, live) location. See slice E2.

/**
 * Load settings via the canonical ConfigLoader (settings.json merged with
 * runtime-config.json overrides) instead of hand-rolling a second
 * settings.json reader here. Kept as a local wrapper (same signature/call
 * sites as before) so this module's internal caller is unchanged.
 *
 * WHY: This used to fs.readFileSync + JSON.parse settings.json directly,
 * swallowing any read/parse failure into a silent `{}` — a shadow loader
 * that bypassed ConfigLoader's caching, USER/SYSTEM tiering, and
 * runtime-config.json merge. A failure here degrades notification config
 * silently (e.g. call-guard or discord webhook quietly reverting to
 * defaults), so it's logged loudly rather than swallowed.
 */
// biome-ignore lint/suspicious/noExplicitAny: settings.json is untyped user JSON; call sites read nested keys defensively
function loadSettings(): Record<string, any> {
  try {
    // biome-ignore lint/suspicious/noExplicitAny: same untyped settings boundary as the return type
    return loadCanonicalSettings() as Record<string, any>;
  } catch (err) {
    console.error("[NotificationService] settings load failed — notifications may be misconfigured:", err);
    return {};
  }
}

/**
 * Get default config from settings.json
 */
function getDefaultConfig(): NotificationConfig {
  const settings = loadSettings();
  const daidentity = settings.daidentity || {};
  const notifications = settings.notifications || {};

  return {
    discordWebhook: notifications.discord?.webhook || "",
    defaultChannel: "log",
    batchWindowMs: 50,
    maxRetries: 3,
    defaultAgentName: daidentity.name || "Kaya",
  };
}

/**
 * Log notification event
 */
function logNotification(
  event: "sent" | "failed" | "queued" | "retried" | "suppressed",
  channel: string,
  message: string,
  error?: string,
): void {
  // Hermetic guard BEFORE the try — the catch below silently swallows, so a
  // call inside the try would defeat the tripwire. Under NODE_ENV=test with an
  // unpinned (live) KAYA_HOME this throws loudly instead of polluting live state.
  assertNotLiveHomeUnderTest("NotificationService.logNotification");
  try {
    const logDir = kayaHomePath("MEMORY", "NOTIFICATIONS");
    const logEntry = {
      timestamp: new Date().toISOString(),
      event,
      channel,
      message: message.slice(0, 500), // Truncate for log
      error,
    };

    const logPath = join(logDir, "notifications.jsonl");
    // logPath is resolved via kayaHomePath() at call time, never cached (see
    // the module-level NOTE above) — the AppendLog handle is constructed per
    // call too, so it always targets whichever KAYA_HOME is active right now.
    createAppendLog(logPath).append(logEntry);
  } catch (err) {
    // Logging must never break notifications, but a broken log (full disk, bad path) is
    // reported on stderr so it is not silently lost.
    console.error(
      `NotificationService: cannot write notifications log: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Sleep utility
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Calculate exponential backoff delay
 */
function getBackoffDelay(attempt: number, baseMs = 100): number {
  return Math.min(baseMs * 2 ** attempt, 5000); // Cap at 5 seconds
}

// ============================================================================
// Channel Implementations
// ============================================================================

/**
 * Record-only channel (the default): the notifications.jsonl entry IS the
 * delivery. Always succeeds, so it never retries, falls back, or dead-letters.
 */
async function sendLog(message: string, _config: NotificationConfig, _options: NotifyOptions): Promise<boolean> {
  logNotification("sent", "log", message);
  return true;
}

/**
 * Send to Discord webhook
 */
async function sendDiscord(message: string, config: NotificationConfig, options: NotifyOptions): Promise<boolean> {
  if (!config.discordWebhook) {
    return false;
  }

  const colorMap: Record<NotificationPriority, number> = {
    low: 0x808080, // Gray
    normal: 0x3b82f6, // Blue
    high: 0xf59e0b, // Orange
    critical: 0xef4444, // Red
  };

  const payload = {
    embeds: [
      {
        title: options.agentName || config.defaultAgentName || "Kaya",
        description: message,
        color: colorMap[options.priority || "normal"],
        timestamp: new Date().toISOString(),
      },
    ],
  };

  const timeout = options.timeout || 15000;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(config.discordWebhook, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (response.ok) {
      logNotification("sent", "discord", message);
      return true;
    } else {
      logNotification("failed", "discord", message, `HTTP ${response.status}`);
      return false;
    }
  } catch (error) {
    clearTimeout(timeoutId);
    const errMsg = error instanceof Error ? error.message : String(error);
    logNotification("failed", "discord", message, errMsg);
    return false;
  }
}

/**
 * Send to email (placeholder - uses Gmail MCP)
 */
async function sendEmail(message: string, _config: NotificationConfig, _options: NotifyOptions): Promise<boolean> {
  // Email channel requires Gmail MCP integration
  // For now, log and return false
  logNotification("failed", "email", message, "Email channel not implemented");
  return false;
}

/**
 * Escape text for Telegram's LEGACY `parse_mode: 'Markdown'` mode (the
 * `parse_mode:'Markdown'` sent at the send choke point below — NOT
 * MarkdownV2). Legacy Markdown balances on four characters: `_ * `` [`.
 * Unbalanced/unescaped occurrences of any of them (e.g. `[STALE]`,
 * `[jobId]` from digest/alert content) make Telegram reject the whole
 * message with HTTP 400.
 *
 * Backslash MUST be escaped FIRST: this runs as two sequential `.replace()`
 * passes, and escaping the legacy-Markdown set first would insert new
 * backslashes that a second backslash-escaping pass would then
 * double-escape.
 *
 * Do NOT reuse `SkipDigestSender.ts`'s `escapeMarkdown()` — that escapes
 * MarkdownV2's larger character set (`_*[]()~\`>#+=|{}.!-`) and over-escapes
 * (e.g. mangles literal `.`/`-`) for legacy mode.
 */
export function escapeLegacyMarkdown(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/[_*`[]/g, "\\$&");
}

/**
 * Telegram sendMessage rejects text over 4096 UTF-16 units. 4000 leaves
 * margin so a boundary miscount can never reproduce the 2026-08-17 incident:
 * the digest composer truncated its BODY to ~4096, this file then prepended
 * the `*title*` wrapper and escaped legacy-Markdown chars, landing the plain
 * fallback at 4100 units and the escaped variant at 4175 — both drew HTTP
 * 400 on every retry and the whole daily digest dead-lettered undelivered.
 */
export const TELEGRAM_CHUNK_UNITS = 4000;

/**
 * Split fully-composed Telegram text (AFTER title-wrapping and escaping —
 * the only point where the real send length is known) into chunks of at most
 * `maxUnits` UTF-16 units. Splits on line boundaries so an escape pair
 * (`\` + char) is never severed; a single line over the limit is hard-split,
 * backing off one unit when the cut would land inside a surrogate pair
 * (a severed emoji is invalid UTF-8 on the wire — its own 400).
 */
export function chunkTelegramText(text: string, maxUnits: number = TELEGRAM_CHUNK_UNITS): string[] {
  if (text.length <= maxUnits) return [text];
  const chunks: string[] = [];
  let current = "";
  for (const line of text.split("\n")) {
    let rest = line;
    while (rest.length > maxUnits) {
      if (current) {
        chunks.push(current);
        current = "";
      }
      let cut = maxUnits;
      const code = rest.charCodeAt(cut - 1);
      if (code >= 0xd800 && code <= 0xdbff) cut -= 1;
      chunks.push(rest.slice(0, cut));
      rest = rest.slice(cut);
    }
    const sep = current ? "\n" : "";
    if (current.length + sep.length + rest.length > maxUnits) {
      chunks.push(current);
      current = rest;
    } else {
      current += sep + rest;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

/**
 * Send via Telegram Bot API
 */
async function sendTelegram(message: string, config: NotificationConfig, options: NotifyOptions): Promise<boolean> {
  const title = options.agentName || config.defaultAgentName || "Kaya";
  // Plain-text variant — used only for the (now rare, defense-in-depth)
  // no-parse_mode fallback below, where nothing needs escaping.
  const text = `*${title}*\n\n${message}`;
  // Escape ONLY the caller-supplied message body, then wrap it in
  // NotificationService's own `*title*` bold marker — so the title's
  // intentional formatting survives while caller content that happens to
  // look like legacy Markdown ([STALE], [jobId], etc.) is neutralized.
  const markdownText = `*${title}*\n\n${escapeLegacyMarkdown(message)}`;
  const timeout = options.timeout || 15000;

  // Chunk AFTER title-wrapping and escaping — the composed strings are what
  // actually go on the wire, and composing past 4096 here (title + escape
  // inflation on an edge-truncated digest body) is exactly what 400'd every
  // attempt on 2026-08-17. Chunks split on line boundaries; the only active
  // entity in the escaped variant is our own balanced `*title*` in chunk 1,
  // so chunking cannot create unbalanced Markdown.
  const mdChunks = chunkTelegramText(markdownText);
  const plainChunks = chunkTelegramText(text);

  // The transport owns the push switch, credentials, Jm's chat, the timeout and
  // one 429 retry (ADR-036). A TelegramTransportError (config, network,
  // timeout, bad-response) lands in the catch below: logged `failed`, and
  // `false` tells sendWithRetry to retry and then fall back.
  try {
    let needPlainResend = false;
    for (const [i, chunk] of mdChunks.entries()) {
      const outcome = await telegramCall(
        "sendMessage",
        { text: chunk, parse_mode: "Markdown" },
        { timeoutMs: timeout },
      );
      if (outcome.status === "suppressed") {
        // Push switch off (settings.json notifications.telegramPush.enabled=false):
        // record the message and report it handled, so it does not retry, fall
        // back, dead-letter or replay later.
        logNotification("suppressed", "telegram", message, "notifications.telegramPush.enabled=false");
        return true;
      }
      if (outcome.status === "ok") {
        // Phase A1 (outbound ledger): record each chunk's message_id so a
        // reply to any chunk resolves its referent. The ORIGINAL message
        // (pre-escape, pre-title-wrap) is what the reply-context reader should see.
        if (outcome.messageId !== null) {
          recordOutbound({ messageId: outcome.messageId, source: "notification-service", text: message });
        }
        if (i < mdChunks.length - 1) await Bun.sleep(200);
        continue;
      }
      // Telegram's `description` says WHY a 400 happened (too long vs
      // can't-parse-entities); discarding it made the 2026-08-17 failure
      // undiagnosable from the logs.
      if (outcome.httpStatus === 400) {
        // Legacy Markdown parse_mode rejects unbalanced entities (_, *, `, [)
        // in freeform content — resend the WHOLE message as plain text
        // (parse_mode off: nothing to balance). Whole-message, not per-chunk:
        // plain chunk boundaries differ from escaped ones, so pairing chunk i
        // across variants would garble the reassembled message.
        logNotification(
          "retried",
          "telegram",
          message,
          `HTTP 400 with parse_mode on chunk ${i + 1}/${mdChunks.length} (${outcome.description}) — retrying without parse_mode`,
        );
        needPlainResend = true;
        break;
      }
      logNotification(
        "failed",
        "telegram",
        message,
        `HTTP ${outcome.httpStatus} on chunk ${i + 1}/${mdChunks.length} (${outcome.description})`,
      );
      return false;
    }

    if (!needPlainResend) {
      logNotification(
        "sent",
        "telegram",
        message,
        mdChunks.length > 1 ? `Delivered in ${mdChunks.length} chunks` : undefined,
      );
      return true;
    }

    for (const [i, chunk] of plainChunks.entries()) {
      const outcome = await telegramCall("sendMessage", { text: chunk }, { timeoutMs: timeout });
      if (outcome.status === "suppressed") {
        logNotification("suppressed", "telegram", message, "notifications.telegramPush.enabled=false");
        return true;
      }
      if (outcome.status === "rejected") {
        logNotification(
          "failed",
          "telegram",
          message,
          `HTTP ${outcome.httpStatus} (no-parse_mode fallback, chunk ${i + 1}/${plainChunks.length}) (${outcome.description})`,
        );
        return false;
      }
      if (outcome.messageId !== null) {
        recordOutbound({ messageId: outcome.messageId, source: "notification-service", text: message });
      }
      if (i < plainChunks.length - 1) await Bun.sleep(200);
    }
    logNotification("sent", "telegram", message, "Delivered without parse_mode after HTTP 400");
    return true;
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    logNotification("failed", "telegram", message, errMsg);
    return false;
  }
}

/**
 * Send ONE message straight through the Telegram channel — no retry loop, no
 * fallback chain, no queue, and critically NO dead-letter write. This is the
 * dead-letter REPLAY seam (bin/notification-deadletter-replay.ts): a replay
 * that failed must simply stay unreplayed for the next tick — routing it
 * back through notify() would re-dead-letter the banner-wrapped copy and
 * grow the file it is draining.
 */
export async function sendTelegramDirect(message: string, options: NotifyOptions = {}): Promise<boolean> {
  return sendTelegram(message, getDefaultConfig(), options);
}

// ============================================================================
// Main Service Implementation
// ============================================================================

/**
 * Create a notification service instance
 */
export function createNotificationService(customConfig?: NotificationConfig): NotificationService {
  const defaultConfig = getDefaultConfig();
  const config: NotificationConfig = { ...defaultConfig, ...customConfig };

  // Internal state
  const queue: QueueItem[] = [];
  let batchBuffer: string[] = [];
  let batchOptions: NotifyOptions = {};
  let batchTimeout: ReturnType<typeof setTimeout> | null = null;
  let batchResolve: (() => void) | null = null;

  // Channel sender lookup
  const senders: Record<
    NotificationChannel,
    (message: string, config: NotificationConfig, options: NotifyOptions) => Promise<boolean>
  > = {
    log: sendLog,
    discord: sendDiscord,
    email: sendEmail,
    telegram: sendTelegram,
  };

  // Fallback chain. 'push' (ntfy.sh) removed entirely in B6, and 'voice'
  // (local voice server) removed 2026-09-29 — every arm that used to fall
  // back to either now falls straight through to its next arm. 'log' never
  // fails, so it has no fallback.
  const fallbackChain: Record<NotificationChannel, NotificationChannel[]> = {
    log: [],
    discord: [],
    email: ["discord"],
    telegram: ["discord"],
  };

  /**
   * Send notification with retry and fallback logic
   */
  async function sendWithRetry(message: string, options: NotifyOptions, retryCount = 0): Promise<boolean> {
    // Hermetic guard BEFORE the channel sender is invoked — sendWithRetry is
    // the ONE choke point every send path (notify/notifySync/batch/flush)
    // funnels through before a channel sender does a real fetch() (Telegram,
    // or Discord). The pre-existing
    // guard in logNotification() fires only AFTER that fetch already left the
    // machine — too late to prevent a fake "[CRITICAL] GitHub token found"
    // test fixture from actually paging Jm's phone (the alert-storm incident
    // this slice fixes). Under NODE_ENV=test with an unpinned (live) KAYA_HOME
    // this throws loudly here, before any network call, instead of after.
    assertNotLiveHomeUnderTest("NotificationService.sendWithRetry");

    const channel = options.channel || config.defaultChannel || "log";

    const maxRetries = options.retry ?? config.maxRetries ?? 3;
    const sender = senders[channel];

    if (!sender) {
      logNotification("failed", channel, message, `Unknown channel: ${channel}`);
      return false;
    }

    // Attempt to send
    const success = await sender(message, config, options);

    if (success) {
      return true;
    }

    // Retry logic
    if (retryCount < maxRetries) {
      const delay = getBackoffDelay(retryCount);
      logNotification("retried", channel, message, `Attempt ${retryCount + 1}, delay ${delay}ms`);
      await sleep(delay);
      return sendWithRetry(message, options, retryCount + 1);
    }

    // Fallback logic
    if (options.fallback) {
      const fallbacks = fallbackChain[channel] || [];
      for (const fallbackChannel of fallbacks) {
        const fallbackSender = senders[fallbackChannel];
        if (fallbackSender) {
          const fallbackSuccess = await fallbackSender(message, config, options);
          if (fallbackSuccess) {
            return true;
          }
        }
      }
    }

    // Queue for later if all attempts failed
    queue.push({
      message,
      options,
      timestamp: Date.now(),
      retries: retryCount,
    });
    logNotification("queued", channel, message, "All attempts failed");

    // Durable dead-letter (B6, S4c/d): a forensic, on-disk record of every
    // notification that exhausted every channel/retry/fallback attempt. NOT
    // a replay/redelivery mechanism — page-tier alerts already get a
    // delivery guarantee from AlertGate (T2-01/B1); this exists so a
    // digest-priority notification that dies here is still visible on disk
    // instead of vanishing into the in-memory `queue` above (which is lost
    // on process exit). Best-effort, mirroring AlertGate's own
    // delivery-failure trace pattern: a failure writing this forensic
    // record must not turn an already-failed delivery into a thrown
    // exception, since notify()'s contract is "never throws for delivery
    // failure." The hermetic guard at the top of this function already
    // fired for this call, so this is not a silent hermeticity bypass.
    try {
      const deadLetterPath = kayaHomePath("MEMORY", "NOTIFICATIONS", "dead-letter.jsonl");
      createAppendLog(deadLetterPath).append({
        timestamp: new Date().toISOString(),
        channel,
        message,
        priority: options.priority,
        retries: retryCount,
        reason: "all channels/retries/fallback exhausted",
      });
    } catch (err) {
      console.error("[NotificationService] dead-letter write failed:", err);
    }

    return false;
  }

  /**
   * Flush the batch buffer
   */
  function flushBatch(): void {
    if (batchBuffer.length === 0) return;

    const combined = batchBuffer.join("\n- ");
    const message = batchBuffer.length > 1 ? `- ${combined}` : (batchBuffer[0] ?? "");

    const options = batchOptions;
    batchBuffer = [];
    batchOptions = {};
    if (batchTimeout) {
      clearTimeout(batchTimeout);
      batchTimeout = null;
    }

    sendWithRetry(message, options).finally(() => {
      if (batchResolve) {
        batchResolve();
        batchResolve = null;
      }
    });
  }

  // The service object
  const service: NotificationService = {
    /**
     * Send notification (async). Returns whether it was actually delivered.
     */
    async notify(message: string, options: NotifyOptions = {}): Promise<boolean> {
      return sendWithRetry(message, options);
    },

    /**
     * Fire-and-forget notification
     */
    notifySync(message: string, options: NotifyOptions = {}): void {
      // Don't await - fire and forget
      sendWithRetry(message, options).catch((err) => {
        // Silent fail for sync — EXCEPT the hermetic-guard tripwire, which
        // must be loud. notifySync's fire-and-forget .catch used to swallow
        // EVERY rejection, including assertNotLiveHomeUnderTest's throw —
        // so a hermeticity violation from a test that forgot to pin
        // KAYA_HOME was silently absorbed here with no trace, masking the
        // very failure this guard exists to surface. Other errors (network
        // flakiness, channel failures) keep the existing silent-fail
        // behavior — notifySync callers must not be broken by delivery
        // failures.
        if (err instanceof Error && err.message.startsWith("[hermetic-guard]")) {
          console.error(err.message);
        }
      });
    },

    /**
     * Batch multiple messages
     */
    async batch(messages: string[], options: NotifyOptions = {}): Promise<void> {
      return new Promise((resolve) => {
        batchBuffer.push(...messages);
        // Options passed to batch() were dropped before; later calls override earlier keys.
        batchOptions = { ...batchOptions, ...options };
        batchResolve = resolve;

        if (batchTimeout) {
          clearTimeout(batchTimeout);
        }

        batchTimeout = setTimeout(() => {
          flushBatch();
        }, config.batchWindowMs || 50);

        // If buffer is getting large, flush immediately
        if (batchBuffer.length >= 10) {
          flushBatch();
        }
      });
    },

    /**
     * Check service health
     */
    async isServiceHealthy(channel: NotificationChannel = "log"): Promise<boolean> {
      if (channel === "log") {
        return true;
      }

      if (channel === "discord") {
        return !!config.discordWebhook;
      }

      return false;
    },

    /**
     * Get queued count
     */
    getQueuedCount(): number {
      return queue.length;
    },

    /**
     * Flush queued notifications
     */
    async flush(): Promise<void> {
      const toFlush = [...queue];
      queue.length = 0;

      for (const item of toFlush) {
        await sendWithRetry(item.message, item.options, item.retries);
      }
    },
  };

  return service;
}

// ============================================================================
// Singleton Exports
// ============================================================================

// Create a default singleton service
let defaultService: NotificationService | null = null;

function getDefaultService(): NotificationService {
  if (!defaultService) {
    defaultService = createNotificationService();
  }
  return defaultService;
}

/**
 * Send notification (async) using default service.
 * Resolves `true` if delivered, `false` if every channel attempt failed.
 */
export async function notify(message: string, options?: NotifyOptions): Promise<boolean> {
  return getDefaultService().notify(message, options);
}

/**
 * Fire-and-forget notification using default service
 */
export function notifySync(message: string, options?: NotifyOptions): void {
  getDefaultService().notifySync(message, options);
}

// ============================================================================
// CLI
// ============================================================================

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    console.log(`
NotificationService - Unified notification service for Kaya

Usage:
  bun run NotificationService.ts --test "Message"     Send test notification
  bun run NotificationService.ts --health             Check service health
  bun run NotificationService.ts --channel telegram "Message"

Options:
  --test <message>       Send a test notification (default channel: log)
  --health               Report which push channels are configured
  --channel <channel>    Specify channel (log, discord, telegram, email)
  --agent <name>         Agent name for title
  --priority <level>     Priority (low, normal, high, critical)
  --help, -h             Show this help
    `);
    process.exit(0);
  }

  const service = createNotificationService();

  // Health check
  if (args.includes("--health")) {
    const discordHealthy = await service.isServiceHealthy("discord");
    console.log(`Discord: ${discordHealthy ? "CONFIGURED" : "NOT CONFIGURED"}`);
    process.exit(0);
  }

  // Parse options
  let channel: NotificationChannel = "log";
  let agentName: string | undefined;
  let priority: NotificationPriority = "normal";
  let message = "";

  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? "";

    if (arg === "--test" && args[i + 1]) {
      message = args[i + 1] ?? "";
      i++;
    } else if (arg === "--channel" && args[i + 1]) {
      channel = args[i + 1] as NotificationChannel;
      i++;
    } else if (arg === "--agent" && args[i + 1]) {
      agentName = args[i + 1];
      i++;
    } else if (arg === "--priority" && args[i + 1]) {
      priority = args[i + 1] as NotificationPriority;
      i++;
    } else if (!arg.startsWith("--")) {
      message = arg;
    }
  }

  if (!message) {
    console.error("Error: No message provided");
    process.exit(1);
  }

  try {
    await service.notify(message, {
      channel,
      agentName,
      priority,
    });
    console.log(`Notification sent to ${channel}: "${message}"`);
    process.exit(0);
  } catch (error) {
    console.error("Failed to send notification:", error);
    process.exit(1);
  }
}

// Run if executed directly
if (import.meta.main) {
  main().catch(console.error);
}
