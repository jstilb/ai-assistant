/**
 * WeekendHolds.ts — the Thursday plan (ALIGNMENT G1): at most 3 weekend picks
 * as tentative holds on Jm's primary Google Calendar.
 *
 * Runs inside the weekend-digest job, after its one LLM ranking (no second
 * ranking). Each hold:
 *   - is titled "EventScout hold: <title>" at the event's real start time;
 *   - is tentative, shows as "free" (transparent) and has NO reminders, so it
 *     never notifies (no push channel — Jm turned pushes off 2026-10-26);
 *   - carries a private tag (eventscoutHold / eventscoutWeekend / eventscoutEventId)
 *     so a later run finds it by tag, never by title;
 *   - has the source link, place, price, why it fits, and a "Return visit"
 *     line when the venue is already in Jm's history.
 *
 * Recurring communities first (ALIGNMENT G2, Community.ts): a pick from a
 * series that meets again (salsa social, open mic, pickup game) comes before a
 * one-off show, and its hold says how often the group meets.
 *
 * One placement per weekend (State/holds-ledger.json): a hold Jm deleted never
 * comes back. Each run also marks past holds "kept" (still on the calendar
 * after the event) or "dropped" (deleted) — the real-use counter.
 *
 * Kill switch: EVENTSCOUT_HOLDS=off. Dry run (no calendar or ledger write):
 * EVENTSCOUT_HOLDS_DRY_RUN=1.
 */

import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { CalendarClient, CalendarEvent, NewCalendarEvent } from "./CalendarApi.ts";
import type { RankedEvent } from "./Ranker.ts";
import { KAYA_HOME } from "./types.ts";
import type { EventItem } from "./types.ts";
import { utcMsToLaParts } from "./lib/tz.ts";
import { describeSeries, detectSeries, seriesKey } from "./Community.ts";
import type { ClassifyFn, CommunityCandidate, SeriesFacts } from "./Community.ts";
import { checkCalendarSources } from "./SourceCheck.ts";
import type { ListPublicCalendar, SourceVerdict } from "./SourceCheck.ts";

/** Holds placed by the Thursday plan and their kept/dropped status. Override: EVENTSCOUT_HOLDS_LEDGER_PATH. */
export const DEFAULT_HOLDS_LEDGER_PATH = `${KAYA_HOME}/skills/Productivity/EventScout/State/holds-ledger.json`;

// ============================================================================
// Constants (Kaya's plan values; the product review may tune them)
// ============================================================================

export const HOLD_PREFIX = "EventScout hold: ";
export const MAX_HOLDS = 3;
const MAX_PER_DAY = 2;
/** Gap kept between a hold and any other calendar entry or hold. */
const BUFFER_MS = 30 * 60_000;
/** Shown length when the source lists no end time (said so in the hold). */
const DEFAULT_LENGTH_MS = 2 * 3_600_000;
/** Longer events (all-day fairs, exhibitions) are not a "go at 7" plan. */
const MAX_LENGTH_MS = 6 * 3_600_000;
const EARLIEST_HOUR = 9;
const LATEST_START_HOUR = 22;
/**
 * Weeknight holds (product review 1, 2026-11-08; Kaya's values on the review's
 * evidence: 71 % of recurring groups meet Mon–Fri). At most this many per run,
 * communities only, starting at or after WEEKNIGHT_EARLIEST_HOUR (after work).
 */
const MAX_WEEKNIGHT_HOLDS = 1;
const WEEKNIGHT_EARLIEST_HOUR = 17;
/** Ranker scores are 0–100; below this a pick is too weak to put on a calendar. */
const MIN_SCORE = 40;
/**
 * Quiet rule (Kaya's heuristic, 2026-11-08; not Jm's rule): this many own timed
 * events (10:00–23:00) on Sat/Sun = a full weekend, so no holds.
 */
const FULL_WEEKEND_EVENTS = 3;
const HISTORY_DAYS = 56;
const TZ = "America/Los_Angeles";

// ============================================================================
// Ledger
// ============================================================================

