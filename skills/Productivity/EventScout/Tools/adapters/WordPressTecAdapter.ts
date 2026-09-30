#!/usr/bin/env bun
/**
 * WordPressTecAdapter.ts — Generic adapter for WordPress sites running
 * "The Events Calendar" (TEC) plugin, which exposes a REST API at
 * /wp-json/tribe/events/v1/events.
 *
 * First consumer: Balboa Park (balboapark.org).
 *
 * Exports:
 *   mapTecEventToItem(raw: TecEvent, source: EventSource): EventItem
 *       PURE function — no network. Maps one TEC API event object to EventItem.
 *       Throws only when there is truly no parseable date.
 *       HTML description is stripped to plain text.
 *
 *   fetchWordPressTecEvents(source: EventSource): Promise<EventItem[]>
 *       Pages through the TEC REST API (up to MAX_PAGES pages, 50 per page,
 *       max 200 events total). Derives the origin from source.url.
 *       Maps each raw event through mapTecEventToItem, drops invalid ones,
 *       deduplicates by id, and returns the array.
 *       Throws on HTTP/JSON failure so Ingest records the failure reason.
 *
 * Script mode (bun .../WordPressTecAdapter.ts):
 *   Requires EVENTSCOUT_TEC_URL env var (or defaults to balboapark.org).
 *   Fetches live, prints a summary. Does NOT write to cache in script mode.
 *
 * Date handling:
 *   TEC API returns `utc_start_date` as "YYYY-MM-DD HH:MM:SS" (space-separated,
 *   no "T", no "Z"). We normalize to ISO UTC by replacing the space with "T" and
 *   appending "Z", then pass to utcIsoToLaIso() from tz.ts.
 *   Fallback: if utc_start_date is absent/unparseable, normalize start_date
 *   (LA naive) using naiveLaToUtcMs → utcIsoToLaIso.
 *
 * Price handling:
 *   cost_details.values is a string[] of numeric values (e.g. ["10","25"]).
 *   If the array is non-empty, we parse floats: priceMin = min, priceMax = max.
 *   isFree = true only when one of the values is "0" or "0.00".
 *   Empty values array → leave price undefined, isFree = false (do NOT assume free).
 *
 * Category mapping:
 *   TEC categories are mapped to our Category enum by slug/name match.
 *   Falls back to source.categoryHint ?? "other".
 *
 * Description:
 *   raw.description is HTML; we strip tags with a simple regex approach.
 *   raw.excerpt is used as fallback when description is empty after stripping.
 *
 * Venue guard:
 *   raw.venue may be an object with a `venue` string field, or an empty array [],
 *   or absent. We guard all cases.
 *
 * Image guard:
 *   raw.image may be an object with a `url` string, or boolean false.
 */

import { createHash } from "crypto";
import type { EventItem, EventSource, Category } from "../types.ts";
import { EventItemSchema, CategorySchema } from "../types.ts";
import { utcIsoToLaIso, naiveLaToUtcMs } from "../lib/tz.ts";

// ============================================================================
// TEC API types (minimal — only fields we use; allow unknown extras)
// ============================================================================

export interface TecVenue {
  venue?: string;
  address?: string;
  city?: string;
  [key: string]: unknown;
}

export interface TecCostDetails {
  currency_symbol?: string;
  currency_code?: string;
  values?: string[];
}

export interface TecImage {
  url: string;
  [key: string]: unknown;
}

export interface TecCategory {
  name: string;
  slug: string;
}

export interface TecEvent {
  id: number;
  title: string;
  url: string;
  all_day: boolean;
  start_date: string;       // "YYYY-MM-DD HH:MM:SS" local
  utc_start_date?: string;  // "YYYY-MM-DD HH:MM:SS" UTC
  end_date?: string;
  utc_end_date?: string;
  description?: string;
  excerpt?: string;
  venue?: TecVenue | [];    // may be empty array when no venue
  categories?: TecCategory[];
  cost?: string;
  cost_details?: TecCostDetails;
  image?: TecImage | false; // false when no image
  [key: string]: unknown;
}

