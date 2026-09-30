/**
 * CalendarWriteLog.ts — one structured audit log for every calendar WRITE,
 * regardless of which code path performed it.
 *
 * calassist-overhaul-20260702 (S5) unifies the calendar seam, but ADR-006
 * (skills do not cross-import each other's Tools/) means there are still TWO
 * write code paths:
 *   - skills/Productivity/CalendarAssistant/Tools/GoogleCalendarAdapter.ts
 *     (CalendarAssistant-internal: scheduler + LucidTasks' pre-existing
 *     cross-import exception)
 *   - lib/core/GcalCli.ts (the shared, downward-importable seam for
 *     EventScout/Actions.ts and LifeOS/Capture/Router.ts)
 *
 * Rather than duplicate the same ~10-line "append one JSONL line" logic in
 * both, this tiny lib/core module is the ONE place either path calls into —
 * "one auditable seam for ALL writes" (Jm grill decision #6) means one log
 * file and one writer, not necessarily one call path.
 *
 * Primary-calendar writes stay AUTOMATIC (no approval gate, no allowlist) —
 * this module is pure observability, never a gate. Logging failures must
 * never break the calendar write they're recording.
 *
 * @module CalendarWriteLog
 */

import { kayaHomePath } from "./KayaHome.ts";
import { createAppendLog } from "./AppendLog.ts";

export interface CalendarWriteLogEntry {
  timestamp: string;
  target: string;
  caller: string;
  title: string;
  outcome: string;
}

export type CalendarWriteLogInput = Omit<CalendarWriteLogEntry, "timestamp">;

/**
 * Canonical log location: <KAYA_HOME>/skills/Productivity/CalendarAssistant/Data/calendar-writes.jsonl.
 * Resolved via getKayaHome() (KAYA_HOME/KAYA_DIR override honored) — never hardcoded,
 * so tests and alternate installs land somewhere other than the live tree.
 */
export function defaultCalendarWriteLogPath(): string {
  return kayaHomePath("skills/Productivity/CalendarAssistant/Data/calendar-writes.jsonl");
}

/**
 * Append one structured JSONL line recording a calendar write attempt.
 * Called for BOTH successful and failed writes — the seam is auditable
 * regardless of outcome. Never throws: a broken log path must not fail the
 * calendar write it's describing (logged loudly to console.error instead).
 */
export function logCalendarWrite(
  entry: CalendarWriteLogInput,
  opts: { logPath?: string } = {}
): void {
  const logPath = opts.logPath ?? defaultCalendarWriteLogPath();
  const line: CalendarWriteLogEntry = { timestamp: new Date().toISOString(), ...entry };
  try {
    // createAppendLog() (lib/core/AppendLog.ts) rather than raw appendFileSync —
    // gives rotation/retention for free on what will be an ever-growing log,
    // and satisfies the repo's no-raw-append lint gate. append() throws on
    // failure by design; caught here so a broken log path never fails the
    // calendar write it's describing.
    createAppendLog(logPath).append(line);
  } catch (err) {
    console.error(
      `logCalendarWrite: failed to append audit log at ${logPath}: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}
