#!/usr/bin/env bun
/**
 * TaskOrchestrator.ts - Per-item Builder/Verifier loop with adversarial verification
 *
 * Alternates between Builder and Verifier agents until convergence or termination.
 * Uses dependency injection for Builder/Verifier functions to remain unit-testable.
 * Real implementations pass closures that call Task(); tests pass mock functions.
 *
 * Loop termination conditions:
 *   (a) Verifier returns all-PASS (allPass: true)  → converged: true
 *   (b) Max iterations reached (configurable, default 3) → converged: false, reason: "max_iterations"
 *   (c) Same failures two consecutive iterations (stall) → converged: false, reason: "stall"
 *
 * After convergence, runs SkepticalVerifier as supplementary check before reporting.
 */

import { SkepticalVerifier, type ItemReviewSummary } from "./SkepticalVerifier.ts";
import type { EffortLevel } from "./WorkQueue.ts";

// ============================================================================
// Types
// ============================================================================

export interface VerifierReport {
  rows: Array<{
    iscId: number;
    verdict: "PASS" | "FAIL";
    evidence: string;
    linkedTest: string | null;
    concern: string | null;
  }>;
  summary: string;
  allPass: boolean;
}

export type LoopResult =
  | { converged: true; iterations: number; verifierReport: VerifierReport; needsReview: boolean }
  | { converged: false; reason: "stall" | "max_iterations"; lastReport: VerifierReport }
  | { converged: false; reason: "error"; error: string };

export interface TaskOrchestratorConfig {
  /** Maximum number of Builder/Verifier iterations before terminating (default: 3) */
  maxIterations: number;
  effort: EffortLevel;
}

/** Builder function signature — accepts feedback markdown on iteration > 1 */
export type BuilderFn = (feedback: string | null, iteration: number) => Promise<void>;

/** Verifier function signature — returns a VerifierReport */
export type VerifierFn = (iteration: number) => Promise<VerifierReport>;

// ============================================================================
// Helper: format verifier feedback as markdown for Builder re-submission
// ============================================================================

function formatFeedback(report: VerifierReport, iteration: number): string {
  const failRows = report.rows.filter(r => r.verdict === "FAIL");
  const tableRows = failRows
    .map(r => `| ${r.iscId} | FAIL | ${r.concern ?? r.evidence} |`)
    .join("\n");

  return `## Verifier Feedback (Iteration ${iteration})

| ISC Row | Verdict | Feedback |
|---------|---------|----------|
${tableRows}

Address each FAIL row specifically before re-submitting.`;
}


// ============================================================================
// TaskOrchestrator Class
// ============================================================================

export class TaskOrchestrator {
  private config: TaskOrchestratorConfig;
  private skepticalVerifier: SkepticalVerifier;

  constructor(
    config?: Partial<TaskOrchestratorConfig>,
    skepticalVerifier?: SkepticalVerifier,
  ) {
    this.config = {
      maxIterations: config?.maxIterations ?? 3,
      effort: config?.effort ?? "STANDARD",
    };
    this.skepticalVerifier = skepticalVerifier ?? new SkepticalVerifier();
  }

  /**
   * executeLoop — runs Builder/Verifier alternation until convergence or termination.
   *
   * @param builderFn - Async function that runs the Builder agent
   * @param verifierFn - Async function that runs the Verifier agent and returns a report
   * @param summary   - Item summary for SkepticalVerifier supplementary check (required)
   */
  async executeLoop(
    builderFn: BuilderFn,
    verifierFn: VerifierFn,
    summary: ItemReviewSummary,
  ): Promise<LoopResult> {
    let lastReport: VerifierReport | null = null;
    let previousFailedIds: string | null = null; // JSON.stringify of sorted failed IDs

    for (let iteration = 1; iteration <= this.config.maxIterations; iteration++) {
      // --- Builder phase ---
      const feedback = lastReport && iteration > 1
        ? formatFeedback(lastReport, iteration - 1)
        : null;

      try {
        await builderFn(feedback, iteration);
      } catch (err) {
        return {
          converged: false,
          reason: "error",
          error: `Builder failed on iteration ${iteration}: ${err instanceof Error ? err.message : String(err)}`,
        };
      }

      // --- Verifier phase ---
      let report: VerifierReport;
      try {
        report = await verifierFn(iteration);
      } catch (err) {
        return {
          converged: false,
          reason: "error",
          error: `Verifier failed on iteration ${iteration}: ${err instanceof Error ? err.message : String(err)}`,
        };
      }

      lastReport = report;

      // --- Termination condition (a): all PASS ---
      // Compute allPass deterministically from row data instead of trusting LLM self-report
      const allPass = report.rows?.every(r => r.verdict === "PASS") ?? false;
      if (allPass) {
        // Run SkepticalVerifier as supplementary check after convergence (always runs)
        return await this.runSupplementaryCheck(report, iteration, summary);
      }

      // --- Termination condition (c): stall detection ---
      // Compare both IDs and failure reasons — same IDs with different reasons means progress
      const currentFailures = report.rows
        .filter(r => r.verdict === "FAIL")
        .map(r => ({ id: r.iscId, reason: r.concern ?? r.evidence }));
      const currentFailureKey = JSON.stringify(currentFailures);
      if (previousFailedIds !== null && previousFailedIds === currentFailureKey) {
        return { converged: false, reason: "stall", lastReport: report };
      }
      previousFailedIds = currentFailureKey;
    }

    // --- Termination condition (b): max iterations reached ---
    // lastReport is guaranteed non-null here since we ran at least one iteration
    return {
      converged: false,
      reason: "max_iterations",
      lastReport: lastReport!,
    };
  }

  // --------------------------------------------------------------------------
  // Supplementary check: SkepticalVerifier after convergence
  // --------------------------------------------------------------------------

  /**
   * Runs SkepticalVerifier after the Builder/Verifier loop converges.
   * If SkepticalVerifier returns FAIL or NEEDS_REVIEW, marks as needs_review.
   */
  private async runSupplementaryCheck(
    verifierReport: VerifierReport,
    iterations: number,
    summary: ItemReviewSummary,
  ): Promise<LoopResult> {
    try {
      const skepticalResult = await this.skepticalVerifier.review(summary);

      if (
        skepticalResult.finalVerdict === "FAIL" ||
        skepticalResult.finalVerdict === "NEEDS_REVIEW"
      ) {
        // Don't auto-complete — mark as needs_review
        return {
          converged: true,
          iterations,
          verifierReport,
          needsReview: true,
        };
      }

      return { converged: true, iterations, verifierReport, needsReview: false };
    } catch (err) {
      // SkepticalVerifier infra failure — flag for human review, never silently pass
      console.error(`[TaskOrchestrator] SkepticalVerifier failed: ${err instanceof Error ? err.message : String(err)}`);
      return { converged: true, iterations, verifierReport, needsReview: true };
    }
  }
}
