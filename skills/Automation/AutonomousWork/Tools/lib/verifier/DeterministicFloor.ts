/**
 * DeterministicFloor.ts - Floor enforcement for Phase 2 verdict upgrade prevention.
 *
 * Phase 2 (Sonnet judgment) cannot upgrade a verdict to PASS when Phase 1
 * recorded deterministic failures (test exit codes, git cross-validation).
 * If the floor applies, the verdict is capped at NEEDS_REVIEW.
 */

import type { SkepticalReviewResult, VerificationTier } from "../../../Tools/SkepticalVerifier.ts";

/**
 * Deterministic Floor Principle: cap verdict at NEEDS_REVIEW when Phase 1
 * recorded deterministic failures and Phase 2 would have returned PASS.
 */
export function applyDeterministicFloor(
  tiers: VerificationTier[],
  verdict: SkepticalReviewResult["finalVerdict"],
  concerns: string[],
): SkepticalReviewResult["finalVerdict"] {
  const phase1 = tiers.find(t => t.tier === 1);
  if (
    phase1?.deterministicFailures !== undefined &&
    phase1.deterministicFailures.length > 0 &&
    verdict === "PASS"
  ) {
    const failNames = phase1.deterministicFailures.map(f => f.checkName).join(", ");
    concerns.push(
      `[DeterministicFloor] Phase 2 verdict capped from PASS to NEEDS_REVIEW: deterministic failures present (${failNames})`,
    );
    return "NEEDS_REVIEW";
  }
  return verdict;
}
