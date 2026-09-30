/**
 * PhaseL.ts — Phase L (Live Exercise) gate, shared across all verifier tiers.
 *
 * Phase L is the MANDATORY live-verification gate: an independent Explorer agent
 * must ACTUALLY run the built artifact and observe real behavior vs the spec.
 * It runs for every effort tier (Trivial/Standard/Rigorous) whenever the summary
 * carries a `liveVerificationInput`. A live FAIL — including "no live evidence"
 * (the artifact was never actually run) — is a HARD BLOCK: Phase 2 does not run,
 * the verdict is FAIL, and the item flows through the existing verify-fail →
 * auto-retry path (broken code should be re-attempted, not sent to human review).
 *
 * native UI cannot be auto-driven here → HUMAN_REQUIRED: not a FAIL (the code may
 * be fine) but never an auto-PASS of the native UI; the rows are dispositioned
 * human-required upstream.
 */

import type { VerificationTier } from "../../SkepticalVerifier.ts";
import type { LiveVerifierInput, LiveVerificationResult } from "../../LiveVerifier.ts";

export interface PhaseLOutcome {
  /** Whether Phase L actually ran (false when no liveVerificationInput present). */
  ran: boolean;
  /** True when live exercise passed OR was deferred to a human (non-blocking). */
  passed: boolean;
  /** True for native/undrivable surfaces — rows must be human-required. */
  humanRequired: boolean;
  /** The Phase L tier record to append (only on a hard FAIL). */
  tier?: VerificationTier;
  /** Concerns to merge into the review (failed scenarios, warnings). */
  concerns: string[];
  /** Mirrors LiveVerificationResult.verdict for the SkepticalReviewResult. */
  livePassed?: boolean;
  /**
   * True when live verification could not RUN in this execution context (not a code
   * FAIL). Carries a recognizable LIVE_VERIFICATION_ENVIRONMENT_BLOCK concern so the
   * upstream pipeline classifies the failure "environment" and re-stages the item
   * (Principle B2 / Slice 2) rather than escalating it to the human board.
   */
  environmentBlocked?: boolean;
}

/**
 * Run the Phase L live-exercise gate.
 *
 * @param liveVerificationInput  the engine input (surface, effort, workingDir, …)
 * @param liveVerify             DI'd engine call (runLiveVerification)
 */
export async function runPhaseL(
  liveVerificationInput: LiveVerifierInput | undefined,
  liveVerify: (input: LiveVerifierInput) => Promise<LiveVerificationResult>,
): Promise<PhaseLOutcome> {
  if (!liveVerificationInput) {
    return { ran: false, passed: true, humanRequired: false, concerns: [] };
  }

  const result = await liveVerify(liveVerificationInput);
  const concerns: string[] = [];

  // native / undrivable → defer to human; do NOT fail, do NOT auto-pass the UI.
  if (result.humanVerificationRequired || result.verdict === "HUMAN_REQUIRED") {
    concerns.push(
      "LIVE_VERIFICATION_HUMAN_REQUIRED: native UI could not be auto-driven here — rows must be dispositioned human-required, never auto-DONE",
    );
    concerns.push(...result.warnings);
    return { ran: true, passed: true, humanRequired: true, concerns, livePassed: undefined };
  }

  // Environment block (Slice 2): live verification could not RUN in this execution
  // context — e.g. the non-dangerous self-verify harness found nothing allowlisted to
  // run, or the dangerous Explorer was unavailable. This is NOT a code FAIL. We still
  // block completion (verification did not happen), but carry a recognizable marker so
  // the pipeline re-stages the item for the next eligible run instead of escalating it.
  if (result.environmentBlocked) {
    concerns.push(
      "LIVE_VERIFICATION_ENVIRONMENT_BLOCK: live verification could not run in this execution context (no runnable exercise here / explorer unavailable) — re-stage for the next eligible run; this is NOT a code failure",
    );
    concerns.push(...result.warnings);
    const tier: VerificationTier = {
      tier: 1,
      verdict: "FAIL",
      confidence: 1.0,
      concerns: concerns.slice(),
      recommendation:
        "Live verification was environment-blocked. Re-run where it can execute (authorized autonomous/cron, or with runnable ISC verify commands). Do NOT treat as a code defect.",
      costEstimate: 0,
      latencyMs: result.explorationTimeMs,
    };
    return { ran: true, passed: false, humanRequired: false, tier, concerns, livePassed: false, environmentBlocked: true };
  }

  if (result.verdict === "FAIL") {
    if (result.noEvidence) {
      concerns.push(
        "LIVE_VERIFICATION: no live evidence — the artifact was never actually run, so we cannot confirm it works (hard FAIL)",
      );
    }
    for (const s of result.scenarios.filter(sc => sc.verdict === "FAIL")) {
      const label = s.description ?? s.command ?? s.id;
      concerns.push(
        `LIVE_FAIL [${s.kind}] ${label}: expected "${s.expected ?? "?"}" but observed "${s.observed ?? "?"}" (exit ${s.exitCode ?? "?"})`,
      );
    }
    concerns.push(...result.warnings);

    const tier: VerificationTier = {
      tier: 1,
      verdict: "FAIL",
      confidence: 1.0,
      concerns: concerns.slice(),
      recommendation:
        "Live verification failed — the artifact does not behave as specified when actually run. Fix the runtime behavior and re-submit.",
      costEstimate: 0,
      latencyMs: result.explorationTimeMs,
    };

    return { ran: true, passed: false, humanRequired: false, tier, concerns, livePassed: false };
  }

  // PASS — carry any non-fatal warnings (e.g. flaky) forward.
  return { ran: true, passed: true, humanRequired: false, concerns: result.warnings.slice(), livePassed: true };
}
