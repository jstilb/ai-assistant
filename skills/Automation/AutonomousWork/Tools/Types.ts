/**
 * Types.ts — Shared types for the AutonomousWork library (WorkQueue,
 * LLMSpecComprehension, Integrator).
 *
 * ISCRow, TechDebtInput, FollowOnLoop and InferenceFn moved here from the
 * deleted orchestrator files (2026-11-05). They still describe persisted
 * WorkItemMetadata fields and the comprehension inference seam.
 */

import type { InferenceLevel } from "../../../../lib/core/Inference.ts";

// ============================================================================
// Persisted WorkItemMetadata shapes
// ============================================================================

export type ISCRowExecutability = "automatable" | "human-required" | "deferred";

export interface ISCRow {
  id: number;
  description: string;
  status: "PENDING" | "DONE" | "VERIFIED" | "EXECUTION_FAILED";
  capability?: string;
  parallel: boolean;
  source?: "EXPLICIT" | "INFERRED" | "IMPLICIT" | "RESEARCH";
  specSection?: string;
  /** True when spec exists but parseSpec returned empty ISC, forcing template fallback */
  specFallback?: boolean;
  /**
   * Whether this row can be completed by automation or requires human action.
   * Field name kept as `disposition` for compatibility with persisted `isc_rows`
   * JSON; the concept is ISC Row Executability (ontology D2 — "disposition" is
   * reserved for the LucidTask routing column).
   */
  disposition?: ISCRowExecutability;
  /** Test level classification from TestStrategy */
  testLevel?: "unit" | "integration" | "e2e" | "manual";
  /** Verification priority — smoke rows run first for fast-fail */
  priority?: "smoke" | "full";
  /** True when this row represents an infrastructure failure, not a work item fault */
  infraFault?: boolean;
  /** Optional evidence artifacts attached when row is marked done */
  evidence?: { files?: string[]; commands?: string[]; summary?: string };
  /** Human-readable instruction for manual ISC rows. */
  verifyMethod?: string;
  verification?: {
    method: string;
    command?: string;
    success_criteria: string;
    result?: "PASS" | "FAIL";
    /** When true, non-zero exit = PASS and zero exit = FAIL (for "X is NOT present" assertions) */
    invertExit?: boolean;
  };
}

export interface TechDebtInput {
  description: string;
  location: string;
  category: string;
}

export interface FollowOnLoop {
  /** Title for the next loop's work item. */
  title: string;
  /** Optional spec path for the next loop (resolved relative to KAYA_HOME if not absolute). */
  specPath?: string;
  /** Optional description override. */
  description?: string;
}

// ============================================================================
// Inference seam (LLMSpecComprehension)
// ============================================================================

/** Injectable inference function — allows test mocking without dynamic import */
export type InferenceFn = (opts: {
  systemPrompt: string;
  userPrompt: string;
  level: InferenceLevel;
  expectJson: boolean;
  timeout: number;
}) => Promise<{ success: boolean; parsed?: unknown; output?: string; error?: string }>;

// ============================================================================
// LLM Spec Comprehension (Phase 4a)
// ============================================================================

/**
 * A single ISC row as extracted by the LLM spec comprehension module.
 * The LLM must NOT invent, merge, or split rows — one spec ISC entry = one row.
 */
export interface ComprehendedRow {
  id: number; // Sequential integer starting at 1, preserving spec row order
  description: string; // The criterion text verbatim
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
  rowIds: number[]; // ids of ComprehendedRow entries that belong to this phase
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