export interface HoldEntry {
  weekend: string;
  calendarEventId: string;
  eventId: string;
  title: string;
  start: string;
  end: string;
  sourceUrl: string;
  returnVisit: boolean;
  /** G2: the pick is a recurring community (series key = Community.seriesKey). */
  community?: boolean;
  seriesKey?: string;
  placedAt: string;
  status: "placed" | "kept" | "dropped";
  checkedAt?: string;
}

export interface HoldRun {
  weekend: string;
  ranAt: string;
  placed: number;
  reason: string;
}

export interface HoldsLedger {
  entries: HoldEntry[];
  runs: HoldRun[];
}

function ledgerPath(): string {
  return process.env["EVENTSCOUT_HOLDS_LEDGER_PATH"] ?? DEFAULT_HOLDS_LEDGER_PATH;
}

export function readLedger(path = ledgerPath()): HoldsLedger {
  if (!existsSync(path)) return { entries: [], runs: [] };
  const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<HoldsLedger>;
  return { entries: raw.entries ?? [], runs: raw.runs ?? [] };
}

function writeLedger(ledger: HoldsLedger, path = ledgerPath()): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(ledger, null, 2)}\n`);
  renameSync(tmp, path);
}

// ============================================================================
// Pure helpers
// ============================================================================

interface Interval {
  startMs: number;
  endMs: number;
}

function laDate(ms: number): string {
  const p = utcMsToLaParts(ms);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

function laHour(ms: number): number {
  return utcMsToLaParts(ms).hour;
}

function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** The interval a hold occupies; `endKnown` false = the source lists no end. */
export function holdInterval(e: RankedEvent): (Interval & { endKnown: boolean }) | null {
  const startMs = Date.parse(e.startDatetime);
  if (!Number.isFinite(startMs)) return null;
  const rawEnd = e.endDatetime && e.endTimeKnown !== false ? Date.parse(e.endDatetime) : Number.NaN;
  if (Number.isFinite(rawEnd) && rawEnd > startMs) return { startMs, endMs: rawEnd, endKnown: true };
  return { startMs, endMs: startMs + DEFAULT_LENGTH_MS, endKnown: false };
}

/** Timed, non-cancelled calendar entries as intervals (all-day entries never block). */
export function busyIntervals(events: CalendarEvent[]): Interval[] {
  const out: Interval[] = [];
  for (const ev of events) {
    if (ev.status === "cancelled" || !ev.start.dateTime || !ev.end.dateTime) continue;
    const startMs = Date.parse(ev.start.dateTime);
    const endMs = Date.parse(ev.end.dateTime);
    if (Number.isFinite(startMs) && Number.isFinite(endMs)) out.push({ startMs, endMs });
  }
  return out;
}

function overlaps(a: Interval, b: Interval): boolean {
  return a.startMs < b.endMs + BUFFER_MS && b.startMs < a.endMs + BUFFER_MS;
}

/** The per-event hold rules (no calendar or other-pick checks): see selectHolds. */
export function holdEligible(e: RankedEvent, days: readonly string[], earliestHour: number = EARLIEST_HOUR): boolean {
  if (e.allDay || e.startTimeKnown === false || e.status !== "scheduled" || e.score < MIN_SCORE || !eventLink(e)) return false;
  const span = holdInterval(e);
  if (!span || span.endMs - span.startMs > MAX_LENGTH_MS) return false;
  if (!days.includes(laDate(span.startMs))) return false;
  const hour = laHour(span.startMs);
  return hour >= earliestHour && hour <= LATEST_START_HOUR;
}

/**
 * Choose at most MAX_HOLDS picks from the ranked list (best first): starts on
 * one of `days` (LA dates — the window filter also lets in a Friday event that
 * runs past midnight, and Jm's calendar is read for `days` only), timed,
 * scheduled, 09:00–22:00 start, ≤ 6 h, score ≥ MIN_SCORE, no overlap with
 * Jm's calendar or another pick, ≤ 2 per day, no repeated title or venue.
 */
export function selectHolds(
  ranked: RankedEvent[],
  busy: Interval[],
  days: readonly string[],
  max: number = MAX_HOLDS,
  earliestHour: number = EARLIEST_HOUR,
): RankedEvent[] {
  const chosen: RankedEvent[] = [];
  const taken: Interval[] = [...busy];
  const perDay = new Map<string, number>();
  const titles = new Set<string>();
  const venues = new Set<string>();
  for (const e of ranked) {
    if (chosen.length >= max) break;
    if (!holdEligible(e, days, earliestHour)) continue;
    const span = holdInterval(e);
    if (!span) continue;
    const day = laDate(span.startMs);
    if ((perDay.get(day) ?? 0) >= MAX_PER_DAY) continue;
    const title = normalize(e.title);
    const venue = normalize(e.venue ?? "");
    if (titles.has(title) || (venue && venues.has(venue)) || taken.some((t) => overlaps(t, span))) continue;
    chosen.push(e);
    taken.push(span);
    titles.add(title);
    if (venue) venues.add(venue);
    perDay.set(day, (perDay.get(day) ?? 0) + 1);
  }
  return chosen;
}

/** Quiet rule: Jm's own timed entries on the weekend days, 10:00–23:00 LA. */
export function ownWeekendEvents(events: CalendarEvent[], satIso: string, sunIso: string): number {
  return busyIntervals(events).filter((b) => {
    const day = laDate(b.startMs);
    const hour = laHour(b.startMs);
    return (day === satIso || day === sunIso) && hour >= 10 && hour < 23;
  }).length;
}

// ============================================================================
// Return visit (history = activity_log + Jm's calendar, last 8 weeks)
// ============================================================================

export interface HistoryItem {
  text: string;
  source: "activity_log" | "calendar";
  date: string;
}

const GENERIC_VENUES = new Set(["san diego", "online", "virtual", "tba", "tbd", "various", "various locations", "multiple locations"]);

/** "calendar 2026-10-12" when the pick's venue appears in Jm's history, else null. */
export function returnVisitEvidence(e: RankedEvent, history: HistoryItem[]): string | null {
  const venue = normalize(e.venue ?? "");
  if (venue.length < 5 || GENERIC_VENUES.has(venue)) return null;
  const hit = history.find((h) => ` ${normalize(h.text)} `.includes(` ${venue} `));
  return hit ? `${hit.source} ${hit.date}` : null;
}

function activityLogHistory(): HistoryItem[] {
  // cross-skill-allowed: read-only activity_log rows for return-visit evidence; EventScout never writes LifeOS
  const dbPath = `${KAYA_HOME}/skills/Productivity/LifeOS/Data/lifeos.db`;
  if (!existsSync(dbPath)) return [];
  const db = new Database(dbPath, { readonly: true });
  try {
    const rows = db.query("SELECT date, activity, notes FROM activity_log").all() as Array<{
      date: string | null;
      activity: string | null;
      notes: string | null;
    }>;
    return rows.map((r) => ({ text: `${r.activity ?? ""} ${r.notes ?? ""}`, source: "activity_log", date: r.date ?? "" }));
  } finally {
    db.close();
  }
}

function calendarHistory(events: CalendarEvent[]): HistoryItem[] {
  return events
    .filter((ev) => ev.status !== "cancelled" && !ev.extendedProperties?.private?.["eventscoutHold"])
    .map((ev) => ({
      text: `${ev.summary ?? ""} ${ev.location ?? ""}`,
      source: "calendar" as const,
      date: (ev.start.dateTime ?? ev.start.date ?? "").slice(0, 10),
    }));
}

// ============================================================================
// Community order (ALIGNMENT G2): groups that meet again rank above one-offs
// ============================================================================

/**
 * The recurring series among the events that could become holds, one
 * candidate per series (the best-ranked event of it), for one LLM verdict each.
 */
export function communityCandidates(
  ranked: RankedEvent[],
  series: Map<string, SeriesFacts>,
  days: readonly string[],
  earliestHour: number = EARLIEST_HOUR,
): CommunityCandidate[] {
  const out = new Map<string, CommunityCandidate>();
  for (const e of ranked) {
    const key = seriesKey(e);
    const facts = key ? series.get(key) : undefined;
    if (!key || !facts || out.has(key) || !holdEligible(e, days, earliestHour)) continue;
    out.set(key, {
      key,
      title: e.title,
      ...(e.venue && { venue: e.venue }),
      category: e.category,
      tags: e.tags,
      ...((e.description ?? e.sourceDescription) && { description: e.description ?? e.sourceDescription }),
      cadence: facts.weekday ? `${facts.cadence} on ${facts.weekday}s` : facts.cadence,
    });
  }
  return [...out.values()];
}

/** Stable reorder: community events first (in ranked order), then the rest. */
export function communityFirst(ranked: RankedEvent[], communityKeys: ReadonlySet<string>): RankedEvent[] {
  const isCommunity = (e: RankedEvent): boolean => {
    const key = seriesKey(e);
    return key !== null && communityKeys.has(key);
  };
  return [...ranked.filter(isCommunity), ...ranked.filter((e) => !isCommunity(e))];
}

// ============================================================================
// The calendar entry
// ============================================================================

function formatWhen(ms: number): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: TZ,
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(ms));
}

function priceText(e: RankedEvent): string {
  if (e.isFree) return "Free";
  if (e.priceMin !== undefined) {
    const max = e.priceMax !== undefined && e.priceMax > e.priceMin ? `–$${e.priceMax}` : "";
    return `$${e.priceMin}${max}`;
  }
  return "Not listed on the source";
}

/** A bare domain, or a site search / "find" page: it does not show one event. */
function isGenericUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.pathname.replace(/\/+$/, "") === "" || /\/(find|search)(\/|$)/i.test(u.pathname);
  } catch {
    return true;
  }
}

/**
 * The page Jm opens from a hold, or null when no usable page exists (the pick
 * is then skipped). A generic source page (e.g. Meetup's /find/ list) yields
 * to a specific ticket/event URL. A public Google Calendar ICS feed is not
 * readable in a browser, so it becomes that calendar's public web view.
 */
export function eventLink(e: RankedEvent): string | null {
  let url = e.sources[0]?.url ?? e.sourceUrl;
  if (isGenericUrl(url) && e.ticketUrl && !isGenericUrl(e.ticketUrl)) url = e.ticketUrl;
  const gcal = /^https:\/\/calendar\.google\.com\/calendar\/ical\/([^/]+)\/public\//.exec(url);
  if (gcal) return `https://calendar.google.com/calendar/embed?src=${gcal[1]}&ctz=America%2FLos_Angeles`;
  return isGenericUrl(url) ? null : url;
}

