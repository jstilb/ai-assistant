/**
 * Types.ts — Shared types for the AutonomousWork tool layer.
 *
 * This file is the source of truth for types that cross module boundaries.
 * TaskOrchestrator.ts re-exports these for backwards compatibility with
 * class-importing test consumers.
 */

import type { EffortLevel } from "./WorkQueue.ts";
import type { FaultClass } from "./WorkOrchestrator.ts";

// ============================================================================
// Effort Classification (deterministic — no LLM)
// ============================================================================

/**
 * ISC 2: Per-effort-tier wall-clock caps.
 * Moved from TaskOrchestrator.ts (Phase 5c — class deleted).
 *
 * RIGOROUS is the spec's alias for THOROUGH — both map to 4h.
 */
export const WALL_CLOCK_CAPS: Record<EffortLevel | "RIGOROUS", number> = {
  TRIVIAL: 15 * 60 * 1000,
  QUICK: 30 * 60 * 1000,
  STANDARD: 2 * 60 * 60 * 1000,
  THOROUGH: 4 * 60 * 60 * 1000,
  RIGOROUS: 4 * 60 * 60 * 1000,
  DETERMINED: 8 * 60 * 60 * 1000,
};

/**
 * Maps each EffortLevel to the maximum number of Builder/Verifier iterations allowed.
 * Canonical location: Types.ts (moved here from EffortClassifier.ts — Phase 3b refactor).
 */
export const ITERATION_LIMITS: Record<EffortLevel, number> = {
  TRIVIAL: 1,
  QUICK: 3,
  STANDARD: 10,
  THOROUGH: 25,
  DETERMINED: 100,
};

/**
 * The single default effort cap applied at prepare() when no explicit
 * effortOverride is provided.
 *
 * Determinism-residue cleanup: the old deriveEffort() keyword heuristic
 * (greeting→TRIVIAL, "overnight"→DETERMINED, architectural-keywords→THOROUGH,
 * typo/rename→QUICK, else STANDARD) interpreted the request text to pick a tier.
 * Per "determinism must earn its place", iteration/wall-clock caps are plain
 * default numbers, not content-derived tiers — they exist only as a generous
 * loud-failing backstop, not a judgment. deriveEffort returned STANDARD for
 * nearly every real work item anyway, so STANDARD is the default; callers that
 * genuinely need a larger budget pass an explicit effortOverride.
 */
export const DEFAULT_EFFORT: EffortLevel = "STANDARD";

// ============================================================================
// VerifierReport
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
  /**
   * S3a: structured fault class emitted by the Verifier agent for any failure.
   * One of: item | infrastructure | environment | transient.
   * Absent (undefined) on a passing report.
   */
  faultClass?: FaultClass;
  /** Gate A + Gate B test execution results emitted by the Verifier sub-agent.
   *  Carried through to ItemReviewSummary.testExecutionResults so Tier1 Check-17
   *  and the RigorousVerifier path can consume them. */
  testExecutionResults?: {
    gateA?: {
      command: string;
      exitCode: number;
      stdout: string;
      testsPassed?: number;
      testsFailed?: number;
      verdict: "PASS" | "FAIL" | "SKIP";
    };
    gateB?: Array<{
      file: string;
      exitCode: number;
      stdout: string;
      verdict: "PASS" | "FAIL";
    }>;
  };
}

// ============================================================================
// LoopResult
// ============================================================================

export type LoopResult =
  | { converged: true; iterations: number; verifierReport: VerifierReport; needsReview: boolean }
  | { converged: false; reason: "stall" | "max_iterations"; lastReport: VerifierReport }
  | { converged: false; reason: "wall_clock_exceeded"; elapsedMs: number; capMs: number; lastReport: VerifierReport | null }
  | { converged: false; reason: "error"; error: string };

// ============================================================================
// LLM Spec Comprehension (Phase 4a)
// ============================================================================

/**
 * A single ISC row as extracted by the LLM spec comprehension module.
 * The LLM must NOT invent, merge, or split rows — one spec ISC entry = one row.
 */
export interface ComprehendedRow {
  id: number;              // Sequential integer starting at 1, preserving spec row order
  description: string;    // The criterion text verbatim
  /** VERBATIM runnable shell command from the spec. null if verify cell is prose with no command. */
  verifyCommand: string | null;
  /** true ONLY if the row inherently needs a human — credential entry, account consent,
   *  physical on-device action, or irreversible-destructive op. Otherwise false. */
  humanRequired: boolean;
  /** true if the criterion concerns a native mobile/desktop UI artifact needing a real device. */
  native: boolean;
  /** true when the verifyCommand SUCCEEDS by exiting non-zero — i.e. the row asserts the
   *  ABSENCE of something (e.g. "grep finds 0 matches", "X is removed"). The LLM sets this
   *  from the criterion's meaning; CommandRunner inverts the pass/fail on exit code.
   *  Optional/defaults to false (normal: exit 0 = pass). */
  invertExit?: boolean;
  /**
   * Broad category of the criterion (Phase 6 — replaces inferCategoryInline regex).
   * "implementation" | "documentation" | "deployment" | "general"
   * Optional — absent in comprehensions from before Phase 6; callers fall back to "general".
   */
  category?: string;
  /**
   * Appropriate test level for this row (Phase 6 — replaces classifyTestLevel regex).
   * "unit" | "integration" | "e2e" | "manual"
   * Optional — absent in comprehensions from before Phase 6; callers fall back to "unit".
   */
  testLevel?: "unit" | "integration" | "e2e" | "manual";
}

export interface ComprehendedPhase {
  number: number;
  name: string;
  rowIds: number[];  // ids of ComprehendedRow entries that belong to this phase
}

export interface ComprehendedSpec {
  rows: ComprehendedRow[];
  complexityHint: "trivial" | "standard" | "thorough";
  /** Phase breakdown if the spec has explicit phase headings; [] for single-phase specs. */
  phases: ComprehendedPhase[];
  /**
   * Set to true when spec content exceeded SPEC_CONTENT_MAX_CHARS and was truncated
   * before being sent to the LLM. Callers should treat this as a warning signal:
   * ISC rows may be incomplete if the truncation cut off part of the criteria section.
   */
  truncated?: boolean;
}
