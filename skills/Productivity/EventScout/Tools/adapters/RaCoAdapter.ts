#!/usr/bin/env bun
/**
 * RaCoAdapter.ts — Resident Advisor San Diego (ra.co GraphQL) → EventItem.
 *
 * The RA listings page (https://ra.co/events/us/sandiego) 403s any plain
 * datacenter fetch, but the GraphQL API its own Next.js frontend hydrates from
 * answers a bare POST with no auth and no bot-wall:
 *
 *   POST https://ra.co/graphql
 *     { eventListings(filters: { areas: {eq: 309}, listingDate: {gte, lte} },
 *       pageSize, page) { data { event {...} } totalResults } }
 *
 * Area 309 = San Diego (resolved via `area(areaUrlName:"sandiego",
 * countryUrlCode:"us")`). Exact structured data — venue, address, cost,
 * lineup, RA-pick blurb — so this is an `api`-tier source: no browser, no LLM
 * extraction.
 *
 * Times: RA returns naive venue-local datetimes ("2026-08-20T21:00:00.000").
 * All area-309 venues are San Diego, so naive-LA → UTC → LA-offset ISO via
 * lib/tz.ts, same as ActiveNetAdapter.
 *
 * Cost semantics: `cost` is a free-text string — "5", "5.00", "", sometimes
 * words. A parsed 0 (or /free/i) → isFree; empty/unparseable → unknown, which
 * maps to isFree=false with NO priceMin (absence of evidence, not evidence of
 * free — most RA listings leave cost blank and charge at the door).
 *
 * Mirrors ActiveNetAdapter: pure mappers (unit-testable, no network) + a fetch
 * runner. fetchRaCoEvents() returns EventItem[]; it does NOT write to cache.
 * Constants below are the only San Diego-specific knobs — generalize to
 * per-source config the day a second RA area is added (two adapters = a real
 * seam).
 */

import { createHash } from "crypto";
import { upsertEvents } from "../Cache.ts";
import { horizonDays } from "../Horizon.ts";
import type { EventItem } from "../types.ts";
import { naiveLaToUtcMs, utcIsoToLaIso } from "../lib/tz.ts";

// ============================================================================
// RA GraphQL types (only the fields we use)
// ============================================================================

export interface RaEvent {
  id: string;
  title: string;
  /** Naive venue-local, "2026-08-20T00:00:00.000" (midnight = date-only) */
  date: string;
  /** Naive venue-local, "2026-08-20T21:00:00.000", or null */
  startTime: string | null;
  endTime: string | null;
  /** "/events/2411126" */
  contentUrl: string;
  /** Free-text: "5", "5.00", "", "Free", … */
  cost: string | null;
  isTicketed: boolean;
  venue: { name: string; address: string | null } | null;
  artists: Array<{ name: string }> | null;
  /** RA's own genre taxonomy ("House", "Hip-Hop", …); often empty */
  genres: Array<{ name: string }> | null;
  /** Present only on RA editorial picks */
  pick: { blurb: string | null } | null;
}

interface RaListingsResponse {
  data?: {
    eventListings?: {
      totalResults: number;
      data: Array<{ event: RaEvent | null }>;
    };
  };
  errors?: Array<{ message: string }>;
}

// ============================================================================
// Constants — Resident Advisor, San Diego area
// ============================================================================

const SOURCE_ID = "ra-co-sandiego";
const GRAPHQL_URL = "https://ra.co/graphql";
const LISTINGS_PAGE_URL = "https://ra.co/events/us/sandiego";
const AREA_ID = 309; // ra.co area "sandiego" (US)
const PAGE_SIZE = 100;
const MAX_PAGES = 10; // safety cap — SD runs ~60 listings/month today
const PAGE_GAP_MS = 250; // politeness gap between page requests

const LISTINGS_QUERY = `
query EventScoutListings($filters: FilterInputDtoInput, $pageSize: Int, $page: Int) {
  eventListings(filters: $filters, pageSize: $pageSize, page: $page) {
    totalResults
    data {
      event {
        id
        title
        date
        startTime
        endTime
        contentUrl
        cost
        isTicketed
        venue { name address }
        artists { name }
        genres { name }
        pick { blurb }
      }
    }
  }
}`;

