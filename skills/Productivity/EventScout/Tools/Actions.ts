/**
 * Actions.ts — EventScout save-actions (Slice 11).
 *
 * saveToIdeas(event)     → append to activity_ideas via LifeOS SheetsIO
 * addToCalendar(event)   → create Google Calendar event via gcalcli
 * deleteIdea(ref)        → delete by row index (cleanup/testing)
 * deleteCalendarEvent(ref) → delete by title|date ref (cleanup/testing)
 *
 * Pure builder functions exported for unit tests:
 *   buildIdeaRow(event)      → activity_ideas row object
 *   buildCalendarEvent(event) → gcalcli arg set
 */

import {
  appendRow,
  readRows,
  deleteRows,
} from "../../LifeOS/StorageIO/SheetsIO.ts"; // cross-skill-allowed: EventScout writes idea/calendar rows through LifeOS's positive-data store by design (capture routing)
// cross-skill-allowed: EventScout writes idea/calendar rows through LifeOS's positive-data store by design (capture routing)
import { readWorkbookConfig } from "../../LifeOS/StorageIO/Config.ts";
import { addEvent, deleteEvent } from "../../../../lib/core/GcalCli.ts";
import type { EventItem } from "./types.ts";
import type { RankedEvent } from "./Ranker.ts";
import { utcIsoToLaIso } from "./lib/tz.ts";
import { bestLink } from "./lib/links.ts";
import { noteBooking } from "./BookingLedger.ts";
import type { BookingAction } from "./Booking.ts";
import type { NoteResult } from "./BookingLedger.ts";

// ============================================================================
// Constants
// ============================================================================

const CALENDAR = process.env["LIFEOS_CALENDAR"] ?? "[user-email]";

// activity_ideas headers: name | priority | rank | had | gmap_url
const ACTIVITY_IDEAS_TAB = "activity_ideas";

// ============================================================================
// Pure builder functions (exported for unit tests)
// ============================================================================

export type IdeaRow = Record<string, string>;

/**
 * Map an EventItem → activity_ideas row.
 *
 * Schema: name | priority | rank | had | gmap_url
 *   name     = event title
 *   priority = "medium" (EventScout picks are all medium by default)
 *   rank     = "" (no user ranking yet)
 *   had      = "" (not yet attended)
 *   gmap_url = "" (EventScout doesn't provide Google Maps links)
 */
export function buildIdeaRow(event: EventItem | RankedEvent): IdeaRow {
  return {
    name: event.title,
    priority: "medium",
    rank: "",
    had: "",
    gmap_url: "",
  };
}

export interface CalendarEventArgs {
  title: string;
  when: string;
  duration: number;   // minutes
  location: string;
  description: string;
  calendar: string;
}

/**
 * Map an EventItem → gcalcli add arg set.
 *
 *   title       = event title
 *   when        = startDatetime formatted as "YYYY-MM-DD HH:MM" in PT (gcalcli local-time format)
 *   duration    = (endDatetime - startDatetime) in minutes, default 120 if no end
 *   location    = address ?? venue ?? ""
 *   description = why (if RankedEvent) + "\n" + ticketUrl ?? sourceUrl
 *   calendar    = LIFEOS_CALENDAR env or "[user-email]"
 */
