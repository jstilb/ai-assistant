/**
 * DeliveryUtils.ts - Shared delivery and settings utilities for DailyBriefing tools
 *
 * Extracts common deliverVoice(), deliverTelegram(), and loadSettings() that were
 * duplicated across BriefingGenerator, WeeklyScorecardGenerator, and EveningCheckinGenerator.
 */

import { existsSync } from "fs";
import { join } from "path";
import { z } from "zod";

const KAYA_HOME = process.env.KAYA_DIR || join(process.env.HOME!, ".claude");
const LIB_CORE = join(KAYA_HOME, "lib", "core");
const SETTINGS_FILE = join(KAYA_HOME, "settings.json");

// ============================================================================
// Settings Loader (via StateManager)
// ============================================================================

const SettingsSchema = z.record(z.unknown());

let _stateManager: { load: () => Promise<Record<string, unknown>> } | null = null;

async function getSettingsManager() {
  if (!_stateManager) {
    const { createStateManager } = await import(join(LIB_CORE, "StateManager.ts"));
    _stateManager = createStateManager({
      path: SETTINGS_FILE,
      schema: SettingsSchema,
      defaults: {},
    });
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
// Telegram Delivery
// ============================================================================

export async function deliverTelegram(message: string): Promise<void> {
  try {
    const telegramPath = join(KAYA_HOME, "skills", "Telegram", "Tools", "TelegramClient.ts");
    if (existsSync(telegramPath)) {
      const proc = Bun.spawn(
        ["bun", telegramPath, "send", message],
        { stdout: "ignore", stderr: "ignore" }
      );
      await proc.exited;
      console.log("Telegram delivered");
    } else {
      console.log("Telegram skipped (client not found)");
    }
  } catch (e) {
    console.error("Telegram delivery failed:", e);
  }
}