// ============================================================================
// Stable ID — canonical(title) + startDate + venue (SPEC §4.1)
// ============================================================================

function canonical(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, " ");
}

function stableId(title: string, startDatetime: string, venue: string): string {
  const raw = `${canonical(title)}|${startDatetime}|${canonical(venue)}`;
  return createHash("sha256").update(raw).digest("hex").slice(0, 16);
}

// ============================================================================
// Helpers — pure, unit-testable
// ============================================================================

/**
 * RA's free-text cost → { isFree, priceMin? }. "0" / "free" → free;
 * "5" / "5.00" / "$10" → priceMin; "" / null / unparseable → unknown
 * (isFree=false, no price).
 */
export function parseCost(cost: string | null): { isFree: boolean; priceMin?: number } {
  const trimmed = (cost ?? "").trim();
  if (!trimmed) return { isFree: false };
  if (/free/i.test(trimmed)) return { isFree: true };
  const m = /([\d,]+(?:\.\d+)?)/.exec(trimmed);
  if (!m) return { isFree: false };
  const n = parseFloat(m[1]!.replace(/,/g, ""));
  if (!Number.isFinite(n)) return { isFree: false };
  if (n === 0) return { isFree: true };
  return { isFree: false, priceMin: n };
}

/**
 * Naive venue-local RA datetime ("2026-08-20T21:00:00.000") → LA-offset ISO.
 * Returns null for null/malformed input.
 */
export function raTimeToLaIso(raw: string | null): string | null {
  if (!raw) return null;
  const naive = raw.slice(0, 19);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(naive)) return null;
  return utcIsoToLaIso(new Date(naiveLaToUtcMs(naive)).toISOString());
}

/**
 * Map one RA event to an EventItem. Pure — `fetchedAt` injected for
 * testability. Returns null for rows missing the essentials (title/date).
 */
export function mapRaEventToItem(e: RaEvent, fetchedAt: string): EventItem | null {
  const title = e.title?.trim();
  if (!title || !e.date) return null;

  const start = raTimeToLaIso(e.startTime);
  const allDay = start == null;
  const startDatetime = start ?? raTimeToLaIso(`${e.date.slice(0, 10)}T00:00:00`);
  if (!startDatetime) return null;

  const venue = e.venue?.name?.trim() ?? "";
  const eventUrl = e.contentUrl ? `https://ra.co${e.contentUrl}` : LISTINGS_PAGE_URL;
  const { isFree, priceMin } = parseCost(e.cost);
  const artists = (e.artists ?? []).map((a) => a.name.trim()).filter(Boolean);
  const genres = (e.genres ?? []).map((g) => g.name.trim().toLowerCase()).filter(Boolean);
  const blurb = e.pick?.blurb?.trim();

  // Real RA genres when present ("house", "hip-hop", "trance", …) so a
  // non-electronic club night isn't mislabeled; "electronic" only as the
  // platform-default fallback for the many untagged listings.
  const tags = ["nightlife", "resident-advisor", ...genres];
  if (genres.length === 0) tags.push("electronic");
  if (blurb != null) tags.push("ra-pick");

  const item: EventItem = {
    id: stableId(title, startDatetime, venue),
    title,
    startDatetime,
    allDay,
    category: "music",
    tags,
    isFree,
    ticketUrl: eventUrl,
    sourceUrl: eventUrl,
    sources: [{ sourceId: SOURCE_ID, url: eventUrl }],
    fetchedAt,
    status: "scheduled",
  };
  if (venue) item.venue = venue;
  const address = e.venue?.address?.trim();
  if (address) item.address = address;
  const end = raTimeToLaIso(e.endTime);
  if (end) item.endDatetime = end;
  if (priceMin !== undefined) {
    item.priceMin = priceMin;
    item.currency = "USD";
  }
  if (artists.length > 0) item.performersOrTeams = artists.join(", ");
  if (blurb) item.description = `[RA Pick] ${blurb}`.slice(0, 300);
  return item;
}

