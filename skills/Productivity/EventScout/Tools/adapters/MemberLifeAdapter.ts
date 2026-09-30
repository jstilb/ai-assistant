#!/usr/bin/env bun
/**
 * MemberLifeAdapter.ts — Majesty in Motion (salsa/bachata studio) → EventItem.
 *
 * The studio (6380 El Cajon Blvd, San Diego) runs its class schedule through
 * Member.life, a SaaS studio-management platform. The public site
 * (majestyinmotion.com) and Member.life's own hosted pages
 * (member.life/majestyinmotion/schedule) render the weekly schedule
 * client-side from a Vue app, so a tier-1 HTML/LLM fetch sees no classes.
 * This adapter pulls the same structured data those pages consume, straight
 * from Member.life's public data endpoint:
 *
 *   POST https://member.life/api/get-data
 *   Content-Type: application/x-www-form-urlencoded
 *   Body: name_short=<studio short name>&classes=1
 *
 * No auth/cookies required (validated live 2026-07-10). The response is a
 * RECURRING WEEKLY TEMPLATE, not dated occurrences: each class carries zero
 * or more `timeslots`, each timeslot a `day` (0=Sunday..6=Saturday) + a
 * `seconds_start`/`seconds_stop` offset into that day. This adapter projects
 * that template forward across a rolling WINDOW_DAYS window into concrete,
 * dated EventItem occurrences — one per (timeslot, matching calendar date)
 * pair.
 *
 * A stray `day:7` has been observed in live data (one timeslot, "Royal
 * Elegance Beginner Team"). Any day outside 0-6 is skipped with a loud
 * console.warn — never crashed on, never silently dropped without logging.
 *
 * Mirrors Pike13Adapter/SdfcAdapter: pure mappers (unit-testable, no
 * network) + a fetch runner. fetchMemberLifeEvents() returns EventItem[]; it
 * does NOT write to cache. `nameShort` is a parameter (not hardcoded) so a
 * second Member.life studio can reuse this adapter by passing its own
 * name_short — venue/address/category stay as Majesty-in-Motion-specific
 * constants until a second studio actually shows up (one adapter =
 * hypothetical seam; generalize further only when a second caller exists).
 */

import { createHash } from "crypto";
import { upsertEvents } from "../Cache.ts";
import type { EventItem } from "../types.ts";
import { laDateIso, utcMsToLaParts } from "../lib/tz.ts";

// ============================================================================
// Member.life get-data API types (only the fields we use)
// ============================================================================

export interface MemberLifeTimeslot {
  id: number;
  class_id: number;
  /**
   * 0=Sunday..6=Saturday. Live data has shown one stray `7` — callers must
   * guard for values outside 0-6 (see mapClassesResponseToEvents).
   */
  day: number;
  room: string;
  seconds_start: number;
  seconds_stop: number;
  staff_first: string | null;
  staff_last: string | null;
  assistant_first: string | null;
  assistant_last: string | null;
}

export interface MemberLifeClass {
  id: number;
  title: string;
  description: string;
  /** Human category label as it appears in the API's grouping keys, e.g. "Salsa". */
  category: string;
  timeslots: MemberLifeTimeslot[];
}

export interface MemberLifeStudio {
  name: string;
  name_short: string;
  timezone: string;
}

export interface MemberLifeGetDataResponse {
  success: boolean;
  reason?: string;
  data: {
    studio: MemberLifeStudio;
    /** Keyed by category slug, e.g. "salsa" | "bachata" | "mambo" | "" (uncategorized). */
    classes: Record<string, MemberLifeClass[]>;
  };
}

// ============================================================================
// Constants — Majesty in Motion (San Diego)
// ============================================================================

const SOURCE_ID = "majestyinmotion-classes";
const DEFAULT_NAME_SHORT = "majestyinmotion";
const API_ENDPOINT = "https://member.life/api/get-data";
const SCHEDULE_URL = "https://member.life/majestyinmotion/schedule";
const VENUE = "Majesty in Motion";
const ADDRESS = "6380 El Cajon Blvd, San Diego, CA";
/**
 * Days ahead to project. The schedule recurs weekly, and any 7 consecutive
 * calendar days contain each weekday exactly once, so a 7-day window yields
 * exactly one dated occurrence per timeslot (~45 timeslots -> ~45 events).
 */
