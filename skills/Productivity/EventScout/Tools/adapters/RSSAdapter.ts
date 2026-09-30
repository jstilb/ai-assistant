#!/usr/bin/env bun
/**
 * RSSAdapter.ts — Slice 3: RSS/Atom feed → EventItem adapter.
 *
 * Exports:
 *   mapFeedItemToEvent(item: FeedItem, source: EventSource): EventItem
 *       Pure mapper — unit-testable, no network. Maps one RSSParser FeedItem
 *       to an EventItem. Best-effort date handling (see comment below).
 *
 *   fetchRSSEvents(source: EventSource): Promise<EventItem[]>
 *       Fetches the RSS/Atom feed at source.url, parses with the shared
 *       RSSParser, and maps each item to an EventItem.
 *
 * DATE BEST-EFFORT ASSUMPTION:
 *   RSS feeds (especially WordPress news/events feeds) do NOT embed a separate
 *   "event start date" field in the RSS item. The only reliable timestamp in a
 *   standard RSS item is pubDate / dc:date (when the post was published).
 *   We use FeedItem.publishedAt as the startDatetime fallback. Items whose
 *   description embeds event metadata as labeled prose (SD Reader's
 *   When:/Where:/Cost:) are enriched via extractReaderEnrichments() — a
 *   batched, schema-constrained LLM extraction (see the enrichment section).
 *   Downstream, when a ConstraintSet filter is applied against startDatetime,
 *   publish-date fallbacks may cause false positives / misses. Geocoding and
 *   LLM ranking passes should be aware of this limitation.
 *
 * Script mode (bun .../RSSAdapter.ts --source <id>):
 *   Fetches live and prints a summary. Does NOT write to cache — callers
 *   (Ingest.ts) handle cache writes.
 */

import { createHash } from "crypto";
// cross-skill-allowed: adapter wraps ContentAggregator's RSSParser by design — thin adapter over a shared parser
import { parseRSSFeed } from "../../../../../skills/Content/ContentAggregator/Tools/RSSParser.ts";
// cross-skill-allowed: adapter wraps ContentAggregator's RSSParser by design — thin adapter over a shared parser
import type { FeedItem } from "../../../../../skills/Content/ContentAggregator/Tools/RSSParser.ts";
import type { EventItem, EventSource } from "../types.ts";
import { naiveLaToUtcMs, utcIsoToLaIso } from "../lib/tz.ts";
import { inference } from "../../../../../lib/core/Inference.ts";

// ============================================================================
// Stable ID — mirrors PadresAdapter convention (§4.1):
//   canonical(title) + startDate + venue (or sourceUrl if no venue)
// ============================================================================

function canonical(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, " ");
}

function stableId(title: string, startDatetime: string, venueOrUrl: string): string {
  const raw = `${canonical(title)}|${startDatetime}|${canonical(venueOrUrl)}`;
  return createHash("sha256").update(raw).digest("hex").slice(0, 16);
}

// ============================================================================
// SD Reader enrichment — model-delegated extraction
//
// The San Diego Reader RSS feed embeds event metadata inside the item
// description as plain text (after HTML tag-stripping by RSSParser):
//
//   When: Saturday, Aug. 1, 2026, 5:30 a.m. to 4 p.m.
//   Where: Rimac Arena, 9500 Gilman Drive, San Diego
//   Cost: $40 - $150
//   Age limit: All ages
//   Description: <free text>
//
// HISTORY (2026-08-01, markdown-regex remediation): this used to be a
// hand-written regex parser (parseReaderDescription). The feed's prose
// drifted — month names became abbreviated ("Aug. 1" vs "August 1") — and the
// parser silently missed 100% of start times (measured live: 0/50 items),
// falling back to the RSS publish date, i.e. Jm was shown wrong event times
// with no signal. Third-party prose is non-deterministic; extraction is now
// delegated to the model via a schema-constrained inference() call, batched
// per fetch. Structural validation of the model's rows (index bounds, naive
// datetime shape, LA-offset conversion) stays deterministic below.
// ============================================================================

/** Enrichment fields for one reader-style feed item. */
export interface ReaderDescriptionFields {
  title: string;
  startDatetime?: string;
  endDatetime?: string;
  venue?: string;
  address?: string;
  priceMin?: number;
  priceMax?: number;
  isFree?: boolean;
}

