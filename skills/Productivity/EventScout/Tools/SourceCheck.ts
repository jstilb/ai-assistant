/**
 * SourceCheck.ts — the pre-hold source check (product review 1, 2026-11-08;
 * Kaya's plan in ~/.kaya/handoffs/eventscout-ALIGNMENT.md).
 *
 * A pick from a public Google Calendar feed (e.g. the Daylight calendar) used
 * to link to the WHOLE calendar, so Jm could not check its date, time or price.
 * Just before placement, this reads that calendar's weekend events through the
 * Calendar API (read-only) and matches each candidate by start time + title:
 *   - found → the event's own page (`htmlLink`) and the organizer's link from
 *     its description;
 *   - not found → the event left the source after the morning prefetch, so it
 *     gets no hold (the next candidate takes its place);
 *   - the read failed → no verdict; the caller keeps the old calendar-view link
 *     and reports the failure (loud, but it does not cost the weekend's holds).
 * Other sources are not checked here.
 */

import type { CalendarEvent } from "./CalendarApi.ts";
import type { RankedEvent } from "./Ranker.ts";

export type SourceVerdict =
  | { status: "found"; link: string; organizer: string | null }
  | { status: "gone"; calendarId: string }
  /** On the calendar, but its own text names another date rule ("second Sunday" on a third Sunday). */
  | { status: "doubtful"; calendarId: string; phrase: string };

/** Reads one public calendar's events in [timeMin, timeMax); tests pass a fake. */
export type ListPublicCalendar = (calendarId: string, timeMin: string, timeMax: string) => Promise<CalendarEvent[]>;

export interface SourceCheckOutcome {
  /** Event id → verdict. No entry = not a calendar source, or its read failed. */
  verdicts: Map<string, SourceVerdict>;
  checked: number;
  gone: number;
  doubtful: number;
  errors: string[];
}

const ICS_URL = /^https:\/\/calendar\.google\.com\/calendar\/ical\/([^/]+)\/public\//;

/** The calendar id of a public Google Calendar ICS feed URL, else null. */
export function publicCalendarId(url: string | undefined): string | null {
  const m = url ? ICS_URL.exec(url) : null;
  if (!m?.[1]) return null;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return null;
  }
}

/** The URL a hold links to by default (same rule as WeekendHolds.eventLink). */
function primarySourceUrl(e: RankedEvent): string | undefined {
  return e.sources[0]?.url ?? e.sourceUrl;
}

