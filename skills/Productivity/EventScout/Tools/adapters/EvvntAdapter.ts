#!/usr/bin/env bun
/**
 * EvvntAdapter.ts — Generic adapter for the Evvnt events-discovery platform.
 *
 * Evvnt is used by many local-news sites (e.g. inewsource) as a white-labelled
 * events calendar. Each publisher has a numeric publisher_id. The home-page
 * events API returns a flat JSON object with a `rawEvents` array.
 *
 * First consumer: inewsource (publisher_id 11515).
 *
 * Exports:
 *   mapEvvntEventToItem(raw: EvvntEvent, source: EventSource): EventItem
 *       PURE function — no network. Maps one Evvnt API event object to EventItem.
 *       Throws only when there is truly no parseable date.
 *       HTML description is stripped to plain text.
 *
 *   fetchEvvntEvents(source: EventSource): Promise<EventItem[]>
 *       Fetches source.url (which must already carry publisher_id + params), then
 *       paginates by incrementing the `page` query param up to MAX_PAGES.
 *       Maps each raw event through mapEvvntEventToItem, drops failures,
 *       filters to future events, deduplicates by id, and returns the array.
 *       Throws on HTTP/JSON failure so Ingest records the failure reason.
 *
 * Date handling:
 *   Evvnt `start_time` / `end_time` are already offset-aware ISO 8601 strings
 *   (e.g. "2026-06-08T08:00:00-07:00"). We parse them via new Date() and then
 *   normalise to a canonical LA-offset ISO string via utcIsoToLaIso().
 *   Fallback: if start_time is missing/unparseable, we fall back to start_date
 *   (a "YYYY-MM-DD" LA-local date string), treating it as LA midnight.
 *
 * Category mapping:
 *   Evvnt category_name is a string (e.g. "Conferences"). We lowercase and
 *   keyword-match against our Category enum.
 *
 * Price:
 *   Evvnt home-page feed carries no reliable free/paid signal; isFree = false.
 *
 * Image:
 *   images entries may be objects { url: string } or bare URL strings; we guard both.
 *
 * Pagination:
 *   source.url must carry `page=0` (Evvnt uses 0-based pages). We increment and
 *   stop when rawEvents is empty or shorter than hitsPerPage.
 */

import { createHash } from "crypto";
import type { EventItem, EventSource, Category } from "../types.ts";
import { EventItemSchema } from "../types.ts";
import { utcIsoToLaIso, naiveLaToUtcMs } from "../lib/tz.ts";

// ============================================================================
// Evvnt API types (minimal — only fields we use; allow unknown extras)
// ============================================================================

export interface EvvntVenue {
  name?: string;
  address_1?: string;
  address_2?: string | null;
  town?: string;
  [key: string]: unknown;
}

export interface EvvntEvent {
  objectID: string | number;
  title: string;
  start_date?: string;        // "YYYY-MM-DD"
  start_time?: string;        // "YYYY-MM-DDTHH:MM:SS±HH:MM" — already offset-aware
  end_time?: string | null;   // same format, may be null/absent
  venue?: EvvntVenue | null;
  category_name?: string;
  description?: string;
  // Live API returns nested image objects ({ original:{url}, featured:{url} }) or strings.
  images?: unknown;
  // Live API returns a DICT { "Tickets": url, "Website": url } — not an array.
  // Accept both shapes (dict from Evvnt; array tolerated for safety).
  links?: Record<string, string> | string[];
  original_links?: Record<string, string> | string[];
  organiser_name?: string;
  online_only?: boolean;
  // Live API returns comma-separated strings, not arrays. Accept both.
  keywords?: string | string[];
  artists?: string | string[];
  [key: string]: unknown;
}

export interface EvvntResponse {
  rawEvents: EvvntEvent[];
  rawFacets?: unknown;
  rawFeaturedEvents?: unknown;
  rawEditorsPickEvents?: unknown;
  [key: string]: unknown;
}

// ============================================================================
// Constants
// ============================================================================

// MAX_PAGES removed (Slice 6: horizon-driven pagination replaces fixed cap).
// HITS_PER_PAGE is kept — it is part of the API request param AND the natural
// last-page stop signal (events.length < HITS_PER_PAGE).
const HITS_PER_PAGE = 50;

// Safety bound: stop if we somehow never hit an empty/short page.
// Evvnt publishers rarely have > 2000 events; 40 pages × 50 = 2000 is generous.
// When hit, log loudly — never truncate silently.
const MAX_PAGES_SAFETY = 40;

// ============================================================================
// Stable ID — same convention as WordPressTecAdapter (SPEC §4.1)
// ============================================================================

function canonical(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, " ");
}

