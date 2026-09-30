/**
 * WakeLock — hold a `caffeinate` assertion for a cron job's lifetime so the
 * Mac can't idle-sleep mid-run.
 *
 * Root cause this fixes: the 2026-07-01 sleep-kill incident, where a long
 * cron job got killed mid-run because macOS idle-slept the machine.
 * NOTE launchd does NOT wake the machine for StartCalendarInterval — if the
 * Mac is asleep, the timer fires at the next wake, including a ~45s DarkWake
 * maintenance sliver (observed 2026-07-27: daily-briefing spawned 06:04:17,
 * 1s after the 06:04:16 DarkWake). `caffeinate` is what keeps the machine up
 * once the job is running.
 *
 * Flags (2026-07-31, daily-briefing DarkWake root-cause):
 *   -i  PreventUserIdleSystemSleep — blocks idle sleep from a full wake.
 *   -s  PreventSystemSleep — additionally blocks the "Maintenance Sleep" /
 *       "Sleep Service Back to Sleep" return-to-sleep when the job started
 *       inside a DarkWake sliver, which `-i` alone cannot (observed
 *       2026-07-31: caffeinate.held at 06:00:00, machine re-slept 06:00:40,
 *       job got ~45s of CPU per ~16min and burned 3 timeout attempts).
 *       Effective on AC power only (caffeinate(8)) — all three observed
 *       failures were onAC:true.
 *
 * KNOWN LIMIT: on battery, `-s` is inert and `-i` cannot defeat clamshell
 * (lid-closed) sleep — there this module does not guard the run; the
 * sleep-defer path (JobSpawner sleptThrough → 'deferred' + reconciler
 * catch-up) is the honest fallback.
 *
 * Deliberately injectable: `acquireWakeLock` takes an optional `spawnFn` so
 * tests can substitute a fake "process" (no real `caffeinate` binary
 * required) and assert start/stop behavior hermetically.
 */

/** Minimal shape of what we need from a spawned process — matches Bun.Subprocess. */
export interface WakeLockProcess {
  pid: number;
  kill(signal?: string): void;
  readonly exited: Promise<number>;
}

export type SpawnCaffeinate = (args: string[]) => WakeLockProcess;

export interface WakeLockHandle {
  /** True if a real caffeinate assertion was successfully spawned. */
  held: boolean;
  /** Release the wake lock. Safe to call multiple times (idempotent). */
  release(): void;
}

const defaultSpawn: SpawnCaffeinate = (args: string[]) => {
  const proc = Bun.spawn(['caffeinate', ...args], {
    stdout: 'ignore',
    stderr: 'ignore',
  });
  return {
    pid: proc.pid,
    kill: (signal?: string) => {
      try {
        proc.kill(signal as any);
      } catch {
        // Already gone — fine.
      }
    },
    exited: proc.exited,
  };
};

/**
 * Acquire a wake lock tied to `runnerPid`'s lifetime: `caffeinate -i -s -w <pid>`
 * auto-exits once that process dies, so a crash/throw in the caller can never
 * leave a dangling caffeinate process. We ALSO return an explicit release()
 * for the normal completion path, so the lock is dropped promptly rather than
 * waiting on the (already-dead-by-then) runner pid.
 *
 * Never throws: if spawning caffeinate fails (e.g. binary missing, sandboxed
 * environment), `held` is false and `release()` is a no-op — a wake-lock
 * failure must never fail the job it's protecting.
 */
export function acquireWakeLock(
  runnerPid: number,
  spawnFn: SpawnCaffeinate = defaultSpawn,
): WakeLockHandle {
  let proc: WakeLockProcess | null = null;
  try {
    proc = spawnFn(['-i', '-s', '-w', String(runnerPid)]);
  } catch {
    proc = null;
  }

  let released = false;
  return {
    held: proc !== null,
    release(): void {
      if (released || !proc) return;
      released = true;
      proc.kill('SIGTERM');
    },
  };
}
