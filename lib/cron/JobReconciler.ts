/**
 * JobReconciler — pure decision functions for the desired-state catch-up
 * reconciler (bin/job-reconciler.ts).
 *
 * For each manifest job with `catchUp:true` (see JobSpec.ts), the reconciler
 * asks: "has this job reached its desired state, and if not should we run it
 * right now?" This module holds the ZERO-I/O decision logic; bin/job-
 * reconciler.ts is the thin I/O wrapper (reads the manifest, stats the
 * desired artifact, probes power/network, and invokes
 * `bun bin/run-cron-job.ts <id> --catchup` when a decision is 'run').
 *
 * B2 (commit 296e458c4) DELETED the run-ledger signal and a duplicate
 * cron-slot-matching helper (also named `mostRecentDueSlot`) that used to
 * feed it. That helper matched cron slots in UTC while run-cron-job.ts's own
 * slot matcher (findMatchedSlot) matches in local time — a UTC-vs-local
 * divergence that meant the reconciler could conclude a slot was "due" hours
 * away from when run-cron-job.ts itself would ever agree to run it, so the
 * two never converged and the reconciler looped forever re-deciding "run"
 * for a job that, by run-cron-job.ts's own clock, was not actually missed.
 * B2's fix was to delete the second cron-matching implementation outright:
 * artifact freshness ALONE decided desired state, and job.schedule was never
 * read by the reconciler at all.
 *
 * S2 brings a *shared* notion of "when is this job due" back, to fix a
 * different bug B2 introduced as a side effect: decideCatchUp's artifact
 * check resolved `desiredArtifact.path`'s `{date}` token against TODAY
 * unconditionally (see bin/job-reconciler.ts's resolveArtifactPath call),
 * with no notion of whether the job's schedule had come due yet today. For
 * every dated-artifact catchUp job scheduled after midnight, every hourly
 * tick between midnight and the scheduled time saw "today's artifact
 * missing" and fired a duplicate pre-schedule catch-up run. The fix: derive
 * `dueAt` — the most recent cron slot at-or-before `now` — via
 * `../lib/cron/CronMatch.ts`'s `mostRecentDueSlot`, the SAME local-time
 * matcher run-cron-job.ts's `findMatchedSlot` uses (imported from one shared
 * module, not a second hand-rolled copy — that divergence is exactly what
 * B2 had to clean up, so this time there is only one implementation to keep
 * in sync). job.schedule is read again, but ONLY to pick which calendar
 * day's dated artifact to look for — decideCatchUp's actual verdict is still
 * artifact-freshness-only, never a second "is now on-schedule" gate.
 *
 * Because a catch-up invocation of run-cron-job.ts always executes the job
 * at wall-clock NOW (not at the due slot's original time) and therefore
 * writes TODAY's dated artifact, the reconciler must check BOTH the due
 * slot's path and today's path and treat the job as caught up if EITHER is
 * fresh (`computeDueArtifactPaths` + `pickFresherArtifact` below) — checking
 * only the due-slot path would mean a catch-up run's own output could never
 * satisfy the check until the due slot rolls over to today, re-triggering a
 * run every tick in between.
 *
 * Conditions gate ALWAYS: even a definitively-missed job is not re-run while
 * offline or asleep — see run-cron-job.ts's own network-precondition
 * behavior (it defers rather than spawning blind). Re-running while asleep
 * is not actually reachable in practice (the reconciler itself only runs
 * while the machine is awake to fire it), but the check is defensive and
 * keeps decideCatchUp fully specified for testing.
 */

// 'skip-locked' is decided at invoke time by bin/job-reconciler.ts (a live
// run-lock holder means another wrapper is executing the job RIGHT NOW —
// see lib/cron/RunLock.ts), never by decideCatchUp(), which stays a pure
// artifact-freshness decision.
export type CatchUpDecision = 'run' | 'skip-fresh' | 'skip-offline' | 'skip-locked';

export interface DecideCatchUpInput {
  /** Whether job.desiredArtifact.path (after {date} substitution) exists on disk. */
  artifactExists: boolean;
  /** Age of the artifact in hours, or null if it doesn't exist. */
  artifactAgeHrs: number | null;
  /** job.desiredArtifact.maxAgeHrs. */
  maxAgeHrs: number;
  /** Network reachability probe result. */
  online: boolean;
  /** Whether the machine is awake (reconciler only runs while awake, but kept explicit for testability). */
  awake: boolean;
  /** Current time — unused by the pure decision itself but threaded through for future extension/logging symmetry. */
  now: Date;
  /**
   * Slice A (sleep-cascade remediation): true when
   * job.desiredArtifact.staleIfFirstLineContains is set AND the artifact's
   * first line (bounded read — see bin/job-reconciler.ts's checkStaleMarker)
   * contains that marker. A marker-present artifact is treated as stale
   * regardless of mtime freshness — this is how the reconciler tells a
   * deterministic-fallback-authored artifact (e.g. daily-briefing's 07:45
   * sentinel writes a fresh-by-mtime but not-the-real-thing artifact) apart
   * from a genuine successful run. Always false when the job declares no
   * marker (checkStaleMarker is only invoked when staleIfFirstLineContains
   * is set — see bin/job-reconciler.ts's call site).
   */
  markerPresent: boolean;
}