/**
 * Build a naive LA datetime string "YYYY-MM-DDTHH:MM:SS" and convert to an
 * offset-aware LA ISO string using the shared tz helpers.
 * Returns undefined if conversion fails.
 */
function naiveToLaIso(naive: string): string | undefined {
  const utcMs = naiveLaToUtcMs(`${naive}:00`);
  if (isNaN(utcMs)) return undefined;
  return utcIsoToLaIso(new Date(utcMs).toISOString());
}

/** One row of the model's batched extraction output. */
interface ReaderModelRow {
  index: number;
  title: string;
  startDatetime: string | null;
  endDatetime: string | null;
  venue: string | null;
  address: string | null;
  priceMin: number | null;
  priceMax: number | null;
  isFree: boolean;
}

/** Schema handed to inference() — model output is API-level constrained. */
const READER_EXTRACTION_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    events: {
      type: "array",
      items: {
        type: "object",
        properties: {
          index: { type: "integer" },
          title: { type: "string" },
          startDatetime: { type: ["string", "null"], description: "Naive local start time 'YYYY-MM-DDTHH:MM', or null" },
          endDatetime: { type: ["string", "null"], description: "Naive local end time 'YYYY-MM-DDTHH:MM', or null" },
          venue: { type: ["string", "null"] },
          address: { type: ["string", "null"] },
          priceMin: { type: ["number", "null"] },
          priceMax: { type: ["number", "null"] },
          isFree: { type: "boolean" },
        },
        required: ["index", "title", "startDatetime", "endDatetime", "venue", "address", "priceMin", "priceMax", "isFree"],
        additionalProperties: false,
      },
    },
  },
  required: ["events"],
  additionalProperties: false,
};

const READER_EXTRACTION_SYSTEM_PROMPT = `You extract structured event fields from San Diego Reader RSS event listings. Each input item has an [index], a raw TITLE, and a BODY with labeled fields (When:, Where:, Cost:, Age limit:, Description:). Return exactly one output row per input item, carrying its index.

Field rules:
- title: the event title with any leading weekday/date prefix stripped ("Mon 6/1: Concert" → "Concert").
- startDatetime / endDatetime: the event's LOCAL start/end as "YYYY-MM-DDTHH:MM", exactly as stated in the text (America/Los_Angeles wall-clock; do NOT convert timezones). "noon" = 12:00, "midnight" = 00:00. null when the text does not state one.
- venue: the venue name — the text before the first comma of Where:. address: the full Where: text. null when absent.
- priceMin / priceMax: dollar amounts from Cost:. "Free" → isFree=true and priceMin=0. A single price → priceMin only. "$10 suggested donation" → priceMin=10. null when not stated.
- Never guess a field the text does not support — use null.`;

/** Max reader items per LLM call — bounds output size per request. */
const READER_BATCH_SIZE = 20;

/**
 * Structurally validate one model row and convert its naive datetimes to
 * offset-aware LA ISO strings. Deterministic, hermetically testable.
 * Returns null when the row's index is out of bounds or its title is empty.
 * A malformed datetime drops that field, never the row.
 */
export function enrichmentFromModelRow(
  row: ReaderModelRow,
  itemCount: number,
): { index: number; fields: ReaderDescriptionFields } | null {
  if (!Number.isInteger(row.index) || row.index < 0 || row.index >= itemCount) return null;
  const title = row.title.trim();
  if (title.length === 0) return null;

  const fields: ReaderDescriptionFields = { title };
  const naiveShape = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;

  if (row.startDatetime !== null && naiveShape.test(row.startDatetime)) {
    const iso = naiveToLaIso(row.startDatetime);
    if (iso) fields.startDatetime = iso;
  }
  if (row.endDatetime !== null && naiveShape.test(row.endDatetime)) {
    const iso = naiveToLaIso(row.endDatetime);
    if (iso) fields.endDatetime = iso;
  }
  if (row.venue !== null && row.venue.trim().length > 0) fields.venue = row.venue.trim();
  if (row.address !== null && row.address.trim().length > 0) fields.address = row.address.trim();
  if (row.priceMin !== null && Number.isFinite(row.priceMin)) fields.priceMin = row.priceMin;
  if (row.priceMax !== null && Number.isFinite(row.priceMax)) fields.priceMax = row.priceMax;
  fields.isFree = row.isFree === true;

  return { index: row.index, fields };
}

