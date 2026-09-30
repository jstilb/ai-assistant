/**
 * GcalCli.ts — shared adapter for gcalcli operations (agenda / add / delete),
 * invoked via the `kaya-cli gcal` passthrough (kaya-cli's `gcal` service is a
 * pure `exec /opt/homebrew/bin/gcalcli "$@"` — see bin/kaya-cli's
 * `calendar_cmd()`), so this module's callers get identical stdout/exit-code
 * behavior to calling gcalcli directly.
 *
 * WHY THIS EXISTS (S14): three skills each hand-rolled gcalcli invocations by
 * building a SHELL STRING and running it via `execSync` — quoting values with
 * `JSON.stringify(s)`. That is NOT shell-safe: bash still expands `$(...)` and
 * backticks *inside double-quoted strings*, so a hostile event title like
 * `$(rm -rf ~)` would be command-substituted by the shell before gcalcli ever
 * saw it. This module never invokes a shell — `execFileSync` spawns the
 * binary directly with an argv array, so arbitrary strings (titles,
 * descriptions, search text) are always inert, literal arguments.
 *
 * Consumers (S14):
 *   - skills/Productivity/DailyBriefing/Tools/CalendarBlock.ts   → agenda()
 *   - skills/Productivity/EventScout/Tools/Actions.ts            → addEvent(), deleteEvent()
 *   - skills/Productivity/LifeOS/Capture/Router.ts               → addEvent()
 *
 * Relationship to skills/Productivity/CalendarAssistant/Tools/GoogleCalendarAdapter.ts:
 *   That adapter is skill-local to CalendarAssistant (its own scoped-calendar
 *   caching/health-check logic for the autonomous scheduler) and per ADR-006
 *   skills do not cross-import each other's Tools/. This module is the
 *   lib/core (shared, downward-importable) counterpart for the three *other*
 *   skills above — not a replacement for GoogleCalendarAdapter.ts.
 *
 * All operations are synchronous (execFileSync), matching every pre-S14 call
 * site — none of them were async internally (EventScout's addToCalendar/
 * deleteCalendarEvent are `async function`s that made a *synchronous*
 * execSync call inside; LifeOS Router's WritePlan.write() is a synchronous
 * closure). Keeping this adapter synchronous avoids changing any of those
 * call sites' signatures.
 *
 * calassist-overhaul-20260702 (S5): addEvent()/deleteEvent() now record every
 * write attempt (success or failure) via lib/core/CalendarWriteLog.ts — the
 * same shared audit seam GoogleCalendarAdapter.ts's createEvent/deleteEvent
 * use — so primary-calendar writes from EventScout/LifeOS are auditable too.
 * Pass `caller` (e.g. "EventScout.Actions.addToCalendar") on every call site;
 * it defaults to "unknown" but new call sites should always set it.
 */

import { execFileSync } from "child_process";
import { join } from "path";
import { getKayaHome } from "./KayaHome.ts";
import { logCalendarWrite } from "./CalendarWriteLog.ts";

// ============================================================================
// kaya-cli path resolution
// ============================================================================

/**
 * Canonical kaya-cli binary path: <KAYA_HOME>/bin/kaya-cli.
 *
 * Pre-S14, EventScout/Actions.ts and LifeOS/Router.ts each hardcoded the
 * literal string "~/.claude/bin/kaya-cli". Resolving through
 * getKayaHome() means KAYA_HOME/KAYA_DIR overrides (used by tests and
 * alternate installs) are honored instead of silently pointing at Jm's
 * personal machine path.
 */
export function resolveKayaCliPath(): string {
  return join(getKayaHome(), "bin", "kaya-cli");
}

// ============================================================================
// Exec seam — real execFileSync by default, injectable for tests
// ============================================================================

/** (file, argv) → stdout. Throws on nonzero exit, exactly like execFileSync. */
export type GcalExecFn = (file: string, args: string[]) => string;

export interface GcalCliDeps {
  /** Override the kaya-cli binary path. Defaults to resolveKayaCliPath(). */
  kayaCliPath?: string;
  /** Override the exec function — tests inject a fake to capture argv without spawning a real process. */
  execImpl?: GcalExecFn;
  /** Optional timeout in ms, forwarded to execFileSync (default: none, matching pre-S14 behavior except CalendarBlock's agenda, which passed 10s). */
  timeoutMs?: number;
}

function runGcal(subArgs: string[], deps: GcalCliDeps = {}): string {
  const kayaCliPath = deps.kayaCliPath ?? resolveKayaCliPath();
  if (deps.execImpl) return deps.execImpl(kayaCliPath, ["gcal", ...subArgs]);
  return execFileSync(kayaCliPath, ["gcal", ...subArgs], {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
    ...(deps.timeoutMs !== undefined ? { timeout: deps.timeoutMs } : {}),
  });
}

// ============================================================================
// agenda — DailyBriefing/CalendarBlock.ts
// ============================================================================

export interface AgendaOptions extends GcalCliDeps {
  /** --calendar flags, repeated once per entry, injected as GLOBAL flags BEFORE the subcommand (gcalcli requirement). */
  calendars?: string[];
  /** --nocolor flag. Default true (every pre-S14 call site passed it). */
  nocolor?: boolean;
}