/**
 * Pure decision function — zero I/O. See module doc for the artifact-
 * freshness + conditions-gate policy.
 */
export function decideCatchUp(input: DecideCatchUpInput): CatchUpDecision {
  const { artifactExists, artifactAgeHrs, maxAgeHrs, online, awake, markerPresent } = input;

  // Conditions gate first: never attempt a re-run while offline or asleep,
  // regardless of how badly the job has drifted from desired state.
  if (!online || !awake) return 'skip-offline';

  // Slice A: a marker-present artifact (fallback-authored) is never fresh,
  // even if its mtime is well within maxAgeHrs — see DecideCatchUpInput's doc.
  const artifactFresh =
    artifactExists && artifactAgeHrs !== null && artifactAgeHrs <= maxAgeHrs && !markerPresent;
  return artifactFresh ? 'skip-fresh' : 'run';
}

// ============================================================================
// selectMostStaleJob — pure one-job-per-tick invocation budget
// ============================================================================

export interface StaleCandidate {
  jobId: string;
  /** Age of the missing/stale artifact in hours, or null if the artifact
   *  doesn't exist at all (treated as more stale than any existing-but-old
   *  artifact, since "never produced" is a worse desired-state gap than
   *  "produced but old"). */
  artifactAgeHrs: number | null;
}

/**
 * The reconciler awaits each re-run inline, and a caught-up job can
 * legitimately take the full retry budget to finish (e.g. a 20-min timeout
 * times up to 3 attempts ~= 60 min) — awaiting more than one such run inline
 * in a single tick would blow past the reconciler's OWN timeout and get the
 * child SIGTERM'd mid-catch-up. So the reconciler invokes AT MOST ONE job
 * per tick: given every job whose decideCatchUp verdict was 'run' this tick,
 * pick the single MOST STALE one (largest artifactAgeHrs; a wholly-missing
 * artifact outranks any existing-but-old one). Every other missed job is
 * left for a later tick (an hour later, per job-reconciler.yaml's schedule)
 * to pick up — bounded, no overlap, and no persisted state is needed since
 * staleness is recomputed fresh from disk every tick.
 *
 * A1 (remediation-p1p5): ties (equal staleness) used to break by raw input
 * order alone, i.e. readdir order of the manifest directory — observed live
 * (2026-07-21) as maintenance-daily winning 6 straight ticks while 3 other
 * equally-stale jobs starved, because it always sorted first. Ties now break
 * by LEAST-RECENTLY-INVOKED: `lastInvokedAt` (built by buildLastInvokedAtMap
 * below from a bounded tail of the already-durable reconciliation.jsonl log —
 * no new state file) maps jobId -> ISO timestamp of its most recent
 * `invoked:true` row. A job absent from the map (never invoked in the tail
 * window) is treated as invoked at the beginning of time — it always wins a
 * tie over any job with a real timestamp, so a never-invoked job can't starve
 * forever behind readdir order once its staleness catches up to the leader.
 * When `lastInvokedAt` is omitted (defaults to an empty map — e.g. a missing/
 * corrupt log window degrading cleanly), every candidate is "never invoked"
 * and the tie-break degrades to the original input-order behavior.
 */
export function selectMostStaleJob(
  candidates: StaleCandidate[],
  lastInvokedAt: ReadonlyMap<string, string> = new Map(),
): string | null {
  if (candidates.length === 0) return null;

  // Pass 1: find the max staleness and every candidate tied at it (input
  // order preserved within the tie group).
  let bestAge = -Infinity;
  let tied: StaleCandidate[] = [];
  for (const candidate of candidates) {
    const age = candidate.artifactAgeHrs ?? Infinity;
    if (age > bestAge) {
      bestAge = age;
      tied = [candidate];
    } else if (age === bestAge) {
      tied.push(candidate);
    }
  }
  if (tied.length === 1) return tied[0]!.jobId;

  // Pass 2: break the staleness tie by least-recently-invoked. A missing or
  // unparseable timestamp is treated as -Infinity (oldest possible), so it
  // always beats a real one.
  const invokedAtMs = (jobId: string): number => {
    const raw = lastInvokedAt.get(jobId);
    if (raw === undefined) return -Infinity;
    const parsed = Date.parse(raw);
    return Number.isNaN(parsed) ? -Infinity : parsed;
  };

  let winner = tied[0]!;
  let winnerMs = invokedAtMs(winner.jobId);
  for (const candidate of tied.slice(1)) {
    const candidateMs = invokedAtMs(candidate.jobId);
    if (candidateMs < winnerMs) {
      winner = candidate;
      winnerMs = candidateMs;
    }
  }
  return winner.jobId;
}

