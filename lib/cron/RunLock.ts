/**
 * RunLock — per-jobId run lock so two cron wrappers never execute the same
 * job concurrently.
 *
 * Root cause this fixes: the schedule-vs-reconciler race. launchd fires a
 * job's scheduled slot while, within the same second, the hourly catch-up
 * reconciler (bin/job-reconciler.ts) sees the job's desired artifact still
 * missing — the scheduled run started milliseconds ago and hasn't written it
 * yet — and invokes a duplicate `--catchup` run. Both wrappers then execute
 * the full job (observed live: daily-briefing 2026-07-10T13:00Z, two
 * complete briefing generations; pre-Fix-B weeks also saw catch-ups overlap
 * still-alive retry triads, e.g. maintenance-daily 2026-07-09T10:03Z).
 * Overlap is churn, not corruption — every consumer writes append-only jsonl
 * and idempotent artifacts — but it double-spends agent runs and doubles
 * user-visible output.
 *
 * Design: one lock file per jobId under MEMORY/daemon/cron/locks/, created
 * with O_EXCL (`flag: "wx"`) so acquisition is atomic. The file body records
 * the holder's pid so contenders can do stale-lock recovery:
 *
 *   - holder pid dead              → stale; remove and take over. A crashed
 *     or OOM-killed wrapper must never brick its job.
 *   - holder alive, lock older than MAX_AGE_MS → disambiguate via the
 *     holder process's START TIME (`ps -o etime=`): a process that started
 *     BEFORE the lock was acquired is the genuine (long/sleep-suspended)
 *     holder and keeps the lock — wall-clock age spans machine sleep, so an
 *     8h job under sleep inflation can legitimately exceed any fixed cap
 *     (adversarial-verifier finding: age-alone staleness would steal the
 *     lock mid-run and reproduce the double-run bug). A process that
 *     started AFTER acquisition is a pid-reuse impostor (or ps failed —
 *     e.g. the recorded pid predates a reboot) → stale, preserving
 *     self-heal for locks orphaned across reboots.
 *   - holder alive and fresh       → locked; caller skips (exit 0). The
 *     running wrapper owns the slot's outcome. A machine that sleeps mid-run
 *     keeps its wrapper (and lock) alive; the reconciler simply skips that
 *     tick and catches up on a later one, so a held lock never blocks the
 *     morning catch-up for longer than the run itself.
 *
 * release() only unlinks the file when it still records OUR pid — after a
 * stale takeover, the previous holder's late release must not free the new
 * holder's lock.
 *
 * Deliberately injectable (the WakeLock.ts convention): `isPidAlive` and
 * `now` can be substituted so tests exercise contention and staleness
 * hermetically, with no real second process or clock wait.
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { memPath } from "../core/MemoryPaths";

/**
 * The ONE canonical locks-dir resolver — both producers (bin/run-cron-job.ts)
 * and checkers (bin/job-reconciler.ts) must call this, never spell the path
 * themselves: two independently-spelled relative paths would silently break
 * cross-process lock visibility if either ever drifted.
 */
export function defaultRunLocksDir(): string {
  return memPath("daemon", "cron", "locks");
}

/** Persisted lock-file body. */
export interface RunLockHolder {
  pid: number;
  correlationId?: string;
  acquiredAt: string;
}

export interface RunLockDeps {
  isPidAlive?: (pid: number) => boolean;
  now?: () => Date;
  /** Start time of a live process, or null when undeterminable. */
  getPidStartTime?: (pid: number) => Date | null;
}

export interface AcquireRunLockResult {
  acquired: boolean;
  /** Set when acquired: removes the lock file (idempotent, own-pid-guarded). */
  release: () => void;
  /** Set when NOT acquired: who holds the lock. */
  holder?: RunLockHolder;
}

/**
 * Locks older than this trigger the pid-reuse disambiguation (process start
 * time vs acquiredAt) instead of being trusted on liveness alone.
 */
export const MAX_LOCK_AGE_MS = 24 * 60 * 60 * 1000;

/** Slack when comparing process start time to acquiredAt (clock coarseness:
 *  `ps -o etime=` has 1s resolution and the wrapper starts slightly before
 *  it acquires). */
const START_TIME_SLACK_MS = 60_000;

const defaultIsPidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM = exists but not ours to signal — still alive.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
};

/**
 * Live process start time via `ps -o etime=` (elapsed since start —
 * "[[dd-]hh:]mm:ss"), chosen over `lstart` because it needs no locale/TZ
 * parsing. Returns null when ps fails or the output doesn't parse.
 */