/** Venue + address with repeated parts and the country removed. */
export function placeText(e: RankedEvent): string {
  const seen = new Set<string>();
  const parts: string[] = [];
  for (const raw of [e.venue ?? "", ...(e.address ?? "").split(",")]) {
    const part = raw.trim();
    const key = part.toLowerCase();
    if (!part || key === "usa" || key === "united states" || seen.has(key)) continue;
    // A bare state ("CA") after "CA 92118" repeats it.
    if (/^[a-z]{2}$/.test(key) && parts.some((p) => p.toLowerCase().startsWith(`${key} `))) continue;
    seen.add(key);
    parts.push(part);
  }
  return parts.join(", ");
}

const WEEKLY_WORDING = /\b(every|weekly|mondays|tuesdays|wednesdays|thursdays|fridays|saturdays|sundays)\b/i;

export function buildHoldEvent(
  e: RankedEvent,
  satIso: string,
  returnVisit: string | null,
  now: Date,
  community: SeriesFacts | null = null,
  /** The pre-hold source check found this event on its source calendar. */
  checked: Extract<SourceVerdict, { status: "found" }> | null = null,
): NewCalendarEvent {
  const span = holdInterval(e);
  if (!span) throw new Error(`WeekendHolds: unparseable start for ${e.id}`);
  const link = checked?.link ?? eventLink(e);
  if (!link) throw new Error(`WeekendHolds: no usable source link for ${e.id}`);
  const place = placeText(e);
  const lines = [
    `Why: ${e.why}`,
    `When: ${formatWhen(span.startMs)}${span.endKnown ? ` – ${formatWhen(span.endMs)}` : " (end time not listed; this hold shows 2 hours)"}`,
    `Where: ${place || "Not listed on the source"}`,
    `Price: ${priceText(e)}`,
    `Source: ${link}`,
  ];
  if (checked?.organizer) lines.push(`Organizer page: ${checked.organizer}`);
  if (checked) lines.push(`Checked on the source: ${formatWhen(now.getTime())} (this date and time are on it).`);
  if (e.ticketUrl && e.ticketUrl !== link && !isGenericUrl(e.ticketUrl)) lines.push(`Tickets: ${e.ticketUrl}`);
  if (!checked && (e.recurrenceRule || WEEKLY_WORDING.test(e.title))) {
    lines.push("Repeating listing: the source gives a pattern, not this exact date. Check the source that it runs this date.");
  }
  if (community) lines.push(`Recurring group: ${describeSeries(community)}. Going again is how you become a regular.`);
  if (returnVisit) lines.push(`Return visit: this place is in your history (${returnVisit}).`);
  // G3 slice 1: the follow-up question rides in the hold (no push channel). A
  // past-tense line with a rating routes to activity_log via the LifeOS Router.
  // The date is in the example: a weekday word in a title ("Thursday 50/50
  // Salsa") otherwise leaks into the logged date (review, 2026-11-08).
  const onDay = new Intl.DateTimeFormat("en-US", { timeZone: TZ, month: "short", day: "numeric" }).format(new Date(span.startMs));
  lines.push(
    `After you go: how was it, and anyone you want to see again? Tell Kaya in one line with a rating, ` +
      `for example "${e.title} on ${onDay}, 8/10, met two people I'd see again". It goes to your activity log.`,
  );
  lines.push(
    "",
    `Tentative hold from EventScout (Kaya), placed ${laDate(now.getTime())}. Nothing was booked or sent.`,
    "To drop it, delete this event.",
  );
  const location = place;
  return {
    summary: `${HOLD_PREFIX}${e.title}`,
    description: lines.join("\n"),
    ...(location && { location }),
    start: { dateTime: new Date(span.startMs).toISOString(), timeZone: TZ },
    end: { dateTime: new Date(span.endMs).toISOString(), timeZone: TZ },
    status: "tentative",
    transparency: "transparent",
    colorId: "8",
    reminders: { useDefault: false, overrides: [] },
    source: { title: "EventScout source", url: link },
    extendedProperties: { private: { eventscoutHold: "1", eventscoutWeekend: satIso, eventscoutEventId: e.id } },
  };
}