const WINDOW_DAYS = 7;

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

/** Collapse Member.life's plain-text (CRLF-heavy) description into one line. */
export function normalizeWhitespace(s: string): string {
  return s.replace(/\r\n|\r|\n/g, " ").replace(/\s+/g, " ").trim();
}

function joinName(
  first: string | null | undefined,
  last: string | null | undefined
): string | undefined {
  const parts = [first, last].filter((p): p is string => Boolean(p && p.trim()));
  return parts.length > 0 ? parts.join(" ") : undefined;
}

const LEVEL_TAGS: Array<[RegExp, string]> = [
  [/level\s*1\b/i, "beginner"],
  [/level\s*2\b/i, "intermediate"],
  [/level\s*3\b/i, "advanced"],
  [/level\s*4\b/i, "advanced"],
  [/\bbeg(inner)?\b/i, "beginner"],
];

/** Derive ranker/filter tags (style, level, audience) from a class title + category. */
export function deriveTags(title: string, category: string): string[] {
  const tags = new Set<string>(["dance", "class"]);
  const catTag = category.trim().toLowerCase().replace(/\s+/g, "-");
  if (catTag) tags.add(catTag);
  for (const [re, tag] of LEVEL_TAGS) if (re.test(title)) tags.add(tag);
  if (/\bteam\b/i.test(title)) tags.add("team");
  if (/kids?|youth|\bages?\b/i.test(title)) {
    tags.add("youth");
    tags.add("family");
  }
  return [...tags];
}

/** Split a `seconds`-since-midnight offset into wall-clock hour/minute/second. */
export function secondsToHms(totalSeconds: number): {
  hour: number;
  minute: number;
  second: number;
} {
  const hour = Math.floor(totalSeconds / 3600);
  const minute = Math.floor((totalSeconds % 3600) / 60);
  const second = totalSeconds % 60;
  return { hour, minute, second };
}

/**
 * Project a weekly `day` (0=Sunday..6=Saturday) forward across a window of
 * `windowDays` calendar days starting at `windowStart`, returning every
 * matching calendar date. Pure calendar-date arithmetic (UTC-anchored to
 * avoid DST/local-TZ pitfalls) — the returned {year,month,day} triples are
 * later interpreted as America/Los_Angeles wall-clock dates by the caller.
 */
export function projectWeekdayDates(
  weekday: number,
  windowStart: { year: number; month: number; day: number },
  windowDays: number
): Array<{ year: number; month: number; day: number }> {
  const dates: Array<{ year: number; month: number; day: number }> = [];
  const startMs = Date.UTC(windowStart.year, windowStart.month - 1, windowStart.day);
  for (let i = 0; i < windowDays; i++) {
    const d = new Date(startMs + i * 86_400_000);
    if (d.getUTCDay() === weekday) {
      dates.push({ year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() });
    }
  }
  return dates;
}

// ============================================================================
// Core mappers — pure functions, unit-testable
// ============================================================================

/** Map ONE concrete dated occurrence (a timeslot projected onto a calendar date) to an EventItem. */
export function mapTimeslotOccurrenceToEvent(
  cls: MemberLifeClass,
  timeslot: MemberLifeTimeslot,
  date: { year: number; month: number; day: number }
): EventItem {
  const title = cls.title.trim();
  const start = secondsToHms(timeslot.seconds_start);
  const stop = secondsToHms(timeslot.seconds_stop);
  const startDatetime = laDateIso(date.year, date.month, date.day, start.hour, start.minute, start.second);
  const endDatetime = laDateIso(date.year, date.month, date.day, stop.hour, stop.minute, stop.second);
  const venue = timeslot.room ? `${VENUE} (${timeslot.room})` : VENUE;
  const instructors = [
    joinName(timeslot.staff_first, timeslot.staff_last),
    joinName(timeslot.assistant_first, timeslot.assistant_last),
  ].filter((n): n is string => Boolean(n));
  const description = cls.description ? normalizeWhitespace(cls.description).slice(0, 300) : "";

  const event: EventItem = {
    id: stableId(title, startDatetime, venue),
    title,
    startDatetime,
    endDatetime,
    allDay: false,
    venue,
    address: ADDRESS,
    category: "arts",
    tags: deriveTags(title, cls.category),
    isFree: false,
    ticketUrl: SCHEDULE_URL,
    sourceUrl: SCHEDULE_URL,
    sources: [{ sourceId: SOURCE_ID, url: SCHEDULE_URL }],
    fetchedAt: new Date().toISOString(),
    status: "scheduled",
  };
  if (instructors.length > 0) event.performersOrTeams = instructors.join(", ");
  if (description) event.description = description;
  return event;
}

