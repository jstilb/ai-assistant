#!/usr/bin/env bun
/**
 * ActiveNetAdapter.ts — SD Parks & Rec (ActiveNet/ActiveCommunities) → EventItem.
 *
 * The City of San Diego Parks & Recreation activity catalog
 * (https://anc.apm.activecommunities.com/sdparkandrec/activity/search) is an
 * Angular SPA whose list view is hydrated entirely from a JSON REST endpoint:
 *
 *   POST https://anc.apm.activecommunities.com/sdparkandrec/rest/activities/list?locale=en-US
 *     header  page_info: {"order_by":"","page_number":N,"total_records_per_page":20}
 *     body    {"activity_search_pattern":{...},"activity_transfer_pattern":{}}
 *
 * No auth involved — it's the same public endpoint the search page calls. The
 * server hard-caps pages at 20 rows regardless of the requested page size, and
 * ignores date_after/date_before (the catalog only lists current + upcoming
 * seasons anyway, ~1,900 rows ≈ 95 pages), so this adapter pages through the
 * whole catalog and filters client-side.
 *
 * Mapping model — one EventItem per activity SESSION, not per weekly meeting:
 * most rows are multi-week classes/leagues ("Sep 25 – Nov 6, Fri 4:30 PM").
 * Emitting every weekly meeting would flood the cache with thousands of
 * near-duplicate rows, so each activity becomes a single event at its next
 * upcoming meeting date (start date if the session hasn't begun; the next
 * days_of_week occurrence, tagged "in-progress", if it has).
 *
 * Skipped rows (logged in the script summary):
 *   - parent activities: date-less containers; their sub-activities are NOT
 *     returned by the list endpoint (an activity_id search returns only the
 *     parent row again), so they cannot be expanded without a per-row detail
 *     fetch. Accepted loss.
 *   - youth-capped: age_max_year in (0, 18) — after-school camps, 10u leagues.
 *   - already ended sessions.
 *
 * Data-quality caveat: time_range is the string the public site itself renders
 * and some rec centers enter wall-clock times with the wrong meridiem (e.g. an
 * evening hip-hop class listed "5:00 AM - 6:15 AM"). We mirror the source
 * verbatim — there is no deterministic correction, and the site shows the same.
 *
 * Mirrors Pike13Adapter: pure mappers (unit-testable, no network) + a fetch
 * runner. fetchActiveNetEvents() returns EventItem[]; it does NOT write to
 * cache. Constants below are the only sdparkandrec-specific knobs — generalize
 * to per-source config the day a second ActiveNet city is added (two adapters
 * = a real seam).
 */

import { createHash } from "crypto";
import { upsertEvents } from "../Cache.ts";
import type { Category, EventItem } from "../types.ts";
import { naiveLaToUtcMs, utcIsoToLaIso } from "../lib/tz.ts";

// ============================================================================
// ActiveNet list-API types (only the fields we use)
// ============================================================================

interface ActiveNetLink {
  href: string;
  label: string;
}

export interface ActiveNetActivity {
  id: number;
  name: string;
  desc: string;
  detail_url: string;
  parent_activity: boolean;
  only_one_day: boolean;
  /** "2026-09-25" or "" (parents) */
  date_range_start: string;
  /** "2026-11-06", or "" when only_one_day */
  date_range_end: string;
  /** "4:30 AM - 5:30 PM" or "" */
  time_range: string;
  /** "Mon,Tue" or "" */
  days_of_week: string;
  /** e.g. "18 and up", "6 to 12" */
  ages: string;
  age_min_year: number;
  age_max_year: number;
  /** label: "Balboa Park Club (2150 Pan American Road, 92101)" | "Fitness Room" */
  location: ActiveNetLink;
  /** label: "Free" | "$25.00" */
  fee: ActiveNetLink;
  enroll_now: ActiveNetLink | null;
  allow_drop_in_reg: boolean;
}

interface ActiveNetListResponse {
  headers: {
    response_code: string;
    response_message: string;
    page_info: { page_number: number; total_page: number; total_records: number };
  };
  body: { activity_items: ActiveNetActivity[] };
}

// ============================================================================
// Constants — City of San Diego Parks & Recreation
// ============================================================================

const SOURCE_ID = "sdparkandrec-activenet";
const API_URL =
  "https://anc.apm.activecommunities.com/sdparkandrec/rest/activities/list?locale=en-US";
