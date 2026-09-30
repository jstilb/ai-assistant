/**
 * FailureClassifier — pure classification of why a cron job run failed.
 *
 * Used by run-cron-job.ts to tag `failureClass` on spawn.complete /
 * execute.complete log events and on the RunLedger row (see RunLedger.ts),
 * and to decide whether a failure is worth retrying (see item 4 — retry
 * ONLY on 'transient' | 'timeout' | 'environment', never 'bug' | 'auth').
 *
 * Deliberately pure/injectable: takes plain data, does no I/O, so it's
 * unit-testable without spawning real processes.
 */

export type FailureClass = 'environment' | 'transient' | 'timeout' | 'auth' | 'bug' | 'detection';

/**
 * Exit-code contract for self-alerting sentinel jobs (2026-08-07): a job
 * that exits with THIS code is declaring "I detected the condition I watch
 * for AND already routed my own alert through AlertGate" — a degraded run,
 * not a code defect. Classified 'detection': recorded in the run ledger as
 * a failure (never a silent success), but excluded from FailStreak
 * escalation (its predicate allowlists bug/timeout), retry (not in
 * RETRYABLE), the generic cron-health page, and incident-triage — the same
 * one-incident-one-page rationale as cron-health-monitor.ts's
 * SELF_ALERTING_JOBS, declared in-band by the job instead of hardcoded by
 * jobId. A sentinel that CRASHES, or whose AlertGate send throws, must still
 * exit 1 so the meta layer pages. Producers: FreshnessGuard.ts,
 * LearningIntakeWatchdog.ts.
 */
export const DETECTION_EXIT_CODE = 42;

export interface FailureInput {
  exitCode: number | null;
  signal: string | null;
  stderr: string | undefined;
  /**
   * stdout of the failed process. The claude CLI prints usage-limit errors to
   * STDOUT and exits 1 with an EMPTY stderr (2026-07-09 production fixture:
   * "You've hit your weekly limit · resets Jul 11 at 7am (America/Los_Angeles)",
   * 73 chars, exit 1) — classifying on stderr alone dropped those runs into
   * 'bug' (never retried), so pattern rules run over BOTH streams.
   */
  stdout?: string;
  /** True when the network-precondition probe (item 6) found us offline. */
  wasOffline: boolean;
  /**
   * True ONLY when run-cron-job.ts's OWN timeout handler fired (see the
   * `timedOut` flag around the setTimeout/SIGTERM/SIGKILL block). A bare
   * SIGTERM/SIGKILL signal without this flag set is NOT assumed to be our
   * timeout — it could be an external kill, OOM killer, etc. — and falls
   * through to the other rules instead.
   */
  timedOut: boolean;
}

// Transient network/LLM-call patterns. Mirrors the shape of Inference.ts's
// own timeout message plus common Node/Bun socket-failure signatures.
// `/network/i` is a deliberately broad catch-all per the task spec's
// judgment call — false positives here just mean an extra retry attempt,
// which is safe (retries are capped, see item 4), whereas false negatives
// mean a transient blip gets misclassified as 'bug' and never retried.
const TRANSIENT_PATTERNS: RegExp[] = [
  /Timeout after \d+ms/i,
  /socket.*closed/i,
  /ECONNRESET/i,
  /ETIMEDOUT/i,
  /EPIPE/i,
  /network/i,
];

