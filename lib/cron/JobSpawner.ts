/**
 * JobSpawner — the ONE shared spawn+timeout+classify primitive for running a
 * cron job's underlying process.
 *
 * Extracted from bin/run-cron-job.ts's original inline `spawnOnce()` (S3
 * item 4/B4) so the in-process daemon's job executor — which duplicated the
 * same Bun.spawn/timeout/kill-group logic by hand — could delegate to this
 * instead of maintaining a second, drifting copy. See S3 item 2 ("retire the
 * duplicate engine"). The daemon (and its job executor) was deleted outright
 * in slice D1 (2026-07-03) — bin/run-cron-job.ts is now this module's only
 * caller.
 *
 * Deliberately pure I/O glue, no retry/wake-lock/ledger concerns layered in
 * — those stay in the callers (run-cron-job.ts's runWithRetry loop, its
 * wake-lock acquire/release, its RunLedger append). This module only knows
 * how to spawn one process, enforce one timeout, and classify one result.
 */

import { classifyFailure, type FailureClass } from './FailureClassifier';
import { sleptDuringWindow } from '../core/SleepWindow';

export interface SpawnJobOptions {
  /** Full argv, e.g. [claudeBin, '-p', prompt, ...] or [command, ...args]. */
  spawnArgs: string[];
  /** Working directory for the spawned process. */
  cwd: string;
  /** Environment variables for the spawned process (already fully resolved by the caller). */
  env: Record<string, string | undefined>;
  /** Timeout in ms before the process (and its group) is killed. */
  timeout: number;
  /**
   * Exit codes this attempt treats as success. Defaults to [0]. Exists for
   * detector-style jobs (scheduler-watchdog, token-health-sentinel) that
   * exit 1 BY DESIGN when they detect a problem — they self-page via
   * AlertGate rather than relying on the cron layer's failure path. Without
   * this, every detection got misclassified as a 'bug'-class cron failure
   * (see lib/cron/JobSpec.ts's expectedExitCodes doc, remediation-s1s5 A2).
   */
  expectedExitCodes?: number[];
  /** Called once if the timeout fires, before the kill signals are sent. */
  onTimeout?: () => void;
  /**
   * Called synchronously with the spawned process immediately after spawn,
   * so a caller can track it (e.g. the daemon's runningProcesses map) without
   * maintaining its own duplicate Bun.spawn. The proc is owned by spawnJob;
   * callers must NOT await/kill it themselves — use onTimeout for cancellation.
   */
  onSpawn?: (proc: ReturnType<typeof Bun.spawn>) => void;
  /**
   * Injectable measurement-based sleep-window check, default
   * `SleepWindow.sleptDuringWindow`. Composed via `||` with the wall-ratio
   * heuristic (`isSleepInflated`) at the sleptThrough call site below: the
   * 2026-07-11 incident (957s wall / 900s timeout = 1.06x) proved the
   * wall-ratio check alone misses lockstep timer suspension, where the
   * process's own timers are suspended right along with the timeout timer so
   * wall-clock never balloons past the ratio threshold even though the
   * machine genuinely slept mid-attempt. Injectable purely for tests — real
   * callers get the real sysctl-backed measurement for free.
   */
  sleptDuringWindowFn?: (startMs: number, endMs: number) => boolean;
}

export interface SpawnJobResult {
  success: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** Wall-clock ms from spawn to process exit (Date.now(), spans machine sleep). */
  wallMs: number;
  /**
   * True when the attempt timed out AND its wall-clock lifetime is so far
   * beyond the timeout budget that the process must have been suspended
   * mid-run (see isSleepInflated) — the machine slept, the job wasn't slow.
   */
  sleptThrough: boolean;
  failureClass?: FailureClass;
}