const defaultGetPidStartTime = (pid: number): Date | null => {
  try {
    const proc = Bun.spawnSync(["ps", "-p", String(pid), "-o", "etime="]);
    const m = /^(?:(\d+)-)?(?:(\d+):)?(\d{1,2}):(\d{2})$/.exec(proc.stdout.toString().trim());
    if (!m) return null;
    const [, d, h, min, s] = m;
    const elapsedMs =
      ((Number(d ?? 0) * 24 + Number(h ?? 0)) * 3600 + Number(min) * 60 + Number(s)) * 1000;
    return new Date(Date.now() - elapsedMs);
  } catch {
    // intentionally silent: null = "undeterminable", and the caller treats
    // that as stale — the conservative self-heal direction.
    return null;
  }
};

function lockPath(locksDir: string, jobId: string): string {
  return join(locksDir, `${jobId}.lock`);
}

function resolveDeps(deps: RunLockDeps): Required<RunLockDeps> {
  return {
    isPidAlive: deps.isPidAlive ?? defaultIsPidAlive,
    now: deps.now ?? (() => new Date()),
    getPidStartTime: deps.getPidStartTime ?? defaultGetPidStartTime,
  };
}

function readHolder(path: string): RunLockHolder | null {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    if (typeof parsed?.pid !== "number" || typeof parsed?.acquiredAt !== "string") return null;
    return parsed as RunLockHolder;
  } catch {
    // Missing or unparseable (torn write) — treat as no valid holder.
    return null;
  }
}

function isStale(holder: RunLockHolder | null, deps: Required<RunLockDeps>): boolean {
  if (holder === null) return true; // unparseable lock can't be honored
  if (!deps.isPidAlive(holder.pid)) return true;
  const acquiredAtMs = Date.parse(holder.acquiredAt);
  const age = deps.now().getTime() - acquiredAtMs;
  if (Number.isNaN(age)) return true;
  if (age <= MAX_LOCK_AGE_MS) return false;
  // Alive but over-age: genuine long/sleep-suspended holder, or a recycled
  // pid? A genuine holder's process started BEFORE it acquired the lock; a
  // recycled pid's process started after. Undeterminable start (ps failure,
  // or a pid orphaned across a reboot) → stale, keeping the self-heal path.
  const started = deps.getPidStartTime(holder.pid);
  if (started === null) return true;
  return started.getTime() > acquiredAtMs + START_TIME_SLACK_MS;
}

/**
 * Read the current live holder of a job's lock, or null when unlocked/stale.
 * Read-only — never removes a stale file (recovery belongs to the acquirer).
 * This is the reconciler's pre-invoke check.
 */
export function readRunLock(jobId: string, locksDir: string, deps: RunLockDeps = {}): RunLockHolder | null {
  const d = resolveDeps(deps);
  const holder = readHolder(lockPath(locksDir, jobId));
  return holder !== null && !isStale(holder, d) ? holder : null;
}

/**
 * Atomically acquire the per-job run lock, recovering stale locks (dead
 * holder pid, over-age, or torn file). On contention with a LIVE holder,
 * returns { acquired: false, holder } — the caller should skip, not fail.
 */
export function acquireRunLock(
  jobId: string,
  locksDir: string,
  meta: { pid?: number; correlationId?: string } = {},
  deps: RunLockDeps = {},
): AcquireRunLockResult {
  const d = resolveDeps(deps);
  const pid = meta.pid ?? process.pid;
  const path = lockPath(locksDir, jobId);
  mkdirSync(locksDir, { recursive: true });

  const body: RunLockHolder = {
    pid,
    ...(meta.correlationId ? { correlationId: meta.correlationId } : {}),
    acquiredAt: d.now().toISOString(),
  };

  const release = (): void => {
    // Own-pid guard: never free a lock a later acquirer now holds.
    if (readHolder(path)?.pid === pid) {
      try {
        rmSync(path);
      } catch {
        // intentionally silent: release is idempotent — a concurrent remover
        // (or a re-entrant release) already achieved the desired end state.
      }
    }
  };

  // Two tries: a clean O_EXCL create, then (after stale recovery) one more.
  // Losing the post-recovery re-create race just means someone else took
  // over first — report their lock, don't loop.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(path, JSON.stringify(body), { flag: "wx" });
      return { acquired: true, release };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      const holder = readHolder(path);
      if (!isStale(holder, d)) {
        return { acquired: false, release: () => {}, holder: holder! };
      }
      try {
        rmSync(path); // stale — recover and retry the exclusive create once
      } catch {
        // intentionally silent: a racing acquirer removed the stale file
        // first; the retry's O_EXCL create decides the winner either way.
      }
    }
  }
  const holder = readHolder(path);
  return { acquired: false, release: () => {}, holder: holder ?? undefined };
}
