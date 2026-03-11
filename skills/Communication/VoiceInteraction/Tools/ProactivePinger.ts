#!/usr/bin/env bun
/**
 * ProactivePinger.ts - Event-driven proactive voice outreach
 *
 * Sends voice messages to the user based on triggers:
 * - Scheduled pings (time-based)
 * - Event-driven pings (calendar, queue completion, etc.)
 * - Context-based pings (goal reminders, check-ins)
 *
 * Routes to active channel: desktop speakers if running, else Telegram voice.
 *
 * Usage:
 *   bun ProactivePinger.ts send "Meeting in 10 minutes"           # Send now via best channel
 *   bun ProactivePinger.ts send --channel=telegram "Hello"        # Force Telegram
 *   bun ProactivePinger.ts send --channel=desktop "Hello"         # Force desktop
 *   bun ProactivePinger.ts schedule --at "2026-02-05T09:00" --message "Good morning"
 *   bun ProactivePinger.ts list                                    # List scheduled pings
 *   bun ProactivePinger.ts cancel <ping-id>                        # Cancel scheduled ping
 */

import { spawnSync } from "child_process";
import { unlinkSync } from "fs";
import { join } from "path";
import {
  TEMP_DIR,
  VOICE_RESPONSE_TOOL,
  TELEGRAM_CLIENT,
  DESKTOP_CLIENT,
  ensureTempDir,
  getPingsManager,
  type ScheduledPing,
} from "./VoiceCommon.ts";
import { notifySync } from "../../../../lib/core/NotificationService.ts";

interface PingResult {
  sent: boolean;
  channel: "desktop" | "telegram";
  message: string;
  timestamp: string;
}

/**
 * Check if desktop voice client is running
 */
function isDesktopActive(): boolean {
  const result = spawnSync("bun", [DESKTOP_CLIENT, "status"], {
    encoding: "utf-8",
    timeout: 5000,
  });
  try {
    const status = JSON.parse(result.stdout);
    return status.running === true;
  } catch {
    return false;
  }
}

/**
 * Send a voice message via the best available channel
 */
