/**
 * RefreshIntent.ts — Pure function for cache-first refresh source selection
 * (Slice 1; markdown-first re-intake 2026-07 — the old NL refresh-intent
 * word-matcher is deleted: refresh intent is now the CALLING AGENT's
 * judgment, expressed as cli.ts's `--refresh` flag — see SKILL.md's
 * "How to invoke query (agents)").
 *
 * Exports:
 *   selectRefreshSources({ refresh, sources, constraints }) → EventSource[]
 *     Decides which sources to live-refresh:
 *       refresh=false → [] (nothing; cache-only path)
 *       refresh=true  → all enabled, category-relevant sources (staleness
 *                        and highValue are both IGNORED — caller asked explicitly)
 *
 * PURE — no I/O, no side-effects. Import freely in tests.
 */

import type { EventSource, Category } from "./types.ts";

// ============================================================================
// selectRefreshSources
// ============================================================================

/**
 * Structural subset of ConstraintSet/QueryContext this module actually reads.
 * Both types satisfy this shape, so callers on either the legacy NL path or
 * the new structured QueryContext path can pass their query object as-is.
 */
export interface CategoryConstraint {
  categories?: Category[];
}

export interface SelectRefreshSourcesArgs {
  /** Whether a live refresh was requested (via flag or NL intent). */
  refresh: boolean;
  /** Full source registry. */
  sources: EventSource[];
  /** Query context/constraints (only `categories` is consulted here). */
  constraints: CategoryConstraint;
}

/**
 * Returns true if the source is relevant to the given constraints.
 *
 * A source is relevant when:
 *   - constraints.categories is not set (any category OK), OR
 *   - the source has no categoryHint (could surface any category), OR
 *   - the source's categoryHint is in constraints.categories.
 */
function isCategoryRelevant(source: EventSource, constraints: CategoryConstraint): boolean {
  const { categories } = constraints;
  if (!categories || categories.length === 0) return true;
  if (!source.categoryHint) return true;
  return (categories as Category[]).includes(source.categoryHint);
}

/**
 * Selects which sources to live-refresh for a query.
 *
 * - refresh=false → returns [] (pure cache read; highValue is NOT consulted)
 * - refresh=true  → returns all ENABLED, category-relevant sources.
 *                   Staleness and highValue have no effect on selection;
 *                   when the user explicitly requests fresh data, all relevant
 *                   sources are refreshed regardless.
 *
 * PURE function — deterministic for the same inputs.
 */
export function selectRefreshSources({
  refresh,
  sources,
  constraints,
}: SelectRefreshSourcesArgs): EventSource[] {
  if (!refresh) return [];

  return sources.filter(
    (s) => s.enabled && isCategoryRelevant(s, constraints)
  );
}