// ============================================================================
// Runner — pages through the GraphQL listings and returns EventItem[]
// ============================================================================

async function fetchListingsPage(
  page: number,
  gte: string,
  lte: string,
): Promise<{ events: RaEvent[]; totalResults: number }> {
  const res = await fetch(GRAPHQL_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
      Referer: LISTINGS_PAGE_URL,
    },
    body: JSON.stringify({
      query: LISTINGS_QUERY,
      variables: {
        filters: { areas: { eq: AREA_ID }, listingDate: { gte, lte } },
        pageSize: PAGE_SIZE,
        page,
      },
    }),
  });
  if (!res.ok) {
    throw new Error(`RA GraphQL request failed: ${res.status} ${res.statusText} (page ${page})`);
  }
  const data = (await res.json()) as RaListingsResponse;
  if (data.errors?.length) {
    throw new Error(`RA GraphQL error on page ${page}: ${data.errors[0]!.message}`);
  }
  const listings = data.data?.eventListings;
  if (!listings) {
    throw new Error(`RA GraphQL returned no eventListings payload (page ${page})`);
  }
  return {
    events: listings.data.map((d) => d.event).filter((e): e is RaEvent => e != null),
    totalResults: listings.totalResults,
  };
}

/** LA calendar date (YYYY-MM-DD) for "today". */
function laTodayYmd(): string {
  return utcIsoToLaIso(new Date().toISOString()).slice(0, 10);
}

export async function fetchRaCoEvents(): Promise<EventItem[]> {
  const gte = laTodayYmd();
  const lte = new Date(Date.now() + horizonDays() * 86_400_000).toISOString().slice(0, 10);
  const fetchedAt = new Date().toISOString();

  const rows: RaEvent[] = [];
  const first = await fetchListingsPage(1, gte, lte);
  rows.push(...first.events);
  const totalPages = Math.min(Math.ceil(first.totalResults / PAGE_SIZE), MAX_PAGES);
  if (Math.ceil(first.totalResults / PAGE_SIZE) > MAX_PAGES) {
    console.warn(`  [ra-co] ${first.totalResults} listings; capped at ${MAX_PAGES} pages`);
  }
  for (let p = 2; p <= totalPages; p++) {
    await new Promise((r) => setTimeout(r, PAGE_GAP_MS));
    const page = await fetchListingsPage(p, gte, lte);
    if (page.events.length === 0) break;
    rows.push(...page.events);
  }

  let skipped = 0;
  // RA re-lists the same event under multiple listing dates — collapse by
  // stable id so one party is one event.
  const events = new Map<string, EventItem>();
  for (const e of rows) {
    const item = mapRaEventToItem(e, fetchedAt);
    if (item) events.set(item.id, item);
    else skipped++;
  }
  console.log(
    `  [ra-co] ${rows.length} listings → ${events.size} events` +
      (skipped > 0 ? ` (skipped ${skipped} missing title/date)` : ""),
  );
  return [...events.values()];
}

// ============================================================================
// Script entry point
// ============================================================================

const IS_SCRIPT =
  typeof process !== "undefined" &&
  process.argv[1] != null &&
  (process.argv[1].endsWith("RaCoAdapter.ts") || process.argv[1].endsWith("RaCoAdapter"));

if (IS_SCRIPT) {
  console.log(`\nFetching Resident Advisor San Diego listings (GraphQL)...\n`);
  try {
    const events = await fetchRaCoEvents();
    upsertEvents(events);
    console.log(`Upserted ${events.length} RA event(s) to cache.\n`);
    for (const e of events.slice(0, 15)) {
      console.log(
        `  [${e.startDatetime}] ${e.title} — ${e.venue ?? "TBD"}` +
          ` (${e.isFree ? "Free" : e.priceMin != null ? `$${e.priceMin}` : "$?"})`,
      );
    }
    console.log(`\nSource: ${SOURCE_ID}`);
    process.exit(0);
  } catch (err) {
    console.error(`\nFATAL: ${(err as Error).message}`);
    process.exit(1);
  }
}
