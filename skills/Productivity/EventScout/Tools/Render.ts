/**
 * Render.ts — EventScout markdown renderer.
 *
 * renderTiered(events, c?) → string
 *
 * Top FULL_TIER_SIZE events get full cards; the rest get compact one-liners.
 * If total ≤ FULL_TIER_SIZE, all events are full cards (no compact section).
 * This is the sole renderer used by the query pipeline (Query.ts).
 */

import type { EventItem, QueryContext } from "./types.ts";
import type { RankedEvent } from "./Ranker.ts";
import { utcIsoToLaIso } from "./lib/tz.ts";
import { bestLink } from "./lib/links.ts";

// ============================================================================
// Internal helpers
// ============================================================================

/**
 * Format an ISO 8601 datetime string to a human-readable LA local date+time.
 * e.g. "2026-06-06T19:00:00-07:00" → "Sat Jun 6, 7:00 PM"
 */
function formatDateTime(isoStr: string): string {
  // Ensure we have an offset-aware ISO before formatting
  let laIso: string;
  try {
    // If the string already has an offset, use it; otherwise convert from UTC
    if (/[+-]\d{2}:\d{2}$/.test(isoStr) || isoStr.endsWith("Z")) {
      laIso = utcIsoToLaIso(new Date(isoStr).toISOString());
    } else {
      laIso = isoStr; // already local, use as-is
    }
  } catch {
    return isoStr; // fallback: raw string
  }

  try {
    const d = new Date(laIso);
    return new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Los_Angeles",
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    }).format(d);
  } catch {
    return laIso;
  }
}

/**
 * Format price display: "Free" / "$25–$75" / "$25" / "—"
 */
function formatPrice(e: EventItem): string {
  if (e.isFree) return "Free";
  if (e.priceMin !== undefined && e.priceMax !== undefined) {
    if (e.priceMin === e.priceMax) return `$${e.priceMin}`;
    return `$${e.priceMin}–$${e.priceMax}`;
  }
  if (e.priceMin !== undefined) return `$${e.priceMin}+`;
  if (e.priceMax !== undefined) return `up to $${e.priceMax}`;
  return "—";
}

/**
 * Build a summary line describing the active constraints.
 */
function summarizeConstraints(c: QueryContext | undefined): string {
  if (!c) return "";

  const parts: string[] = [];

  if (c.window) {
    const start = c.window.start.slice(0, 10);
    const end = c.window.end.slice(0, 10);
    if (start === end) {
      parts.push(`date: ${start}`);
    } else {
      parts.push(`${start} → ${end}`);
    }
  }

  if (c.categories && c.categories.length > 0) {
    parts.push(`category: ${c.categories.join(", ")}`);
  }

  if (c.free) {
    parts.push("price: free");
  } else if (c.maxPrice !== undefined) {
    parts.push(`price: under $${c.maxPrice}`);
  }

  if (c.home && c.radiusMiles !== undefined) {
    parts.push(`within ${c.radiusMiles}mi`);
  }

  if (c.timeOfDay && c.timeOfDay.length > 0) {
    parts.push(`time: ${c.timeOfDay.join(", ")}`);
  }

  return parts.length > 0 ? `[${parts.join(" | ")}]` : "";
}

// ============================================================================
// renderTiered — top N full cards + compact one-liners for the rest
// ============================================================================

/**
 * Number of top events that receive a full card.
 * Events ranked beyond this receive a compact one-liner.
 */
export const FULL_TIER_SIZE = 10;

/**
 * Render ranked events in two tiers:
 *   - Full tier: top FULL_TIER_SIZE events as ranked cards with why-lines.
 *   - Compact tier: remaining events as a single line each:
 *       N. {Title} · {Day Mon D, h:mmAM} · {Venue} · {Price} · {Link}
 *
 * If total events ≤ FULL_TIER_SIZE, all are rendered as full cards.
 * If 0 events, returns a graceful no-results message.
 *
 * @param events - RankedEvent[] (pre-ranked, first = best).
 * @param c      - Optional QueryContext for header/constraint summary.
 */
export function renderTiered(events: RankedEvent[], c?: QueryContext): string {
  const constraintSummary = summarizeConstraints(c);
  const rawQuery = c?.rawQuery ? `"${c.rawQuery}"` : "events";
  const total = events.length;

  // ---- 0 events: graceful no-results ----
  if (total === 0) {
    const lines: string[] = [
      `## EventScout — No results for ${rawQuery}`,
    ];
    if (constraintSummary) lines.push(`> Filters: ${constraintSummary}`);
    lines.push("");
    lines.push(
      "No events matched your criteria. Try broadening your date range, increasing the radius, or relaxing the price or category filter."
    );
    return lines.join("\n");
  }

  const fullCount = Math.min(FULL_TIER_SIZE, total);
  const fullEvents = events.slice(0, fullCount);
  const compactEvents = events.slice(fullCount);

  // ---- Header ----
  const lines: string[] = [
    `## EventScout — Top ${fullCount} of ${total} matches for ${rawQuery}`,
  ];
  if (constraintSummary) lines.push(`> Filters: ${constraintSummary}`);
  lines.push("");

  // ---- Full tier ----
  for (let i = 0; i < fullEvents.length; i++) {
    const e = fullEvents[i]!;
    const rank = i + 1;
    const datetime = formatDateTime(e.startDatetime);
    const venue = e.venue ?? "Venue TBD";
    const price = formatPrice(e);
    const link = bestLink(e);
    const cat = e.category;

    lines.push(`### ${rank}. ${e.title}`);
    lines.push(`> _${e.why}_`);
    lines.push(`- **When:** ${datetime}`);
    lines.push(`- **Where:** ${venue}`);
    lines.push(`- **Price:** ${price}`);
    lines.push(`- **Category:** ${cat}`);
    lines.push(`- **Link:** ${link}`);
    lines.push("");
  }

  // ---- Compact tier ----
  if (compactEvents.length > 0) {
    lines.push(`### More matches (${compactEvents.length})`);
    lines.push("");
    for (let i = 0; i < compactEvents.length; i++) {
      const e = compactEvents[i]!;
      const rank = fullCount + i + 1;
      const datetime = formatDateTime(e.startDatetime);
      const venue = e.venue ?? "Venue TBD";
      const price = formatPrice(e);
      const link = bestLink(e);

      lines.push(`${rank}. ${e.title} · ${datetime} · ${venue} · ${price} · ${link}`);
    }
  }

  return lines.join("\n").trimEnd();
}
