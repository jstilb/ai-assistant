/**
 * RunLedger — append-only JSONL record of every cron job run's outcome.
 *
 * Lives at RUN_LEDGER_PATH() (lib/core/MemoryPaths.ts — call-time resolved)
 * (lib/core/KayaHome.ts) — the same call-time-resolved KAYA_HOME convention
 * used elsewhere in the repo (e.g. FailureLog.ts), so tests can override
 * process.env.KAYA_HOME per-test for hermeticity (no manual cache reset needed).
 *
 * Purpose (S3 — run-cron-job.ts hardening):
 *   - Idempotency: `lastOutcomeForSlot` lets run-cron-job.ts detect "this
 *     exact scheduled slot already succeeded" and skip a duplicate/coalesced
 *     launchd fire without re-spawning the job.
 *   - Forensics: every run (success/failure/timeout/deferred/skipped) gets a
 *     row with its failureClass (see FailureClassifier.ts) and attempt
 *     number, for future B1/A2/S5 slices (reconciliation, dashboards).
 *
 * Row shape is intentionally flat/simple — one row per (jobId, slotKey,
 * attempt). `slotKey` is `computeSlotKey(jobId, slotDate)`, a pure function
 * with no I/O so it's trivially unit-testable.
 */

import { readFileSync } from 'fs';
import { createAppendLog } from '../core/AppendLog.ts';
import { RUN_LEDGER_PATH } from '../core/MemoryPaths.ts';

export type RunOutcome = 'success' | 'failure' | 'deferred' | 'skipped';

export interface RunLedgerRow {
  jobId: string;
  slotKey: string;
  startedAt: string;
  finishedAt: string;
  outcome: RunOutcome;
  failureClass?: string;
  attempt: number;
  /** Optional extra fields future slices (B1/A2) may attach — kept loose. */
  [extra: string]: unknown;
}

/**
 * Pure function: derive the slot key that identifies "this job's scheduled
 * run for this particular slot". The caller is responsible for resolving
 * `slot` to the ALREADY-matched cron slot Date (see run-cron-job.ts's
 * matchesCron loop) — this function does no cron-expression matching itself,
 * keeping it trivially unit-testable without mocking time or I/O.
 */
export function computeSlotKey(jobId: string, slot: Date): string {
  return `${jobId}:${slot.toISOString()}`;
}

/**
 * Append-only, best-effort write. Mirrors logEvent()'s try/catch-swallow
 * style in run-cron-job.ts and FailureLog.ts's recordFailure — a ledger
 * write must never fail the job it's recording.
 */
export function appendRunLedger(row: RunLedgerRow): void {
  try {
    const ledgerPath = RUN_LEDGER_PATH();
    // Path resolved per call (KAYA_HOME can change under tests), so the
    // AppendLog handle is created per call too — createAppendLog is cheap.
    createAppendLog(ledgerPath).append(row);
  } catch {
    // Logging is best-effort; never fail the job over a ledger write.
  }
}

/**
 * Read back the ledger (sync — low-frequency cron runner, not a hot path)
 * and return the most recent row's outcome for the exact (jobId, slotKey)
 * pair, or undefined if no row matches. Malformed/unparseable lines are
 * skipped rather than thrown on, so a partially-corrupted ledger doesn't
 * break idempotency checks for other rows.
 */
export function lastOutcomeForSlot(jobId: string, slotKey: string): RunOutcome | undefined {
  const ledgerPath = RUN_LEDGER_PATH();
  let raw: string;
  try {
    raw = readFileSync(ledgerPath, 'utf-8');
  } catch {
    return undefined;
  }

  let mostRecent: RunOutcome | undefined;
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line) as Partial<RunLedgerRow>;
      if (row.jobId === jobId && row.slotKey === slotKey && row.outcome) {
        mostRecent = row.outcome;
      }
    } catch {
      // Skip malformed lines rather than losing the whole read.
    }
  }
  return mostRecent;
}

/**
 * Pure idempotency-gate decision: given the prior outcome (or undefined for
 * a slot with no ledger history), should run-cron-job.ts skip spawning this
 * run? Only a prior 'success' for the EXACT same slot skips — 'failure',
 * 'deferred', 'skipped', or no history at all all mean "proceed normally".
 * This guards against launchd coalescing duplicate fires and against a
 * future (S5) reconciler re-running an already-successful slot.
 */
export function shouldSkipIdempotent(priorOutcome: RunOutcome | undefined): boolean {
  return priorOutcome === 'success';
}
