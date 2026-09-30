#!/usr/bin/env bun
/**
 * Pike13Adapter.ts — Culture Shock San Diego dance classes → EventItem.
 *
 * The studio's public class schedule (hip-hop, choreography, contemporary,
 * jazz, breaking, burlesque, heels, tap, etc.) is rendered on the WordPress
 * page https://cultureshocksandiego.org/hip-hop-class-schedule/ by a Pike13
 * widget (widgets.pike13.com/widget.js). The page itself ships an EMPTY
 * container — <div id="pike13-widget-container"></div> — that the widget
 * hydrates client-side, so a tier-1 HTML/LLM fetch sees zero classes. This
 * adapter pulls the same structured data the widget consumes, straight from
 * Pike13's public "front" API:
 *
 *   https://<subdomain>.pike13.com/api/v2/front/event_occurrences.json
 *     ?client_id=<public-widget-key>&from=YYYY-MM-DD&to=YYYY-MM-DD&location_ids[]=<id>
 *
 * `client_id` is the public widget key baked into widget.js (identical for every
 * Pike13 embed); no auth or secret is involved. Each occurrence carries an exact
 * start/end, instructor (staff_members), studio room (resources), and a per-class
 * registration URL (…/e/<id>).
 *
 * Mirrors SdfcAdapter/PadresAdapter: a pure mapper (unit-testable, no network) +
 * a fetch runner. fetchPike13Events() returns EventItem[]; it does NOT write to
 * cache. Currently configured for the one Pike13 source (Culture Shock SD); the
 * SUBDOMAIN / LOCATION_IDS / VENUE / ADDRESS constants are the only
 * studio-specific knobs — generalize them to per-source config the day a second
 * Pike13 studio is added (two adapters = a real seam).
 */

import { createHash } from "crypto";
import { upsertEvents } from "../Cache.ts";
import type { EventItem } from "../types.ts";
import { utcIsoToLaIso } from "../lib/tz.ts";

// ============================================================================
// Pike13 front-API types (only the fields we use)
// ============================================================================

export interface Pike13Staff {
  id: number;
  name: string;
}

export interface Pike13Resource {
  id: number;
  name: string;
}

export interface Pike13Occurrence {
  id: number;
  event_id: number;
  name: string;
  description?: string;
  location_id: number;
  /** UTC ISO, e.g. "2026-06-06T00:30:00Z" */
  start_at: string;
  end_at?: string;
  /** Per-class registration page, e.g. ".../e/265290276" */
  url?: string;
  timezone?: string;
  /** "active" | "canceled" */
  state: string;
  full?: boolean;
  staff_members?: Pike13Staff[];
  resources?: Pike13Resource[];
}

interface Pike13Response {
  event_occurrences?: Pike13Occurrence[];
}

// ============================================================================
// Constants — Culture Shock San Diego
// ============================================================================

const SOURCE_ID = "cultureshock-sd";
const SUBDOMAIN = "cultureshocksandiego";
const LOCATION_IDS = [37073];
/** Public widget client_id baked into widgets.pike13.com/widget.js — NOT a secret. */
const CLIENT_ID = "KR8INAuWvDpEHEG6r12XUDo2wuEHLZya94hArhaV";
const SCHEDULE_PAGE_URL = "https://cultureshocksandiego.org/hip-hop-class-schedule/";
const VENUE = "Culture Shock Dance Studio";
const ADDRESS = "2110 Hancock St #200, San Diego, CA 92110";
const API_HOST = `https://${SUBDOMAIN}.pike13.com`;
/** Days ahead to pull. Classes recur weekly; 14d ≈ 2 cycles (matches the widget). */
const WINDOW_DAYS = 14;

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

/** Collapse Pike13's rich-text HTML description into a plain one-liner. */
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

const STYLE_TAGS: Array<[RegExp, string]> = [
  [/hip ?hop/i, "hip-hop"],
  [/choreo/i, "choreography"],
  [/contemporary/i, "contemporary"],
  [/jazz ?funk/i, "jazz-funk"],
  [/\bjazz\b/i, "jazz"],
  [/break/i, "breaking"],
  [/krump/i, "krump"],
  [/tutting/i, "tutting"],
  [/popping/i, "popping"],
  [/whacking/i, "whacking"],
  [/twerk/i, "twerk"],
  [/burlesque/i, "burlesque"],
  [/heels/i, "heels"],
  [/\btap\b/i, "tap"],
  [/ballet/i, "ballet"],
  [/dancehall/i, "dancehall"],
  [/afro/i, "afro"],
  [/groove/i, "grooves"],
  [/cardio/i, "cardio"],
  [/strength|stretch|conditioning/i, "fitness"],
];