/**
 * Sleep-inflation detector: a timed-out attempt whose wall-clock lifetime
 * wildly exceeds its timeout budget was suspended mid-run, not slow.
 *
 * Evidence (2026-07-08/09 nights): the MacBook lid-closed on battery gets
 * only 2-8s DarkWake slivers every ~16min, so maintenance-daily's
 * 600_000ms-timeout attempts consistently showed ~1_000_000ms+ wall-clock
 * (>=1.67x) before the timer fired — while an awake timeout-kill costs
 * timeout + 5s SIGTERM grace + stream drain, well under 1.5x for any real
 * job timeout. The +1000ms floor keeps sub-second test timeouts from
 * tripping on the fixed 5s grace period alone unless a test intends to.
 *
 * ABSOLUTE_SLOP_MS (remediation-p1p5 E2, 2026-07-21): the pure ratio check
 * above dilutes below its own 1.5x threshold as the timeout grows. The SAME
 * ~15-20min system-wide DarkWake stall that cleanly tripped
 * maintenance-daily's 10-min timeout (1.61-1.86x, correctly deferred) and
 * knowledge-daily's 20-min timeout (2.87x, correctly deferred) landed
 * evals-nightly's 35-min timeout at only 1.11x-1.445x on 2026-07-21 — under
 * the 1.5x floor, so all 3 attempts burned as ordinary `failureClass:
 * 'timeout'` failures instead of deferring (see plans/remediation-p1p5/
 * PLAN.md P5 / E1 investigation). An awake timeout-kill's overshoot is
 * bounded (timeout + 5s grace + drain — a few seconds, regardless of the
 * timeout's size) — there is no legitimate awake reason for a
 * multi-minute-late timer fire. Capping the ratio-derived allowance at
 * ABSOLUTE_SLOP_MS = 600_000 (10 min) makes any >10-min overshoot inflated
 * no matter how large the timeout is, while leaving short-timeout behavior
 * BIT-FOR-BIT unchanged: for any timeout <=20min (timeoutMs*0.5 <=
 * 600_000 — covers both live jobs today, maintenance-daily's 10min and
 * knowledge-daily's 20min exactly), `min()` picks the ratio term, so the
 * formula reduces to the original `timeoutMs*1.5+1000`. The cap only starts
 * binding — and only makes detection MORE sensitive, never less — once a
 * job's timeout exceeds 20min, which is exactly evals-nightly's 35-min
 * case.
 */
const ABSOLUTE_SLOP_MS = 600_000;

export function isSleepInflated(wallMs: number, timeoutMs: number): boolean {
  return wallMs > timeoutMs + Math.min(timeoutMs * 0.5, ABSOLUTE_SLOP_MS) + 1000;
}

/**
 * Spawn one process, wait for it to exit (or be killed on timeout), and
 * return its outcome. A single attempt — callers that want retry semantics
 * wrap this in their own loop (see RetryRunner.runWithRetry).
 *
 * Timeout behavior: kills the entire process group (spawned `detached: true`
 * so PGID === proc.pid) with SIGTERM, waits a 5s grace period, then SIGKILLs
 * the group. Both kill calls swallow ESRCH (process already gone).
 */
export async function spawnJob(options: SpawnJobOptions): Promise<SpawnJobResult> {
  const { spawnArgs, cwd, env, timeout, onTimeout, onSpawn } = options;

  const startMs = Date.now();
  const proc = Bun.spawn(spawnArgs, {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
    detached: true,
    env,
  });
  onSpawn?.(proc);

  let timedOut = false;
  const timeoutHandle = setTimeout(async () => {
    timedOut = true;
    onTimeout?.();
    // Kill entire process group (PGID == proc.pid because detached: true)
    try { process.kill(-proc.pid!, 'SIGTERM') } catch (_e) { /* ESRCH = already gone */ }
    // Grace period, then SIGKILL the group
    await new Promise(r => setTimeout(r, 5000));
    try { process.kill(-proc.pid!, 'SIGKILL') } catch (_e) { /* ESRCH = already gone */ }
  }, timeout);

  const exitCode = await proc.exited;
  clearTimeout(timeoutHandle);
  const wallMs = Date.now() - startMs;

  const stdout = (await new Response(proc.stdout).text()).trim();
  const stderr = (await new Response(proc.stderr).text()).trim();
  // Success = a non-null exit code that's in the job's expected set (default
  // [0], preserving every existing job's exit-0-only semantics) AND no
  // timeout fired. timedOut short-circuits this to false even if the killed
  // process happened to exit with a code in the expected set (see JobSpec.ts
  // expectedExitCodes doc, remediation-s1s5 A2).
  const expected = options.expectedExitCodes ?? [0];
  const success = exitCode !== null && expected.includes(exitCode) && !timedOut;
  // Composition: the wall-ratio heuristic (isSleepInflated) catches gross
  // suspensions; the measurement-based sysctl check (sleptDuringWindowFn)
  // catches lockstep suspension where wall-clock stays near the timeout
  // ratio (the 2026-07-11 blind spot — 957s/900s = 1.06x, well under
  // isSleepInflated's 1.5x threshold). `||` means either signal alone is
  // sufficient; sysctl unavailability (sleptDuringWindow returns false on no
  // evidence — see SleepWindow.ts) just leaves the wall-ratio fallback
  // in effect, so this can never regress behavior when sleep evidence is
  // absent.
  const sleepCheck = options.sleptDuringWindowFn ?? sleptDuringWindow;
  const sleptThrough = timedOut && (isSleepInflated(wallMs, timeout) || sleepCheck(startMs, Date.now()));
  const failureClass = success
    ? undefined
    : classifyFailure({ exitCode, signal: null, stderr, stdout, wasOffline: false, timedOut });

  return { success, exitCode, stdout, stderr, timedOut, wallMs, sleptThrough, failureClass };
}
