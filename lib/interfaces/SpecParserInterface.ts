/**
 * lib/interfaces/SpecParserInterface.ts — Shared ISC criterion type.
 *
 * ISpecParser was removed in Phase 6 (dead interface — SpecParser.ts deleted,
 * SpecPipelineRunner no longer uses dynamic import for ISC extraction).
 * ISCCriterion is retained because TestStrategyGenerator uses it as its
 * internal row shape when mapping from ComprehendedRow.
 */

/** A single ISC (Ideal State Criteria) row extracted from a spec */
export interface ISCCriterion {
  /** Row number (e.g. 1, 2, 101) */
  number: number;
  /** Description of the criterion */
  description: string;
  /** How to verify the criterion is met */
  verifyMethod?: string;
  /** Embedded command for automated verification */
  embeddedCommand?: string;
  /** Whether this is a smoke test (fast-fail) criterion */
  priority?: "smoke" | "normal";
  /** Source file/section reference */
  source?: string;
}
