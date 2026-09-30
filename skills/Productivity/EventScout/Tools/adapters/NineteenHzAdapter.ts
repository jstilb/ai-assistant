#!/usr/bin/env bun
/**
 * NineteenHzAdapter.ts — 19hz.info SoCal electronic-music listings → EventItem.
 *
 * 19hz publishes the best SoCal electronic listing as a server-rendered,
 * rigidly-structured chronological <table> (two tables: near-term + later).
 * The old spa-tier LLM extraction chronically timed out on the dense
 * current-week window (0/4 prefetch runs finished inside the 600s budget —
 * 2026-08-19); a structured table is exactly the case where determinism EARNS
 * its place, so this adapter parses the rows directly: no browser, no LLM.
 *
 * Row shape (one line, td[1] is UNCLOSED — split on `<td` boundaries, never
 * require `</td>`):
 *
 *   <tr><td>Fri: Aug 21 <br />(9pm-2am)</td>
 *       <td><a href='TICKET_URL'>Title</a> @ Venue (City)
 *       <td>genre, genre</td><td>$21 | 18+</td><td>Organizer</td>
 *       <td>[extra links]</td><td><div class='shrink'>2026/08/21</div></td></tr>
 *
 * The shrink div carries a full YYYY/MM/DD date — authoritative, no year
 * inference. The listing is SoCal-WIDE (~900 rows, mostly LA); rows are
 * filtered to San Diego-county cities before geocoding — a structured
 * geographic constraint (the radius filter's job, applied early so prefetch
 * doesn't Nominatim-geocode hundreds of LA venues at 1 req/s).
 *
 * Mirrors RaCoAdapter: pure mappers (unit-testable, no network) + a fetch
 * runner. fetchNineteenHzEvents() returns EventItem[]; it does NOT write cache.
 */

import { createHash } from "crypto";
import type { EventItem, EventSource } from "../types.ts";
import { naiveLaToUtcMs, utcIsoToLaIso, utcMsToLaParts } from "../lib/tz.ts";

// ============================================================================
// Constants
// ============================================================================

const FETCH_TIMEOUT_MS = 30_000;
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36";

/**
 * San Diego-county city labels as 19hz prints them in "@ Venue (City)".
 * Substring-matched case-insensitively against the city token only.
 */
const SD_CITIES = [
  "san diego",
  "la jolla",
  "pacific beach",
  "ocean beach",
  "point loma",
  "north park",
  "chula vista",
  "national city",
  "imperial beach",
  "oceanside",
  "carlsbad",
  "encinitas",
  "solana beach",
  "del mar",
  "escondido",
  "vista",
  "san marcos",
  "el cajon",
  "la mesa",
  "santee",
  "poway",
  "spring valley",
  "lemon grove",
];

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
// Pure parsers
// ============================================================================

/** One raw table row, split into cell HTML fragments. */
export interface NineteenHzRow {
  /** "Fri: Aug 21 <br />(9pm-2am)" — or "Mondays (8pm-1:30am)" for recurring rows */
  dayTime: string;
  /** "<a href='URL'>Title</a> @ Venue (City)" */
  eventHtml: string;
  /** "house, techno" */
  genres: string;
  /** "$21 | 18+" */
  priceAge: string;
  organizer: string;
  linksHtml: string;
  /**
   * "2026-08-21" (from the dated table's shrink div), or null for the
   * recurring-weeklies table (6 cells, no date column) — resolved to the
   * next occurrence by mapRowToItem.
   */
  date: string | null;
}

