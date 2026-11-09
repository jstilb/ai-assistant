/**
 * Render.ts — EventScout markdown renderer.
 *
 * renderTiered(events, c?) → string
 *
 * The first FULL_TIER_SIZE events per date group get full cards; the rest get compact entries.
 * If total ≤ FULL_TIER_SIZE, all events are full cards (no compact section).
 * This is the sole renderer used by the query pipeline (Query.ts).
 */

import type { EventItem, QueryContext, QueryCoverage } from "./types.ts";
import type { RankedEvent } from "./Ranker.ts";
import { isNaiveDatetime, naiveLaToUtcMs, utcIsoToLaIso } from "./lib/tz.ts";
import { bestLink } from "./lib/links.ts";

// ============================================================================
// Internal helpers
// ============================================================================

/**
 * Format an ISO 8601 datetime string to a human-readable LA local date+time.
 * e.g. "2026-06-06T19:00:00-07:00" → "Sat, Jun 6, 2026 at 7:00 PM PDT"
 */
function formatDateTime(isoStr: string, timeOnly = false): string {
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
      ...(timeOnly ? {} : { weekday: "short", month: "short", day: "numeric", year: "numeric" } as const),
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
      timeZoneName: "short",
    }).format(d);
  } catch {
    return laIso;
  }
}

function formatEventDateTime(e: EventItem): string {
  if (!e.allDay) {
    if (e.startTimeKnown === false || e.endTimeKnown === false) {
      const dateLabel = (value: string): string => {
        try {
          const date = /^\d{4}-\d{2}-\d{2}$/.test(value)
            ? value : utcIsoToLaIso(new Date(value).toISOString()).slice(0, 10);
          return new Intl.DateTimeFormat("en-US", {
            timeZone: "UTC", weekday: "short", month: "short", day: "numeric", year: "numeric",
          }).format(new Date(`${date}T12:00:00Z`));
        } catch {
          return value;
        }
      };
      const startDate = dateLabel(e.startDatetime);
      const start = e.startTimeKnown === false ? startDate : formatDateTime(e.startDatetime);
      if (!e.endDatetime) return e.startTimeKnown === false ? `${start} · Time unavailable` : start;
      const endDate = dateLabel(e.endDatetime);
      if (e.startTimeKnown === false && e.endTimeKnown === false) {
        return `${startDate}${endDate !== startDate ? ` – ${endDate}` : ""} · Time unavailable`;
      }
      if (e.startTimeKnown === false) {
        return `${start} – ${formatDateTime(e.endDatetime)} · Start time unavailable`;
      }
      return `${start}${endDate !== startDate ? ` – ${endDate}` : ""} · End time unavailable`;
    }
    const start = formatDateTime(e.startDatetime);
    if (!e.endDatetime) return start;
    try {
      const startDate = new Date(e.startDatetime);
      const endDate = new Date(e.endDatetime);
      if (!Number.isFinite(endDate.getTime()) || endDate < startDate) return `${start} · End time unavailable`;
      const sameDay = utcIsoToLaIso(startDate.toISOString()).slice(0, 10)
        === utcIsoToLaIso(endDate.toISOString()).slice(0, 10);
      return `${start} – ${formatDateTime(e.endDatetime, sameDay)}`;
    } catch {
      return `${start} · End time unavailable`;
    }
  }
  const calendarDate = (value: string): string => /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? value : utcIsoToLaIso(new Date(value).toISOString()).slice(0, 10);
  try {
    const start = calendarDate(e.startDatetime);
    const end = e.endDatetime ? calendarDate(e.endDatetime) : start;
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: "UTC", weekday: "short", month: "short", day: "numeric", year: "numeric",
    });
    const dateLabel = (date: string): string => formatter.format(new Date(`${date}T12:00:00Z`));
    const range = end !== start ? `${dateLabel(start)} – ${dateLabel(end)}` : dateLabel(start);
    return `${range} · All day`;
  } catch {
    return `${e.startDatetime}${e.endDatetime ? ` – ${e.endDatetime}` : ""} · All day`;
  }
}

/**
 * Format price display: "Free" / "$25–$75" / "$25" / "Price unknown"
 */
function formatEventLocation(e: EventItem): string {
  const venue = e.venue?.trim();
  const address = e.address?.trim();
  if (!venue) return address || "Venue TBD";
  if (!address || venue.replace(/\s+/g, " ").toLowerCase() === address.replace(/\s+/g, " ").toLowerCase()) return venue;
  return `${venue}, ${address}`;
}

