/**
 * ActivationLogger.ts - Append-only logger for strategy-activation cron events
 *
 * Six activation cron jobs (activation-s0-boredom, s3, s4, s5, s6, s8) invoke this
 * as `bun ActivationLogger.ts log <strategyId> <type> <message>` to record that a
 * scheduled nudge fired. Entries are appended to MEMORY/ACTIVATION/activation-log.jsonl.
 *
 * Line schema (stable, validated against 97+ historical entries):
 *   { timestamp: ISO-8601, strategyId: string, type: string, message: string }
 */

import { join } from "path";
import { createAppendLog } from "../../../../lib/core/AppendLog.ts";
import { getKayaHome } from "../../../../lib/core/KayaHome.ts";

const KAYA_HOME = getKayaHome(); // was KAYA_DIR-only; getKayaHome() superset
const ACTIVATION_LOG = join(KAYA_HOME, "MEMORY", "ACTIVATION", "activation-log.jsonl");
const activationLog = createAppendLog(ACTIVATION_LOG);

export interface ActivationEntry {
  timestamp: string;
  strategyId: string;
  type: string;
  message: string;
}

/**
 * Append a single activation event to activation-log.jsonl.
 * Returns the entry that was written (timestamp filled in if not supplied).
 */
export function logActivation(
  strategyId: string,
  type: string,
  message: string,
  timestamp: string = new Date().toISOString(),
): ActivationEntry {
  const entry: ActivationEntry = { timestamp, strategyId, type, message };
  activationLog.append(entry);
  return entry;
}

// ============================================================================
// CLI: bun ActivationLogger.ts log <strategyId> <type> <message>
// ============================================================================

if (import.meta.main) {
  const [command, strategyId, type, ...messageParts] = process.argv.slice(2);

  if (command !== "log") {
    console.error(`Unknown command: ${command ?? "(none)"}`);
    console.error('Usage: bun ActivationLogger.ts log <strategyId> <type> <message>');
    process.exit(1);
  }

  const message = messageParts.join(" ");
  if (!strategyId || !type || !message) {
    console.error("Missing argument(s).");
    console.error('Usage: bun ActivationLogger.ts log <strategyId> <type> <message>');
    process.exit(1);
  }

  const entry = logActivation(strategyId, type, message);
  console.log(`Logged activation: ${entry.strategyId}/${entry.type} @ ${entry.timestamp}`);
}