function titleKey(s: string): string {
  return s
    .toLowerCase()
    .replace(/&amp;/g, "&")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function sameTitle(a: string, b: string): boolean {
  const ka = titleKey(a);
  const kb = titleKey(b);
  return ka !== "" && kb !== "" && (ka === kb || ka.includes(kb) || kb.includes(ka));
}

const WEEKDAY_NAMES = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const ORDINALS: Record<string, number> = {
  first: 1, "1st": 1, second: 2, "2nd": 2, third: 3, "3rd": 3, fourth: 4, "4th": 4, fifth: 5, "5th": 5, last: -1,
};
const ORD = "first|second|third|fourth|fifth|last|1st|2nd|3rd|4th|5th";
const ORDINAL_RULE = new RegExp(
  `\\b((?:${ORD})(?:\\s*(?:,|and|&|or)\\s*(?:${ORD}))*)\\s+(${WEEKDAY_NAMES.join("|")})s?\\b`,
  "gi",
);

/**
 * A date rule in the event's own text ("on the second Sunday of the month")
 * that the event's date does not fit, else null. Review fix, 2026-11-08: the
 * Daylight calendar listed a "second Sunday" workshop on a third Sunday.
 */
export function ordinalConflict(description: string | undefined, startDatetime: string): string | null {
  if (!description) return null;
  const text = description.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ");
  // "Every Saturday … and on the first Saturday a potluck" is a weekly event: no conflict.
  if (new RegExp(`\\bevery\\s+(?:${WEEKDAY_NAMES.join("|")})\\b|\\bweekly\\b`, "i").test(text)) return null;
  const iso = startDatetime.slice(0, 10); // LA-offset ISO: the wall-clock date
  const date = new Date(`${iso}T12:00:00Z`);
  const weekday = WEEKDAY_NAMES[date.getUTCDay()];
  const day = date.getUTCDate();
  const daysInMonth = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
  const fits = (n: number): boolean => (n === -1 ? day + 7 > daysInMonth : Math.ceil(day / 7) === n);
  let conflict: string | null = null;
  for (const m of text.matchAll(ORDINAL_RULE)) {
    const phrase = m[0];
    const ords = (m[1] ?? "").toLowerCase().match(new RegExp(ORD, "g")) ?? [];
    const sameDay = (m[2] ?? "").toLowerCase() === weekday;
    if (sameDay && ords.some((o) => fits(ORDINALS[o] ?? 0))) return null; // one rule fits this date
    conflict ??= phrase;
  }
  return conflict;
}

const TRACKING_PARAM = /^(utm_.*|fbclid|igsh|igshid|gclid|mc_cid|mc_eid)$/i;

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

/**
 * The first organizer link in a Google Calendar description: an http(s) URL
 * that is not a Google page. Google's redirect wrapper (google.com/url?q=…) is
 * unwrapped; tracking parameters are removed.
 */
export function organizerLink(description: string | undefined): string | null {
  if (!description) return null;
  const raw = [
    ...[...description.matchAll(/href="([^"]+)"/gi)].map((m) => m[1] ?? ""),
    ...[...description.matchAll(/https?:\/\/[^\s"<>]+/gi)].map((m) => m[0]),
  ];
  for (const candidate of raw) {
    let u: URL;
    try {
      u = new URL(decodeEntities(candidate));
    } catch {
      continue;
    }
    if (/(^|\.)google\.com$/i.test(u.hostname) && u.pathname === "/url") {
      const q = u.searchParams.get("q");
      if (!q) continue;
      try {
        u = new URL(q);
      } catch {
        continue;
      }
    }
    if (u.protocol !== "https:" && u.protocol !== "http:") continue;
    if (/(^|\.)google\.com$/i.test(u.hostname)) continue;
    for (const key of [...u.searchParams.keys()]) if (TRACKING_PARAM.test(key)) u.searchParams.delete(key);
    return u.toString();
  }
  return null;
}

/**
 * Check every candidate from a public Google Calendar feed that starts in
 * [timeMin, timeMax). One read per calendar. Never throws: a failed read is
 * recorded in `errors` and leaves its candidates without a verdict.
 */
export async function checkCalendarSources(
  candidates: readonly RankedEvent[],
  timeMin: string,
  timeMax: string,
  list: ListPublicCalendar,
): Promise<SourceCheckOutcome> {
  const out: SourceCheckOutcome = { verdicts: new Map(), checked: 0, gone: 0, doubtful: 0, errors: [] };
  const lo = Date.parse(timeMin);
  const hi = Date.parse(timeMax);
  const byCalendar = new Map<string, RankedEvent[]>();
  for (const e of candidates) {
    const id = publicCalendarId(primarySourceUrl(e));
    const startMs = Date.parse(e.startDatetime);
    if (!id || e.allDay || !Number.isFinite(startMs) || startMs < lo || startMs >= hi) continue;
    byCalendar.set(id, [...(byCalendar.get(id) ?? []), e]);
  }
  for (const [calendarId, events] of byCalendar) {
    let live: CalendarEvent[];
    try {
      live = await list(calendarId, timeMin, timeMax);
    } catch (err) {
      out.errors.push(`${calendarId}: ${(err as Error).message}`);
      continue;
    }
    for (const e of events) {
      out.checked++;
      const startMs = Date.parse(e.startDatetime);
      const atStart = live.filter(
        (ev) => ev.status !== "cancelled" && ev.start.dateTime !== undefined && Date.parse(ev.start.dateTime) === startMs,
      );
      // An exact title first; a contained title only when none is exact.
      const match =
        atStart.find((ev) => titleKey(ev.summary ?? "") === titleKey(e.title)) ??
        atStart.find((ev) => sameTitle(ev.summary ?? "", e.title));
      if (!match) {
        out.gone++;
        out.verdicts.set(e.id, { status: "gone", calendarId });
        continue;
      }
      // Its own text names a date rule this date does not fit: no hold (0 doubtful dates).
      const phrase = ordinalConflict(match.description, e.startDatetime);
      if (phrase) {
        out.doubtful++;
        out.verdicts.set(e.id, { status: "doubtful", calendarId, phrase });
        continue;
      }
      // On the source but without its own page link: no verdict (old link stays).
      if (!match.htmlLink) continue;
      out.verdicts.set(e.id, { status: "found", link: match.htmlLink, organizer: organizerLink(match.description) });
    }
  }
  return out;
}