// Usage-limit / rate-limit exhaustion from the claude CLI or Anthropic API.
// These arrive on STDOUT with an empty stderr (see FailureInput.stdout).
// Classified 'transient': the bounded in-process retry is harmless, and the
// hourly reconciler catch-up is the real recovery path once the pool frees
// up — what matters is that this is NOT 'bug' (never-retried, feeds the
// FailStreak heal-escalation pager). Machine-text carve-out per
// feedback_determinism_earns_its_place ruling (i): regex over
// machine-generated error text gating a bounded retry. First pattern is the
// literal 2026-07-09 daily-upkeep/knowledge-daily production signature; the
// others are known Anthropic CLI/API limit banners.
const USAGE_LIMIT_PATTERNS: RegExp[] = [
  /hit your (usage|weekly|5-hour|session) limit/i,
  /usage limit reached/i,
  // The literal API error type only — NOT a loose /rate.?limit/i: several
  // modules log the phrase "rate limit" in prose during normal self-handled
  // 429 backoff, and a loose match would flip a later unrelated 'bug' crash
  // in the same run to 'transient', suppressing the FailStreak escalation.
  /rate_limit_error/i,
  /credit balance is too low/i,
  // 2026-08-29 production signature (31 rows in cron logs): "You've reached
  // your Fable 5 limit. Switch to another model, ..." — matched nothing above,
  // fell through to 'bug', never retried (18-failure streak). Per-model pool
  // banners say "reached", not "hit".
  /reached your (?:[a-z0-9.-]+ ){0,3}limit/i,
];

// Mirrors TokenHealth.ts's classifyReactiveFailure() substring checks
// (Invalid Credentials / invalid_grant / token has been expired), minus its
// bare '401'/'403' checks — those are too broad a catch-all here since a lot
// of non-auth stderr could contain those digits incidentally (e.g. exit
// codes, line numbers). Keep to the higher-signal string patterns.
//
// The last two entries are the 2026-07-15 401 auth-storm carve-out: the
// claude CLI's dead-setup-token failure prints the literal 73-char string
// "Failed to authenticate. API Error: 401 Invalid authentication
// credentials" to stdout/stderr (confirmed byte-identical in both the
// 2026-07-12 cron run records — MEMORY/daemon/cron/logs/*.jsonl,
// execute.complete.error — and session transcript isApiErrorMessage/
// apiErrorStatus:401 rows). Before this, that exact string matched no rule
// and fell through to 'bug' — misclassified as a code defect (never
// retried, but also never recognized as auth, so cron-health-monitor paged
// it once per job per run instead of collapsing the whole outage into one
// incident page — see bin/cron-health-monitor.ts's auth-incident handling).
// Machine-text carve-out per feedback_determinism_earns_its_place ruling
// (i): regex over machine-generated CLI/API error text, not free-form prose.
const AUTH_PATTERNS: RegExp[] = [
  /Invalid Credentials/i,
  /invalid_grant/i,
  /token has been expired/i,
  /Failed to authenticate/i,
  /Invalid authentication credentials/i,
];

/**
 * Classify a completed (failed) run. Rules apply in priority order —
 * first match wins (pattern rules 3-5 run over stderr AND stdout combined —
 * see FailureInput.stdout):
 *   1. timedOut === true                          -> 'timeout'
 *   2. wasOffline === true                         -> 'environment'
 *   3. exitCode === DETECTION_EXIT_CODE            -> 'detection'
 *      (before the text rules: an explicit exit-code contract beats
 *      pattern heuristics — a sentinel's stale-artifact listing may well
 *      contain words like "network" or "auth")
 *   4. text matches a transient network pattern    -> 'transient'
 *   5. text matches a usage/rate-limit pattern     -> 'transient'
 *   6. text matches an auth-failure pattern        -> 'auth'
 *   7. else (clean non-zero exit, no pattern)      -> 'bug'
 */
export function classifyFailure(input: FailureInput): FailureClass {
  if (input.timedOut === true) return 'timeout';
  if (input.wasOffline === true) return 'environment';
  if (input.exitCode === DETECTION_EXIT_CODE) return 'detection';

  const text = `${input.stderr ?? ''}\n${input.stdout ?? ''}`;
  if (TRANSIENT_PATTERNS.some((re) => re.test(text))) return 'transient';
  if (USAGE_LIMIT_PATTERNS.some((re) => re.test(text))) return 'transient';
  if (AUTH_PATTERNS.some((re) => re.test(text))) return 'auth';

  return 'bug';
}
