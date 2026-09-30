/**
 * RetryPolicy — pure decision of whether a classified failure is worth
 * retrying. Used by run-cron-job.ts's retry loop (item 4 — retry ONLY on
 * transient/timeout/environment failures, NEVER on bug or auth, since
 * retrying a deterministic bug or a bad credential just wastes attempts and
 * delays the failure being surfaced to Jm).
 *
 * Deliberately pure — takes the already-computed FailureClass (see
 * FailureClassifier.ts), does no I/O, so it's trivially unit-testable.
 */

import type { FailureClass } from './FailureClassifier';

const RETRYABLE: ReadonlySet<FailureClass> = new Set(['transient', 'timeout', 'environment']);

export function isRetryableFailure(failureClass: FailureClass): boolean {
  return RETRYABLE.has(failureClass);
}
