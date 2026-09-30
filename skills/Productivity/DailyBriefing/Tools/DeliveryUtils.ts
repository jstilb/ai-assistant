/**
 * DeliveryUtils.ts - Shared delivery and settings utilities for DailyBriefing tools
 *
 * Extracts common deliverVoice(), deliverTelegram(), and loadSettings() that were
 * duplicated across the DailyBriefing delivery tools.
 *
 * S5: also owns deliverVoiceToTelegram() (moved out of the since-deleted v2
 * orchestrator) and an
 * in-process deliverTelegram() — see each function's docstring. Both talk to Telegram
 * directly via TelegramClient.ts's exported sendVoiceBuffer() / TelegramFormatting.ts's
 * buildSendMessageParams() instead of spawning `bun TelegramClient.ts ...` as a
 * subprocess. Secrets are loaded via this module's own loadTelegramSecretsSafe()
 * (below), not TelegramConfig.loadTelegramSecrets() — see that function's docstring.
 */

import { existsSync } from "fs";
import { join, basename } from "path";
import { z } from "zod";
// cross-skill-allowed: ADR-004 sanctioned Telegram lane — deliberate in-process delivery (S5 migration), see file docstring
import { sendVoiceBuffer } from "../../../Communication/Telegram/Tools/TelegramClient.ts";
// cross-skill-allowed: ADR-004 sanctioned Telegram lane — deliberate in-process delivery (S5 migration), see file docstring
import { buildSendMessageParams } from "../../../Communication/Telegram/Tools/TelegramFormatting.ts";
import { httpClient } from "../../../../lib/core/CachedHTTPClient.ts";
import { getKayaHome } from "../../../../lib/core/KayaHome.ts";
import { recordOutbound } from "../../../../lib/core/TelegramOutboundLedger.ts";

const KAYA_HOME = getKayaHome(); // was KAYA_DIR-only; getKayaHome() superset
const LIB_CORE = join(KAYA_HOME, "lib", "core");
const SETTINGS_FILE = join(KAYA_HOME, "settings.json");
const VOICE_GENERATOR_PATH = join(KAYA_HOME, "skills", "Communication", "VoiceInteraction", "Tools", "VoiceResponseGenerator.ts");

// ============================================================================
// Telegram secrets — deliberately NOT TelegramConfig.loadTelegramSecrets()
// ============================================================================
//
// WHY: TelegramConfig.ts's loadTelegramSecrets() calls process.exit(1) on
// missing/unreadable secrets — correct for a CLI subprocess (only that
// subprocess dies), but fatal if called in-process here: it would kill the
// whole briefing delivery run instead of just failing one delivery channel.
// WaitingOnJmNotifier.ts
// hit this same landmine and hand-rolls its own non-exiting loader for the
// same reason ("mirrors ApprovalNudge.ts's loadSecrets — same shape, same
// file"); this mirrors that precedent.
interface TelegramSecrets {
  bot_token: string;
  chat_id: string;
}

async function loadTelegramSecretsSafe(): Promise<TelegramSecrets | null> {
  try {
    const secrets = (await Bun.file(join(KAYA_HOME, "secrets.json")).json()) as Record<string, unknown>;
    const tg = secrets.telegram as Partial<TelegramSecrets> | undefined;
    if (!tg?.bot_token || !tg?.chat_id) return null;
    return { bot_token: tg.bot_token, chat_id: tg.chat_id };
  } catch {
    return null;
  }
}

// ============================================================================
// Settings Loader (via StateManager)
// ============================================================================

// Zod v4 requires explicit key+value schemas for z.record.
const SettingsSchema = z.record(z.string(), z.unknown());

type SettingsManager = { load: () => Promise<Record<string, unknown>> };
let _stateManager: SettingsManager | null = null;

async function getSettingsManager(): Promise<SettingsManager> {
  if (!_stateManager) {
    const { createStateManager } = await import(join(LIB_CORE, "StateManager.ts"));
    _stateManager = createStateManager({
      path: SETTINGS_FILE,
      schema: SettingsSchema,
      defaults: {},
    }) as SettingsManager;
  }
  return _stateManager;
}

