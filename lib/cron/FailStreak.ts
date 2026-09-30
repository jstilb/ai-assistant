/**
 * FailStreak — per-jobId consecutive-"bug"-failure counter for
 * run-cron-job.ts.
 *
 * WHY: the 2026-07-03/07-07 appusage-nightly incident — a DuckDB SIGTRAP
 * crash (see Db.ts's transaction() doc) — fired on THREE separate nightly
 * cron invocations, each one independently crashing and retrying, burning
 * ~7h with nobody paged. RetryRunner already retries transient/timeout/
 * environment failures WITHIN one invocation (see FailureClassifier.ts), but
 * nothing tracked a deterministic 'bug'-class failure RECURRING ACROSS
 * separate invocations. This module closes that gap: it clones the
 * heal-streak counter pattern from bin/kaya-bot-liveness.sh's
 * bump_streak_and_maybe_page() (a per-label consecutive-needs-healing
 * counter that pages via AlertGate once a threshold is hit), generalized
 * from one hardcoded launchd label to any cron jobId.
 *
 * 'bug'-class failures, and (2026-07-20 widening) NON-sleep-inflated
 * 'timeout'-class failures, count toward the streak — 'transient' has its
 * own in-run retry, 'environment' is handled by the network-precondition
 * path, and 'auth' has its own TokenHealth alerting. A sleep-inflated
 * timeout (sleptThrough=true) never bumps the streak — a machine that was
 * merely asleep is not evidence of a chronic bug, and run-cron-job.ts's own
 * deferred-run branch already treats those as 'deferred', not 'failure',
 * whenever the job is reconciler-eligible; this widening only reaches
 * jobs that are NOT reconciler-eligible and therefore still flow through
 * this function as an ordinary 'failure'. A 'bug' (or a genuine non-sleep
 * 'timeout') recurring unchanged across independent invocations is exactly
 * the "blind retry loop is not fixing this" signal worth paging on. ANY
 * other outcome (success, or a non-escalatable failure) resets the streak —
 * "consecutive" means uninterrupted by a different outcome, so the page only
 * fires for the SAME deterministic problem recurring, not an unrelated blip
 * sandwiched between two real failures.
 *
 * State file: MEMORY/State/<jobId>-fail-streak.count (bare integer, one
 * line). Path resolved via memPath() at call time — same KAYA_HOME-aware,
 * test-isolation convention as every other cron module (RunLedger.ts,
 * FailureLog.ts).
 */

import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname } from 'path';
import { memPath } from '../core/MemoryPaths.ts';
import { sendAlert, type AlertResult } from '../core/AlertGate.ts';
import type { FailureClass } from './FailureClassifier.ts';
import type { RunOutcome } from './RunLedger.ts';

export const HEAL_ESCALATE_THRESHOLD = 3;

function streakPath(jobId: string): string {
  return memPath('State', `${jobId}-fail-streak.count`);
}

/**
 * Read the current streak for `jobId`. Never throws — a missing or
 * unreadable/corrupt state file reads as a clean streak of 0 (matches
 * RunLedger.ts's "malformed data is skipped rather than thrown on"
 * convention), not an error.
 */
export function readFailStreak(jobId: string): number {
  try {
    const raw = readFileSync(streakPath(jobId), 'utf-8').trim();
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  } catch {
    return 0; // no file yet, or unreadable — treat as a clean streak
  }
}

/**
 * Best-effort write. Mirrors appendRunLedger()'s try/catch-swallow style — a
 * streak-file write must never fail the cron job it's tracking.
 */
export function writeFailStreak(jobId: string, n: number): void {
  try {
    const p = streakPath(jobId);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, String(n), 'utf-8');
  } catch {
    // intentionally silent: best-effort — a streak-file write failure must
    // never fail the cron job itself. Next run just re-derives from 0.
  }
}

export type FailStreakResult =
  | { action: 'reset' }
  | { action: 'below-threshold'; streak: number }
  | { action: 'paged'; streak: number; alertResult: AlertResult };