/**
 * Batch-extract enrichment fields for reader-style feed items (body contains
 * "When:") via schema-constrained inference. Items without "When:" cost
 * nothing — standard RSS feeds never trigger an LLM call.
 *
 * Failure policy: a failed batch logs LOUDLY and contributes no enrichments —
 * affected items keep the standard RSS mapping (publish-date fallback), and
 * the cron log shows exactly why. Never throws: one bad batch must not kill
 * the whole source ingest.
 */
export async function extractReaderEnrichments(
  items: FeedItem[],
): Promise<Map<number, ReaderDescriptionFields>> {
  const enrichments = new Map<number, ReaderDescriptionFields>();

  const readerIndices = items
    .map((item, i) => ({ item, i }))
    .filter(({ item }) => item.body != null && item.body.includes("When:"));
  if (readerIndices.length === 0) return enrichments;

  for (let b = 0; b < readerIndices.length; b += READER_BATCH_SIZE) {
    const batch = readerIndices.slice(b, b + READER_BATCH_SIZE);
    const userPrompt = batch
      .map(({ item, i }) => `[${i}] TITLE: ${item.title}\nBODY: ${item.body!.slice(0, 700)}`)
      .join("\n\n");

    const result = await inference({
      systemPrompt: READER_EXTRACTION_SYSTEM_PROMPT,
      userPrompt,
      level: "standard",
      schema: READER_EXTRACTION_SCHEMA,
      timeout: 180_000,
      retries: 1,
    });

    if (!result.success || result.parsed === undefined || result.parsed === null) {
      console.error(
        `[RSSAdapter] Reader enrichment batch failed (items ${batch[0]!.i}–${batch[batch.length - 1]!.i}): ` +
        `${result.error ?? "no structured output"} — these items keep publish-date fallback`,
      );
      continue;
    }

    const rows = (result.parsed as { events: ReaderModelRow[] }).events;
    for (const row of rows) {
      const validated = enrichmentFromModelRow(row, items.length);
      if (validated) enrichments.set(validated.index, validated.fields);
    }
  }

  return enrichments;
}

// ============================================================================
// Pure mapper — FeedItem + EventSource → EventItem
// ============================================================================

/**
 * Map a single RSSParser FeedItem to an EventItem.
 *
 * Pure and synchronous. When `enrichment` is provided (model-extracted reader
 * fields from extractReaderEnrichments), its fields override the standard RSS
 * mapping. Without it, the mapping is the plain RSS one — standard feeds
 * (e.g. sd-press-club) are byte-for-byte unaffected.
 *
 * @param item       - Parsed feed item from parseRSSFeed().
 * @param source     - The EventSource the item came from (provides id, categoryHint, url).
 * @param enrichment - Optional model-extracted fields for reader-style items.
 */
export function mapFeedItemToEvent(
  item: FeedItem,
  source: EventSource,
  enrichment?: ReaderDescriptionFields,
): EventItem {
  // Prefer item URL; fall back to source.url if missing
  const itemUrl = item.url && item.url.trim().length > 0 ? item.url : source.url;

  let title = item.title;
  let startDatetime = item.publishedAt;
  let endDatetime: string | undefined;
  let venue: string | undefined;
  let address: string | undefined;
  let priceMin: number | undefined;
  let priceMax: number | undefined;
  let isFree = false;

  if (enrichment !== undefined) {
    title = enrichment.title;
    if (enrichment.startDatetime !== undefined) startDatetime = enrichment.startDatetime;
    if (enrichment.endDatetime !== undefined) endDatetime = enrichment.endDatetime;
    if (enrichment.venue !== undefined) venue = enrichment.venue;
    if (enrichment.address !== undefined) address = enrichment.address;
    if (enrichment.priceMin !== undefined) priceMin = enrichment.priceMin;
    if (enrichment.priceMax !== undefined) priceMax = enrichment.priceMax;
    if (enrichment.isFree !== undefined) isFree = enrichment.isFree;
  }

  // Venue for stable ID: prefer parsed venue, else item URL
  const venueOrUrl = venue ?? itemUrl;

  return {
    id: stableId(title, startDatetime, venueOrUrl),
    title,
    startDatetime,
    ...(endDatetime !== undefined ? { endDatetime } : {}),
    allDay: false,
    ...(venue !== undefined ? { venue } : {}),
    ...(address !== undefined ? { address } : {}),
    category: source.categoryHint ?? "other",
    // Pass through any tags the RSSParser extracted from <category> elements
    tags: item.tags,
    isFree,
    ...(priceMin !== undefined ? { priceMin } : {}),
    ...(priceMax !== undefined ? { priceMax } : {}),
    sourceUrl: itemUrl,
    sources: [{ sourceId: source.id, url: itemUrl }],
    description: item.body && item.body.length > 0 ? item.body : undefined,
    fetchedAt: new Date().toISOString(),
    status: "scheduled",
  };
}