export interface TecApiResponse {
  total: number;
  total_pages: number;
  events: TecEvent[];
}

// ============================================================================
// Constants
// ============================================================================

// MAX_PAGES and MAX_TOTAL removed (Slice 6: horizon-driven pagination).
// The adapter now loops to min(total_pages, MAX_PAGES_SAFETY) instead of
// stopping at the old hard cap of 4 pages / 200 events.
const PER_PAGE = 50;

// Safety bound: stop if the server reports an unrealistically high total_pages
// (e.g. a bug or a misconfigured source). 40 pages × 50 = 2000 events is a
// generous ceiling for any realistic WordPress TEC calendar.
// When hit, log loudly — never truncate silently.
const MAX_PAGES_SAFETY = 40;

// ============================================================================
// Stable ID — same convention as PadresAdapter (SPEC §4.1)
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
// TEC utc_start_date / utc_end_date format: "YYYY-MM-DD HH:MM:SS" (no T, no Z).
// Normalize to ISO UTC by replacing the space with "T" and appending "Z".
// ============================================================================

/**
 * Normalize a TEC space-separated datetime string to ISO UTC.
 * "2026-06-01 07:00:00" → "2026-06-01T07:00:00Z"
 * Returns null if the input is missing or does not match expected shape.
 */
function normalizeTecUtc(raw: string | undefined): string | null {
  if (!raw) return null;
  // Expect "YYYY-MM-DD HH:MM:SS"
  const normalized = raw.trim().replace(" ", "T") + "Z";
  // Validate the resulting ISO string parses correctly
  const ms = Date.parse(normalized);
  if (isNaN(ms)) return null;
  return normalized;
}

/**
 * Parse a TEC datetime field (either UTC or local) into a LA offset-aware ISO string.
 *
 * Strategy:
 *   1. Try utcField first: normalize "YYYY-MM-DD HH:MM:SS" → "YYYY-MM-DDTHH:MM:SSZ",
 *      then pass to utcIsoToLaIso().
 *   2. Fall back to localField: treat the space-separated string as LA naive,
 *      normalize to "YYYY-MM-DDTHH:MM:SS" (no Z, no offset), then use
 *      naiveLaToUtcMs + utcIsoToLaIso.
 *   3. Return null if both are unparseable.
 *
 * Callers throw or filter null results.
 */
function parseTecDatetime(utcField: string | undefined, localField: string | undefined): string | null {
  // Attempt 1: UTC field
  const utcNorm = normalizeTecUtc(utcField);
  if (utcNorm !== null) {
    return utcIsoToLaIso(utcNorm);
  }

  // Attempt 2: local naive field — treat as LA wall-clock time
  if (localField) {
    const naiveIso = localField.trim().replace(" ", "T"); // "YYYY-MM-DDTHH:MM:SS" (no Z)
    const utcMs = naiveLaToUtcMs(naiveIso);
    if (!isNaN(utcMs)) {
      return utcIsoToLaIso(new Date(utcMs).toISOString());
    }
  }

  return null;
}

// ============================================================================
// HTML stripping
//
// Strip HTML tags from description. This is a best-effort approach for
// the TEC event description field (e.g. "<p>Fun outdoor event</p>").
// We do NOT import a full HTML parser to avoid adding a dependency.
// ============================================================================

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]*>/g, " ")   // replace tags with spaces
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
// Map TEC category slugs/names to our Category enum.
// TEC slugs are lowercase-hyphenated; we normalize before matching.
// ============================================================================

const VALID_CATEGORIES: Category[] = [
  "music", "comedy", "theater", "sports", "arts",
  "community", "festival", "talk", "film", "food", "other",
];