function stableId(title: string, startDatetime: string, venueOrUrl: string): string {
  const raw = `${canonical(title)}|${startDatetime}|${canonical(venueOrUrl)}`;
  return createHash("sha256").update(raw).digest("hex").slice(0, 16);
}

// ============================================================================
// Date normalization
//
// Evvnt start_time / end_time are already offset-aware ISO 8601 strings
// (e.g. "2026-06-08T08:00:00-07:00"). We pass them through new Date().toISOString()
// to normalise to UTC ISO, then convert to LA wall-clock via utcIsoToLaIso().
//
// Fallback: start_date is "YYYY-MM-DD" — treat as LA-local midnight via
// naiveLaToUtcMs, then utcIsoToLaIso.
// ============================================================================

/**
 * Parse an Evvnt datetime field to a canonical LA offset-aware ISO string.
 * Returns null if neither field is parseable.
 */
function parseEvvntDatetime(
  offsetAwareField: string | null | undefined,
  fallbackDateOnly: string | undefined,
): string | null {
  // Attempt 1: offset-aware ISO field (start_time / end_time)
  if (offsetAwareField) {
    const ms = Date.parse(offsetAwareField);
    if (!isNaN(ms)) {
      return utcIsoToLaIso(new Date(ms).toISOString());
    }
  }

  // Attempt 2: date-only fallback — treat as LA-local midnight
  if (fallbackDateOnly) {
    const naiveMs = naiveLaToUtcMs(fallbackDateOnly);
    if (!isNaN(naiveMs)) {
      return utcIsoToLaIso(new Date(naiveMs).toISOString());
    }
  }

  return null;
}

// ============================================================================
// HTML stripping
// ============================================================================

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

// ============================================================================
// Category mapping
//
// Map Evvnt category_name to our Category enum by lowercased keyword match.
// Order: more specific first.
// ============================================================================

// Keyword patterns → Category.
// Mapping: "conference"/"talk"/"lecture" → talk, "music"/"concert" → music,
//          "art" → arts, "festival" → festival, "comedy" → comedy,
//          "theat" → theater, "film"/"movie" → film, "sport" → sports,
//          "communit" → community; else → source.categoryHint ?? "other"
const CATEGORY_MAP: Array<{ pattern: RegExp; category: Category }> = [
  { pattern: /\bfestival\b/i,                      category: "festival" },
  { pattern: /\bcomedy\b/i,                         category: "comedy" },
  { pattern: /\btheat(er|re)\b/i,                   category: "theater" },
  { pattern: /\bfilm\b|\bcinema\b|\bmovie\b/i,      category: "film" },
  { pattern: /\bmusic\b|\bconcert\b/i,              category: "music" },
  { pattern: /\bsports?\b/i,                        category: "sports" },
  { pattern: /\bcommunit(y|ies)\b/i,                category: "community" },
  { pattern: /\barts?\b/i,                          category: "arts" },
  { pattern: /\bconferences?\b|\blectures?\b|\btalks?\b/i, category: "talk" },
];

function mapEvvntCategory(categoryName: string | undefined, hint: Category | undefined): Category {
  if (!categoryName) return hint ?? "other";

  for (const { pattern, category } of CATEGORY_MAP) {
    if (pattern.test(categoryName)) return category;
  }

  return hint ?? "other";
}

// ============================================================================
// URL extraction — first http(s) URL from a links array
// ============================================================================

function firstHttpUrl(links: Record<string, string> | string[] | undefined): string | undefined {
  if (!links) return undefined;
  const isHttp = (u: unknown): u is string => typeof u === "string" && /^https?:\/\//i.test(u);
  // Dict shape { "Tickets": url, "Website": url }: prefer a Tickets link, else any http value.
  if (!Array.isArray(links)) {
    const entries = Object.entries(links);
    const tickets = entries.find(([k]) => /ticket/i.test(k))?.[1];
    if (isHttp(tickets)) return tickets;
    for (const [, v] of entries) if (isHttp(v)) return v;
    return undefined;
  }
  // Array shape: first http(s) string.
  for (const u of links) if (isHttp(u)) return u;
  return undefined;
}

// ============================================================================
// Image URL extraction — images may be objects { url } or bare strings
// ============================================================================

function extractImageUrl(images: unknown): string | undefined {
  if (!Array.isArray(images) || images.length === 0) return undefined;
  const first = images[0];
  if (typeof first === "string" && first.length > 0) return first;
  if (first !== null && typeof first === "object") {
    const obj = first as Record<string, unknown>;
    // Bare { url }
    if (typeof obj["url"] === "string" && (obj["url"] as string).length > 0) return obj["url"] as string;
    // Live Evvnt shape: { original: { url }, featured: { url } }
    for (const key of ["original", "featured"]) {
      const nested = obj[key];
      if (nested !== null && typeof nested === "object") {
        const u = (nested as Record<string, unknown>)["url"];
        if (typeof u === "string" && u.length > 0) return u;
      }
    }
  }
  return undefined;
}

