/**
 * Filter.ts — EventScout hard filter (Slice 6; markdown-first re-intake 2026-07).
 *
 * Pure function: filterEvents(events, c) → EventItem[]
 *
 * Applies all active hard constraints from the QueryContext (the agent-resolved,
 * structured query intake — see types.ts):
 *   - window:    startDatetime in [window.start, window.end] (inclusive day bounds).
 *                Always active — QueryContext.window is never undefined (the CLI
 *                defaults it to the next 14 days when --from/--to are omitted).
 *   - home/radiusMiles: haversine miles from c.home to event ≤ radiusMiles.
 *                Events with undefined lat/lng are KEPT regardless (unknown
 *                locality is surfaced to the ranking LLM as a text signal in the
 *                event's scoring line — no code-level penalty, not a hard gate).
 *   - free:      only isFree===true kept.
 *   - maxPrice:  isFree OR (priceMin ?? priceMax) ≤ maxPrice kept.
 *   - categories: hard filter iff present — the agent has already decided this
 *                is explicit (it only passes --category when the user named one).
 *   - timeOfDay:  LA local hour falls in the requested band(s)
 *                   morning   5–12
 *                   afternoon 12–17
 *                   evening   17–22
 *                   late      22–5  (wraps midnight)
 *
 * Result is sorted by startDatetime ascending.
 *
 * No I/O, no side effects. Import freely in tests.
 */

import type { EventItem, QueryContext } from "./types.ts";
import { utcMsToLaParts } from "./lib/tz.ts";

// ============================================================================
// Haversine distance (miles)
// ============================================================================

const EARTH_RADIUS_MILES = 3958.8;

function toRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

/**
 * Haversine great-circle distance in miles between two lat/lng points.
 */
function haversineMiles(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number
): number {
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return EARTH_RADIUS_MILES * 2 * Math.asin(Math.sqrt(a));
}

// ============================================================================
// TimeOfDay band check
// ============================================================================

type TimeOfDay = "morning" | "afternoon" | "evening" | "late";

/**
 * Return true iff the LA local hour of `startDatetime` falls in `band`.
 *
 * Bands (LA local hour):
 *   morning   [5, 12)
 *   afternoon [12, 17)
 *   evening   [17, 22)
 *   late      [22, 5)  — wraps midnight
 */
function inTimeOfDayBand(startDatetime: string, band: TimeOfDay): boolean {
  const utcMs = new Date(startDatetime).getTime();
  if (isNaN(utcMs)) return false;
  const { hour } = utcMsToLaParts(utcMs);

  switch (band) {
    case "morning":
      return hour >= 5 && hour < 12;
    case "afternoon":
      return hour >= 12 && hour < 17;
    case "evening":
      return hour >= 17 && hour < 22;
    case "late":
      return hour >= 22 || hour < 5;
  }
}

// ============================================================================
// Main filter
// ============================================================================

/**
 * Apply hard constraints to a list of events.
 *
 * Each constraint is AND-gated (every active constraint must pass).
 * Result is sorted by startDatetime ascending.
 */
export function filterEvents(
  events: EventItem[],
  c: QueryContext
): EventItem[] {
  let result = events;

  // ---- window filter --------------------------------------------------------
  // Always active — QueryContext.window is never undefined (cli.ts defaults it
  // to the next 14 days when --from/--to are omitted; see buildDefaultWindow).
  {
    const windowStart = new Date(c.window.start).getTime();
    const windowEnd = new Date(c.window.end).getTime();
    result = result.filter((e) => {
      const t = new Date(e.startDatetime).getTime();
      return t >= windowStart && t <= windowEnd;
    });
  }

  // ---- location / radius filter ------------------------------------------
  // Always active — QueryContext.home/radiusMiles are never undefined.
  {
    const { lat: homeLat, lng: homeLng } = c.home;
    const radius = c.radiusMiles;
    result = result.filter((e) => {
      // Events WITH coords beyond the radius are excluded (correctly removes
      // far away-game stadiums, which are always geocoded).
      // Events with NO coords are KEPT — geocoding covers only ~50% of the
      // catalog, and hard-excluding the rest silently hid half the events
      // (e.g. ICS-sourced community events with no per-event geocode). Unknown
      // locality reaches the ranking LLM as a text signal in the scoring line;
      // the LLM decides how much it matters — no code-level penalty.
      if (e.lat === undefined || e.lng === undefined) return true;
      return haversineMiles(homeLat, homeLng, e.lat, e.lng) <= radius;
    });
  }

  // ---- price filter -------------------------------------------------------
  // free/maxPrice are independent flags (SKILL.md tells the agent not to pass
  // both — see "How to invoke query" — but if both are set, they AND-combine
  // rather than crash).
  if (c.free === true) {
    result = result.filter((e) => e.isFree === true);
  }
  if (c.maxPrice !== undefined) {
    const maxPrice = c.maxPrice;
    result = result.filter((e) => {
      if (e.isFree) return true;
      // Use priceMin as the minimum cost to attend. If no price info at all,
      // treat as unknown → exclude (Infinity > maxPrice).
      const lowestCost = e.priceMin ?? e.priceMax ?? Infinity;
      return lowestCost <= maxPrice;
    });
  }

  // ---- category filter ----------------------------------------------------
  // Hard-filter iff present. The CALLING AGENT now owns the "explicit vs
  // inferred" judgment that ConstraintParser's LLM-guessed categoriesExplicit
  // used to make: it only passes --category when the user NAMED a category
  // directly (e.g. "comedy shows"). A vibe/goal query ("meet people") gets no
  // --category flag at all — that's a soft ranking signal handled entirely by
  // Ranker.ts, not a hard gate here (otherwise a fuzzy social query would drop
  // salsa/comedy/food events that fit the intent just as well).
  if (c.categories && c.categories.length > 0) {
    const catSet = new Set(c.categories);
    result = result.filter((e) => catSet.has(e.category));
  }

  // ---- timeOfDay filter ---------------------------------------------------
  if (c.timeOfDay && c.timeOfDay.length > 0) {
    const bands = c.timeOfDay as TimeOfDay[];
    result = result.filter((e) =>
      bands.some((band) => inTimeOfDayBand(e.startDatetime, band))
    );
  }

  // ---- sort ascending by startDatetime ------------------------------------
  result = result.slice().sort(
    (a, b) => new Date(a.startDatetime).getTime() - new Date(b.startDatetime).getTime()
  );

  return result;
}