// Slug/name patterns → Category. Order matters: more specific first.
const CATEGORY_MAP: Array<{ pattern: RegExp; category: Category }> = [
  { pattern: /\bmusic\b/i,         category: "music" },
  { pattern: /\bcomedy\b/i,         category: "comedy" },
  { pattern: /\btheat(er|re)\b/i,   category: "theater" },
  { pattern: /\bsports?\b/i,        category: "sports" },
  { pattern: /\barts?\b/i,          category: "arts" },
  { pattern: /\bcommunit(y|ies)\b/i, category: "community" },
  { pattern: /\bfestival\b/i,       category: "festival" },
  { pattern: /\btalk(s)?\b/i,       category: "talk" },
  { pattern: /\bfilm\b|\bcinema\b|\bmovie\b/i, category: "film" },
  { pattern: /\bfood\b|\bdrink\b|\bculinary\b|\bdining\b|\btasting\b/i, category: "food" },
];

function mapTecCategory(
  categories: TecCategory[] | undefined,
  hint: Category | undefined
): Category {
  if (!categories || categories.length === 0) return hint ?? "other";

  for (const cat of categories) {
    const text = `${cat.name} ${cat.slug}`.toLowerCase();

    // Exact match against our enum first
    const parsed = CategorySchema.safeParse(text.trim());
    if (parsed.success) return parsed.data;

    // Try slug direct match
    const slugParsed = CategorySchema.safeParse(cat.slug.toLowerCase().trim());
    if (slugParsed.success) return slugParsed.data;

    // Pattern match
    for (const { pattern, category } of CATEGORY_MAP) {
      if (pattern.test(text)) return category;
    }
  }

  return hint ?? "other";
}

// ============================================================================
// Venue extraction — guard against empty array, false, absent
// ============================================================================

function extractVenue(raw: TecEvent["venue"]): string | undefined {
  if (!raw) return undefined;
  if (Array.isArray(raw)) return undefined; // empty array []
  if (typeof raw !== "object") return undefined;
  const v = (raw as TecVenue).venue;
  if (typeof v === "string" && v.trim().length > 0) return v.trim();
  return undefined;
}

// ============================================================================
// Image extraction — guard against image === false
// ============================================================================

function extractImageUrl(raw: TecEvent["image"]): string | undefined {
  if (!raw) return undefined;
  if (typeof raw === "boolean") return undefined; // false
  if (typeof raw === "object" && "url" in raw) {
    const u = (raw as TecImage).url;
    if (typeof u === "string" && u.length > 0) return u;
  }
  return undefined;
}

// ============================================================================
// Price extraction
//
// cost_details.values is string[] of numeric values, e.g. ["10","25"].
// Empty array → no price info, isFree = false (unknown ≠ free).
// Non-empty → parse floats, priceMin = min, priceMax = max.
// isFree = true only if one value is 0 (or 0.00, etc.).
// ============================================================================

interface PriceInfo {
  isFree: boolean;
  priceMin?: number;
  priceMax?: number;
  currency?: string;
}

function extractPriceInfo(event: TecEvent): PriceInfo {
  const values = event.cost_details?.values;
  const currency = event.cost_details?.currency_code;

  if (!values || values.length === 0) {
    // No price data — do NOT assume free
    return { isFree: false };
  }

  const parsed = values
    .map((v) => parseFloat(v))
    .filter((n) => !isNaN(n));

  if (parsed.length === 0) {
    return { isFree: false };
  }

  const minVal = Math.min(...parsed);
  const maxVal = Math.max(...parsed);
  const isFree = minVal === 0;

  return {
    isFree,
    priceMin: minVal,
    priceMax: maxVal,
    ...(currency ? { currency } : {}),
  };
}

