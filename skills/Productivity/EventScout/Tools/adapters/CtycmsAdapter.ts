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
 * Live probe: bun Tools/Ingest.ts --source liberty-station
 */

import type { EventItem, EventSource, Category } from "../types.ts";
import { naiveLaToUtcMs, utcIsoToLaIso, utcMsToLaParts } from "../lib/tz.ts";
import { stableId } from "./AdapterUtil.ts";

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
  jan: 0,
  feb: 1,
  mar: 2,
  apr: 3,
  may: 4,
  jun: 5,
  jul: 6,
  aug: 7,
  sep: 8,
  oct: 9,
  nov: 10,
  dec: 11,
};

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

interface PicnicCard {
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
  // The site renamed the card class from "pcrd" to "evcard" (seen 2026-11-08);
  // the inner structure is the same, so both prefixes parse.
  const blockRe = /<a\s+class="(pcrd|evcard)"\s+href="([^"]+)"[\s\S]*?<\/a>/gi;
  for (const m of html.matchAll(blockRe)) {
    const [block, p, rawHref] = m;
    if (!p || !rawHref) continue;
    const href = rawHref.trim();

    const title = pickDiv(block, `${p}-content-headline`);
    if (!title) continue;

    // Date box: dow / day / month (no year).
    const dowM = block.match(new RegExp(`class="${p}-date-dow"[^>]*>([^<]+)<`, "i"));
    const dayM = block.match(new RegExp(`class="${p}-date-day"[^>]*>([^<]+)<`, "i"));
    const monM = block.match(new RegExp(`class="${p}-date-month"[^>]*>([^<]+)<`, "i"));
    if (!dayM || !monM) continue;
    const day = parseInt(dayM[1]!.trim(), 10);
    const month = MONTHS[monM[1]!.trim().slice(0, 3).toLowerCase()];
    if (!Number.isFinite(day) || month === undefined) continue;

    const venue = pickDiv(block, `${p}-content-venue`);
    const timeText = pickDiv(block, `${p}-content-time`);

    const imgM = block.match(new RegExp(`${p}-image-image[^"]*"[^>]*data-src="([^"]+)"`, "i"));

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
  const m = token
    .trim()
    .toLowerCase()
    .match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/);
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
  geocodeAddress: string,
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
    const endDayMs =
      naiveLaToUtcMs(`${year}-${mm}-${dd}T00:00:00`) + (endMin <= startMin! ? 24 * 60 : 0) * 60_000 + endMin * 60_000;
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

const USER_AGENT = "Mozilla/5.0 (EventScout; Kaya personal assistant)";

/**
 * GET the calendar page once and return its session cookie ("name=value").
 * Since 2026-11 the AJAX endpoint reads session keys that the page sets; with
 * no session it answers HTTP 200 with PHP warnings and zero cards.
 */
async function primeSession(pageUrl: string): Promise<string> {
  const res = await fetch(pageUrl, { headers: { "User-Agent": USER_AGENT } });
  if (!res.ok) {
    throw new Error(`ctycms calendar page request failed: ${res.status} ${res.statusText} — ${pageUrl}`);
  }
  await res.text();
  const cookie = res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0]?.trim() ?? "")
    .find((c) => c.startsWith("PHPSESSID="));
  if (!cookie) {
    throw new Error(`ctycms calendar page set no PHPSESSID cookie — ${pageUrl}`);
  }
  return cookie;
}

async function fetchTag(
  origin: string,
  refererUrl: string,
  cookie: string,
  rt: number,
  ds: string,
  de: string,
  ti: number,
): Promise<string> {
  const url = `${origin}/_templates/_picnic_list_ajax.php?rt=${rt}&ds=${ds}&de=${de}&ti=${ti}`;
  const res = await fetch(url, {
    headers: {
      "User-Agent": USER_AGENT,
      "X-Requested-With": "XMLHttpRequest",
      Referer: refererUrl,
      Cookie: cookie,
    },
  });
  if (!res.ok) {
    throw new Error(`ctycms picnic request failed: ${res.status} ${res.statusText} — ${url}`);
  }
  const body = await res.text();
  // A broken request still answers 200, with PHP warnings and no cards. Fail
  // loudly so Ingest records an error instead of "fetched 0 event(s)".
  if (/<b>(?:Warning|Notice|Fatal error)<\/b>:/i.test(body)) {
    throw new Error(`ctycms picnic response contains PHP errors (session or params changed?) — ${url}`);
  }
  return body;
}

/**
 * Fetch all events for a ctycms Picnic source within the horizon window.
 * Merges the all-set with per-tag category fetches; category precedence is
 * base → performance(title) → authoritative tags (last write wins).
 */
export async function fetchCtycmsEvents(source: EventSource): Promise<EventItem[]> {
  const cfg = SITE_CONFIG[source.id];
  if (!cfg) {
    throw new Error(`[CtycmsAdapter] no tag config for source "${source.id}" — add one to SITE_CONFIG`);
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

  // 0) Session cookie (throws on failure → Ingest records it).
  const cookie = await primeSession(refererUrl);

  // 1) Base "all" set (throws on failure → Ingest records it).
  applyCards(await fetchTag(origin, refererUrl, cookie, cfg.allTi, ds, de, cfg.allTi), () => defaultCategory);

  // 2) Performance grab-bag, classified by title.
  if (cfg.performanceTi !== undefined) {
    try {
      applyCards(await fetchTag(origin, refererUrl, cookie, cfg.allTi, ds, de, cfg.performanceTi), (c) =>
        classifyPerformanceTitle(c.title),
      );
    } catch (err) {
      // non-fatal: base set already populated (secondary fetch — logged degrade)
      console.warn(`[CtycmsAdapter] ${source.id}: performance tag ${cfg.performanceTi} fetch failed: ${err}`);
    }
  }

  // 3) Authoritative category tags (override title/default).
  for (const { ti, category } of cfg.tags) {
    try {
      applyCards(await fetchTag(origin, refererUrl, cookie, cfg.allTi, ds, de, ti), () => category);
    } catch (err) {
      // non-fatal: keep what we have (secondary fetch — logged degrade)
      console.warn(`[CtycmsAdapter] ${source.id}: tag ${ti} (${category}) fetch failed: ${err}`);
    }
  }

  return [...byId.values()];
}
