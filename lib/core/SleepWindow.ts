/**
 * SleepWindow — parses `sysctl -n kern.sleeptime kern.waketime` output into
 * the most-recent sleep/wake timestamps, for measurement-based sleep-window
 * detection. Consumed by the cron health monitor, JobSpawner, the Telegram
 * bot, and bash scripts (via the CLI below) — hence lib/core/, not lib/cron/.
 *
 * Root cause this exists for: on 2026-07-11 an unplugged MacBook slept
 * through cron runs and the health monitor paged Jm 7 times overnight,
 * because nothing checked whether the machine had actually been asleep.
 *
 * `sysctl -n kern.sleeptime kern.waketime` output looks like (two lines,
 * sleeptime first, then waketime):
 *   { sec = 1783886881, usec = 544220 } Sun Jul 12 13:08:01 2026
 *   { sec = 1783886899, usec = 985436 } Sun Jul 12 13:08:19 2026
 *
 * `sec = 0` means the machine has not slept/woken since boot — treated as
 * no evidence (null), not epoch-0.
 *
 * Deliberately injectable: every exported function takes an optional
 * `execFn` so tests never spawn a real `sysctl` process. Mirrors
 * PowerState.ts's injectable-spawn shape and never-throws contract.
 */

export type ExecSysctl = () => string;

export interface LastSleepWake {
  lastSleepAtMs: number | null;
  lastWakeAtMs: number | null;
}

// Absolute path, NOT a bare 'sysctl': sysctl lives in /usr/sbin, which the
// launchd cron plists' PATH does not include — a bare name makes
// Bun.spawnSync throw ENOENT in every cron wrapper, silently reducing all
// sleep detection to "no evidence" (the 2026-07-21/27/31 daily-briefing
// failures: runs the machine slept through burned 3 timeout attempts
// instead of deferring, because this probe never executed).
const SYSCTL_BIN = '/usr/sbin/sysctl';

const defaultExec: ExecSysctl = () => {
  return Bun.spawnSync([SYSCTL_BIN, '-n', 'kern.sleeptime', 'kern.waketime']).stdout.toString();
};

/** Parses a `sec = (\d+)` value out of one sysctl output line. `sec = 0` (never slept/woken since boot) is null. */
function parseSecLine(line: string | undefined): number | null {
  if (!line) return null;
  const match = line.match(/sec\s*=\s*(\d+)/);
  if (!match) return null;
  const sec = parseInt(match[1]!, 10);
  if (sec === 0) return null;
  return sec * 1000;
}

/**
 * Parse `sysctl -n kern.sleeptime kern.waketime`-shaped output (via
 * injectable execFn) into the most-recent sleep/wake timestamps. Never
 * throws: any exec failure or unparseable output falls back to
 * { lastSleepAtMs: null, lastWakeAtMs: null }.
 */
export function getLastSleepWake(execFn: ExecSysctl = defaultExec): LastSleepWake {
  let raw: string;
  try {
    raw = execFn();
  } catch {
    return { lastSleepAtMs: null, lastWakeAtMs: null };
  }

  const lines = raw.split('\n').filter((line) => line.trim().length > 0);
  const lastSleepAtMs = parseSecLine(lines[0]);
  const lastWakeAtMs = parseSecLine(lines[1]);

  return { lastSleepAtMs, lastWakeAtMs };
}

/**
 * The most-recent sleep interval implied by getLastSleepWake, or null if
 * there's no sleep evidence at all. If wake is missing or precedes sleep,
 * the machine is (or was last known) in a sleep that hasn't ended: an open
 * interval [lastSleepAtMs, +Infinity).
 */
function lastSleepInterval(execFn: ExecSysctl = defaultExec): { start: number; end: number } | null {
  const { lastSleepAtMs, lastWakeAtMs } = getLastSleepWake(execFn);
  if (lastSleepAtMs === null) return null;
  if (lastWakeAtMs === null || lastWakeAtMs < lastSleepAtMs) {
    return { start: lastSleepAtMs, end: Infinity };
  }
  return { start: lastSleepAtMs, end: lastWakeAtMs };
}

/**
 * True iff there's sleep evidence AND the most-recent sleep interval
 * overlaps [startMs, endMs]. No evidence → false (callers keep their own
 * fallbacks).
 */
export function sleptDuringWindow(startMs: number, endMs: number, execFn: ExecSysctl = defaultExec): boolean {
  const interval = lastSleepInterval(execFn);
  if (interval === null) return false;
  return interval.start <= endMs && interval.end >= startMs;
}

/**
 * True iff lastSleepAtMs is present and >= sinceMs. No evidence → false.
 * (A present sleep with a null/missing wake still counts as "slept since".)
 */
export function sleptSince(sinceMs: number, execFn: ExecSysctl = defaultExec): boolean {
  const { lastSleepAtMs } = getLastSleepWake(execFn);
  return lastSleepAtMs !== null && lastSleepAtMs >= sinceMs;
}

/**
 * True iff the machine has been awake for at least `ms`.
 * - No sleep evidence at all → true (awake since boot, as far as we can measure).
 * - Open sleep interval (still asleep / wake missing) → false.
 * - Otherwise → (nowMs - lastWakeAtMs) >= ms.
 * - On exec failure → true (fail-open: a broken sysctl must not hold the
 *   morning digest hostage forever; the monitor's other guards still apply).
 */
export function stableAwakeFor(ms: number, nowMs: number = Date.now(), execFn: ExecSysctl = defaultExec): boolean {
  // getLastSleepWake never throws — exec failure already surfaces as
  // lastSleepAtMs === null, which the branch below treats as "no evidence"
  // → true (fail-open), satisfying the exec-failure contract for free.
  const { lastSleepAtMs, lastWakeAtMs } = getLastSleepWake(execFn);
  if (lastSleepAtMs === null) return true;
  if (lastWakeAtMs === null || lastWakeAtMs < lastSleepAtMs) return false;
  return nowMs - lastWakeAtMs >= ms;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const sinceIdx = args.indexOf('--slept-since');

  if (sinceIdx === -1 || !args[sinceIdx + 1]) {
    console.error('Usage: bun lib/core/SleepWindow.ts --slept-since <epochMs>');
    process.exit(1);
  }

  const sinceMs = Number(args[sinceIdx + 1]);
  if (Number.isNaN(sinceMs)) {
    console.error(`Invalid epochMs: ${args[sinceIdx + 1]}`);
    process.exit(1);
  }

  console.log(sleptSince(sinceMs) ? 'true' : 'false');
}