export async function loadSettings(): Promise<Record<string, unknown>> {
  try {
    const mgr = await getSettingsManager();
    return await mgr.load();
  } catch {
    return {};
  }
}

// ============================================================================
// Voice Delivery (via lib/core/NotificationService)
// ============================================================================

export async function deliverVoice(message: string, agentName: string = "DailyBriefing"): Promise<void> {
  try {
    const notificationPath = join(LIB_CORE, "NotificationService.ts");
    if (existsSync(notificationPath)) {
      const { notifySync } = await import(notificationPath);
      notifySync(message, { agentName });
    }
    console.log("Voice delivered");
  } catch (e) {
    console.error("Voice delivery failed:", e);
  }
}

// ============================================================================
// Voice Delivery to Telegram (TTS generation + in-process send)
// ============================================================================

/**
 * Upload a generated audio buffer to Telegram as a document — fallback for
 * when sendVoice rejects the file's format. In-process reimplementation of
 * TelegramClient.ts's own (unexported) sendDocument()/apiCallFormData(): same
 * multipart shape, same endpoint, just without spawning TelegramClient.
 */
async function sendDocumentBuffer(
  buffer: Buffer,
  filename: string,
  chatId: string,
  botToken: string
): Promise<boolean> {
  const formData = new FormData();
  formData.append("chat_id", chatId);
  formData.append("document", new Blob([buffer]), filename);

  const url = `https://api.telegram.org/bot${botToken}/sendDocument`;
  const response = await httpClient.fetch(url, { method: "POST", body: formData, cache: "none" });
  const result = (await response.json()) as { ok: boolean };
  return result.ok;
}

/**
 * Generate TTS audio for `text` and deliver it to Telegram as a voice message.
 *
 * Moved here from the v2 orchestrator (S5): this module already owns voice
 * delivery mechanics (see deliverVoice above), so the Telegram-voice path
 * belongs alongside it rather than duplicated in the caller.
 *
 * GENERATION still shells out to VoiceResponseGenerator.ts via Bun.spawn —
 * that's audio synthesis (TTS), not a delivery channel, so it's outside the
 * S5 in-process-delivery mandate (see deliverTelegram below for the mandate
 * itself).
 *
 * DELIVERY is in-process: reads the generated file into a Buffer and calls
 * TelegramClient's exported `sendVoiceBuffer()` directly — the same function
 * TelegramBot.ts's programmatic callers use (see TelegramClient.ts's own
 * "Main — guarded" comment, which documents sendVoiceBuffer as the intended
 * external entry point) — instead of spawning `bun TelegramClient.ts
 * send-voice <path>`. Falls back to an in-process document upload
 * (sendDocumentBuffer above) if Telegram rejects the voice format, mirroring
 * the previous subprocess fallback.
 */
async function generateVoice(text: string, audioPath: string): Promise<void> {
  const genProc = Bun.spawn(
    ["bun", VOICE_GENERATOR_PATH, "telegram", text, audioPath],
    { stdout: "pipe", stderr: "pipe" }
  );
  const exitCode = await genProc.exited;
  if (exitCode !== 0) throw new Error(`TTS generation failed (exit ${exitCode})`);
}

export async function deliverVoiceToTelegram(
  text: string,
  audioPath: string,
  generate: (text: string, audioPath: string) => Promise<void> = generateVoice,
): Promise<void> {
  try {
    await generate(text, audioPath);

    if (!existsSync(audioPath)) {
      throw new Error("TTS generation produced no audio file");
    }

    const secrets = await loadTelegramSecretsSafe();
    if (!secrets) {
      throw new Error("telegram secrets missing/unreadable in secrets.json");
    }
    const audioBuffer = Buffer.from(await Bun.file(audioPath).arrayBuffer());

    const sent = await sendVoiceBuffer(audioBuffer, secrets.chat_id, secrets.bot_token);
    if (sent) {
      console.log("Voice delivered to Telegram");
      return;
    }

    const delivered = await sendDocumentBuffer(audioBuffer, basename(audioPath), secrets.chat_id, secrets.bot_token);
    if (!delivered) throw new Error("voice and document both rejected");
    console.log("Voice delivered to Telegram (as document)");
  } catch (e) {
    console.error("Telegram voice delivery failed:", e);
    throw e;
  }
}

