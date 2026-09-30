#!/usr/bin/env bun
/**
 * CtycmsAdapter.ts — adapter for the ctycms "Picnic" events calendar widget.
 *
 * First (and only) consumer: Liberty Station (libertystation.com), a ctykit /
 * ctycms-hosted community + arts district site. Its /events/calendar page is a
 * JS shell — the events themselves are served by an AJAX endpoint:
 *
 *   GET {origin}/_templates/_picnic_list_ajax.php?ds=YYYY-MM-DD&de=YYYY-MM-DD&ti=<tagId>
 *
 * (ds = date-start floor, de = date-end ceiling, ti = tag/category id). Without
 * ds/de the endpoint throws a PHP fatal, so we always pass an explicit window.
 * The response is clean server-rendered HTML cards (`a.pcrd`) carrying title,
 * time, venue, a date box (dow/day/month — NO year), a /do/<slug> detail link,
 * and a flyer image. We parse those deterministically — no LLM, no Playwright —
 * which is far more reliable than scraping the un-hydrated calendar shell.
 *
 * Why a dedicated adapter (not html-llm pointed at the .php URL): the card dates
 * are year-less and the endpoint needs live ds/de params baked into the URL
 * (which would drift). Computing the window here keeps it fresh and lets us
 * resolve each card's year against "today" exactly.
 *
 * Category: the listing cards carry no per-card category, but the endpoint can
 * filter by tag (`ti`). We fetch the site's category tags and assign categories
 * from that authoritative taxonomy. The "performance" tag is a grab-bag
 * (improv/comedy + musicals + concerts + the odd wrestling night), so events
 * found only there are classified by title (comedy vs theater).
 *
 * Exports:
 *   parseCards(html): PicnicCard[]                  — PURE, no network
 *   classifyPerformanceTitle(title): Category       — PURE
 *   mapCardToEvent(card, category, source, refMs): EventItem  — PURE
 *   fetchCtycmsEvents(source): Promise<EventItem[]> — fetch + parse + merge
 *
 * Script mode (bun .../CtycmsAdapter.ts): fetches Liberty Station live and
 * prints a summary. Does NOT write to cache.
 */

import { createHash } from "crypto";
import type { EventItem, EventSource, Category } from "../types.ts";
import { naiveLaToUtcMs, utcIsoToLaIso, utcMsToLaParts } from "../lib/tz.ts";

// ============================================================================
// Per-source tag configuration
//
// Tag ids are site-specific (they index that site's own category taxonomy), so
// they live in a per-source map keyed by EventSource.id. Liberty Station is the
// only consumer today; add an entry here to onboard another ctycms site.
// ============================================================================

interface CtycmsConfig {
  /** "All events" tag — the base set (default category applied). */
  allTi: number;
  /** Grab-bag "performance" tag classified by title. Omit if the site lacks one. */
  performanceTi?: number;
  /** Authoritative tag → category overrides. */
  tags: ReadonlyArray<{ ti: number; category: Category }>;
  /**
   * Street address of the venue complex, used for geocoding. The per-card venue
   * names (e.g. "Visions Museum of Textile Art") rarely geocode on their own, so
   * we anchor every event to this address — Nominatim needs a street number.
   * The card's venue name is still kept for display.
   */
  geocodeAddress: string;
}

const SITE_CONFIG: Record<string, CtycmsConfig> = {
  "liberty-station": {
    allTi: 24, // "All Events"
    performanceTi: 41, // improv/comedy + musicals + concerts → split by title
    tags: [
      { ti: 53, category: "film" }, // events-film
      { ti: 40, category: "music" }, // music
      { ti: 43, category: "arts" }, // exhibit
      { ti: 54, category: "arts" }, // art-and-craft
      { ti: 51, category: "food" }, // food-and-drink
      { ti: 39, category: "community" }, // family-friendly
    ],
    geocodeAddress: "2640 Historic Decatur Rd, San Diego, CA 92106",
  },
};

/** How far ahead to pull. Kept under the endpoint's ~200-row cap on the all-set. */
const HORIZON_DAYS = 90;

const MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

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
// HTML helpers
// ============================================================================

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&#0?38;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#8211;|&ndash;/g, "–")
    .replace(/&#8217;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

/** Extract the inner text of the first element whose class matches `cls`. */
function pickDiv(block: string, cls: string): string | undefined {
  const re = new RegExp(`class="${cls}"[^>]*>([\\s\\S]*?)</div>`, "i");
  const m = block.match(re);
  if (!m) return undefined;
  // Strip any nested tags (icon <span>/<i>), then decode.
  const text = decodeEntities(m[1]!.replace(/<[^>]+>/g, " "));
  return text.length ? text : undefined;
}

// ============================================================================
// Card parsing — PURE
// ============================================================================

export interface PicnicCard {
  /** Detail path, e.g. "/do/cyanotype" (or absolute URL). */
  href: string;
  /** Last path segment — stable per-event key. */
  slug: string;
  title: string;
  venue?: string;
  /** Raw time text, e.g. "8:30pm - 9:45pm" or undefined (all-day). */
  timeText?: string;
  dow?: string;
  day: number;
  /** 0-based month index. */
  month: number;
  imageUrl?: string;
}

/**
 * Parse the AJAX HTML into Picnic cards. Each card is one `<a class="pcrd" ...>`
 * block. Cards missing a parseable date box are skipped.
 */
export function parseCards(html: string): PicnicCard[] {
  const cards: PicnicCard[] = [];
  const blockRe = /<a\s+class="pcrd"\s+href="([^"]+)"[\s\S]*?<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = blockRe.exec(html)) !== null) {
    const block = m[0]!;
    const href = m[1]!.trim();

    const title = pickDiv(block, "pcrd-content-headline");
    if (!title) continue;

    // Date box: dow / day / month (no year).
    const dowM = block.match(/class="pcrd-date-dow"[^>]*>([^<]+)</i);
    const dayM = block.match(/class="pcrd-date-day"[^>]*>([^<]+)</i);
    const monM = block.match(/class="pcrd-date-month"[^>]*>([^<]+)</i);
    if (!dayM || !monM) continue;
    const day = parseInt(dayM[1]!.trim(), 10);
    const month = MONTHS[monM[1]!.trim().slice(0, 3).toLowerCase()];
    if (!Number.isFinite(day) || month === undefined) continue;

    const venue = pickDiv(block, "pcrd-content-venue");
    const timeText = pickDiv(block, "pcrd-content-time");

    const imgM = block.match(/pcrd-image-image[^"]*"[^>]*data-src="([^"]+)"/i);

    const slug = href.split("?")[0]!.replace(/\/+$/, "").split("/").pop() ?? href;

    cards.push({
      href,
      slug,
      title,
      venue,
      timeText,
      dow: dowM?.[1]?.trim(),
      day,
      month,
      imageUrl: imgM?.[1],
    });
  }
  return cards;
}

// ============================================================================
// Title classification for the "performance" grab-bag — PURE
// ============================================================================

export function classifyPerformanceTitle(title: string): Category {
  const t = title.toLowerCase();
  if (/\b(improv|comedy|stand-?up|stand up|open mic|laughs?|sketch)\b/.test(t)) {
    return "comedy";
  }
  if (/\b(musical|the\s+\w+\s+musical|cabaret|opera|symphony|orchestra|concert|live music|dj\b)\b/.test(t)) {
    return "music";
  }
  // SpongeBob Musical, plays, "A Space Western", etc. → theater
  return "theater";
}

// ============================================================================
// Time parsing — PURE
// ============================================================================

/** Parse "8:30pm" / "1pm" / "12am" → minutes since midnight, or null. */
function parseClock(token: string): number | null {
  const m = token.trim().toLowerCase().match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/);
  if (!m) return null;
  let h = parseInt(m[1]!, 10);
  const min = m[2] ? parseInt(m[2], 10) : 0;
  const mer = m[3]!;
  if (h === 12) h = 0;
  if (mer === "pm") h += 12;
  return h * 60 + min;
}

