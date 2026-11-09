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

import { classifyText } from "../core/ClaudeRunEnd.ts";

export type FailureClass = "environment" | "transient" | "timeout" | "auth" | "bug" | "detection";

/**
 * Exit-code contract for self-alerting sentinel jobs (2026-08-07): a job
 * that exits with THIS code is declaring "I detected the condition I watch
 * for AND already routed my own alert through AlertGate" — a degraded run,
 * not a code defect. Classified 'detection': recorded in the run ledger as
 * a failure (never a silent success), but excluded from FailStreak
 * escalation (its predicate allowlists bug/timeout), retry (not in
 * RETRYABLE), the generic cron-health page, and incident-triage — the same
 * one-incident-one-page rationale behind cron-health-monitor.ts's
 * partitionSelfAlertingFailures, declared in-band by the job (the hardcoded
 * jobId set it replaced was removed 2026-11-08). A sentinel that CRASHES,
 * or whose AlertGate send throws, must still exit 1 so the meta layer pages. Producers: FreshnessGuard.ts,
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

// The text rules read the ONE CLI-text table (lib/core/ClaudeRunEnd.ts) under
// the "log" tier, over stderr AND stdout combined. Not "machine": a cron
// SCRIPT job's stderr and stdout are its own log text, where bare tokens
// ("timeout", "401", "rate limit", "permission denied") appear in normal
// self-handled runs and must not flip a real crash to 'transient'/'auth'
// (the FailStreak 'bug' page would never fire). Not "any": script output
// carries error wording ("read ECONNRESET", "Timeout after 30000ms",
// "Invalid Credentials") that the prose-safe tier skips. Plan P02 S2.

/**
 * Classify a completed (failed) run. Rules apply in priority order —
 * first match wins:
 *   1. timedOut === true                          -> 'timeout'
 *   2. wasOffline === true                         -> 'environment'
 *   3. exitCode === DETECTION_EXIT_CODE            -> 'detection'
 *      (before the text rule: an explicit exit-code contract beats
 *      pattern heuristics — a sentinel's stale-artifact listing may well
 *      contain error wording)
 *   4. stderr + stdout under classifyText(…, "log"):
 *      network / rate-limit / quota / timeout      -> 'transient'
 *      auth                                        -> 'auth'
 *   5. else (incl. blank output)                   -> 'bug'
 */
export function classifyFailure(input: FailureInput): FailureClass {
  if (input.timedOut === true) return "timeout";
  if (input.wasOffline === true) return "environment";
  if (input.exitCode === DETECTION_EXIT_CODE) return "detection";

  const end = classifyText(`${input.stderr ?? ""}\n${input.stdout ?? ""}`, "log");
  if (end === "auth") return "auth";
  if (end !== null) return "transient";

  return "bug";
}