// ============================================================================
// Telegram Delivery
// ============================================================================

const TELEGRAM_DELIVERY_TIMEOUT_MS = 45_000;

interface TelegramSendMessageResult {
  ok: boolean;
  description?: string;
  parameters?: { retry_after?: number };
  result?: { message_id?: number };
}

/**
 * POST one Telegram sendMessage request. Extracted so sendTelegramMessage
 * can retry once on HTTP 429 without duplicating the request-building code.
 */
async function postTelegramSendMessage(
  url: string,
  params: Record<string, unknown>
): Promise<{ response: Response; result: TelegramSendMessageResult }> {
  const response = await httpClient.fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
    cache: "none",
    timeout: TELEGRAM_DELIVERY_TIMEOUT_MS,
  });
  const result = (await response.json()) as TelegramSendMessageResult;
  return { response, result };
}

/**
 * Send a Telegram text message in-process — mirrors TelegramClient.ts's own
 * (unexported) sendMessage()/apiCall(): same param builder
 * (TelegramFormatting.buildSendMessageParams), same HTTP 429
 * retry-after-once behavior — just without spawning TelegramClient as a
 * subprocess, and using loadTelegramSecretsSafe() (above) instead of
 * TelegramConfig.loadTelegramSecrets() (which process.exit(1)s in-process —
 * see that function's docstring). TelegramClient.ts only exports
 * sendVoiceBuffer (no exported text-send function), so this reuses
 * TelegramClient's OWN shared building blocks directly rather than adding an
 * export to a file this slice must not modify (see SkipDigestSender.ts /
 * WaitingOnJmNotifier.ts for the same established in-process-Telegram-send
 * pattern elsewhere in this repo).
 */
async function sendTelegramMessage(message: string): Promise<void> {
  const config = await loadTelegramSecretsSafe();
  if (!config) {
    throw new Error("Telegram secrets (bot_token/chat_id) missing or unreadable in secrets.json");
  }
  const url = `https://api.telegram.org/bot${config.bot_token}/sendMessage`;
  const params = buildSendMessageParams(config.chat_id, message);

  // Phase A1 (outbound ledger): record the briefing send so a reply to it can
  // resolve its referent. Best-effort — never fails the delivery.
  const recordSend = (r: TelegramSendMessageResult): void => {
    if (typeof r.result?.message_id === "number") {
      recordOutbound({ messageId: r.result.message_id, source: "daily-briefing", text: message });
    }
  };

  let { response, result } = await postTelegramSendMessage(url, params);
  if (result.ok) {
    recordSend(result);
    return;
  }

  if (response.status === 429) {
    const retryAfter = result.parameters?.retry_after ?? 5;
    await Bun.sleep(retryAfter * 1000);
    ({ response, result } = await postTelegramSendMessage(url, params));
    if (result.ok) {
      recordSend(result);
      return;
    }
  }

  throw new Error(`Telegram sendMessage failed: ${result.description ?? `HTTP ${response.status}`}`);
}

export async function deliverTelegram(
  message: string,
  sendMessage: (message: string) => Promise<void> = sendTelegramMessage,
): Promise<void> {
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        reject(new Error(`in-process Telegram send exceeded ${TELEGRAM_DELIVERY_TIMEOUT_MS}ms`));
      }, TELEGRAM_DELIVERY_TIMEOUT_MS);
    });
    await Promise.race([sendMessage(message), timeoutPromise]);
    console.log("Telegram delivered");
  } catch (e) {
    if (timedOut) {
      console.error(`Telegram delivery killed after ${TELEGRAM_DELIVERY_TIMEOUT_MS}ms — in-process send hung`);
    } else {
      console.error("Telegram delivery failed:", e);
    }
    throw e;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
