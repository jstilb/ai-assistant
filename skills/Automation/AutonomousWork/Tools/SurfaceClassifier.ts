/**
 * SurfaceClassifier.ts — reduced to the only surface distinction that still matters.
 *
 * Phase 6: the per-surface RuntimeVerifier strategy dispatch and the per-surface live
 * recipes are gone — Phase L hands the Explorer ONE generic "figure out how to run it"
 * instruction. So we no longer guess browser/cli/api/integration from spec prose or diff
 * paths. The one surface fact that still drives behaviour is **native**: native UI can't
 * be auto-driven here, so native artifacts must route to a human/device check and are
 * never auto-DONE (ADR-0006 / the native → HUMAN_REQUIRED lock).
 *
 * Native is determined by the producer's LLM-classified `item.surface` — the same signal
 * comprehension uses to flag native ISC rows `human-required`. We deliberately do NOT
 * re-guess it from keywords (that was the deterministic machinery this refactor deletes).
 */

import type { WorkItem } from "./WorkQueue.ts";

// ============================================================================
// Types
// ============================================================================

/** The surface label carried through to Phase L (observability + the native lock). */
export type WorkSurface = "browser" | "cli" | "api" | "integration" | "native" | "docs";

/**
 * Map a producer/item surface value (the LLM-classified `item.surface`, enum
 * `browser | native | cli | api | library`, plus the consumer-only `daemon`)
 * to the consumer `WorkSurface`. Returns undefined for absent/unknown values so
 * the caller falls back to a non-native default (ADR-0006).
 */
export function mapProducerSurface(surface: string | undefined): WorkSurface | undefined {
  switch (surface) {
    case "browser": return "browser";
    case "cli": return "cli";
    case "api": return "api";
    case "native": return "native";
    case "library": return "integration";
    case "daemon": return "integration";
    default: return undefined; // absent/unknown → caller defaults to a non-native surface
  }
}

/**
 * Is this a native (real-device UI) artifact? Native cannot be auto-driven in this
 * environment, so a true result forces the human/device check (never an auto-PASS).
 *
 * Driven purely by the producer's surface classification — comprehension already
 * dispositions native ISC rows `human-required`, and the producer tags `item.surface`
 * "native"; this is the single boolean the rest of the pipeline needs.
 *
 * @param specContent reserved for symmetry with callers; native detection intentionally
 *                    does not re-derive the surface from spec prose.
 */
export function isNative(item: WorkItem, _specContent?: string): boolean {
  return mapProducerSurface(item.surface) === "native";
}
