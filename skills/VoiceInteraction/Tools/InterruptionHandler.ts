#!/usr/bin/env bun
/**
 * InterruptionHandler.ts - Manages interruption of in-flight voice responses
 *
 * Tracks active voice responses and provides cancellation when new input arrives.
 * Works across both desktop (VAD-based) and Telegram (new message) channels.
 *
 * NOTE: Interruption is between-turn, not real-time. When a new user turn is
 * detected, any in-progress TTS playback or generation is cancelled before
 * processing the new input.
 *
 * Usage:
 *   bun InterruptionHandler.ts register <session-id>     # Register active response
 *   bun InterruptionHandler.ts cancel <session-id>        # Cancel active response
 *   bun InterruptionHandler.ts cancel-all                 # Cancel all active responses
 *   bun InterruptionHandler.ts status                     # Show active responses
 */

import { spawnSync } from "child_process";
import {
  ensureTempDir,
  getInterruptionManager,
  type ActiveResponse,
  type InterruptionState,
} from "./VoiceCommon.ts";

/**
 * Register an active voice response being generated/played
 */
async function registerResponse(
  sessionId: string,
  channel: "desktop" | "telegram",
  pid?: number,
  audioFile?: string
): Promise<void> {
  const manager = getInterruptionManager();
  await manager.update((state) => {
    // Remove any existing entry for this session
    const filtered = state.activeResponses.filter(
      (r) => r.sessionId !== sessionId
    );

    filtered.push({
      sessionId,
      channel,
      startedAt: new Date().toISOString(),
      pid,
      audioFile,
    });

    return { ...state, activeResponses: filtered };
  });
}

/**
 * Cancel an active response by session ID
 */
async function cancelResponse(sessionId: string, reason: string = "user_interrupt"): Promise<boolean> {
  const manager = getInterruptionManager();
  const state = await manager.load();
  const response = state.activeResponses.find((r) => r.sessionId === sessionId);

  if (!response) {
    return false;
  }

  // Kill afplay if playing audio on desktop
  if (response.channel === "desktop") {
    spawnSync("pkill", ["-f", "afplay"], { encoding: "utf-8" });
  }

  // Kill specific PID if tracked
  if (response.pid) {
    try {
      process.kill(response.pid, "SIGTERM");
    } catch {
      // Process may already be gone
    }
  }

  // Update state
  await manager.update((s) => ({
    activeResponses: s.activeResponses.filter((r) => r.sessionId !== sessionId),
    lastInterruption: {
      sessionId,
      at: new Date().toISOString(),
      reason,
    },
  }));

  return true;
}

/**
 * Cancel all active responses
 */
async function cancelAll(reason: string = "cancel_all"): Promise<number> {
  const manager = getInterruptionManager();
  const state = await manager.load();
  const count = state.activeResponses.length;

  // Kill all afplay processes
  spawnSync("pkill", ["-f", "afplay"], { encoding: "utf-8" });

  // Kill all tracked PIDs
  for (const response of state.activeResponses) {
    if (response.pid) {
      try {
        process.kill(response.pid, "SIGTERM");
      } catch {
        // Process may already be gone
      }
    }
  }

  await manager.save({
    activeResponses: [],
    lastInterruption: {
      sessionId: "all",
      at: new Date().toISOString(),
      reason,
    },
  });

  return count;
}

/**
 * Check if there's an active response that should be interrupted
 */
async function hasActiveResponse(channel?: "desktop" | "telegram"): Promise<boolean> {
  const manager = getInterruptionManager();
  const state = await manager.load();
  if (channel) {
    return state.activeResponses.some((r) => r.channel === channel);
  }
  return state.activeResponses.length > 0;
}

/**
 * Get current state
 */
async function getStatus(): Promise<InterruptionState> {
  const manager = getInterruptionManager();
  return manager.load();
}

// --- CLI ---

async function main() {
  const [command, ...args] = process.argv.slice(2);

  ensureTempDir();

  switch (command) {
    case "--help":
    case "-h":
    case "help": {
      console.log(`InterruptionHandler - Voice response interruption management

Commands:
  register <session-id> [channel] [pid]  Register active response
  cancel <session-id>                     Cancel specific response
  cancel-all                              Cancel all active responses
  status                                  Show active response state
  --help                                  Show this help`);
      break;
    }

    case "register": {
      const sessionId = args[0];
      const channel = (args[1] || "desktop") as "desktop" | "telegram";
      const pid = args[2] ? parseInt(args[2]) : undefined;
      if (!sessionId) {
        console.error("Usage: register <session-id> [channel] [pid]");
        process.exit(1);
      }
      await registerResponse(sessionId, channel, pid);
      console.log(JSON.stringify({ registered: true, sessionId, channel }));
      break;
    }

    case "cancel": {
      const sessionId = args[0];
      if (!sessionId) {
        console.error("Usage: cancel <session-id>");
        process.exit(1);
      }
      const cancelled = await cancelResponse(sessionId);
      console.log(JSON.stringify({ cancelled, sessionId }));
      break;
    }

    case "cancel-all": {
      const count = await cancelAll();
      console.log(JSON.stringify({ cancelled: count }));
      break;
    }

    case "status": {
      const status = await getStatus();
      console.log(JSON.stringify(status, null, 2));
      break;
    }

    default:
      console.log(`InterruptionHandler - Voice response interruption management

Commands:
  register <session-id> [channel] [pid]  Register active response
  cancel <session-id>                     Cancel specific response
  cancel-all                              Cancel all active responses
  status                                  Show active response state`);
      break;
  }
}

main().catch((err) => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});

export {
  registerResponse,
  cancelResponse,
  cancelAll,
  hasActiveResponse,
  getStatus,
};
export type { ActiveResponse, InterruptionState };
