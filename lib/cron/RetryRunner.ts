/**
 * RetryRunner — generic retry-loop driver for run-cron-job.ts (item 4 — B4).
 *
 * Deliberately separated from spawnOnce()'s actual Bun.spawn glue: this
 * module only knows how to decide "run again or stop?" given a classified
 * result, so it's trivially unit-testable with a fake attemptFn (no real
 * process spawning) and reused by anything else that needs the same
 * classify-then-retry shape in the future.
 *
 * Retry eligibility is delegated to RetryPolicy.isRetryableFailure() — retry
 * ONLY on transient/timeout/environment, NEVER on bug/auth (see that
 * module's doc for the "why").
 */

import { isRetryableFailure } from './RetryPolicy';
import type { FailureClass } from './FailureClassifier';

export interface AttemptResult<T> {
  success: boolean;
  /** Required on failure (success=false); ignored when success=true. */
  failureClass?: FailureClass;
  /**
   * When true, stop immediately — no further attempts even if failureClass
   * is retryable. Used by run-cron-job.ts for sleep-inflated timeouts
   * (JobSpawner.sleptThrough): the machine is asleep, so a retry would just
   * re-burn the attempt budget against a suspended process.
   */
  abort?: boolean;
  value: T;
}

export interface RetryPolicyConfig {
  /** Max number of retries AFTER the initial attempt (max:2 => 3 tries total). */
  max: number;
  backoffMs: number;
}

export interface RetryInfo {
  attempt: number;
  nextAttempt: number;
  backoffMs: number;
}

export interface RunWithRetryOptions<T> {
  attemptFn: (attempt: number) => Promise<AttemptResult<T>>;
  retry: RetryPolicyConfig;
  /** Called right before sleeping ahead of each retry. */
  onRetry?: (info: RetryInfo) => void;
  /** Injectable so tests don't need real timers. Defaults to a real sleep. */
  sleepFn?: (ms: number) => Promise<void>;
}

export interface RunWithRetryResult<T> {
  result: AttemptResult<T>;
  /** The 1-indexed attempt number the final result came from. */
  attempt: number;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Run `attemptFn` up to `retry.max + 1` times total, retrying only when the
 * failure is classified as retryable (see RetryPolicy.isRetryableFailure).
 * Stops immediately (no further attempts) on success, on a non-retryable
 * failure, or once the attempt budget is exhausted — whichever comes first.
 */
export async function runWithRetry<T>(options: RunWithRetryOptions<T>): Promise<RunWithRetryResult<T>> {
  const { attemptFn, retry, onRetry, sleepFn = defaultSleep } = options;
  const maxAttempts = retry.max + 1;

  let attempt = 1;
  for (;;) {
    const result = await attemptFn(attempt);

    const shouldRetry =
      !result.success &&
      !result.abort &&
      attempt < maxAttempts &&
      result.failureClass !== undefined &&
      isRetryableFailure(result.failureClass);

    if (!shouldRetry) {
      return { result, attempt };
    }

    onRetry?.({ attempt, nextAttempt: attempt + 1, backoffMs: retry.backoffMs });
    await sleepFn(retry.backoffMs);
    attempt += 1;
  }
}
