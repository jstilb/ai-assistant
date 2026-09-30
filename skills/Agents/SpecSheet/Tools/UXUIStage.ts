/**
 * UXUIStage.ts — Pure orchestration decisions for the shared UX/UI Stage.
 *
 * Single source of truth for the gating / model / sequence rules used by:
 *   - Interactive workflow: CurrentWork.md (Step 4d)
 *   - Automated pipeline: SpecPipelineRunner (Slice 6 — not wired here yet)
 *
 * These functions are deliberately pure and dependency-free so they can be
 * imported by the pipeline and mirrored exactly in the markdown instruction docs.
 *
 * Rules (from Design Brief §10 + ADRs 0004 / 0006):
 *   - Surface gate : UX/UI Stage runs only for `browser` or `native` surfaces.
 *   - Model        : Small/Medium effort → Sonnet; Large effort → Opus.
 *   - Review gate  : Designer review pass (always Opus) on Medium or Large only.
 *   - Sequence     : UXDesigner → UIDesigner → Designer? (if review fires)
 */

// cross-skill-allowed: type-only import (erased at runtime) — Surface is the shared UX/UI surface taxonomy also used by LucidTasks' KayaTaskClassifier
import type { Surface } from "../../../Productivity/LucidTasks/Tools/KayaTaskClassifier.ts";

// ============================================================================
// Exported Types
// ============================================================================

/** Effort tier (mirrors CurrentWork.md + CONTEXT.md vocabulary). */
export type Effort = "Small" | "Medium" | "Large";

/** One agent step in the ordered UX/UI Stage sequence. */
export interface StageStep {
  agent: "UXDesigner" | "UIDesigner" | "Designer";
  model: "Sonnet" | "Opus";
}

/** The ordered sequence returned by planUXUIStage. Empty when surface is non-UI. */
export type StagePlan = StageStep[];

// ============================================================================
// Surface Gate
// ============================================================================

/**
 * Returns true iff the given surface warrants UX/UI spec generation.
 * Only `browser` and `native` fire the Stage; all others (cli/api/library)
 * and undefined (legacy/no-surface items) do not.
 */
export function shouldRunUXUI(surface: Surface | undefined): boolean {
  return surface === "browser" || surface === "native";
}

// ============================================================================
// Model Selection
// ============================================================================

/**
 * Returns the generator model for a given effort tier.
 *   Small  → Sonnet  (fast, sufficient for lean scope)
 *   Medium → Sonnet  (default; adequate depth)
 *   Large  → Opus    (full personas / per-state realizations require deeper reasoning)
 */
export function modelForEffort(effort: Effort): "Sonnet" | "Opus" {
  return effort === "Large" ? "Opus" : "Sonnet";
}

// ============================================================================
// Designer Review Gate
// ============================================================================

/**
 * Returns true iff the Designer review pass should run.
 * Review fires on Medium and Large effort; it is skipped on Small (ADR 0006 +
 * Design Brief §10: "Designer review only on Medium+, at Opus").
 */
export function shouldRunReview(effort: Effort): boolean {
  return effort === "Medium" || effort === "Large";
}

// ============================================================================
// Stage Plan
// ============================================================================

/**
 * Returns the ordered agent sequence for the UX/UI Stage.
 *
 * Returns [] when shouldRunUXUI is false.
 * Otherwise returns:
 *   [UXDesigner(model), UIDesigner(model), ...Designer(Opus) if review]
 *
 * where model = modelForEffort(effort).
 */
export function planUXUIStage(input: {
  surface: Surface | undefined;
  effort: Effort;
}): StagePlan {
  if (!shouldRunUXUI(input.surface)) {
    return [];
  }

  const model = modelForEffort(input.effort);

  const steps: StagePlan = [
    { agent: "UXDesigner", model },
    { agent: "UIDesigner", model },
  ];

  if (shouldRunReview(input.effort)) {
    steps.push({ agent: "Designer", model: "Opus" });
  }

  return steps;
}