// ============================================================================
// Core mapper — pure function, no network
//
// Design decision: the mapper is TOTAL — it never returns null.
// It throws ONLY when there is truly no parseable date (both utc_start_date
// and start_date are missing/unparseable). All other missing fields degrade
// gracefully to defaults/undefined. The FETCHER wraps each call in try/catch
// and drops events that throw, counting them as skipped.
//
// This keeps the contract simple: callers can always assume a returned
// EventItem is structurally valid (title, startDatetime, id, etc.).
// ============================================================================

export function mapTecEventToItem(raw: TecEvent, source: EventSource): EventItem {
  // --- Dates ---
  const startDatetime = parseTecDatetime(raw.utc_start_date, raw.start_date);
  if (startDatetime === null) {
    throw new Error(
      `[WordPressTecAdapter] Cannot parse date for event id=${raw.id} title="${raw.title}"`
    );
  }

  const endDatetime = parseTecDatetime(raw.utc_end_date, raw.end_date) ?? undefined;

  // --- Venue ---
  const venue = extractVenue(raw.venue);

  // --- Category ---
  const category = mapTecCategory(raw.categories, source.categoryHint);

  // --- Price ---
  const priceInfo = extractPriceInfo(raw);

  // --- Description ---
  const rawDesc = raw.description ? stripHtml(raw.description) : undefined;
  const description = (rawDesc && rawDesc.length > 0) ? rawDesc : (raw.excerpt ?? undefined);

  // --- Tags: from TEC category slugs/names ---
  const tags = (raw.categories ?? []).map((c) => c.slug.toLowerCase()).filter(Boolean);

  // --- Image ---
  const imageUrl = extractImageUrl(raw.image);

  // --- Stable ID ---
  const idInput = venue ?? raw.url ?? source.url;
  const id = stableId(raw.title, startDatetime, idInput);

  // --- Compose EventItem ---
  const item: EventItem = {
    id,
    title: raw.title,
    startDatetime,
    ...(endDatetime !== undefined ? { endDatetime } : {}),
    allDay: raw.all_day === true,
    ...(venue !== undefined ? { venue } : {}),
    category,
    tags,
    isFree: priceInfo.isFree,
    ...(priceInfo.priceMin !== undefined ? { priceMin: priceInfo.priceMin } : {}),
    ...(priceInfo.priceMax !== undefined ? { priceMax: priceInfo.priceMax } : {}),
    ...(priceInfo.currency !== undefined ? { currency: priceInfo.currency } : {}),
    ticketUrl: raw.url,
    sourceUrl: raw.url ?? source.url,
    sources: [{ sourceId: source.id, url: raw.url ?? source.url }],
    ...(description !== undefined ? { description } : {}),
    ...(imageUrl !== undefined ? { imageUrl } : {}),
    fetchedAt: new Date().toISOString(),
    status: "scheduled",
  };

  // Validate with schema — this catches any structural issues early
  const parsed = EventItemSchema.safeParse(item);
  if (!parsed.success) {
    throw new Error(
      `[WordPressTecAdapter] EventItem schema validation failed for event id=${raw.id}: ` +
      parsed.error.message
    );
  }

  return parsed.data;
}

// ============================================================================
// Fetcher — pages through the TEC REST API
// ============================================================================