// ============================================================================
// Core mapper — pure function, no network
//
// Throws ONLY when there is truly no parseable date. All other missing fields
// degrade gracefully to defaults/undefined. The FETCHER wraps each call in
// try/catch and drops events that throw.
// ============================================================================

export function mapEvvntEventToItem(raw: EvvntEvent, source: EventSource): EventItem {
  // --- Dates ---
  const startDatetime = parseEvvntDatetime(raw.start_time, raw.start_date);
  if (startDatetime === null) {
    throw new Error(
      `[EvvntAdapter] Cannot parse date for event objectID=${raw.objectID} title="${raw.title}"`
    );
  }

  const endDatetime = raw.end_time
    ? parseEvvntDatetime(raw.end_time, undefined) ?? undefined
    : undefined;

  // --- Venue ---
  const venueName =
    raw.venue && typeof raw.venue === "object" && typeof raw.venue.name === "string" && raw.venue.name.trim().length > 0
      ? raw.venue.name.trim()
      : undefined;

  // --- Address: join address_1, address_2, town (skip nulls/empties) ---
  let address: string | undefined;
  if (raw.venue && typeof raw.venue === "object") {
    const parts: string[] = [];
    if (typeof raw.venue.address_1 === "string" && raw.venue.address_1.trim().length > 0) {
      parts.push(raw.venue.address_1.trim());
    }
    if (typeof raw.venue.address_2 === "string" && raw.venue.address_2.trim().length > 0) {
      parts.push(raw.venue.address_2.trim());
    }
    if (typeof raw.venue.town === "string" && raw.venue.town.trim().length > 0) {
      parts.push(raw.venue.town.trim());
    }
    address = parts.length > 0 ? parts.join(", ") : undefined;
  }

  // --- Category ---
  const category = mapEvvntCategory(raw.category_name, source.categoryHint);

  // --- Ticket URL: first http(s) URL from links ?? original_links ---
  const ticketUrl = firstHttpUrl(raw.links) ?? firstHttpUrl(raw.original_links);

  // --- Image URL ---
  const imageUrl = extractImageUrl(raw.images);

  // --- Description: strip HTML, truncate at ~500 chars ---
  let description: string | undefined;
  if (raw.description) {
    const stripped = stripHtml(raw.description);
    description = stripped.length > 0
      ? stripped.length > 500
        ? stripped.slice(0, 500).trimEnd() + "…"
        : stripped
      : undefined;
  }

  // --- Tags: lowercased keywords + artists ---
  // Live API returns these as comma-separated strings; tolerate arrays too.
  const toTagList = (v: string | string[] | undefined): string[] => {
    if (!v) return [];
    const parts = Array.isArray(v) ? v : v.split(",");
    return parts.map((s) => s.toLowerCase().trim()).filter(Boolean);
  };
  const tags: string[] = [...toTagList(raw.keywords), ...toTagList(raw.artists)];

  // --- Stable ID ---
  const idInput = venueName ?? ticketUrl ?? source.url;
  const id = stableId(raw.title, startDatetime, idInput);

  // --- Source URL ---
  const sourceUrl = ticketUrl ?? source.url;

  // --- Compose EventItem ---
  const item: EventItem = {
    id,
    title: raw.title,
    startDatetime,
    ...(endDatetime !== undefined ? { endDatetime } : {}),
    allDay: false,
    ...(venueName !== undefined ? { venue: venueName } : {}),
    ...(address !== undefined ? { address } : {}),
    category,
    tags,
    isFree: false,
    ...(ticketUrl !== undefined ? { ticketUrl } : {}),
    sourceUrl,
    sources: [{ sourceId: source.id, url: sourceUrl }],
    ...(description !== undefined ? { description } : {}),
    ...(imageUrl !== undefined ? { imageUrl } : {}),
    fetchedAt: new Date().toISOString(),
    status: "scheduled",
  };

  // Validate with schema — catches structural issues early
  const parsed = EventItemSchema.safeParse(item);
  if (!parsed.success) {
    throw new Error(
      `[EvvntAdapter] EventItem schema validation failed for event objectID=${raw.objectID}: ` +
      parsed.error.message
    );
  }

  return parsed.data;
}