async function sendPing(
  message: string,
  preferredChannel?: "desktop" | "telegram" | "auto"
): Promise<PingResult> {
  // Voice notification before sending ping
  try { notifySync("Sending voice ping"); } catch { /* non-blocking */ }

  const channel = preferredChannel || "auto";
  let targetChannel: "desktop" | "telegram";

  if (channel === "auto") {
    targetChannel = isDesktopActive() ? "desktop" : "telegram";
  } else {
    targetChannel = channel;
  }

  if (targetChannel === "desktop") {
    // Play through speakers via VoiceResponseGenerator
    const result = spawnSync("bun", [VOICE_RESPONSE_TOOL, "speak", message], {
      encoding: "utf-8",
      timeout: 30000,
    });

    if (result.status !== 0) {
      // Fallback to Telegram if desktop fails
      console.error("Desktop playback failed, falling back to Telegram");
      targetChannel = "telegram";
    } else {
      return {
        sent: true,
        channel: "desktop",
        message,
        timestamp: new Date().toISOString(),
      };
    }
  }

  // Telegram channel
  if (targetChannel === "telegram") {
    // Generate OGG voice message
    const oggPath = join(TEMP_DIR, `ping-${Date.now()}.ogg`);
    const genResult = spawnSync("bun", [VOICE_RESPONSE_TOOL, "telegram", message, oggPath], {
      encoding: "utf-8",
      timeout: 30000,
    });

    if (genResult.status !== 0) {
      // Fallback to text message
      spawnSync("bun", [TELEGRAM_CLIENT, "send", `${message}`], {
        encoding: "utf-8",
        timeout: 15000,
      });

      return {
        sent: true,
        channel: "telegram",
        message: `[text fallback] ${message}`,
        timestamp: new Date().toISOString(),
      };
    }

    // Send voice message via Telegram
    const sendResult = spawnSync("bun", [TELEGRAM_CLIENT, "send-document", oggPath, `Kaya`], {
      encoding: "utf-8",
      timeout: 15000,
    });

    // Clean up temp file
    try { unlinkSync(oggPath); } catch { /* ignore */ }

    return {
      sent: sendResult.status === 0,
      channel: "telegram",
      message,
      timestamp: new Date().toISOString(),
    };
  }

  return {
    sent: false,
    channel: targetChannel,
    message,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Schedule a future ping
 */
async function schedulePing(
  message: string,
  scheduledAt: string,
  channel?: "desktop" | "telegram" | "auto"
): Promise<ScheduledPing> {
  const manager = getPingsManager();
  const ping: ScheduledPing = {
    id: `ping-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    message,
    scheduledAt,
    channel: channel || "auto",
    createdAt: new Date().toISOString(),
    status: "pending",
  };

  await manager.update((state) => ({
    pings: [...state.pings, ping],
  }));

  return ping;
}

/**
 * Cancel a scheduled ping
 */
async function cancelPing(pingId: string): Promise<boolean> {
  const manager = getPingsManager();
  const state = await manager.load();
  const ping = state.pings.find((p) => p.id === pingId);
  if (!ping || ping.status !== "pending") return false;

  await manager.update((s) => ({
    pings: s.pings.map((p) => p.id === pingId ? { ...p, status: "cancelled" as const } : p),
  }));

  return true;
}

/**
 * Process any due scheduled pings
 */
async function processDuePings(): Promise<PingResult[]> {
  const manager = getPingsManager();
  const state = await manager.load();
  const now = new Date();
  const results: PingResult[] = [];

  const duePings = state.pings.filter(
    (p) => p.status === "pending" && new Date(p.scheduledAt) <= now
  );

  for (const ping of duePings) {
    const result = await sendPing(ping.message, ping.channel);
    results.push(result);
  }

  // Mark all due pings as sent
  if (duePings.length > 0) {
    const dueIds = new Set(duePings.map((p) => p.id));
    await manager.update((s) => ({
      pings: s.pings.map((p) => dueIds.has(p.id) ? { ...p, status: "sent" as const } : p),
    }));
  }

  return results;
}

// --- CLI ---

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  ensureTempDir();

  switch (command) {
    case "--help":
    case "-h":
    case "help": {
      console.log(`ProactivePinger - Event-driven voice outreach

Commands:
  send [--channel=auto] <message>           Send voice ping now
  schedule --at <ISO> --message <text>      Schedule future ping
  list                                       List pending pings
  cancel <ping-id>                           Cancel scheduled ping
  process-due                                Process all due pings
  --help                                     Show this help`);
      break;
    }

    case "send": {
      let message = "";
      let channel: "desktop" | "telegram" | "auto" | undefined;

      for (let i = 1; i < args.length; i++) {
        if (args[i].startsWith("--channel=")) {
          const val = args[i].split("=")[1];
          if (val === "desktop" || val === "telegram" || val === "auto") {
            channel = val;
          }
        } else {
          message = args.slice(i).join(" ");
          break;
        }
      }

      if (!message) {
        console.error("Usage: send [--channel=auto|desktop|telegram] <message>");
        process.exit(1);
      }

      const result = await sendPing(message, channel);
      console.log(JSON.stringify(result, null, 2));
      break;
    }

    case "schedule": {
      let at = "";
      let message = "";
      let channel: "desktop" | "telegram" | "auto" | undefined;

      for (let i = 1; i < args.length; i++) {
        if (args[i] === "--at" && args[i + 1]) {
          at = args[++i];
        } else if (args[i] === "--message" && args[i + 1]) {
          message = args[++i];
        } else if (args[i].startsWith("--channel=")) {
          const val = args[i].split("=")[1];
          if (val === "desktop" || val === "telegram" || val === "auto") {
            channel = val;
          }
        }
      }

      if (!at || !message) {
        console.error('Usage: schedule --at "ISO-date" --message "text" [--channel=auto]');
        process.exit(1);
      }

      const ping = await schedulePing(message, at, channel);
      console.log(JSON.stringify(ping, null, 2));
      break;
    }

    case "list": {
      const manager = getPingsManager();
      const state = await manager.load();
      const pending = state.pings.filter((p) => p.status === "pending");
      console.log(JSON.stringify(pending, null, 2));
      break;
    }

    case "cancel": {
      const pingId = args[1];
      if (!pingId) {
        console.error("Usage: cancel <ping-id>");
        process.exit(1);
      }
      const cancelled = await cancelPing(pingId);
      console.log(JSON.stringify({ cancelled, pingId }));
      break;
    }

    case "process-due": {
      const results = await processDuePings();
      console.log(JSON.stringify(results, null, 2));
      break;
    }

    default:
      console.log(`ProactivePinger - Event-driven voice outreach

Commands:
  send [--channel=auto] <message>           Send voice ping now
  schedule --at <ISO> --message <text>      Schedule future ping
  list                                       List pending pings
  cancel <ping-id>                           Cancel scheduled ping
  process-due                                Process all due pings`);
      break;
  }
}

main().catch((err) => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});

export { sendPing, schedulePing, cancelPing, processDuePings };
export type { ScheduledPing, PingResult };