interface ParsedTime {
  startMin: number | null; // null → all-day
  endMin: number | null;
}

/** Pull the first one/two clock tokens from a time string; ignore trailing prose. */
function parseTimeText(timeText: string | undefined): ParsedTime {
  if (!timeText) return { startMin: null, endMin: null };
  const tokens = timeText.match(/\d{1,2}(?::\d{2})?\s*(?:am|pm)/gi) ?? [];
  const startMin = tokens[0] ? parseClock(tokens[0]) : null;
  const endMin = tokens[1] ? parseClock(tokens[1]) : null;
  return { startMin, endMin };
}

// ============================================================================
// Year resolution — PURE
//
// Cards carry month+day but no year. Resolve to the first occurrence on or
// after the reference day (LA): if the card's (month,day) precedes today's,
// it belongs to next year. Horizon < 1 year keeps this unambiguous.
// ============================================================================

function resolveYear(month0: number, day: number, refMs: number): number {
  const ref = utcMsToLaParts(refMs);
  const refMonth0 = ref.month - 1;
  let year = ref.year;
  if (month0 < refMonth0 || (month0 === refMonth0 && day < ref.day)) year += 1;
  return year;
}

// ============================================================================
// Card → EventItem — PURE
// ============================================================================

export function mapCardToEvent(
  card: PicnicCard,
  category: Category,
  source: EventSource,
  refMs: number,
  geocodeAddress: string
): EventItem {
  const origin = new URL(source.url).origin;
  const detailUrl = card.href.startsWith("http") ? card.href : `${origin}${card.href}`;

  const year = resolveYear(card.month, card.day, refMs);
  const mm = String(card.month + 1).padStart(2, "0");
  const dd = String(card.day).padStart(2, "0");

  const { startMin, endMin } = parseTimeText(card.timeText);
  const allDay = startMin === null;

  const startNaive = allDay
    ? `${year}-${mm}-${dd}T00:00:00`
    : `${year}-${mm}-${dd}T${String(Math.floor(startMin! / 60)).padStart(2, "0")}:${String(startMin! % 60).padStart(2, "0")}:00`;
  const startDatetime = utcIsoToLaIso(new Date(naiveLaToUtcMs(startNaive)).toISOString());

  let endDatetime: string | undefined;
  if (!allDay && endMin !== null) {
    // End past midnight (rare): roll to next day.
    const endDayMs = naiveLaToUtcMs(`${year}-${mm}-${dd}T00:00:00`) +
      (endMin <= startMin! ? 24 * 60 : 0) * 60_000 + endMin * 60_000;
    endDatetime = utcIsoToLaIso(new Date(endDayMs).toISOString());
  }

  const venue = card.venue;
  // Anchor geocoding to the complex street address; keep the venue name as a
  // display prefix. buildGeoQuery() slices from the street number, so the prefix
  // doesn't hurt the lookup.
  const address = venue ? `${venue}, ${geocodeAddress}` : geocodeAddress;

  return {
    id: stableId(card.title, startDatetime, venue ?? "Liberty Station"),
    title: card.title,
    startDatetime,
    ...(endDatetime ? { endDatetime } : {}),
    allDay,
    venue: venue ?? "Liberty Station",
    address,
    category,
    tags: ["liberty-station", "point-loma"],
    isFree: false, // cards carry no price; do not assume free
    ticketUrl: detailUrl,
    sourceUrl: source.url,
    sources: [{ sourceId: source.id, url: detailUrl }],
    ...(card.imageUrl ? { imageUrl: card.imageUrl } : {}),
    fetchedAt: new Date().toISOString(),
    status: "scheduled",
  };
}

// ============================================================================
// Fetch runner
// ============================================================================