// ============================================================================
// Feed fetcher — fetches raw XML, delegates to RSSParser, maps all items
// ============================================================================

/**
 * Fetch a live RSS/Atom feed and return EventItem[].
 * Does NOT write to cache — the caller (Ingest.ts) is responsible.
 *
 * Reader-style items (body contains "When:") are enriched via a batched
 * schema-constrained LLM extraction; standard feeds trigger no LLM call.
 *
 * @param source - EventSource with fetchTier === "rss" and a valid feed URL.
 */
export async function fetchRSSEvents(source: EventSource): Promise<EventItem[]> {
  const res = await fetch(source.url, {
    headers: {
      "User-Agent": "Kaya-EventScout/1.0 (event aggregator; contact: kaya@example.com)",
      Accept: "application/rss+xml, application/atom+xml, text/xml, */*",
    },
  });

  if (!res.ok) {
    throw new Error(
      `RSS fetch failed: HTTP ${res.status} ${res.statusText} — ${source.url}`
    );
  }

  const xml = await res.text();
  const feed = parseRSSFeed(xml);

  if (feed.items.length === 0) {
    // Not a hard error — the feed might genuinely be empty
    console.warn(`[RSSAdapter] Warning: feed returned 0 items for source "${source.id}" (${source.url})`);
  }

  const enrichments = await extractReaderEnrichments(feed.items);
  return feed.items.map((item, i) => mapFeedItemToEvent(item, source, enrichments.get(i)));
}

// ============================================================================
// Script entry point
// ============================================================================

const IS_SCRIPT =
  typeof process !== "undefined" &&
  process.argv[1] != null &&
  (process.argv[1].endsWith("RSSAdapter.ts") ||
    process.argv[1].endsWith("RSSAdapter"));

if (IS_SCRIPT) {
  const args = process.argv.slice(2);

  if (args.includes("--help")) {
    console.log(`
RSSAdapter — Fetch RSS feed → EventItem[]

Usage:
  bun RSSAdapter.ts --url <feed-url> [--source-id <id>] [--category <hint>]

Examples:
  bun Tools/adapters/RSSAdapter.ts --url https://sdpressclub.org/category/news-events/feed/
`);
    process.exit(0);
  }

  const urlIdx = args.indexOf("--url");
  const feedUrl = urlIdx !== -1 ? args[urlIdx + 1] : "https://sdpressclub.org/category/news-events/feed/";
  const sourceIdIdx = args.indexOf("--source-id");
  const sourceId = sourceIdIdx !== -1 ? args[sourceIdIdx + 1] : "rss-script";
  const catIdx = args.indexOf("--category");
  const categoryArg = catIdx !== -1 ? args[catIdx + 1] : "community";

  const scriptSource: EventSource = {
    id: sourceId,
    name: feedUrl,
    url: feedUrl,
    fetchTier: "rss",
    categoryHint: categoryArg as EventSource["categoryHint"],
    pollInterval: 720,
    enabled: true,
  };

  console.log(`\nFetching RSS feed: ${feedUrl}\n`);
  try {
    const events = await fetchRSSEvents(scriptSource);
    console.log(`Fetched ${events.length} item(s).\n`);

    const preview = events.slice(0, 3);
    if (preview.length === 0) {
      console.log("No items found.");
    } else {
      console.log("First 3 items:");
      for (const e of preview) {
        console.log(`  [${e.startDatetime}] ${e.title}`);
        console.log(`    URL: ${e.sourceUrl}`);
        console.log(`    Category: ${e.category}`);
      }
    }
    process.exit(0);
  } catch (err) {
    console.error(`\nFATAL: ${(err as Error).message}`);
    process.exit(1);
  }
}