const LEVEL_TAGS: Array<[RegExp, string]> = [
  [/\b(adv|advanced)\b/i, "advanced"],
  [/\b(int|intermediate)\b/i, "intermediate"],
  [/\b(beg|beginner|beginning)\b/i, "beginner"],
  [/open level/i, "open-level"],
];

/** Derive ranker/filter tags (style, level, audience) from a class name. */
export function deriveTags(name: string): string[] {
  const tags = new Set<string>(["dance", "class"]);
  for (const [re, tag] of STYLE_TAGS) if (re.test(name)) tags.add(tag);
  for (const [re, tag] of LEVEL_TAGS) if (re.test(name)) tags.add(tag);
  if (/youth|shorties|kids?|\bage/i.test(name)) {
    tags.add("youth");
    tags.add("family");
  }
  return [...tags];
}

// ============================================================================
// Core mapper — pure function, unit-testable. Assumes a non-cancelled class.
// ============================================================================

export function mapOccurrenceToEvent(o: Pike13Occurrence): EventItem {
  const title = o.name.trim();
  const startDatetime = utcIsoToLaIso(o.start_at);
  const room = o.resources?.[0]?.name;
  const venue = room ? `${VENUE} (${room})` : VENUE;
  const instructors = (o.staff_members ?? [])
    .map((s) => s.name)
    .filter(Boolean)
    .join(", ");
  const ticketUrl = o.url && /^https?:\/\//i.test(o.url) ? o.url : SCHEDULE_PAGE_URL;
  const description = o.description ? stripHtml(o.description).slice(0, 300) : "";

  const event: EventItem = {
    id: stableId(title, startDatetime, venue),
    title,
    startDatetime,
    allDay: false,
    venue,
    address: ADDRESS,
    category: "arts",
    tags: deriveTags(title),
    isFree: false,
    ticketUrl,
    sourceUrl: SCHEDULE_PAGE_URL,
    sources: [{ sourceId: SOURCE_ID, url: ticketUrl }],
    fetchedAt: new Date().toISOString(),
    status: "scheduled",
  };
  if (o.end_at) event.endDatetime = utcIsoToLaIso(o.end_at);
  if (instructors) event.performersOrTeams = instructors;
  if (description) event.description = description;
  return event;
}

// ============================================================================
// Runner — fetches from Pike13 and returns active-class EventItem[]
// ============================================================================

/** Pike13's from/to params want YYYY-MM-DD (local calendar dates). */
function ymd(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export async function fetchPike13Events(from?: string, to?: string): Promise<EventItem[]> {
  const today = new Date();
  const end = new Date(today);
  end.setDate(today.getDate() + WINDOW_DAYS);

  const fromStr = from ?? ymd(today);
  const toStr = to ?? ymd(end);

  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    from: fromStr,
    to: toStr,
    per_page: "500",
  });
  for (const id of LOCATION_IDS) params.append("location_ids[]", String(id));

  const url = `${API_HOST}/api/v2/front/event_occurrences.json?${params.toString()}`;
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (EventScout; Kaya personal assistant)" },
  });
  if (!res.ok) {
    throw new Error(`Pike13 request failed: ${res.status} ${res.statusText} — ${url}`);
  }

  const data = (await res.json()) as Pike13Response;
  return (data.event_occurrences ?? [])
    .filter((o) => o.state !== "canceled" && o.state !== "cancelled")
    .map(mapOccurrenceToEvent);
}

// ============================================================================
// Script entry point
// ============================================================================

const IS_SCRIPT =
  typeof process !== "undefined" &&
  process.argv[1] != null &&
  (process.argv[1].endsWith("Pike13Adapter.ts") ||
    process.argv[1].endsWith("Pike13Adapter"));

if (IS_SCRIPT) {
  console.log(`\nFetching Culture Shock SD classes (today → +${WINDOW_DAYS} days)...\n`);
  try {
    const events = await fetchPike13Events();
    upsertEvents(events);
    console.log(`Upserted ${events.length} class occurrence(s) to cache.\n`);
    for (const e of events.slice(0, 12)) {
      console.log(
        `  [${e.startDatetime}] ${e.title} — ${e.venue ?? "TBD"}` +
          (e.performersOrTeams ? ` (${e.performersOrTeams})` : "")
      );
    }
    console.log(`\nSource: ${SOURCE_ID} | Pike13 ${SUBDOMAIN} loc ${LOCATION_IDS.join(",")}`);
    process.exit(0);
  } catch (err) {
    console.error(`\nFATAL: ${(err as Error).message}`);
    process.exit(1);
  }
}