// ============================================================================
// Fetcher — pages through the Evvnt home-page events API
//
// source.url must already include: publisher_id, hitsPerPage, multipleEventInstances, page=0
// We increment the `page` query param on subsequent requests.
//
// Stops when (first condition that fires wins):
//   1. rawEvents is empty (no more pages — definitive stop).
//   2. rawEvents.length < HITS_PER_PAGE (natural last-page stop).
//   3. MAX_PAGES_SAFETY reached (safety bound — logs loudly, never silent).
//
// Ordering assumption: Evvnt feeds are date-ordered ascending. We do NOT add
// an "all-past-horizon" early-stop per-page because:
//   (a) a per-page date scan would require mapEvvntEventToItem for every raw
//       event just to check its date, which is wasteful;
//   (b) the uniform withinHorizon post-filter (Slice 5, applied in ingestSource)
//       already trims the far future after we return.
// The safety bound (MAX_PAGES_SAFETY=40) is sufficient to prevent runaway loops
// for the largest realistic Evvnt publishers.
//
// Filters out events whose startDatetime is in the past.
// Deduplicates by id.
// Throws on HTTP/JSON failure.
// ============================================================================

function buildPageUrl(baseUrl: string, page: number): string {
  const u = new URL(baseUrl);
  u.searchParams.set("page", String(page));
  return u.toString();
}

export async function fetchEvvntEvents(source: EventSource): Promise<EventItem[]> {
  const allItems: EventItem[] = [];
  const seenIds = new Set<string>();
  const nowMs = Date.now();

  for (let page = 0; page < MAX_PAGES_SAFETY; page++) {
    const url = buildPageUrl(source.url, page);

    const res = await fetch(url, {
      headers: {
        "Accept": "application/json",
        "User-Agent": "EventScout/1.0 (kaya-bot)",
      },
    });

    if (!res.ok) {
      throw new Error(
        `[EvvntAdapter] HTTP ${res.status} ${res.statusText} from ${url}`
      );
    }

    let data: EvvntResponse;
    try {
      data = (await res.json()) as EvvntResponse;
    } catch (err) {
      throw new Error(
        `[EvvntAdapter] Failed to parse JSON from ${url}: ${(err as Error).message}`
      );
    }

    const events = data.rawEvents ?? [];
    if (events.length === 0) break; // no more pages

    for (const raw of events) {
      try {
        const item = mapEvvntEventToItem(raw, source);
        // Filter out past events
        if (Date.parse(item.startDatetime) < nowMs) continue;
        if (!seenIds.has(item.id)) {
          seenIds.add(item.id);
          allItems.push(item);
        }
      } catch (err) {
        console.warn(
          `[EvvntAdapter] Skipping event objectID=${raw.objectID}: ${(err as Error).message}`
        );
      }
    }

    // Stop if this page had fewer events than hitsPerPage (natural last page)
    if (events.length < HITS_PER_PAGE) break;

    // Safety bound: if we reach here on the last iteration, log loudly
    if (page === MAX_PAGES_SAFETY - 1) {
      console.log(
        `[EvvntAdapter] safety bound ${MAX_PAGES_SAFETY} hit for source "${source.id}" — stopping (coverage may be incomplete)`
      );
    }
  }

  return allItems;
}

// ============================================================================
// Script entry point
// ============================================================================

const IS_SCRIPT =
  typeof process !== "undefined" &&
  process.argv[1] != null &&
  (process.argv[1].endsWith("EvvntAdapter.ts") ||
    process.argv[1].endsWith("EvvntAdapter"));

if (IS_SCRIPT) {
  const publisherId = process.env["EVVNT_PUBLISHER_ID"] ?? "11515";
  const sourceUrl =
    process.env["EVVNT_SOURCE_URL"] ??
    `https://discovery.evvnt.com/api/publisher/${publisherId}/home_page_events` +
    `?hitsPerPage=${HITS_PER_PAGE}&multipleEventInstances=true&page=0&publisher_id=${publisherId}`;

  const testSource: EventSource = {
    id: `evvnt-${publisherId}`,
    url: sourceUrl,
    name: "Evvnt (inewsource)",
    fetchTier: "evvnt",
    categoryHint: "community",
    pollInterval: 720,
    enabled: true,
  };

  console.log(`\nFetching Evvnt events (publisher_id=${publisherId})\n`);

  try {
    const events = await fetchEvvntEvents(testSource);

    console.log(`Fetched ${events.length} event(s).\n`);

    const preview = events.slice(0, 5);
    if (preview.length === 0) {
      console.log("No events found.");
    } else {
      console.log("First 5 events:");
      for (const e of preview) {
        console.log(
          `  [${e.startDatetime}] ${e.title} — ${e.venue ?? "no venue"} (${e.category})`
        );
      }
    }

    process.exit(0);
  } catch (err) {
    console.error(`\nFATAL: ${(err as Error).message}`);
    process.exit(1);
  }
}