const SEARCH_PAGE_URL =
  "https://anc.apm.activecommunities.com/sdparkandrec/activity/search?onlineSiteId=0&activity_select_param=2&drop_in=0&viewMode=list";
const PER_PAGE = 20; // server hard cap — larger requests still return 20
const MAX_PAGES = 120; // safety cap ≈ 2,400 rows (catalog is ~95 pages today)
const PAGE_GAP_MS = 100; // politeness gap between page requests

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

/** Collapse the API's rich-text HTML description into a plain one-liner. */
export function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#?[a-z0-9]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * "4:30 PM" → "16:30". Returns null on anything unparseable.
 */
export function parseClockTime(s: string): string | null {
  const m = /^(\d{1,2}):(\d{2})\s*(AM|PM)$/i.exec(s.trim());
  if (!m) return null;
  let h = parseInt(m[1]!, 10);
  const min = m[2]!;
  const mer = m[3]!.toUpperCase();
  if (h < 1 || h > 12 || parseInt(min, 10) > 59) return null;
  if (mer === "PM" && h !== 12) h += 12;
  if (mer === "AM" && h === 12) h = 0;
  return `${String(h).padStart(2, "0")}:${min}`;
}

/**
 * "4:30 PM - 5:30 PM" → { start: "16:30", end: "17:30" }. Null if the range
 * (or its start) cannot be parsed; end alone may be null.
 */
export function parseTimeRange(s: string): { start: string; end: string | null } | null {
  const parts = s.split(/\s*-\s*/);
  if (parts.length !== 2) return null;
  const start = parseClockTime(parts[0]!);
  if (!start) return null;
  return { start, end: parseClockTime(parts[1]!) };
}

const DOW_INDEX: Record<string, number> = {
  sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6,
};

/**
 * Next date (YYYY-MM-DD) on/after `fromYmd` whose weekday is in the CSV list
 * ("Sun,Wed,Fri"). Falls back to `fromYmd` itself when the CSV is empty or
 * unparseable. Pure calendar arithmetic — no timezones involved.
 */
export function nextOccurrenceYmd(dowCsv: string, fromYmd: string): string {
  const wanted = new Set(
    dowCsv
      .split(",")
      .map((d) => DOW_INDEX[d.trim().slice(0, 3).toLowerCase()])
      .filter((n): n is number => n !== undefined),
  );
  if (wanted.size === 0) return fromYmd;
  // Treat the ymd as a UTC date so weekday math is DST-proof.
  const base = new Date(`${fromYmd}T00:00:00Z`);
  for (let i = 0; i < 7; i++) {
    const d = new Date(base.getTime() + i * 86_400_000);
    if (wanted.has(d.getUTCDay())) return d.toISOString().slice(0, 10);
  }
  return fromYmd;
}