function stripTags(html: string): string {
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Split the page into row objects. Tolerant of the site's unclosed td in the
 * event cell: cells are delimited by `<td` openings, never by closing tags.
 * 7 cells = the dated listing tables (last cell holds a full YYYY/MM/DD);
 * 6 cells = the recurring-weeklies table (no date column) → date: null.
 * Anything else (headers, separators) is skipped.
 */
export function parseRows(html: string): NineteenHzRow[] {
  const rows: NineteenHzRow[] = [];
  const trChunks = html.split(/<tr[ >]/i).slice(1);
  for (const chunk of trChunks) {
    const rowHtml = chunk.split(/<\/tr>/i)[0] ?? "";
    const cells = rowHtml
      .split(/<td[ >]/i)
      .slice(1)
      .map((c) => c.replace(/<\/td>.*$/is, "").trim());
    if (cells.length !== 7 && cells.length !== 6) continue;

    let date: string | null = null;
    if (cells.length === 7) {
      const dateMatch = /(\d{4})\/(\d{2})\/(\d{2})/.exec(cells[6]!);
      if (!dateMatch) continue;
      date = `${dateMatch[1]}-${dateMatch[2]}-${dateMatch[3]}`;
    }
    rows.push({
      dayTime: cells[0]!,
      eventHtml: cells[1]!,
      genres: stripTags(cells[2]!),
      priceAge: stripTags(cells[3]!),
      organizer: stripTags(cells[4]!),
      linksHtml: cells[5]!,
      date,
    });
  }
  return rows;
}

// ============================================================================
// Recurring-row date resolution ("Mondays", "2nd Saturdays" → next occurrence)
// ============================================================================

const WEEKDAYS = [
  "sundays",
  "mondays",
  "tuesdays",
  "wednesdays",
  "thursdays",
  "fridays",
  "saturdays",
];

function isoWeekday(iso: string): number {
  return new Date(`${iso}T12:00:00Z`).getUTCDay();
}

function isoAddDays(iso: string, days: number): string {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * "Mondays" / "2nd Saturdays (9pm-2am)" → the next matching date >= todayIso
 * (YYYY-MM-DD), or null for patterns this doesn't model. Ordinals ("1st"…"5th")
 * mean the Nth such weekday of the month; a month without that occurrence
 * (a 5th, usually) rolls to the next month.
 */
export function nextOccurrenceDate(dayLabel: string, todayIso: string): string | null {
  const m = /^(?:(1st|2nd|3rd|4th|5th)\s+)?(sundays|mondays|tuesdays|wednesdays|thursdays|fridays|saturdays)\b/i.exec(
    dayLabel.trim()
  );
  if (!m) return null;
  const weekday = WEEKDAYS.indexOf(m[2]!.toLowerCase());

  if (!m[1]) {
    const delta = (weekday - isoWeekday(todayIso) + 7) % 7;
    return isoAddDays(todayIso, delta);
  }

  const nth = parseInt(m[1], 10);
  // Check this month, then up to 2 more (a missing 5th occurrence rolls on).
  let [year, month] = [parseInt(todayIso.slice(0, 4), 10), parseInt(todayIso.slice(5, 7), 10)];
  for (let i = 0; i < 3; i++) {
    const first = `${year}-${String(month).padStart(2, "0")}-01`;
    const offsetToWeekday = (weekday - isoWeekday(first) + 7) % 7;
    const candidate = isoAddDays(first, offsetToWeekday + (nth - 1) * 7);
    const inMonth = candidate.slice(0, 7) === first.slice(0, 7);
    if (inMonth && candidate >= todayIso) return candidate;
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
  }
  return null;
}

/** "(9pm-2am)" / "(9:30pm)" → { start, end? } as {hour, minute} 24h, or null. */
export function parseTimeRange(
  dayTime: string
): { start: { hour: number; minute: number }; end?: { hour: number; minute: number } } | null {
  const paren = /\(([^)]*)\)/.exec(stripTags(dayTime));
  if (!paren) return null;
  const tokens = paren[1]!.split(/[-–]/).map((t) => t.trim());
  const parseOne = (t: string): { hour: number; minute: number } | null => {
    const m = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/i.exec(t);
    if (!m) return null;
    let hour = parseInt(m[1]!, 10) % 12;
    if (m[3]!.toLowerCase() === "pm") hour += 12;
    return { hour, minute: m[2] ? parseInt(m[2], 10) : 0 };
  };
  const start = parseOne(tokens[0] ?? "");
  if (!start) return null;
  const end = tokens[1] ? parseOne(tokens[1]) : null;
  return end ? { start, end } : { start };
}

/**
 * "$21 | 18+" / "$48-103 | 18+" / "Free b4 10:30pm | 21+" / "21+" →
 * price + age tag. Price absent (age-only / TBA) → unknown, NOT free.
 */
export function parsePriceAge(priceAge: string): {
  isFree: boolean;
  priceMin?: number;
  priceMax?: number;
  ageTag?: string;
} {
  // No trailing \b — a word boundary can never match right after the "+"
  // (both neighbors are non-word characters), so "21+" would never be caught.
  const age = /\b(\d{2}\+|all ages)/i.exec(priceAge);
  const ageTag = age ? age[1]!.toLowerCase() : undefined;
  const pricePart = priceAge.split("|")[0]!.trim();
  const out: { isFree: boolean; priceMin?: number; priceMax?: number; ageTag?: string } = {
    isFree: /\bfree\b/i.test(pricePart),
  };
  if (ageTag) out.ageTag = ageTag;
  const m = /\$\s*([\d,]+(?:\.\d+)?)(?:\s*[-–]\s*\$?\s*([\d,]+(?:\.\d+)?))?/.exec(pricePart);
  if (m) {
    const min = parseFloat(m[1]!.replace(/,/g, ""));
    if (Number.isFinite(min)) out.priceMin = min;
    if (m[2]) {
      const max = parseFloat(m[2].replace(/,/g, ""));
      if (Number.isFinite(max)) out.priceMax = max;
    }
  }
  return out;
}

/** "<a href='URL'>Title</a> @ Venue (City)" → parts. Null without a title. */
export function parseEventCell(
  eventHtml: string
): { title: string; url: string | null; venue: string; city: string } | null {
  const anchor = /<a\s+[^>]*href=['"]([^'"]*)['"][^>]*>(.*?)<\/a>/is.exec(eventHtml);
  const url = anchor ? anchor[1]!.trim() : null;
  const afterAnchor = anchor ? eventHtml.slice(anchor.index + anchor[0].length) : eventHtml;
  const title = stripTags(anchor ? anchor[2]! : eventHtml.split("@")[0] ?? "");
  if (!title) return null;

  // Venue = text after "@", city = the LAST parenthesized group in it.
  const atIdx = afterAnchor.indexOf("@");
  const venueRaw = stripTags(atIdx >= 0 ? afterAnchor.slice(atIdx + 1) : "");
  const cityMatch = /\(([^()]*)\)\s*$/.exec(venueRaw);
  const city = cityMatch ? cityMatch[1]!.trim() : "";
  const venue = (cityMatch ? venueRaw.slice(0, cityMatch.index) : venueRaw).trim();
  return { title, url, venue, city };
}

export function isSanDiegoCity(city: string): boolean {
  const c = city.toLowerCase();
  return SD_CITIES.some((sd) => c.includes(sd));
}

/** Naive LA wall-clock → LA-offset ISO (same construction as RaCoAdapter). */
function laIso(date: string, hour: number, minute: number, dayOffset = 0): string {
  const naive = `${date}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00`;
  const ms = naiveLaToUtcMs(naive) + dayOffset * 24 * 60 * 60 * 1000;
  return utcIsoToLaIso(new Date(ms).toISOString());
}

/**
 * Map one parsed row to an EventItem. Pure — `fetchedAt` and `todayLaDate`
 * (YYYY-MM-DD, for recurring-row resolution) injected. Returns null for
 * non-SD rows and rows missing essentials.
 */
export function mapRowToItem(
  row: NineteenHzRow,
  sourceId: string,
  pageUrl: string,
  fetchedAt: string,
  todayLaDate: string
): EventItem | null {
  const cell = parseEventCell(row.eventHtml);
  if (!cell) return null;
  if (!isSanDiegoCity(cell.city)) return null;

  const recurring = row.date == null;
  const date = row.date ?? nextOccurrenceDate(stripTags(row.dayTime), todayLaDate);
  if (!date) return null;

  const time = parseTimeRange(row.dayTime);
  const allDay = time == null;
  const startDatetime = time
    ? laIso(date, time.start.hour, time.start.minute)
    : laIso(date, 0, 0);

  const genres = row.genres
    .split(",")
    .map((g) => g.trim().toLowerCase())
    .filter(Boolean);
  const { isFree, priceMin, priceMax, ageTag } = parsePriceAge(row.priceAge);

  const tags = ["electronic", "nightlife", "19hz", ...genres];
  if (ageTag) tags.push(ageTag);
  if (recurring) tags.push("recurring");

  const eventUrl = cell.url ?? pageUrl;
  const item: EventItem = {
    id: stableId(cell.title, startDatetime, cell.venue),
    title: cell.title,
    startDatetime,
    allDay,
    category: "music",
    tags,
    isFree,
    ticketUrl: eventUrl,
    sourceUrl: eventUrl,
    sources: [{ sourceId, url: eventUrl }],
    fetchedAt,
    status: "scheduled",
  };
  if (cell.venue) item.venue = cell.venue;
  if (cell.city) item.address = `${cell.city}, CA`;
  if (time?.end) {
    // An end at/before the start ("9pm-2am") crosses midnight → next day.
    const crossesMidnight =
      time.end.hour < time.start.hour ||
      (time.end.hour === time.start.hour && time.end.minute <= time.start.minute);
    item.endDatetime = laIso(date, time.end.hour, time.end.minute, crossesMidnight ? 1 : 0);
  }
  if (priceMin !== undefined) {
    item.priceMin = priceMin;
    item.currency = "USD";
  }
  if (priceMax !== undefined) item.priceMax = priceMax;

  const descParts: string[] = [];
  if (recurring) descParts.push(`Recurring: ${stripTags(row.dayTime)}`);
  if (row.organizer) descParts.push(`Presented by ${row.organizer}`);
  if (descParts.length > 0) item.description = descParts.join(". ").slice(0, 300);
  return item;
}

// ============================================================================
// Fetch runner
// ============================================================================

export async function fetchNineteenHzEvents(source: EventSource): Promise<EventItem[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let html: string;
  try {
    const res = await fetch(source.url, {
      headers: { "User-Agent": USER_AGENT, Accept: "text/html" },
      redirect: "follow",
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    html = await res.text();
  } finally {
    clearTimeout(timer);
  }

  const rows = parseRows(html);
  if (rows.length === 0) {
    // A structure change must fail LOUDLY, not read as "no events this week".
    throw new Error(
      `[NineteenHz] parsed 0 rows from ${source.url} (${html.length} chars) — page structure changed?`
    );
  }

  const fetchedAt = new Date().toISOString();
  const nowParts = utcMsToLaParts(Date.now());
  const todayLaDate = `${nowParts.year}-${String(nowParts.month).padStart(2, "0")}-${String(nowParts.day).padStart(2, "0")}`;
  const byId = new Map<string, EventItem>();
  for (const row of rows) {
    const item = mapRowToItem(row, source.id, source.url, fetchedAt, todayLaDate);
    if (item) byId.set(item.id, item);
  }
  console.log(
    `[NineteenHz] ${rows.length} rows parsed, ${byId.size} San Diego-area events kept`
  );
  return [...byId.values()];
}