// ============================================================================
// Run
// ============================================================================

export interface HoldsOutcome {
  weekend: string;
  placed: number;
  reason: string;
  dryRun: boolean;
  picks: Array<{
    title: string;
    start: string;
    venue?: string;
    score: number;
    link: string;
    returnVisit: string | null;
    /** The "Recurring group" facts when the pick is a community, else null. */
    community: string | null;
    /** "on source" when the pre-hold check found it; null when not checked. */
    sourceCheck: string | null;
  }>;
  reconciled: { kept: number; dropped: number };
  /** G2 community check: recurring series judged, and how many were communities. */
  communityCheck?: { candidates: number; communities: number; verdicts: Array<{ title: string; community: boolean; kind: string }> };
  /** Set when the community check failed; holds then follow score order. */
  communityError?: string;
  /**
   * Pre-hold source check: calendar-source candidates checked; how many left the
   * source (gone) or carry a date rule their date does not fit (doubtful); the
   * skipped titles with the reason.
   */
  sourceCheck?: { checked: number; gone: number; doubtful: number; skipped: string[] };
  /** Set when a source calendar could not be read; those picks keep the calendar-view link. */
  sourceCheckError?: string;
  /** Weeknight step: community candidates after the rules' pre-filter, holds picked (0–1), why. */
  weeknight?: { candidates: number; picked: number; reason: string };
}