/** "$25.00" → 25; "Free"/"" → null. */
export function parseFee(label: string): number | null {
  const m = /\$\s*([\d,]+(?:\.\d+)?)/.exec(label);
  if (!m) return null;
  const n = parseFloat(m[1]!.replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

/**
 * Split a location label into venue + optional address.
 *   "Balboa Park Club (2150 Pan American Road, 92101)" → venue + parenthesized address
 *   "Stockton Recreation Center, 330 32nd Street, San Diego, CA 92102" → split at first comma
 *   "Fitness Room" → venue only (room-only labels carry no geocodable address)
 */
export function parseLocation(label: string): { venue: string; address?: string } {
  const trimmed = label.trim();
  const paren = /^(.*?)\s*\((.+)\)$/.exec(trimmed);
  if (paren && /\d/.test(paren[2]!)) {
    return { venue: paren[1]!.trim(), address: paren[2]!.trim() };
  }
  const comma = trimmed.indexOf(",");
  if (comma > 0 && /\d/.test(trimmed.slice(comma))) {
    return { venue: trimmed.slice(0, comma).trim(), address: trimmed };
  }
  return { venue: trimmed };
}

const CATEGORY_RULES: Array<[RegExp, Category]> = [
  [/cook|culinary|baking/i, "food"],
  [/danc|ballet|salsa|hip ?hop|baton/i, "arts"],
  [/\bart\b|paint|craft|ceramic|pottery|music|guitar|piano|theat|drama|photo/i, "arts"],
  [/yoga|fitness|zumba|pilates|aerobic|swim|aquatic|tennis|pickleball|golf|basketball|soccer|futsal|volleyball|softball|league|martial|karate|taekwondo|boxing|skate|surf|walk|run|hik/i, "sports"],
  [/concert|festival/i, "festival"],
  [/movie|film/i, "film"],
  [/lecture|workshop|seminar|class/i, "talk"],
];

/** Category from the activity name; rec-programming defaults to "community". */
export function deriveCategory(name: string): Category {
  for (const [re, cat] of CATEGORY_RULES) if (re.test(name)) return cat;
  return "community";
}

/** Ranker/filter tags: provenance, format, audience. */
export function deriveTags(a: ActiveNetActivity, inProgress: boolean): string[] {
  const tags = new Set<string>(["parks-and-rec", "rec-center"]);
  if (!a.only_one_day) tags.add("class");
  if (a.allow_drop_in_reg) tags.add("drop-in");
  if (inProgress) tags.add("in-progress");
  if (a.age_min_year >= 18) tags.add("adults");
  if (a.age_min_year >= 50) tags.add("seniors");
  // Age fields are sometimes left empty by rec-center staff — also catch
  // youth programming by name so the ranker can down-rank it for adult queries.
  if ((a.age_max_year > 0 && a.age_max_year < 18) || /\byouth\b|\bkids?\b|\bteens?\b|\d+u\b/i.test(a.name)) {
    tags.add("youth");
  }
  if (/family/i.test(a.name)) tags.add("family");
  return [...tags];
}

// ============================================================================
// Row filter + core mapper — pure functions, unit-testable
// ============================================================================

export type SkipReason = "parent" | "no-date" | "ended" | "youth";

/**
 * Decide whether a row becomes an event. `todayYmd` is the LA calendar date.
 * Returns a skip reason, or null when the row should be mapped.
 */
export function skipReason(a: ActiveNetActivity, todayYmd: string): SkipReason | null {
  if (a.parent_activity) return "parent";
  if (!a.date_range_start) return "no-date";
  if (a.age_max_year > 0 && a.age_max_year < 18) return "youth";
  const lastDay = a.date_range_end || a.date_range_start;
  if (lastDay < todayYmd) return "ended";
  return null;
}

/**
 * Map one activity row (already vetted by skipReason) to an EventItem.
 * `todayYmd` is the LA calendar date, injected for testability.
 */
export function mapActivityToEvent(a: ActiveNetActivity, todayYmd: string): EventItem {
  const title = a.name.trim();
  const inProgress = a.date_range_start < todayYmd;
  const eventYmd = inProgress
    ? nextOccurrenceYmd(a.days_of_week, todayYmd)
    : a.date_range_start;

  const times = a.time_range ? parseTimeRange(a.time_range) : null;
  const startNaive = times ? `${eventYmd}T${times.start}:00` : `${eventYmd}T00:00:00`;
  const startDatetime = utcIsoToLaIso(new Date(naiveLaToUtcMs(startNaive)).toISOString());

  const { venue, address } = parseLocation(a.location.label);
  const price = parseFee(a.fee.label);
  const isFree = /^free$/i.test(a.fee.label.trim()) || price === 0;
  const ticketUrl =
    (a.enroll_now?.href || a.detail_url || SEARCH_PAGE_URL).trim() || SEARCH_PAGE_URL;
  const description = a.desc ? stripHtml(a.desc).slice(0, 300) : "";

  const event: EventItem = {
    id: stableId(title, startDatetime, venue),
    title,
    startDatetime,
    allDay: !times,
    venue,
    category: deriveCategory(title),
    tags: deriveTags(a, inProgress),
    isFree,
    ticketUrl,
    sourceUrl: a.detail_url || SEARCH_PAGE_URL,
    sources: [{ sourceId: SOURCE_ID, url: ticketUrl }],
    fetchedAt: new Date().toISOString(),
    status: "scheduled",
  };
  if (address) event.address = address;
  if (times?.end) {
    const endNaive = `${eventYmd}T${times.end}:00`;
    event.endDatetime = utcIsoToLaIso(new Date(naiveLaToUtcMs(endNaive)).toISOString());
  }
  if (price !== null && price > 0) {
    event.priceMin = price;
    event.currency = "USD";
  }
  if (description) {
    // Multi-week sessions: surface the session span + cadence the single
    // event row no longer carries structurally.
    const span = a.date_range_end && !a.only_one_day
      ? `[Session ${a.date_range_start} to ${a.date_range_end}${a.days_of_week ? `, ${a.days_of_week}` : ""}] `
      : "";
    event.description = `${span}${description}`.slice(0, 300);
  }
  return event;
}

// ============================================================================
// Runner — pages through the list API and returns EventItem[]
// ============================================================================

function searchBody(): string {
  return JSON.stringify({
    activity_search_pattern: {
      activity_select_param: 2,
      activity_keyword: "",
      activity_id: null,
      date_after: "",
      date_before: "",
      time_after_str: "",
      time_before_str: "",
      days_of_week: null,
      min_age: null,
      max_age: null,
      open_spots: null,
      center_ids: [],
      activity_category_ids: [],
      activity_type_ids: [],
      site_ids: [],
      geographic_area_ids: [],
      season_ids: [],
      activity_department_ids: [],
      activity_other_category_ids: [],
      child_season_ids: [],
      instructor_ids: [],
      skills: [],
      custom_price_from: "",
      custom_price_to: "",
      for_map: false,
    },
    activity_transfer_pattern: {},
  });
}

async function fetchPage(pageNumber: number): Promise<ActiveNetListResponse> {
  const res = await fetch(API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json;charset=utf-8",
      page_info: JSON.stringify({
        order_by: "",
        page_number: pageNumber,
        total_records_per_page: PER_PAGE,
      }),
      "User-Agent": "Mozilla/5.0 (EventScout; Kaya personal assistant)",
    },
    body: searchBody(),
  });
  if (!res.ok) {
    throw new Error(`ActiveNet list request failed: ${res.status} ${res.statusText} (page ${pageNumber})`);
  }
  const data = (await res.json()) as ActiveNetListResponse;
  if (data.headers.response_code !== "0000") {
    throw new Error(
      `ActiveNet list API error on page ${pageNumber}: ${data.headers.response_code} ${data.headers.response_message}`,
    );
  }
  return data;
}