function ymd(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

async function fetchTag(origin: string, refererUrl: string, ds: string, de: string, ti: number): Promise<string> {
  const url = `${origin}/_templates/_picnic_list_ajax.php?ds=${ds}&de=${de}&ti=${ti}`;
  const res = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (EventScout; Kaya personal assistant)",
      "X-Requested-With": "XMLHttpRequest",
      Referer: refererUrl,
    },
  });
  if (!res.ok) {
    throw new Error(`ctycms picnic request failed: ${res.status} ${res.statusText} — ${url}`);
  }
  return res.text();
}

/**
 * Fetch all events for a ctycms Picnic source within the horizon window.
 * Merges the all-set with per-tag category fetches; category precedence is
 * base → performance(title) → authoritative tags (last write wins).
 */
export async function fetchCtycmsEvents(source: EventSource): Promise<EventItem[]> {
  const cfg = SITE_CONFIG[source.id];
  if (!cfg) {
    throw new Error(
      `[CtycmsAdapter] no tag config for source "${source.id}" — add one to SITE_CONFIG`
    );
  }

  const origin = new URL(source.url).origin;
  const refererUrl = source.url;
  const now = new Date();
  const refMs = now.getTime();
  const end = new Date(now);
  end.setDate(now.getDate() + HORIZON_DAYS);
  const ds = ymd(now);
  const de = ymd(end);

  const defaultCategory: Category = source.categoryHint ?? "community";

  // Keyed by event instance id (title + startDatetime + venue). Recurring shows
  // reuse one /do/<slug> across many dates, so keying by slug would collapse
  // them to one instance — the id keeps each date separate while still merging
  // the same instance seen under multiple tags (last category write wins).
  const byId = new Map<string, EventItem>();

  const applyCards = (html: string, categoryOf: (card: PicnicCard) => Category): void => {
    for (const card of parseCards(html)) {
      const category = categoryOf(card);
      const ev = mapCardToEvent(card, category, source, refMs, cfg.geocodeAddress);
      byId.set(ev.id, ev);
    }
  };

  // 1) Base "all" set (throws on failure → Ingest records it).
  applyCards(await fetchTag(origin, refererUrl, ds, de, cfg.allTi), () => defaultCategory);

  // 2) Performance grab-bag, classified by title.
  if (cfg.performanceTi !== undefined) {
    try {
      applyCards(
        await fetchTag(origin, refererUrl, ds, de, cfg.performanceTi),
        (c) => classifyPerformanceTitle(c.title)
      );
    } catch {
      /* non-fatal: base set already populated */
    }
  }

  // 3) Authoritative category tags (override title/default).
  for (const { ti, category } of cfg.tags) {
    try {
      applyCards(await fetchTag(origin, refererUrl, ds, de, ti), () => category);
    } catch {
      /* non-fatal: keep what we have */
    }
  }

  return [...byId.values()];
}

// ============================================================================
// Script entry point
// ============================================================================

const IS_SCRIPT =
  typeof process !== "undefined" &&
  process.argv[1] != null &&
  (process.argv[1].endsWith("CtycmsAdapter.ts") || process.argv[1].endsWith("CtycmsAdapter"));

if (IS_SCRIPT) {
  const source: EventSource = {
    id: "liberty-station",
    url: "https://libertystation.com/events/calendar",
    name: "Liberty Station",
    fetchTier: "ctycms",
    categoryHint: "community",
    geoHint: "Liberty Station, San Diego, CA 92106",
    pollInterval: 720,
    enabled: true,
  };
  console.log(`\nFetching Liberty Station events (today → +${HORIZON_DAYS} days)...\n`);
  try {
    const events = await fetchCtycmsEvents(source);
    console.log(`Parsed ${events.length} event(s).\n`);
    const byCat: Record<string, number> = {};
    for (const e of events) byCat[e.category] = (byCat[e.category] ?? 0) + 1;
    console.log("By category:", byCat, "\n");
    for (const e of events.slice(0, 15)) {
      console.log(`  [${e.startDatetime}] (${e.category}) ${e.title} — ${e.venue ?? "TBD"}`);
    }
    process.exit(0);
  } catch (err) {
    console.error(`\nFATAL: ${(err as Error).message}`);
    process.exit(1);
  }
}
