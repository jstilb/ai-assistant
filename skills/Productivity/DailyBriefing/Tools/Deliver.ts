#!/usr/bin/env bun
/**
 * Deliver.ts - Deterministic delivery CLI for the daily briefing
 *
 * The keep-list of the markdown-first inversion (ADR-022): composition is the
 * editorial agent's job; this tool owns only the mechanics that must be
 * deterministic — idempotent dedup sentinels, the written log + HTML, Drive
 * upload, Telegram text (with LOUD 4096 truncation), and TTS voice. Channel
 * enablement is payload field-presence: omit `telegram`/`voice` to skip that
 * channel (no config file).
 *
 * Usage:
 *   bun Deliver.ts --payload <payload.json>
 *   bun Deliver.ts --payload <payload.json> --dry-run   # print, touch nothing
 *
 * Payload shape:
 *   {
 *     "date": "2026-07-12",        // sentinel + filenames — YYYY-MM-DD
 *     "markdown": "...",           // required: full briefing → MEMORY/BRIEFINGS/{date}.md + .html + Drive
 *     "telegram": "...",           // optional: Telegram text message
 *     "voice": "..."               // optional: TTS script → Telegram voice + local speaker
 *   }
 *
 * Tier receipts permit one fallback-to-full upgrade per channel. A pending
 * full attempt retains legacy receipt provenance and reconciliation eligibility
 * until every requested channel completes; successful channels dedupe on retry.
 */

import { parseArgs } from "util";
import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from "fs";
import { execFileSync } from "child_process";
import { join } from "path";
import { marked } from "marked";
import { z } from "zod";
import {
  deliverVoice as deliverVoiceLocal,
  deliverVoiceToTelegram,
  deliverTelegram as deliverTelegramShared,
} from "./DeliveryUtils.ts";
import { getKayaHome } from "../../../../lib/core/KayaHome.ts";

// ============================================================================
// Payload
// ============================================================================

export const PayloadSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "date must be YYYY-MM-DD"),
  tier: z.enum(["fallback", "full"]).optional(),
  markdown: z.string().min(1, "markdown is required — the written log is not optional"),
  telegram: z.string().optional(),
  voice: z.string().optional(),
});

export type DeliverPayload = z.infer<typeof PayloadSchema>;

const TierSchema = z.enum(["fallback", "full"]);
type DeliveryTier = z.infer<typeof TierSchema>;
const ReceiptSchema = z.object({
  tier: TierSchema,
  deliveredAt: z.string().datetime(),
  legacyTier: TierSchema.optional(),
});
const PendingSchema = z.object({
  tier: z.literal("full"),
  legacyTier: TierSchema,
  channels: z.array(z.enum(["telegram", "voice"])),
});

function readReceipt(path: string): z.infer<typeof ReceiptSchema> | "legacy" | null {
  if (!existsSync(path)) return null;
  const raw = readFileSync(path, "utf8").trim();
  if (z.string().datetime().safeParse(raw).success) return "legacy";
  return ReceiptSchema.parse(JSON.parse(raw));
}

// ============================================================================
// Telegram formatting — link-append + 4096 hard limit (LOUD truncation)
// ============================================================================

const TELEGRAM_CHAR_LIMIT = 4096;

export interface FormattedTelegram {
  message: string;
  /** True when content was cut to fit the 4096-char limit — the caller MUST
   *  log this; silent truncation is how delivered artifacts quietly lie. */
  truncated: boolean;
  droppedChars: number;
}