// ============================================================================
// buildLastInvokedAtMap — pure fold over a bounded tail of already-parsed
// reconciliation.jsonl rows into a jobId -> last-invoked-ts map. Zero I/O:
// reading the log's tail window is bin/job-reconciler.ts's job (thin I/O,
// via lib/core/AppendLog's readLastN); this just folds whatever rows that
// produced. Input is `unknown[]` (not a typed row) on purpose: a corrupt or
// foreign-shaped line silently parses to *something* via JSON.parse (a
// string, a number, null, an object missing fields) and must be skipped
// rather than thrown on, per A1's "degrade cleanly" robustness requirement.
// ============================================================================

export function buildLastInvokedAtMap(rows: readonly unknown[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const row of rows) {
    if (row === null || typeof row !== 'object') continue;
    const r = row as Record<string, unknown>;
    if (typeof r.jobId !== 'string' || typeof r.ts !== 'string' || r.invoked !== true) continue;
    if (Number.isNaN(Date.parse(r.ts))) continue;
    const existing = map.get(r.jobId);
    if (existing === undefined || Date.parse(r.ts) > Date.parse(existing)) {
      map.set(r.jobId, r.ts);
    }
  }
  return map;
}

// ============================================================================
// resolveArtifactPath — pure {date} template substitution
// ============================================================================

/**
 * Some desiredArtifact paths are date-stamped (e.g. daily-briefing writes
 * MEMORY/BRIEFINGS/<YYYY-MM-DD>.md — see DailyBriefing's Deliver.ts) so a literal
 * manifest path can never match. Manifest authors may write `{date}` as a
 * token in `desiredArtifact.path`; this substitutes it with the current
 * LA-local calendar day in YYYY-MM-DD form, matching the briefing's
 * own `toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' })`
 * convention (also used by bin/verify-cron-fixes.ts's TODAY constant) so the
 * reconciler and the job it's checking agree on "today" even near UTC
 * midnight. Paths with no `{date}` token are returned unchanged.
 */
export function resolveArtifactPath(path: string, now: Date): string {
  if (!path.includes('{date}')) return path;
  const date = now.toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
  return path.replace(/\{date\}/g, date);
}

// ============================================================================
// ArtifactState / computeDueArtifactPaths / pickFresherArtifact — S2 due-slot
// support. See module doc for the today-path-too rationale.
// ============================================================================

/** Result of stat'ing a single desiredArtifact path. Owned here (rather than
 *  bin/job-reconciler.ts, which re-exports it) since it is a plain data
 *  shape consumed by this module's own pure functions below — statting the
 *  path itself is still bin/job-reconciler.ts's job (thin I/O). */
export interface ArtifactState {
  exists: boolean;
  ageHrs: number | null;
}

/**
 * The two candidate desiredArtifact paths for a given job at a given tick:
 *   - duePath  — `{date}` resolved against the most recently DUE cron slot
 *                (`dueAt`, from CronMatch.mostRecentDueSlot). This is the
 *                path the job's own scheduled run would have written.
 *   - todayPath — `{date}` resolved against `now`'s calendar day. This is
 *                the path a RECONCILER-TRIGGERED catch-up run writes,
 *                because run-cron-job.ts --catchup always executes at
 *                wall-clock now, not at the original due slot's time.
 * When the due slot already fell on today (the common case, once the slot
 * has passed), the two paths are identical — callers should stat once, not
 * twice, in that case (see bin/job-reconciler.ts's runReconciler loop).
 */
export interface DueArtifactPaths {
  duePath: string;
  todayPath: string;
}

/** Pure — just two resolveArtifactPath calls against different reference dates. */
export function computeDueArtifactPaths(pathTemplate: string, dueAt: Date, now: Date): DueArtifactPaths {
  return {
    duePath: resolveArtifactPath(pathTemplate, dueAt),
    todayPath: resolveArtifactPath(pathTemplate, now),
  };
}

/** An ArtifactState paired with the path it was stat'd from — carried
 *  through pickFresherArtifact so the caller can log which path the
 *  decision actually used (see ReconciliationDecisionRow.artifactPath). */
export interface NamedArtifactState {
  path: string;
  state: ArtifactState;
}