function formatPrice(e: EventItem): string {
  if (e.admissionNote) return `Source admission: ${e.admissionNote}`;
  if (e.isFree) return "Free";
  if (e.priceMin !== undefined && e.priceMax !== undefined) {
    if (e.priceMin === e.priceMax) return `$${e.priceMin}`;
    return `$${e.priceMin}–$${e.priceMax}`;
  }
  if (e.priceMin !== undefined) return `$${e.priceMin}+`;
  if (e.priceMax !== undefined) return `up to $${e.priceMax}`;
  return "Price unknown";
}

function formatSourceDescription(e: EventItem): string | undefined {
  const description = e.sourceDescription?.trim().replace(/\s+/g, " ");
  if (!description) return undefined;
  const excerpt = description.slice(0, 500).replace(/([\\`*_[\]<>])/g, "\\$1");
  const clipped = description.length > 500 ? " … (excerpt; full text in source)" : "";
  const sourceLink = bestLink(e) === e.sourceUrl ? "" : ` · [Source](${e.sourceUrl})`;
  return `**Source description:** ${excerpt}${clipped}${sourceLink}`;
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

  if (c.home && Number.isFinite(c.radiusMiles)) {
    parts.push(`radius requested: ${c.radiusMiles}mi`);
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

function hasUsableCoordinates(event: EventItem): boolean {
  return typeof event.lat === "number" && Number.isFinite(event.lat) && Math.abs(event.lat) <= 90
    && typeof event.lng === "number" && Number.isFinite(event.lng) && Math.abs(event.lng) <= 180;
}

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
function coverageLines(coverage: QueryCoverage | undefined): string[] {
  if (!coverage) return [];
  if (coverage.mode === "cache") {
    return ["> Source coverage: Cache only; no sources were refreshed. Current availability is unverified. Use `--refresh` to request a refresh."];
  }
  if (coverage.attemptedSources.length === 0) {
    return ["> Source coverage: No enabled sources matched the source selection. Results use the existing cache; current availability is unverified. Check enabled sources and category filters before retrying `--refresh`."];
  }
  const lines = [`> Source coverage: ${coverage.refreshedSources.length} of ${coverage.attemptedSources.length} selected sources refreshed. Results may include older cached events.`];
  if (coverage.failedSources.length > 0) {
    const ids = coverage.failedSources.map(id => id.replace(/[^a-zA-Z0-9_.-]/g, "_")).join(", ");
    lines.push(`> Unavailable this attempt: ${ids}. Coverage is incomplete; cached events from these sources may remain. Retry \`--refresh\` later; use event links to confirm details.`);
  }
  if (coverage.persistenceFailed) {
    lines.push("> Cache update failed. Results include fetched events and the existing cache; saving these results could not be confirmed. Retry `--refresh` later; use event links to confirm details.");
  }
  return lines;
}

export function renderTiered(events: RankedEvent[], c?: QueryContext, coverage?: QueryCoverage): string {
  const constraintSummary = summarizeConstraints(c);
  const rawQuery = c?.rawQuery ? `"${c.rawQuery}"` : "events";
  const total = events.length;
  const finiteRadius = c !== undefined && Number.isFinite(c.radiusMiles);
  const unknownCount = finiteRadius ? events.filter(event => !hasUsableCoordinates(event)).length : 0;
  const resultLabel = unknownCount > 0 ? "results" : "matches";

  // ---- 0 events: graceful no-results ----
  if (total === 0) {
    const lines: string[] = [`## EventScout — No results for ${rawQuery}`];
    if (constraintSummary) lines.push(`> Filters: ${constraintSummary}`);
    lines.push(...coverageLines(coverage));
    lines.push("");
    lines.push(
      coverage
        ? "No matching events are available in the cache. This does not establish that no events exist. Try a broader date range, radius, price, or category filter."
        : "No events matched your criteria. Try broadening your date range, increasing the radius, or relaxing the price or category filter."
    );
    return lines.join("\n");
  }

  const fullCount = Math.min(FULL_TIER_SIZE, total);
  let groups: { label?: string; events: RankedEvent[] }[] = [{ events }];
  const windowStart = c?.window ? Date.parse(c.window.start) : NaN;
  const windowEnd = c?.window ? Date.parse(c.window.end) : NaN;
  if (Number.isFinite(windowStart) && Number.isFinite(windowEnd) && windowStart <= windowEnd) {
    const dated: RankedEvent[] = [];
    const earlier: RankedEvent[] = [];
    const later: RankedEvent[] = [];
    const unknown: RankedEvent[] = [];
    for (const event of events) {
      const start = isNaiveDatetime(event.startDatetime)
        ? naiveLaToUtcMs(event.startDatetime) : Date.parse(event.startDatetime);
      if (!Number.isFinite(start)) unknown.push(event);
      else if (start < windowStart) earlier.push(event);
      else if (start > windowEnd) later.push(event);
      else dated.push(event);
    }
    if (earlier.length > 0) {
      groups = [
        { label: "Starts within requested dates", events: dated },
        { label: "Started before requested dates", events: earlier },
        { label: "Starts after requested dates", events: later },
        { label: "Start date unavailable", events: unknown },
      ].filter(group => group.events.length > 0);
    }
  }
  const grouped = groups.some(group => group.label !== undefined);

  // ---- Header ----
  const lines: string[] = [
    grouped
      ? `## EventScout — ${total} ${resultLabel} for ${rawQuery}`
      : `## EventScout — Top ${fullCount} of ${total} ${resultLabel} for ${rawQuery}`,
  ];
  if (constraintSummary) lines.push(`> Filters: ${constraintSummary}`);
  lines.push(...coverageLines(coverage));
  if (events.some(event => event.sourceDescription?.trim())) lines.push("> Source descriptions quote calendar text and may disagree with the displayed date or place. Neither is independently confirmed.");
  if (finiteRadius) lines.push(`> Distance: ${total - unknownCount} with usable coordinates; ${unknownCount} with unknown distance. Radius checked where coordinates are available.`);
  if (grouped) lines.push("> Presentation: Grouped by start date relative to the requested dates. Order within each group follows the supplied ranking; all results remain below.");
  lines.push("");

  let rankOffset = 0;
  for (const group of groups) {
    if (group.label) lines.push(`## ${group.label} (${group.events.length})`, "");
    const fullCount = Math.min(FULL_TIER_SIZE, group.events.length);
    const fullEvents = group.events.slice(0, fullCount);
    const compactEvents = group.events.slice(fullCount);

    // ---- Full tier ----
    for (let i = 0; i < fullEvents.length; i++) {
      const e = fullEvents[i];
      if (!e) continue;
      const rank = rankOffset + i + 1;
      const datetime = formatEventDateTime(e) + (e.recurrenceRule
          ? ` · ${e.recurrenceOverride ? "Source recurrence override: explicit occurrence date; series rule" : "Source recurrence projection"}: ${e.recurrenceRule}; occurrence not independently confirmed` : "");
      const venue = formatEventLocation(e);
      const price = formatPrice(e);
      const link = bestLink(e);
      const cat = e.category;

      lines.push(`### ${rank}. ${e.title}`);
      lines.push(`> _${e.why}_`);
      lines.push(`- **When:** ${datetime}`);
      lines.push(`- **Where:** ${venue}`);
      if (finiteRadius && !hasUsableCoordinates(e)) lines.push("- **Distance:** Distance unknown; radius not verified");
      lines.push(`- **Price:** ${price}`);
      lines.push(`- **Category:** ${cat}`);
      lines.push(`- **Link:** ${link}`);
      const sourceDescription = formatSourceDescription(e);
      if (sourceDescription) lines.push(`- ${sourceDescription}`);
      lines.push("");
    }

    // ---- Compact tier ----
    if (compactEvents.length > 0) {
      lines.push(`### More ${resultLabel} (${compactEvents.length})`);
      lines.push("");
      for (let i = 0; i < compactEvents.length; i++) {
        const e = compactEvents[i];
        if (!e) continue;
        const rank = rankOffset + fullCount + i + 1;
        const datetime = formatEventDateTime(e) + (e.recurrenceRule
          ? ` · ${e.recurrenceOverride ? "Source recurrence override: explicit occurrence date; series rule" : "Source recurrence projection"}: ${e.recurrenceRule}; occurrence not independently confirmed` : "");
        const venue = formatEventLocation(e);
        const price = formatPrice(e);
        const link = bestLink(e);

        const distance = finiteRadius && !hasUsableCoordinates(e) ? " · Distance unknown; radius not verified" : "";
        lines.push(`${rank}. ${e.title} · ${datetime} · ${venue} · ${price} · ${link}${distance}`);
        lines.push(`    - **Why:** ${e.why.trim().replace(/\s+/g, " ") || "Reason unavailable"}`);
        const sourceDescription = formatSourceDescription(e);
        if (sourceDescription) lines.push(`    - ${sourceDescription}`);
      }
    }
    rankOffset += group.events.length;
  }

  return lines.join("\n").trimEnd();
}