/** Append the Drive link if it fits and enforce Telegram's 4096-char limit. */
export function formatTelegramMessage(editorialTelegram: string, driveLink: string | null): FormattedTelegram {
  let msg = editorialTelegram;
  let truncated = false;
  let droppedChars = 0;

  if (driveLink) {
    const linkSuffix = `\n\n[Full briefing](${driveLink})`;
    if (msg.length + linkSuffix.length <= TELEGRAM_CHAR_LIMIT) {
      msg += linkSuffix;
    } else {
      const maxContent = TELEGRAM_CHAR_LIMIT - linkSuffix.length - 4;
      droppedChars = msg.length - maxContent;
      msg = msg.slice(0, maxContent) + "\n..." + linkSuffix;
      truncated = true;
    }
  }

  if (msg.length > TELEGRAM_CHAR_LIMIT) {
    droppedChars += msg.length - (TELEGRAM_CHAR_LIMIT - 4);
    msg = msg.slice(0, TELEGRAM_CHAR_LIMIT - 4) + "\n...";
    truncated = true;
  }

  return { message: msg, truncated, droppedChars };
}

// ============================================================================
// Written log + HTML
// ============================================================================

function wrapInHtml(markdown: string, date: string): string {
  const body = marked.parse(markdown) as string;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Daily Briefing — ${date}</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; line-height: 1.6; color: #1a1a1a; background: #f8f9fa; margin: 0; padding: 16px; }
  .container { max-width: 680px; margin: 0 auto; background: #fff; border-radius: 8px; padding: 24px; box-shadow: 0 1px 3px rgba(0,0,0,0.08); }
  h1 { font-size: 1.4em; border-bottom: 2px solid #e9ecef; padding-bottom: 8px; }
  h2 { font-size: 1.15em; color: #495057; margin-top: 1.5em; }
  table { width: 100%; border-collapse: collapse; margin: 12px 0; font-size: 0.92em; }
  th, td { padding: 8px 10px; border: 1px solid #dee2e6; text-align: left; }
  th { background: #f1f3f5; font-weight: 600; }
  tr:nth-child(even) { background: #f8f9fa; }
  a { color: #228be6; }
  ul, ol { padding-left: 20px; }
  hr { border: none; border-top: 1px solid #e9ecef; margin: 20px 0; }
  em { color: #868e96; }
</style>
</head>
<body><div class="container">
${body}
</div></body>
</html>`;
}

// ============================================================================
// Default channel implementations (injectable for tests)
// ============================================================================

async function uploadToDrive(localPath: string, dateStr: string): Promise<string | null> {
  try {
    const drivePath = `gdrive:Kaya/Briefings/DailyBriefing-${dateStr}.html`;
    execFileSync("rclone", ["copyto", localPath, drivePath], { encoding: "utf-8", timeout: 30000 });

    const linkOutput = execFileSync("rclone", ["link", drivePath], { encoding: "utf-8", timeout: 10000 });
    const driveLink = linkOutput.trim();

    return driveLink && driveLink.startsWith("http") ? driveLink : null;
  } catch (e) {
    console.error("❌ Drive upload failed:", e instanceof Error ? e.message : e);
    return null;
  }
}

export interface DeliverDeps {
  telegramSend: (message: string) => Promise<void>;
  voiceToTelegram: (text: string, audioPath: string) => Promise<void>;
  voiceLocal: (text: string, agentName?: string) => Promise<void>;
  driveUpload: (localPath: string, date: string) => Promise<string | null>;
}

function defaultDeps(): DeliverDeps {
  return {
    telegramSend: deliverTelegramShared,
    voiceToTelegram: deliverVoiceToTelegram,
    voiceLocal: deliverVoiceLocal,
    driveUpload: uploadToDrive,
  };
}

// ============================================================================
// Delivery orchestration
// ============================================================================

export interface DeliverResult {
  delivered: string[];
  skipped: string[];
  truncationWarning: string | null;
  alreadyDeliveredGlobally: boolean;
}

export async function deliver(
  payload: DeliverPayload,
  opts: { dryRun?: boolean } = {},
  depOverrides: Partial<DeliverDeps> = {}
): Promise<DeliverResult> {
  const deps: DeliverDeps = { ...defaultDeps(), ...depOverrides };
  const briefingsDir = join(getKayaHome(), "MEMORY", "BRIEFINGS");
  const { date } = payload;
  const tier = payload.tier ?? "full";

  const result: DeliverResult = {
    delivered: [],
    skipped: [],
    truncationWarning: null,
    alreadyDeliveredGlobally: false,
  };

  const globalSentinel = join(briefingsDir, `.sent-${date}`);
  const channelSentinel = (channel: string) => join(briefingsDir, `.sent-${date}-${channel}`);
  const mdPath = join(briefingsDir, `${date}.md`);
  const pendingPath = `${mdPath}.delivery-pending`;
  const pending = existsSync(pendingPath) ? PendingSchema.parse(JSON.parse(readFileSync(pendingPath, "utf8"))) : null;
  const globalReceipt = readReceipt(globalSentinel);
  const legacyTier: DeliveryTier = pending?.legacyTier
    ?? (globalReceipt && globalReceipt !== "legacy" ? globalReceipt.legacyTier : undefined)
    ?? (existsSync(mdPath) && readFileSync(mdPath, "utf8").split("\n", 1)[0]?.includes("deterministic fallback") ? "fallback" : "full");
  const receiptTier = (receipt: ReturnType<typeof readReceipt>) => receipt === "legacy" ? legacyTier : receipt?.tier;
  const channelTier = (channel: string) => {
    const receipt = readReceipt(channelSentinel(channel));
    return receiptTier(receipt) ?? (globalReceipt === "legacy" ? legacyTier : undefined);
  };
  const channelDone = (channel: string) => {
    const deliveredTier = channelTier(channel);
    return deliveredTier === "full" || deliveredTier === tier;
  };
  const channels = (["telegram", "voice"] as const).filter((channel) => payload[channel]);
  const globalTier = receiptTier(globalReceipt);
  result.alreadyDeliveredGlobally = (globalTier === "full" || globalTier === tier) && channels.every(channelDone);

  if (opts.dryRun) {
    console.log(`=== DRY RUN — nothing sent, nothing written ===\n`);
    console.log(`Date: ${date}`);
    console.log(`Global sentinel present: ${result.alreadyDeliveredGlobally}`);
    console.log(`\n--- WRITTEN (${briefingsDir}/${date}.md + .html + Drive) ---\n${payload.markdown}`);
    if (payload.telegram) {
      const preview = formatTelegramMessage(payload.telegram, null);
      console.log(`\n--- TELEGRAM [${payload.telegram.length} chars${preview.truncated ? `, WOULD TRUNCATE (${preview.droppedChars} dropped)` : ""}] ---\n${preview.message}`);
    } else {
      console.log("\n--- TELEGRAM: omitted (channel skipped) ---");
    }
    if (payload.voice) {
      console.log(`\n--- VOICE [${payload.voice.split(/\s+/).length} words] ---\n${payload.voice}`);
    } else {
      console.log("\n--- VOICE: omitted (channel skipped) ---");
    }
    return result;
  }

  if (tier === "fallback" && (pending || globalTier === "full" || ["telegram", "voice"].some((channel) => channelTier(channel) === "full"))) {
    result.skipped.push(...channels);
    console.log("Full briefing delivery already started — fallback skipped without replacing its artifact");
    return result;
  }

  // ── Written log (always — markdown is required) ──
  if (!existsSync(briefingsDir)) mkdirSync(briefingsDir, { recursive: true });
  const requiredChannels = [...new Set([...(pending?.channels ?? []), ...channels])];
  if (tier === "full" && (!result.alreadyDeliveredGlobally || pending)) {
    writeFileSync(pendingPath, JSON.stringify({ tier, legacyTier, channels: requiredChannels }));
  }
  writeFileSync(mdPath, payload.markdown);
  const htmlPath = join(briefingsDir, `${date}.html`);
  writeFileSync(htmlPath, wrapInHtml(payload.markdown, date));
  console.log(`✅ Written: ${mdPath}`);
  result.delivered.push("written");

  if (result.alreadyDeliveredGlobally && !pending) {
    console.log(`Briefing ${tier} tier already delivered today (${date}) — channels skipped.`);
    for (const ch of ["telegram", "voice"] as const) {
      if (payload[ch]) result.skipped.push(ch);
    }
    return result;
  }

  // ── Drive upload (best-effort, feeds the Telegram link) ──
  let driveLink: string | null = null;
  const drivePromise = deps
    .driveUpload(htmlPath, date)
    .then((link) => {
      if (link) {
        driveLink = link;
        console.log("✅ Uploaded to Drive");
      }
    })
    .catch(() => {});

  // ── Voice ──
  if (payload.voice) {
    if (!channelDone("voice")) {
      await deps.voiceToTelegram(payload.voice, join(briefingsDir, "briefing-voice.ogg"));
      try {
        await deps.voiceLocal(payload.voice, "Morning Briefing");
      } catch {
        // Local playback is secondary — Telegram voice is what reaches the phone.
      }
      writeFileSync(channelSentinel("voice"), JSON.stringify({ tier, deliveredAt: new Date().toISOString() }));
      result.delivered.push("voice");
    } else {
      console.log("⏭️ Voice already delivered");
      result.skipped.push("voice");
    }
  }

  // ── Telegram text (waits briefly for the Drive link) ──
  let driveWaitTimer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    drivePromise,
    new Promise((resolve) => {
      driveWaitTimer = setTimeout(resolve, 5000);
    }),
  ]);
  if (driveWaitTimer) clearTimeout(driveWaitTimer);

  if (payload.telegram) {
    if (!channelDone("telegram")) {
      const formatted = formatTelegramMessage(payload.telegram, driveLink);
      if (formatted.truncated) {
        result.truncationWarning =
          `Telegram message truncated to fit the ${TELEGRAM_CHAR_LIMIT}-char limit — ` +
          `${formatted.droppedChars} chars dropped. The full briefing is in ${mdPath}` +
          (driveLink ? " and on Drive." : ".");
        console.warn(`⚠️ ${result.truncationWarning}`);
      }
      await deps.telegramSend(formatted.message);
      writeFileSync(channelSentinel("telegram"), JSON.stringify({ tier, deliveredAt: new Date().toISOString() }));
      result.delivered.push("telegram");
    } else {
      console.log("⏭️ Telegram already delivered");
      result.skipped.push("telegram");
    }
  }

  // ── Global sentinel ──
  if (tier === "full" && !requiredChannels.every(channelDone)) {
    throw new Error("Full delivery remains pending for a previously requested channel");
  }
  writeFileSync(globalSentinel, JSON.stringify({ tier, deliveredAt: new Date().toISOString(), legacyTier }));
  if (tier === "full" && existsSync(pendingPath)) unlinkSync(pendingPath);
  console.log(`✅ Delivery complete: ${result.delivered.join(", ")}${result.skipped.length ? ` (skipped: ${result.skipped.join(", ")})` : ""}`);
  return result;
}

// ============================================================================
// CLI
// ============================================================================

if (import.meta.main) {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      payload: { type: "string" },
      "dry-run": { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });

  if (values.help || !values.payload) {
    console.log(`
Deliver.ts — deterministic delivery for the daily briefing

Usage:
  bun Deliver.ts --payload <payload.json>            Deliver all channels present in the payload
  bun Deliver.ts --payload <payload.json> --dry-run  Print what would be delivered; touch nothing

Payload JSON: { date, markdown, telegram?, voice? }
Channel enablement = field presence. Sentinels in MEMORY/BRIEFINGS make reruns idempotent.
`);
    process.exit(values.help ? 0 : 1);
  }

  let payload: DeliverPayload;
  try {
    const raw = JSON.parse(readFileSync(values.payload, "utf-8"));
    payload = PayloadSchema.parse(raw);
  } catch (err) {
    console.error(`❌ Invalid payload (${values.payload}):`, err instanceof Error ? err.message : err);
    process.exit(1);
  }

  try {
    await deliver(payload, { dryRun: values["dry-run"] ?? false });
  } catch (err) {
    console.error("❌ Delivery failed:", err);
    process.exit(1);
  }
}