/**
 * Picks whichever of the due-slot and today candidates represents the more
 * "caught up" desired state: an existing artifact beats a missing one;
 * between two existing artifacts, the younger (smaller ageHrs) wins. Ties —
 * including both missing, which is the common not-yet-caught-up case — fall
 * back to `due`, deterministically; the two ArtifactStates are equivalent in
 * that case, so which one is "picked" only matters for the forensic
 * artifactPath the caller logs.
 */
export function pickFresherArtifact(due: NamedArtifactState, today: NamedArtifactState): NamedArtifactState {
  if (due.state.exists !== today.state.exists) {
    return due.state.exists ? due : today;
  }
  if (!due.state.exists) return due;
  const dueAge = due.state.ageHrs ?? Infinity;
  const todayAge = today.state.ageHrs ?? Infinity;
  return dueAge <= todayAge ? due : today;
}

// ============================================================================
// shouldAlertMissedCount / deriveMissedCountsByTick — Slice C (sleep-cascade
// remediation): drain-aware missed-count alerting.
//
// Root cause: the old `alerted = missedCount >= missedThreshold` was
// recomputed fresh EVERY tick with no memory of the previous tick's count —
// so a backlog draining at the reconciler's own one-job-per-tick budget
// (e.g. 40 missed jobs after an overnight sleep, going 40 -> 39 -> 38 -> ...
// one per hourly tick) alerted on every single tick until it dropped below
// threshold: ~36 noisy pages for ONE overnight outage that was already
// self-healing exactly as designed. The fix distinguishes "stuck or growing"
// (a real, worsening problem worth paging about) from "monotonically
// draining" (self-healing — the reconciler is already handling it, no page
// needed) using a short trailing history of prior ticks' missedCount, with
// an unconditional override when the tick's own invocation actually failed
// (that's a new, unrelated signal a draining trend can't explain away).
// ============================================================================

/**
 * Pure decision function — zero I/O. Below `threshold`, never alerts. At or
 * above threshold: an invocation failure THIS tick always alerts (a failed
 * re-run is a distinct problem a decreasing backlog count doesn't excuse).
 * Otherwise, alert only when the trailing run of non-decreasing missedCount
 * values across `[...priorCountsChronological, current]` is at least 2 ticks
 * long (stuck at the same count, or growing, for 2+ consecutive ticks) — a
 * single-tick count that DECREASED from the immediately preceding tick is
 * draining/self-healing and does not alert. No prior history at all (empty
 * `priorCountsChronological`) alerts unconditionally — fail-loud default:
 * with nothing to compare against, "above threshold" is the only signal
 * available and it must not be silently swallowed.
 */
export function shouldAlertMissedCount(
  current: number,
  threshold: number,
  priorCountsChronological: number[],
  anyInvokeFailedThisTick: boolean,
): boolean {
  if (current < threshold) return false;
  if (anyInvokeFailedThisTick) return true;
  if (priorCountsChronological.length === 0) return true;

  // Walk the trailing run of non-decreasing values backward from `current`
  // through the chronological prior counts, counting how many consecutive
  // ticks (including `current`) form a stuck-or-growing streak.
  const series = [...priorCountsChronological, current];
  let streakLength = 1;
  for (let i = series.length - 1; i > 0; i--) {
    if (series[i]! >= series[i - 1]!) {
      streakLength++;
    } else {
      break;
    }
  }
  return streakLength >= 2;
}

/**
 * Pure fold over a bounded tail of already-parsed reconciliation.jsonl rows
 * (see bin/job-reconciler.ts's runReconciler, which writes one row per job
 * per tick, all rows in a single tick sharing the identical `ts`) into a
 * chronological (oldest-tick-first) array of each tick's missedCount —
 * recomputed as `count of rows in that tick whose decision !== 'skip-fresh'`,
 * mirroring runReconciler's own `missedCount` computation exactly, so no new
 * field or log format is needed (smallest-diff choice — see Slice C's design
 * note). Grouping is by first-appearance order of `ts` (a Map preserves
 * insertion order), which matches file order since reconciliation.jsonl is
 * append-only and every row in one tick is written contiguously with the
 * same `ts`. `unknown[]` input, on purpose (matches buildLastInvokedAtMap's
 * contract above): a corrupt or foreign-shaped line must be skipped rather
 * than thrown on.
 */
export function deriveMissedCountsByTick(rows: readonly unknown[]): number[] {
  const countsByTs = new Map<string, number>();
  for (const row of rows) {
    if (row === null || typeof row !== 'object') continue;
    const r = row as Record<string, unknown>;
    if (typeof r.ts !== 'string' || typeof r.decision !== 'string') continue;
    if (!countsByTs.has(r.ts)) countsByTs.set(r.ts, 0);
    if (r.decision !== 'skip-fresh') countsByTs.set(r.ts, countsByTs.get(r.ts)! + 1);
  }
  return [...countsByTs.values()];
}