/** Pure argv builder — exported so the shell-injection regression test can assert on it directly. */
export function buildAgendaArgs(start: string, end: string, opts: AgendaOptions = {}): string[] {
  const args: string[] = [];
  for (const cal of opts.calendars ?? []) args.push("--calendar", cal);
  args.push("agenda", start, end);
  if (opts.nocolor !== false) args.push("--nocolor");
  return args;
}

/**
 * Run `gcalcli agenda <start> <end>` (via kaya-cli gcal). Returns stdout.
 * Throws on any exec failure — CalendarBlock.ts keeps its existing
 * `try { ... } catch { stdout = "[]"; }` at the call site, which now catches
 * this instead of a failed shell `2>/dev/null || echo "[]"` — same net result.
 */
export function agenda(start: string, end: string, opts: AgendaOptions = {}): string {
  return runGcal(buildAgendaArgs(start, end, opts), opts);
}

// ============================================================================
// add — EventScout/Actions.ts (addToCalendar) + LifeOS/Router.ts (planDecision, planCalendar)
// ============================================================================

export interface AddEventOptions extends GcalCliDeps {
  calendar: string;
  title: string;
  when: string;
  duration: number; // minutes
  where?: string;
  description?: string;
  /** --noprompt flag. Default true (every pre-S14 call site passed it). */
  noprompt?: boolean;
  /**
   * Caller identity recorded in the structured write-audit log (calassist-overhaul
   * S5), e.g. "EventScout.Actions.addToCalendar". Defaults to "unknown" if
   * omitted — always pass a real value for new call sites.
   */
  caller?: string;
  /** Override the audit-log path. Defaults to CalendarWriteLog's canonical location — tests must always pass this to avoid polluting the live log. */
  logPath?: string;
}

export function buildAddEventArgs(opts: AddEventOptions): string[] {
  const args: string[] = ["add"];
  if (opts.noprompt !== false) args.push("--noprompt");
  args.push("--calendar", opts.calendar);
  args.push("--title", opts.title);
  args.push("--when", opts.when);
  args.push("--duration", String(opts.duration));
  if (opts.where) args.push("--where", opts.where);
  if (opts.description) args.push("--description", opts.description);
  return args;
}

/**
 * Run `gcalcli add ...` (via kaya-cli gcal). Throws on failure — callers keep
 * their existing catch/error-wrapping.
 *
 * calassist-overhaul S5: every write attempt (success or failure) is recorded
 * via lib/core/CalendarWriteLog.ts — the same shared audit seam
 * GoogleCalendarAdapter.ts's createEvent uses — so EventScout/LifeOS
 * primary-calendar writes are auditable too. Logging never swallows the
 * original error: on failure we log then rethrow.
 */
export function addEvent(opts: AddEventOptions): void {
  try {
    runGcal(buildAddEventArgs(opts), opts);
    logCalendarWrite(
      { target: opts.calendar, caller: opts.caller ?? "unknown", title: opts.title, outcome: "success" },
      { logPath: opts.logPath }
    );
  } catch (err) {
    logCalendarWrite(
      {
        target: opts.calendar,
        caller: opts.caller ?? "unknown",
        title: opts.title,
        outcome: `error:${err instanceof Error ? err.message.slice(0, 200) : String(err)}`,
      },
      { logPath: opts.logPath }
    );
    throw err;
  }
}

// ============================================================================
// delete — EventScout/Actions.ts (deleteCalendarEvent)
// ============================================================================

export interface DeleteEventOptions extends GcalCliDeps {
  text: string;
  startDate: string;
  endDate: string;
  calendar: string;
  /** --iamaexpert flag (skips gcalcli's interactive delete confirmation). Default true. */
  iamaexpert?: boolean;
  /**
   * Caller identity recorded in the structured write-audit log (calassist-overhaul
   * S5), e.g. "EventScout.Actions.deleteCalendarEvent". Defaults to "unknown" if
   * omitted — always pass a real value for new call sites.
   */
  caller?: string;
  /** Override the audit-log path. Defaults to CalendarWriteLog's canonical location — tests must always pass this to avoid polluting the live log. */
  logPath?: string;
}

export function buildDeleteEventArgs(opts: DeleteEventOptions): string[] {
  const args: string[] = ["delete", opts.text, opts.startDate, opts.endDate, "--calendar", opts.calendar];
  if (opts.iamaexpert !== false) args.push("--iamaexpert");
  return args;
}

/**
 * Run `gcalcli delete ...` (via kaya-cli gcal). Throws on failure — callers
 * keep their existing catch/error-wrapping.
 *
 * calassist-overhaul S5: every write attempt (success or failure) is recorded
 * via lib/core/CalendarWriteLog.ts (see addEvent()'s docstring for rationale).
 * `title` in the log entry is `opts.text` — the delete search term is the
 * closest analogue to a title for this operation.
 */
export function deleteEvent(opts: DeleteEventOptions): void {
  try {
    runGcal(buildDeleteEventArgs(opts), opts);
    logCalendarWrite(
      { target: opts.calendar, caller: opts.caller ?? "unknown", title: opts.text, outcome: "success" },
      { logPath: opts.logPath }
    );
  } catch (err) {
    logCalendarWrite(
      {
        target: opts.calendar,
        caller: opts.caller ?? "unknown",
        title: opts.text,
        outcome: `error:${err instanceof Error ? err.message.slice(0, 200) : String(err)}`,
      },
      { logPath: opts.logPath }
    );
    throw err;
  }
}