/**
 * Call once per completed run, after outcome/failureClass are known (see
 * run-cron-job.ts's call site, right after `outcome` is computed). Returns
 * what happened so the caller can log it.
 *
 * `sendAlertFn` is injectable for tests (default: the real AlertGate bridge,
 * `sendAlert` from core/AlertGate.ts — honors KAYA_ALERT_DRY_RUN=1). Async
 * (T2-01): `sendAlert`/`AlertGate.send()` became async so the page tier can
 * await real delivery confirmation before stamping AlertGate's own cooldown;
 * this function stays a thin pass-through, so it must await it too rather
 * than serialize an un-awaited Promise into the caller's forensic ledger.
 *
 * `sleptThrough` (2026-07-20 widening, Jm decision): true when THIS run's
 * timeout was sleep-inflated (see JobSpawner.ts's `sleptThrough`, only ever
 * true when the failure is also 'timeout'). Only affects the 'timeout'
 * branch of the escalation predicate below — every other class is unchanged.
 */
export async function trackFailStreak(
  jobId: string,
  outcome: RunOutcome,
  failureClass: FailureClass | undefined,
  sendAlertFn: typeof sendAlert = sendAlert,
  sleptThrough?: boolean,
): Promise<FailStreakResult> {
  const isEscalatable =
    outcome === 'failure' &&
    (failureClass === 'bug' || (failureClass === 'timeout' && !sleptThrough));
  if (!isEscalatable) {
    writeFailStreak(jobId, 0);
    return { action: 'reset' };
  }

  const streak = readFailStreak(jobId) + 1;
  writeFailStreak(jobId, streak);
  if (streak < HEAL_ESCALATE_THRESHOLD) {
    return { action: 'below-threshold', streak };
  }

  const alertResult = await sendAlertFn(
    `Cron job '${jobId}' has failed with a '${failureClass}'-class error ${streak} consecutive times in a row — ` +
      `a blind retry loop will not fix this; needs investigation.`,
    { key: `cron-fail-streak-${jobId}`, tier: 'page' },
  );
  return { action: 'paged', streak, alertResult };
}

/**
 * trackHealStreak — generalized, binary-outcome sibling of trackFailStreak()
 * (T2-04 consolidation, theme2-failstreak-dedup.md §5 A1). trackFailStreak()'s
 * signature is shaped around a classified cron RunOutcome/FailureClass and a
 * fixed message template; the 3 bash heal-streak watchdogs
 * (kaya-bot-liveness.sh, kaya-lucidtasks-board-liveness.sh,
 * kaya-plist-guard.sh) have a simpler binary domain ("did this check need
 * healing or not") and each embeds its own human-useful, per-symptom reason
 * in the page message — forcing them onto trackFailStreak() as-is would lose
 * that diagnostic detail behind a fixed "'bug'-class error" wording. This
 * export reuses the same readFailStreak/writeFailStreak/
 * HEAL_ESCALATE_THRESHOLD machinery with a caller-supplied message builder
 * instead, so each watchdog keeps its own exact wording. Purely additive:
 * trackFailStreak() itself is untouched, so every existing cron caller/test
 * is unaffected.
 *
 * `target` is the streak-state key (state file:
 * MEMORY/State/<target>-fail-streak.count, via the same streakPath()/
 * memPath() convention as cron jobIds — deliberately a NEW file per watchdog,
 * distinct from each script's old hand-rolled `<label>-heal-streak.count`
 * name, since this is a genuine consolidation onto one shared file
 * convention, not a compatibility shim).
 *
 * `alertKey` is passed straight through to AlertGate as `options.key` —
 * callers pass each watchdog's ORIGINAL AlertGate key verbatim (e.g.
 * `bot-liveness-heal-streak`) so existing alert-gate.json cooldown history
 * for that key isn't orphaned by the migration.
 *
 * `buildMessage(streak)` is only invoked once the threshold is reached (never
 * called for a reset or a below-threshold bump), so callers can defer
 * interpolating the final streak count into their own message template.
 */
/**
 * `cooldownMs` (optional, added for T2-03): passed straight through to
 * AlertGate's SendAlertOptions when defined. Omitted (the default for every
 * EXISTING caller — the 3 bash heal-streak scripts via
 * bin/heal-streak-report.ts, which never passed one before this parameter
 * existed) preserves today's behavior exactly: AlertGate.shouldPage() falls
 * back to its own DEFAULT_COOLDOWN_MS (24h, lib/core/AlertGate.ts:200) —
 * unchanged for those 3 watchdogs. Only a caller that explicitly wants a
 * shorter cooldown (e.g. T2-03's 30-min interactive-auth-incident, matching
 * bin/cron-health-monitor.ts's pageAuthIncident() convention) passes it.
 */