function todayYmd(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * Fetch events from a WordPress site running the TEC plugin.
 *
 * Page loop (Slice 6 — horizon-driven, no fixed cap):
 *   - Fetches pages 1..min(total_pages, MAX_PAGES_SAFETY), stopping early
 *     when a page returns 0 events or the safety bound is reached.
 *   - On page 1, reads total_pages from the response to determine how many
 *     pages exist; caps to MAX_PAGES_SAFETY as a runaway guard.
 *   - Each page uses ?per_page=50&start_date=<today>&page=<n>.
 *   - MAX_TOTAL (200) removed — the Slice-5 withinHorizon post-filter in
 *     ingestSource bounds the far-future tail uniformly across all adapters.
 *
 * Ordering assumption: TEC returns events sorted by start_date ascending.
 * An "all-past-horizon" per-page stop was considered but not added because:
 *   (a) The uniform withinHorizon filter in ingestSource handles far-future
 *       trimming after ingest;
 *   (b) TEC paginates chronologically — once total_pages is known, we just
 *       loop to min(total_pages, MAX_PAGES_SAFETY); no per-event date scan needed.
 *
 * Error handling:
 *   - Throws on HTTP error or JSON parse failure — Ingest records the failure.
 *   - Per-event mapping errors are caught and logged; the event is skipped.
 *   - Dedup by id via a Set to prevent returning the same event twice.
 *   - Safety bound hit → logs loudly, stops, never truncates silently.
 */
export async function fetchWordPressTecEvents(source: EventSource): Promise<EventItem[]> {
  const origin = new URL(source.url).origin;
  const today = todayYmd();
  const baseEndpoint = `${origin}/wp-json/tribe/events/v1/events`;

  const allItems: EventItem[] = [];
  const seenIds = new Set<string>();
  let maxPages = MAX_PAGES_SAFETY; // will be refined from total_pages on page 1
  let safetyHit = false;

  for (let page = 1; page <= maxPages; page++) {
    const url = `${baseEndpoint}?per_page=${PER_PAGE}&start_date=${today}&page=${page}`;

    const res = await fetch(url, {
      headers: {
        "Accept": "application/json",
        "User-Agent": "EventScout/1.0 (kaya-bot)",
      },
    });

    if (!res.ok) {
      throw new Error(
        `[WordPressTecAdapter] HTTP ${res.status} ${res.statusText} from ${url}`
      );
    }

    let data: TecApiResponse;
    try {
      data = (await res.json()) as TecApiResponse;
    } catch (err) {
      throw new Error(
        `[WordPressTecAdapter] Failed to parse JSON from ${url}: ${(err as Error).message}`
      );
    }

    // On first page, set maxPages from the server-reported total_pages,
    // capped by MAX_PAGES_SAFETY to guard against runaway loops.
    if (page === 1) {
      const serverPages = data.total_pages ?? 1;
      if (serverPages > MAX_PAGES_SAFETY) {
        safetyHit = true;
      }
      maxPages = Math.min(serverPages, MAX_PAGES_SAFETY);
    }

    const events = data.events ?? [];
    if (events.length === 0) break; // no more events on this page

    for (const raw of events) {
      try {
        const item = mapTecEventToItem(raw, source);
        if (!seenIds.has(item.id)) {
          seenIds.add(item.id);
          allItems.push(item);
        }
      } catch (err) {
        // Log and skip; don't abort the whole fetch
        console.warn(
          `[WordPressTecAdapter] Skipping event id=${raw.id}: ${(err as Error).message}`
        );
      }
    }
  }

  // Log after the loop so we have the final count
  if (safetyHit) {
    console.log(
      `[WordPressTecAdapter] safety bound ${MAX_PAGES_SAFETY} hit for source "${source.id}" — stopping (coverage may be incomplete)`
    );
  }

  return allItems;
}

// ============================================================================
// Script entry point
// ============================================================================

const IS_SCRIPT =
  typeof process !== "undefined" &&
  process.argv[1] != null &&
  (process.argv[1].endsWith("WordPressTecAdapter.ts") ||
    process.argv[1].endsWith("WordPressTecAdapter"));

if (IS_SCRIPT) {
  const sourceUrl = process.env["EVENTSCOUT_TEC_URL"] ?? "https://balboapark.org/events/";

  const testSource: EventSource = {
    id: "balboa-park",
    url: sourceUrl,
    name: "Balboa Park",
    fetchTier: "wp-tribe",
    categoryHint: "arts",
    pollInterval: 720,
    enabled: true,
  };

  console.log(`\nFetching TEC events from: ${new URL(testSource.url).origin}\n`);

  try {
    const events = await fetchWordPressTecEvents(testSource);

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