/**
 * Project every class's weekly template across the window and map each
 * resulting dated occurrence to an EventItem. Pure — takes `windowStart`
 * explicitly (LA calendar date) so it stays unit-testable without mocking
 * the clock.
 */
export function mapClassesResponseToEvents(
  response: MemberLifeGetDataResponse,
  windowStart: { year: number; month: number; day: number },
  windowDays: number = WINDOW_DAYS
): EventItem[] {
  const events: EventItem[] = [];
  for (const categoryClasses of Object.values(response.data.classes)) {
    for (const cls of categoryClasses) {
      for (const timeslot of cls.timeslots) {
        if (timeslot.day < 0 || timeslot.day > 6) {
          console.warn(
            `[MemberLifeAdapter] skipping timeslot ${timeslot.id} on class "${cls.title}" ` +
              `(id ${cls.id}): invalid day=${timeslot.day} (expected 0-6)`
          );
          continue;
        }
        const dates = projectWeekdayDates(timeslot.day, windowStart, windowDays);
        for (const date of dates) {
          events.push(mapTimeslotOccurrenceToEvent(cls, timeslot, date));
        }
      }
    }
  }
  return events;
}

// ============================================================================
// Runner — fetches from Member.life and returns projected EventItem[]
// ============================================================================

export async function fetchMemberLifeEvents(
  nameShort: string = DEFAULT_NAME_SHORT,
  windowDays: number = WINDOW_DAYS
): Promise<EventItem[]> {
  const res = await fetch(API_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": "Mozilla/5.0 (EventScout; Kaya personal assistant)",
    },
    body: new URLSearchParams({ name_short: nameShort, classes: "1" }).toString(),
  });
  if (!res.ok) {
    throw new Error(`Member.life request failed: ${res.status} ${res.statusText} — ${API_ENDPOINT}`);
  }

  const data = (await res.json()) as MemberLifeGetDataResponse;
  if (!data.success) {
    throw new Error(`Member.life API returned success=false: ${data.reason ?? "unknown reason"}`);
  }

  const todayLa = utcMsToLaParts(Date.now());
  const windowStart = { year: todayLa.year, month: todayLa.month, day: todayLa.day };
  return mapClassesResponseToEvents(data, windowStart, windowDays);
}

// ============================================================================
// Script entry point
// ============================================================================

const IS_SCRIPT =
  typeof process !== "undefined" &&
  process.argv[1] != null &&
  (process.argv[1].endsWith("MemberLifeAdapter.ts") ||
    process.argv[1].endsWith("MemberLifeAdapter"));

if (IS_SCRIPT) {
  console.log(`\nFetching Majesty in Motion classes (today → +${WINDOW_DAYS} days)...\n`);
  try {
    const events = await fetchMemberLifeEvents();
    upsertEvents(events);
    console.log(`Upserted ${events.length} class occurrence(s) to cache.\n`);
    for (const e of events.slice(0, 12)) {
      console.log(
        `  [${e.startDatetime}] ${e.title} — ${e.venue ?? "TBD"}` +
          (e.performersOrTeams ? ` (${e.performersOrTeams})` : "")
      );
    }
    console.log(`\nSource: ${SOURCE_ID} | Member.life ${DEFAULT_NAME_SHORT}`);
    process.exit(0);
  } catch (err) {
    console.error(`\nFATAL: ${(err as Error).message}`);
    process.exit(1);
  }
}