export interface CommunityOptions {
  /**
   * Reads the whole event cache (series facts need every date, not only this
   * weekend). Called inside the community step, so a bad cache read degrades
   * to score order instead of costing the weekend's holds.
   */
  loadCache: () => readonly EventItem[];
  classify: ClassifyFn;
}

function weekendBounds(satIso: string, sunIso: string): { timeMin: string; timeMax: string } {
  // LA midnight Sat → LA midnight Mon, as UTC instants (offset from the dates themselves).
  const satMs = Date.parse(`${satIso}T12:00:00Z`);
  const satOffsetH = 12 - utcMsToLaParts(satMs).hour;
  const monIso = new Date(Date.parse(`${sunIso}T12:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
  const monOffsetH = 12 - utcMsToLaParts(Date.parse(`${monIso}T12:00:00Z`)).hour;
  return {
    timeMin: new Date(Date.parse(`${satIso}T00:00:00Z`) + satOffsetH * 3_600_000).toISOString(),
    timeMax: new Date(Date.parse(`${monIso}T00:00:00Z`) + monOffsetH * 3_600_000).toISOString(),
  };
}

/** LA midnight of `dayIso` as a UTC instant (offset from the date itself; DST-safe). */
function laMidnight(dayIso: string): string {
  const offsetH = 12 - utcMsToLaParts(Date.parse(`${dayIso}T12:00:00Z`)).hour;
  return new Date(Date.parse(`${dayIso}T00:00:00Z`) + offsetH * 3_600_000).toISOString();
}

/** LA midnight of the first day → LA midnight after the last day (days sorted or not). */
function daysBounds(daysIso: readonly string[]): { timeMin: string; timeMax: string } {
  const sorted = [...daysIso].sort();
  const last = sorted[sorted.length - 1] ?? "";
  const after = new Date(Date.parse(`${last}T12:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
  return { timeMin: laMidnight(sorted[0] ?? ""), timeMax: laMidnight(after) };
}

/** Mark past placed holds as kept (still on the calendar) or dropped (deleted). */
async function reconcile(ledger: HoldsLedger, client: CalendarClient, now: Date): Promise<{ kept: number; dropped: number }> {
  let kept = 0;
  let dropped = 0;
  for (const entry of ledger.entries) {
    if (entry.status !== "placed" || Date.parse(entry.end) > now.getTime()) continue;
    let ev: CalendarEvent | null;
    try {
      ev = await client.getEvent(entry.calendarEventId);
    } catch (err) {
      // A flaky read (5xx/429) must not cost this weekend's holds; retry next run.
      console.warn(`[weekend-holds] status check failed for ${entry.calendarEventId}: ${(err as Error).message}`);
      continue;
    }
    entry.status = ev ? "kept" : "dropped";
    entry.checkedAt = now.toISOString();
    if (ev) kept++;
    else dropped++;
  }
  return { kept, dropped };
}

export async function runWeekendHolds(
  ranked: RankedEvent[],
  satIso: string,
  sunIso: string,
  opts: {
    client: CalendarClient;
    now?: Date;
    dryRun?: boolean;
    history?: HistoryItem[];
    path?: string;
    /** G2: put recurring communities first. Omitted = score order only. */
    community?: CommunityOptions;
    /** Pre-hold source check for public Google Calendar sources. Omitted = no check. */
    sourceCheck?: { list: ListPublicCalendar };
    /**
     * Weeknight holds (review 1): ranked evening events from recurring series on
     * `days` (LA dates: this Friday and next Mon–Thu). At most one hold, and only
     * for a community; it takes the last of the MAX_HOLDS slots. Omitted = none.
     */
    weeknight?: { ranked: RankedEvent[]; days: string[] };
  },
): Promise<HoldsOutcome> {
  const now = opts.now ?? new Date();
  const dryRun = opts.dryRun ?? false;
  const path = opts.path ?? ledgerPath();
  const ledger = readLedger(path);
  const outcome: HoldsOutcome = { weekend: satIso, placed: 0, reason: "", dryRun, picks: [], reconciled: { kept: 0, dropped: 0 } };

  outcome.reconciled = await reconcile(ledger, opts.client, now);
  const finish = (reason: string): HoldsOutcome => {
    outcome.reason = reason;
    if (!dryRun) {
      ledger.runs.push({ weekend: satIso, ranAt: now.toISOString(), placed: outcome.placed, reason });
      writeLedger(ledger, path);
    }
    return outcome;
  };

  if (ledger.runs.some((r) => r.weekend === satIso)) {
    outcome.reason = "already planned this weekend (one placement per weekend; dropped holds stay dropped)";
    if (!dryRun && (outcome.reconciled.kept || outcome.reconciled.dropped)) writeLedger(ledger, path);
    return outcome;
  }

  const { timeMin, timeMax } = weekendBounds(satIso, sunIso);
  const weekend = await opts.client.listEvents({ timeMin, timeMax });
  const own = weekend.filter((ev) => !ev.extendedProperties?.private?.["eventscoutHold"]);
  if (weekend.some((ev) => ev.extendedProperties?.private?.["eventscoutWeekend"] === satIso)) {
    return finish("holds for this weekend are already on the calendar");
  }
  const ownCount = ownWeekendEvents(own, satIso, sunIso);
  if (ownCount >= FULL_WEEKEND_EVENTS) {
    return finish(`weekend already full (${ownCount} own timed events 10:00–23:00) — quiet`);
  }

  const days = [satIso, sunIso];
  let order = ranked;
  let wkOrder = opts.weeknight?.ranked ?? [];
  const wkDays = opts.weeknight?.days ?? [];
  let series = new Map<string, SeriesFacts>();
  const communityKeys = new Set<string>();
  if (opts.community) {
    try {
      series = detectSeries(opts.community.loadCache());
      // One community call for the weekend and the weeknight candidates.
      const weekendCandidates = communityCandidates(ranked, series, days);
      const seen = new Set(weekendCandidates.map((c) => c.key));
      const candidates = [
        ...weekendCandidates,
        ...communityCandidates(wkOrder, series, wkDays, WEEKNIGHT_EARLIEST_HOUR).filter((c) => !seen.has(c.key)),
      ];
      const verdicts = await opts.community.classify(candidates);
      for (const [key, v] of verdicts) if (v.community) communityKeys.add(key);
      outcome.communityCheck = {
        candidates: candidates.length,
        communities: communityKeys.size,
        verdicts: candidates.map((c) => ({
          title: c.title,
          community: verdicts.get(c.key)?.community ?? false,
          kind: verdicts.get(c.key)?.kind ?? "no verdict",
        })),
      };
      order = communityFirst(ranked, communityKeys);
    } catch (err) {
      // Loud, not fatal: the holds still go out in score order; the CLI exits 1.
      outcome.communityError = (err as Error).message;
      communityKeys.clear();
      console.error(`[weekend-holds] community check FAILED (holds follow score order): ${outcome.communityError}`);
    }
  }

  // Pre-hold source check: an event that left its source calendar, or whose own
  // text names a date rule its date does not fit, gets no hold.
  // The weeknight range (Fri 00:00 → the day after the last weeknight) holds the weekend too.
  const wkBounds = wkDays.length > 0 ? daysBounds(wkDays) : null;
  let checks = new Map<string, SourceVerdict>();
  if (opts.sourceCheck) {
    const range = wkBounds ?? { timeMin, timeMax };
    const sc = await checkCalendarSources([...order, ...wkOrder], range.timeMin, range.timeMax, opts.sourceCheck.list);
    checks = sc.verdicts;
    const skipped = [...order, ...wkOrder].flatMap((e) => {
      const v = checks.get(e.id);
      if (v?.status === "gone") return [`${e.title} (gone from the source)`];
      if (v?.status === "doubtful") return [`${e.title} (source text says "${v.phrase}"; the date does not fit)`];
      return [];
    });
    outcome.sourceCheck = { checked: sc.checked, gone: sc.gone, doubtful: sc.doubtful, skipped };
    if (sc.errors.length > 0) {
      // Loud, not fatal: those picks keep the calendar-view link; the CLI exits 1.
      outcome.sourceCheckError = sc.errors.join("; ");
      console.error(`[weekend-holds] source check FAILED (calendar-view links kept): ${outcome.sourceCheckError}`);
    }
    const onSource = (e: RankedEvent): boolean => {
      const status = checks.get(e.id)?.status;
      return status !== "gone" && status !== "doubtful";
    };
    order = order.filter(onSource);
    wkOrder = wkOrder.filter(onSource);
  }

  let picks = selectHolds(order, busyIntervals(own), days);

  // Weeknight: the best community (score order) that fits Jm's calendar, not
  // the same group or place as a weekend pick that stays.
  let wkPicks: RankedEvent[] = [];
  if (opts.weeknight && wkBounds) {
    if (communityKeys.size === 0) {
      const why = outcome.communityError ? "community check failed" : opts.community ? "no communities found" : "community check off";
      outcome.weeknight = { candidates: 0, picked: 0, reason: `no weeknight hold: ${why} (weeknight holds are communities only)` };
    } else {
      const isCommunity = (e: RankedEvent): boolean => {
        const key = seriesKey(e);
        return key !== null && communityKeys.has(key);
      };
      const staying = picks.slice(0, MAX_HOLDS - MAX_WEEKNIGHT_HOLDS);
      const stayKeys = new Set(staying.map((e) => seriesKey(e)));
      const stayVenues = new Set(staying.map((e) => normalize(e.venue ?? "")).filter(Boolean));
      const candidates = wkOrder.filter(
        (e) => isCommunity(e) && !stayKeys.has(seriesKey(e)) && !stayVenues.has(normalize(e.venue ?? "")),
      );
      const wkCalendar = await opts.client.listEvents(wkBounds);
      const wkOwn = wkCalendar.filter((ev) => !ev.extendedProperties?.private?.["eventscoutHold"]);
      wkPicks = selectHolds(candidates, busyIntervals(wkOwn), wkDays, MAX_WEEKNIGHT_HOLDS, WEEKNIGHT_EARLIEST_HOUR);
      outcome.weeknight = {
        candidates: candidates.length,
        picked: wkPicks.length,
        reason: wkPicks.length ? "a weeknight community fits" : "no weeknight community passed the rules",
      };
      if (wkPicks.length > 0) picks = picks.slice(0, MAX_HOLDS - wkPicks.length);
    }
  }
  picks = [...picks, ...wkPicks];
  if (picks.length === 0) return finish("no pick passed the rules (timed, score, no overlap)");

  let history = opts.history;
  if (!history) {
    const past = await opts.client.listEvents({
      timeMin: new Date(now.getTime() - HISTORY_DAYS * 86_400_000).toISOString(),
      timeMax: now.toISOString(),
    });
    history = [...activityLogHistory(), ...calendarHistory(past)];
  }

  for (const e of picks) {
    const visit = returnVisitEvidence(e, history);
    const key = seriesKey(e);
    const facts = key && communityKeys.has(key) ? (series.get(key) ?? null) : null;
    const verdict = checks.get(e.id);
    const found = verdict?.status === "found" ? verdict : null;
    const body = buildHoldEvent(e, satIso, visit, now, facts, found);
    const link = body.source?.url ?? e.sourceUrl;
    outcome.picks.push({
      title: e.title,
      start: e.startDatetime,
      venue: e.venue,
      score: e.score,
      link,
      returnVisit: visit,
      community: facts ? describeSeries(facts) : null,
      sourceCheck: found ? `on source${found.organizer ? `; organizer ${found.organizer}` : ""}` : null,
    });
    if (dryRun) continue;
    const created = await opts.client.insertEvent(body);
    outcome.placed++;
    ledger.entries.push({
      weekend: satIso,
      calendarEventId: created.id,
      eventId: e.id,
      title: e.title,
      start: body.start.dateTime ?? e.startDatetime,
      end: body.end.dateTime ?? e.startDatetime,
      sourceUrl: link,
      returnVisit: visit !== null,
      community: facts !== null,
      ...(key && { seriesKey: key }),
      placedAt: now.toISOString(),
      status: "placed",
    });
    writeLedger(ledger, path);
  }
  return finish(dryRun ? `dry run: ${picks.length} pick(s), nothing written` : `placed ${outcome.placed} hold(s)`);
}