export function buildCalendarEvent(event: EventItem | RankedEvent): CalendarEventArgs {
  // Compute duration
  let duration = 120; // default 2h
  if (event.endDatetime) {
    try {
      const startMs = new Date(event.startDatetime).getTime();
      const endMs = new Date(event.endDatetime).getTime();
      const diffMin = Math.round((endMs - startMs) / 60_000);
      if (diffMin > 0) duration = diffMin;
    } catch {
      // Keep default
    }
  }

  // Format start time as "YYYY-MM-DD HH:MM" in LA local time
  const when = formatWhenForGcal(event.startDatetime);

  // Location: prefer address over venue name
  const location = event.address ?? event.venue ?? "";

  // Description: why-line (if ranked) + link
  const link = bestLink(event);
  let description = "";
  if (isRankedEvent(event) && event.why) {
    description = event.why + "\n\n";
  }
  description += link;

  return {
    title: event.title,
    when,
    duration,
    location,
    description,
    calendar: CALENDAR,
  };
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Format an ISO datetime to "YYYY-MM-DD HH:MM" in America/Los_Angeles.
 * gcalcli add --when expects a local datetime string or natural-language phrase.
 */
function formatWhenForGcal(isoStr: string): string {
  let laIso: string;
  try {
    if (/[+-]\d{2}:\d{2}$/.test(isoStr) || isoStr.endsWith("Z")) {
      laIso = utcIsoToLaIso(new Date(isoStr).toISOString());
    } else {
      laIso = isoStr;
    }
  } catch {
    return isoStr;
  }

  try {
    const d = new Date(laIso);
    // Format as "YYYY-MM-DD HH:MM" using Intl — locale-independent
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/Los_Angeles",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).formatToParts(d);

    const get = (t: string): string =>
      parts.find((p) => p.type === t)?.value ?? "";

    const year = get("year");
    const month = get("month");
    const day = get("day");
    let hour = get("hour");
    const minute = get("minute");

    // Intl hour12:false can output "24" for midnight — normalize
    if (hour === "24") hour = "00";

    return `${year}-${month}-${day} ${hour}:${minute}`;
  } catch {
    return isoStr;
  }
}

function isRankedEvent(e: EventItem | RankedEvent): e is RankedEvent {
  return "why" in e && typeof (e as RankedEvent).why === "string";
}

// ============================================================================
// Live actions
// ============================================================================

export interface ActionResult {
  ok: boolean;
  ref: string;
  error?: string;
  /** Present when this action also recorded a booking requirement (addToCalendar only). */
  booking?: NoteResult;
}

/**
 * Append an EventItem to the activity_ideas tab.
 *
 * Returns { ok: true, ref: "<rowIndex1Based>" } on success.
 * ref is the 1-based row index (includes header), usable with deleteIdea().
 */
export async function saveToIdeas(event: EventItem | RankedEvent): Promise<ActionResult> {
  try {
    const { workbookId } = readWorkbookConfig();
    const row = buildIdeaRow(event);

    // Read current row count before append to compute the row index
    const before = readRows(workbookId, ACTIVITY_IDEAS_TAB);
    const beforeCount = before.length;

    appendRow(workbookId, ACTIVITY_IDEAS_TAB, row);

    // New row is at 1-based index: header(1) + beforeCount data rows + 1 new row
    const rowIndex = beforeCount + 2; // +1 header + 1 new row
    return { ok: true, ref: String(rowIndex) };
  } catch (err) {
    return { ok: false, ref: "", error: (err as Error).message };
  }
}

/**
 * Delete an activity_ideas row by 1-based row index (the ref from saveToIdeas).
 */
export async function deleteIdea(ref: string): Promise<ActionResult> {
  try {
    const rowIndex = parseInt(ref, 10);
    if (!Number.isFinite(rowIndex) || rowIndex < 2) {
      throw new Error(`Invalid row index ref: "${ref}" (must be >= 2)`);
    }
    const { workbookId } = readWorkbookConfig();
    deleteRows(workbookId, ACTIVITY_IDEAS_TAB, rowIndex, rowIndex + 1);
    return { ok: true, ref };
  } catch (err) {
    return { ok: false, ref, error: (err as Error).message };
  }
}

/**
 * Create a Google Calendar event from an EventItem.
 *
 * Uses gcalcli add --noprompt.
 * Returns { ok: true, ref: "<title>|<when>" } on success.
 *
 * The ref format "<title>|<when>" is the canonical form consumed by
 * deleteCalendarEvent — it maps directly to the gcalcli delete text+date args.
 *
 * `action`/`bookBy` are CALLER-SUPPLIED (the calling agent's judgment, or a
 * CLI `--action`/`--book-by` flag) — this function does zero classification
 * itself; it only threads the values through to the booking ledger. Omitting
 * `action` records the entry as "unclassified" (see Booking.ts).
 */
export async function addToCalendar(
  event: EventItem | RankedEvent,
  action?: BookingAction,
  bookBy?: string,
): Promise<ActionResult> {
  try {
    const args = buildCalendarEvent(event);

    addEvent({
      calendar: args.calendar,
      title: args.title,
      when: args.when,
      duration: args.duration,
      where: args.location,
      description: args.description,
      caller: "EventScout.Actions.addToCalendar",
    });

    // An event on the calendar often still needs a booking action (tickets,
    // reservation, RSVP) before you can attend. Record it in the booking ledger
    // so the daily notice scan can remind Jm before the deadline. Best-effort —
    // a ledger failure must never fail the calendar add that already succeeded.
    let booking: NoteResult | undefined;
    try {
      booking = noteBooking(event, new Date(), action, bookBy);
    } catch {
      // swallow — booking notices are additive, not load-bearing
    }

    // Ref is always "title|when" — the format deleteCalendarEvent uses directly.
    const ref = `${args.title}|${args.when}`;
    return { ok: true, ref, booking };
  } catch (err) {
    return { ok: false, ref: "", error: (err as Error).message };
  }
}

/**
 * Delete a Google Calendar event by its ref.
 *
 * ref must be "<title>|<when>" (the format returned by addToCalendar).
 * Calls: gcalcli delete <title> <date> <date+1> --iamaexpert
 *
 * Throws if ref does not contain "|" (i.e. is not a valid title|when ref).
 */
export async function deleteCalendarEvent(ref: string): Promise<ActionResult> {
  try {
    const { text, startDate, endDate } = parseCalendarRef(ref);
    deleteEvent({ text, startDate, endDate, calendar: CALENDAR, caller: "EventScout.Actions.deleteCalendarEvent" });
    return { ok: true, ref };
  } catch (err) {
    return { ok: false, ref, error: (err as Error).message };
  }
}

// ============================================================================
// Pure builder helpers (exported for unit tests)
// ============================================================================

/**
 * Build the canonical "<title>|<when>" ref for a calendar event.
 * This is what addToCalendar returns and deleteCalendarEvent expects.
 */
export function buildCalendarRef(event: EventItem | RankedEvent): string {
  const args = buildCalendarEvent(event);
  return `${args.title}|${args.when}`;
}

export interface CalendarDeleteCommand {
  text: string;          // the search text passed to gcalcli delete (must be non-empty)
  startDate: string;     // "YYYY-MM-DD"
  endDate: string;       // "YYYY-MM-DD" (startDate + 1 day)
}

/**
 * Parse a "<title>|<when>" ref into the args for gcalcli delete.
 * Throws if ref is malformed (no "|", empty title, or unparseable date).
 */
export function parseCalendarRef(ref: string): CalendarDeleteCommand {
  if (!ref.includes("|")) {
    throw new Error(
      `Invalid calendar ref "${ref}": expected "<title>|<when>" format`
    );
  }
  const pipeIdx = ref.indexOf("|");
  const title = ref.slice(0, pipeIdx);
  const when = ref.slice(pipeIdx + 1);
  if (!title) {
    throw new Error(`Invalid calendar ref "${ref}": title is empty`);
  }
  const dateStr = when.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    throw new Error(`Invalid calendar ref "${ref}": cannot parse date from when="${when}"`);
  }
  const endDate = advanceDate(dateStr, 1);
  return { text: title, startDate: dateStr, endDate };
}

// ============================================================================
// Private utilities
// ============================================================================

/**
 * Advance a "YYYY-MM-DD" date string by N days.
 */
function advanceDate(dateStr: string, days: number): string {
  const d = new Date(dateStr + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