export async function trackHealStreak(
  target: string,
  needsHealing: boolean,
  buildMessage: (streak: number) => string,
  alertKey: string,
  cooldownMs?: number,
  sendAlertFn: typeof sendAlert = sendAlert,
): Promise<FailStreakResult> {
  if (!needsHealing) {
    writeFailStreak(target, 0);
    return { action: 'reset' };
  }

  const streak = readFailStreak(target) + 1;
  writeFailStreak(target, streak);
  if (streak < HEAL_ESCALATE_THRESHOLD) {
    return { action: 'below-threshold', streak };
  }

  const alertResult = await sendAlertFn(buildMessage(streak), {
    key: alertKey,
    tier: 'page',
    ...(cooldownMs !== undefined ? { cooldownMs } : {}),
  });
  return { action: 'paged', streak, alertResult };
}

function windowStartPath(target: string): string {
  return memPath('State', `${target}-fail-streak.window-start`);
}

function readWindowStart(target: string): number | undefined {
  try {
    const raw = readFileSync(windowStartPath(target), 'utf-8').trim();
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : undefined;
  } catch {
    return undefined;
  }
}

function writeWindowStart(target: string, ms: number | undefined): void {
  try {
    const p = windowStartPath(target);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, ms === undefined ? '' : String(ms), 'utf-8');
  } catch (err) {
    // NOT fail-toward-safe like readWindowStart()'s catch: a swallowed WRITE
    // here means the rolling window never persists, so
    // trackWindowedHealStreak() either never accumulates to threshold or
    // resets wrongly on the next call — the auth-streak escalation this
    // slice exists to add would go quiet with no trace. Breadcrumb only
    // (never throw — a state-file write must still never fail the caller),
    // but loud, since this fires only on a genuine write failure, never on a
    // healthy run.
    console.error(`[FailStreak] writeWindowStart('${target}') failed:`, err);
  }
}

/**
 * trackWindowedHealStreak — trackHealStreak() with a rolling TIME window
 * instead of pure "reset on the next non-qualifying call" semantics (T2-03,
 * theme2-auth-failure-paging.md §5). Built for a class-level signal with no
 * natural "next run" boundary to reset against — StopFailure.hook.ts's
 * authentication_failed events carry no session continuity (a burst of 16
 * DIFFERENT session_ids inside one minute is the live-observed shape this
 * was built from; see that doc's Finding), so a plain trackHealStreak()
 * consecutive counter would work, but with no bound on how far apart two
 * "consecutive" occurrences can be — a stale blip weeks apart could silently
 * prime a false escalation once a third, unrelated one finally landed.
 *
 * Semantics: if `isQualifying` and more than `windowMs` has passed since the
 * FIRST qualifying event of the current streak, the streak resets to 0
 * before this event is counted — "N within any `windowMs` span," not pure
 * infinite-consecutive. A non-qualifying call clears both the counter and
 * the window, identically to trackHealStreak()'s ordinary reset.
 *
 * Purely additive: does not touch trackFailStreak() or trackHealStreak().
 */
/**
 * `cooldownMs` — same optional pass-through as trackHealStreak()'s (see its
 * doc); omitted, this falls back to AlertGate's own 24h DEFAULT_COOLDOWN_MS.
 * StopFailure.hook.ts's interactive-auth-incident call passes 30 * 60 * 1000
 * (T2-03 §5), matching bin/cron-health-monitor.ts's pageAuthIncident()
 * cooldown convention.
 */
export async function trackWindowedHealStreak(
  target: string,
  isQualifying: boolean,
  windowMs: number,
  buildMessage: (streak: number) => string,
  alertKey: string,
  cooldownMs?: number,
  sendAlertFn: typeof sendAlert = sendAlert,
  nowMs: number = Date.now(),
): Promise<FailStreakResult> {
  if (!isQualifying) {
    writeWindowStart(target, undefined);
    return trackHealStreak(target, false, buildMessage, alertKey, cooldownMs, sendAlertFn);
  }

  const windowStart = readWindowStart(target);
  const windowExpired = windowStart === undefined || nowMs - windowStart > windowMs;
  if (windowExpired) {
    writeFailStreak(target, 0); // new window -> fresh streak
    writeWindowStart(target, nowMs);
  }

  return trackHealStreak(target, true, buildMessage, alertKey, cooldownMs, sendAlertFn);
}
