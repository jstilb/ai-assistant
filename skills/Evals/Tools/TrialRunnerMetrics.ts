#!/usr/bin/env bun
/**
 * TrialRunnerMetrics - Extended metrics for multi-trial eval runs
 *
 * Computes:
 *   pass_rate   - Fraction of trials that passed (passCount / totalTrials)
 *   pass_at_k   - Probability of at least 1 success in k trials (capability)
 *   pass_all_k  - Whether ALL k trials passed (consistency/reliability)
 *
 * These metrics complement the existing TrialRunner's pass@k and pass^k
 * with the naming convention used in the foundation eval suite spec.
 *
 * Usage (Library):
 *   import { computePassRate, computePassAtK, computePassAllK } from './TrialRunnerMetrics.ts';
 */

// ============================================================================
// Types
// ============================================================================

export interface TrialOutcome {
  passed: boolean;
  score: number;
}

export interface TrialMetrics {
  pass_rate: number;
  pass_at_k: number;
  pass_all_k: number;
}

// ============================================================================
// Metric Computations
// ============================================================================

/**
 * pass_rate: Simple fraction of trials that passed
 * pass_rate = passCount / totalTrials
 */
export function computePassRate(outcomes: TrialOutcome[]): number {
  if (outcomes.length === 0) return 0;
  const passCount = outcomes.filter((o) => o.passed).length;
  return passCount / outcomes.length;
}

/**
 * pass_at_k: Probability of at least 1 success in k trials
 *
 * When k equals total trials (default): 1 if any passed, 0 otherwise
 * When k < total trials: Uses combinatorial formula
 *   pass@k = 1 - C(n-c, k) / C(n, k)
 *   where n = total, c = passes, k = sample size
 *
 * This measures capability - can the system ever succeed?
 */
export function computePassAtK(outcomes: TrialOutcome[], k?: number): number {
  const n = outcomes.length;
  const c = outcomes.filter((o) => o.passed).length;
  const sampleK = k ?? n;

  if (c === 0) return 0; // Never passed
  if (sampleK > n) return 0; // Can't sample more than available
  if (n - c < sampleK) return 1; // Not enough failures to fill all k slots

  // Combinatorial: 1 - C(n-c, k) / C(n, k)
  // Computed iteratively to avoid factorial overflow
  let failProb = 1;
  for (let i = 0; i < sampleK; i++) {
    failProb *= (n - c - i) / (n - i);
  }

  return 1 - failProb;
}

/**
 * pass_all_k: Whether ALL trials passed (binary consistency check)
 *
 * Returns 1.0 if every trial passed, 0.0 otherwise.
 * This measures consistency/reliability - does the system always succeed?
 */
export function computePassAllK(outcomes: TrialOutcome[]): number {
  if (outcomes.length === 0) return 0;
  return outcomes.every((o) => o.passed) ? 1.0 : 0.0;
}

/**
 * Compute all three metrics at once
 */
export function computeAllMetrics(
  outcomes: TrialOutcome[],
  k?: number
): TrialMetrics {
  return {
    pass_rate: computePassRate(outcomes),
    pass_at_k: computePassAtK(outcomes, k),
    pass_all_k: computePassAllK(outcomes),
  };
}