/** LA calendar date (YYYY-MM-DD) for "today". */
function laTodayYmd(): string {
  return utcIsoToLaIso(new Date().toISOString()).slice(0, 10);
}

export async function fetchActiveNetEvents(): Promise<EventItem[]> {
  const todayYmd = laTodayYmd();
  const rows: ActiveNetActivity[] = [];

  const first = await fetchPage(1);
  rows.push(...first.body.activity_items);
  const totalPages = Math.min(first.headers.page_info.total_page, MAX_PAGES);
  if (first.headers.page_info.total_page > MAX_PAGES) {
    console.warn(
      `  [activenet] catalog has ${first.headers.page_info.total_page} pages; capped at ${MAX_PAGES}`,
    );
  }

  for (let p = 2; p <= totalPages; p++) {
    await new Promise((r) => setTimeout(r, PAGE_GAP_MS));
    const page = await fetchPage(p);
    if (page.body.activity_items.length === 0) break;
    rows.push(...page.body.activity_items);
  }

  const skipped: Record<SkipReason, number> = { parent: 0, "no-date": 0, ended: 0, youth: 0 };
  const events: EventItem[] = [];
  for (const a of rows) {
    const skip = skipReason(a, todayYmd);
    if (skip) {
      skipped[skip]++;
      continue;
    }
    events.push(mapActivityToEvent(a, todayYmd));
  }
  console.log(
    `  [activenet] ${rows.length} rows → ${events.length} events ` +
      `(skipped: ${skipped.parent} parent, ${skipped["no-date"]} no-date, ` +
      `${skipped.ended} ended, ${skipped.youth} youth-only)`,
  );
  return events;
}

// ============================================================================
// Script entry point
// ============================================================================

const IS_SCRIPT =
  typeof process !== "undefined" &&
  process.argv[1] != null &&
  (process.argv[1].endsWith("ActiveNetAdapter.ts") ||
    process.argv[1].endsWith("ActiveNetAdapter"));

if (IS_SCRIPT) {
  console.log(`\nFetching SD Parks & Rec activities (ActiveNet catalog)...\n`);
  try {
    const events = await fetchActiveNetEvents();
    upsertEvents(events);
    console.log(`Upserted ${events.length} activity event(s) to cache.\n`);
    for (const e of events.slice(0, 15)) {
      console.log(
        `  [${e.startDatetime}] ${e.title} — ${e.venue ?? "TBD"}` +
          ` (${e.isFree ? "Free" : `$${e.priceMin ?? "?"}`})`,
      );
    }
    console.log(`\nSource: ${SOURCE_ID}`);
    process.exit(0);
  } catch (err) {
    console.error(`\nFATAL: ${(err as Error).message}`);
    process.exit(1);
  }
}
