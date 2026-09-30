/**
 * Booking.ts — EventScout "notices for booking" logic (pure, zero I/O).
 *
 * This is the missing third stage of the discover → calendar → *book* pipeline.
 * EventScout discovers events and can put them on the calendar (Actions.ts), but
 * many events require a booking ACTION before you attend — buy tickets, make a
 * reservation, RSVP/register — and that action has a deadline (tickets sell out,
 * tables fill, RSVP windows close). Nothing surfaced that deadline. This module
 * does.
 *
 * The booking metadata (price, ticketUrl, category, keywords) is only known at
 * discovery time — a calendar title alone can't tell you a show needs tickets.
 * So we capture it into a booking ledger when an event is committed, and this
 * module turns each ledger entry into a dated, prioritized notice.
 *
 * Everything here is a pure function: no filesystem, no clock reads (callers
 * pass `now` explicitly for deterministic tests). I/O lives in BookingLedger.ts.
 *
 * CLASSIFICATION IS AGENT-JUDGED (markdown-first de-determinization, Slice 2,
 * 2026-07). Booking action classification used to be a regex-keyword cascade
 * (deleted from this file in Commit 3 of that slice) — an enumerated keyword
 * list, silently wrong on anything unanticipated. That guessing has moved to
 * the calling agent: it reads SKILL.md's "Booking Notices" section,
 * judges buy-tickets / reserve / rsvp / none from the event text, and passes
 * `--action` explicitly to `cli.ts add-to-calendar` / `booking note`. Code
 * keeps only what markdown can't do: the ledger, digest/urgency/expiry
 * mechanics, `computeBookBy` date math, and the lead-day policy defaults
 * below. When the agent is unsure, it omits `--action` entirely — the entry
 * lands `"unclassified"` and nags in every scan/digest until resolved, rather
 * than being silently guessed at (or silently dropped as `"none"`).
 */

import { z } from "zod";
import type { EventItem } from "./types.ts";
import type { RankedEvent } from "./Ranker.ts";
import { bestLink } from "./lib/links.ts";
import { utcIsoToLaIso } from "./lib/tz.ts";

// ============================================================================
// Booking action
// ============================================================================

/**
 * What the user must DO to secure a spot at this event.
 *
 * "unclassified" means no caller has judged this event yet — it is NOT the
 * same as "none" (a deliberate "no booking needed" determination). See the
 * module doc comment above.
 */
export const BookingActionSchema = z.enum([
  "buy-tickets",
  "reserve",
  "rsvp",
  "none",
  "unclassified",
]);
export type BookingAction = z.infer<typeof BookingActionSchema>;

/**
 * The subset of BookingAction a caller (CLI flag, agent) may explicitly
 * assert. "unclassified" is never passed explicitly — it is the default when
 * no action is supplied at all (see cli.ts's `parseBookingFlags`).
 */
export const ExplicitBookingActionSchema = z.enum(["buy-tickets", "reserve", "rsvp", "none"]);
export type ExplicitBookingAction = z.infer<typeof ExplicitBookingActionSchema>;

/** True for the three actions that actually require booking ahead of time. */
function requiresBookingAction(action: BookingAction): boolean {
  return action === "buy-tickets" || action === "reserve" || action === "rsvp";
}

/** Short human explanation shown in the ledger/digest for each action. */
const ACTION_REASON: Record<BookingAction, string> = {
  "buy-tickets": "Buy tickets before they sell out.",
  reserve: "Reserve ahead — hold a table/seat.",
  rsvp: "RSVP/register to hold your spot.",
  none: "No booking needed — just show up.",
  unclassified: "Booking action not yet determined — needs review.",
};

// ============================================================================
// "Book by" lead-time policy
// ============================================================================

/**
 * Days of lead time to recommend booking BEFORE the event, keyed by category.
 * High-demand categories (sports, festivals) get more runway; casual ones less.
 * These are the defaults used when the action is buy-tickets; reserve/rsvp apply
 * their own shorter floors below.
 */
const CATEGORY_LEAD_DAYS: Record<string, number> = {
  sports: 21,
  festival: 21,
  music: 14,
  comedy: 14,
  theater: 14,
  arts: 7,
  food: 7,
  talk: 5,
  film: 5,
  community: 3,
  other: 7,
};

/** Fixed lead times for the non-ticket actions (override category lead). */
const ACTION_LEAD_DAYS: Partial<Record<BookingAction, number>> = {
  reserve: 7,
  rsvp: 3,
};

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Compute the recommended "book by" instant (ISO) for an event, given the
 * (caller-supplied) action. This is pure date arithmetic — the code default
 * used when the caller doesn't pass an explicit `--book-by` override.
 *
 * Policy: bookBy = eventStart − leadDays, but never earlier than `now`
 * (if the ideal lead window has already passed, the answer is "book now").
 *
 * Returns null when:
 *   - action is "none" or "unclassified" (nothing to book — a caller with a
 *     real deadline in mind should pass an explicit `--book-by` instead), or
 *   - the event start is unparseable, or
 *   - the event has already started (nothing left to book).
 */
export function computeBookBy(
  event: EventItem | RankedEvent,
  action: BookingAction,
  now: Date,
): string | null {
  if (!requiresBookingAction(action)) return null;

  const startMs = Date.parse(event.startDatetime);
  if (!Number.isFinite(startMs)) return null;
  if (startMs <= now.getTime()) return null; // event already began

  const leadDays =
    ACTION_LEAD_DAYS[action] ??
    CATEGORY_LEAD_DAYS[event.category] ??
    CATEGORY_LEAD_DAYS["other"]!;

  const idealMs = startMs - leadDays * DAY_MS;
  const bookByMs = Math.max(idealMs, now.getTime());
  return new Date(bookByMs).toISOString();
}

// ============================================================================
// Booking ledger entry
// ============================================================================

export const BookingLedgerEntrySchema = z.object({
  /** Same stable id as the EventItem it was derived from. */
  eventId: z.string(),
  title: z.string(),
  /** ISO start of the event itself. */
  startDatetime: z.string(),
  venue: z.string().optional(),
  action: BookingActionSchema,
  reason: z.string(),
  /** ISO instant to book by; null if not applicable. */
  bookBy: z.string().nullable(),
  /** Ticket/booking/source link to act on. */
  link: z.string(),
  isFree: z.boolean(),
  priceMin: z.number().optional(),
  priceMax: z.number().optional(),
  status: z.enum(["open", "booked", "dismissed", "expired"]),
  /** ISO timestamp this entry was created. */
  notedAt: z.string(),
});
export type BookingLedgerEntry = z.infer<typeof BookingLedgerEntrySchema>;

export const BookingLedgerSchema = z.object({
  entries: z.array(BookingLedgerEntrySchema),
  lastUpdated: z.string(),
});
export type BookingLedger = z.infer<typeof BookingLedgerSchema>;

/**
 * Build a ledger entry from an event. Pure — `now` is passed for the notedAt
 * stamp and the default bookBy computation.
 *
 * `action` is CALLER-SUPPLIED (the agent's judgment, or a CLI `--action`
 * flag) — this function does zero classification itself. Omitting `action`
 * defaults to `"unclassified"`, which still produces an entry (bookBy null)
 * so it surfaces for review rather than vanishing. Passing `"none"` is a
 * deliberate "no booking needed" determination and returns null — the one
 * case that skips the ledger entirely, so the digest stays signal, not noise.
 *
 * `bookByOverride`, when given, wins over the computed lead-day default
 * (still applies even for an "unclassified" entry, so a caller who knows the
 * deadline but not yet the action can still record it).
 */
export function buildLedgerEntry(
  event: EventItem | RankedEvent,
  now: Date,
  action: BookingAction = "unclassified",
  bookByOverride?: string,
): BookingLedgerEntry | null {
  if (action === "none") return null; // no booking needed — skip noise entirely

  const bookBy = bookByOverride ?? computeBookBy(event, action, now);

  return {
    eventId: event.id,
    title: event.title,
    startDatetime: event.startDatetime,
    venue: event.venue,
    action,
    reason: ACTION_REASON[action],
    bookBy,
    link: bestLink(event),
    isFree: event.isFree,
    priceMin: event.priceMin,
    priceMax: event.priceMax,
    status: "open",
    notedAt: now.toISOString(),
  };
}

// ============================================================================
// Notice selection + urgency
// ============================================================================

export type NoticeUrgency = "overdue" | "urgent" | "soon";

export interface BookingNotice {
  entry: BookingLedgerEntry;
  urgency: NoticeUrgency;
  /** Whole days from `now` until bookBy (negative = past due). */
  daysUntilBookBy: number;
}

/** bookBy within this many days of `now` (default 2) → "urgent". */
const URGENT_WINDOW_DAYS = 2;

/**
 * Classify a single open entry's urgency relative to `now`.
 * Entries with no bookBy sort as "soon".
 */
export function urgencyOf(entry: BookingLedgerEntry, now: Date): BookingNotice {
  const nowMs = now.getTime();
  const bookByMs = entry.bookBy ? Date.parse(entry.bookBy) : NaN;

  let urgency: NoticeUrgency = "soon";
  let daysUntilBookBy = Number.POSITIVE_INFINITY;

  if (Number.isFinite(bookByMs)) {
    daysUntilBookBy = Math.floor((bookByMs - nowMs) / DAY_MS);
    if (bookByMs < nowMs) urgency = "overdue";
    else if (bookByMs <= nowMs + URGENT_WINDOW_DAYS * DAY_MS) urgency = "urgent";
    else urgency = "soon";
  }

  return { entry, urgency, daysUntilBookBy };
}

const URGENCY_RANK: Record<NoticeUrgency, number> = {
  overdue: 0,
  urgent: 1,
  soon: 2,
};

/**
 * Select the open entries that are DUE for a notice, prioritized.
 *
 * An entry is due when it is "open", its event has not already started, and its
 * bookBy is within `windowDays` of now (entries with no bookBy are always shown
 * so they aren't silently lost). Sorted overdue → urgent → soon, then by
 * soonest bookBy, then soonest event.
 *
 * Pure: does not mutate `entries`.
 */
export function selectDueNotices(
  entries: BookingLedgerEntry[],
  now: Date,
  windowDays = 14,
): BookingNotice[] {
  const nowMs = now.getTime();
  const windowMs = windowDays * DAY_MS;

  const due: BookingNotice[] = [];
  for (const entry of entries) {
    if (entry.status !== "open") continue;

    const startMs = Date.parse(entry.startDatetime);
    if (Number.isFinite(startMs) && startMs <= nowMs) continue; // event passed

    const bookByMs = entry.bookBy ? Date.parse(entry.bookBy) : NaN;
    // No bookBy → always surface. Has bookBy → only within the window.
    if (Number.isFinite(bookByMs) && bookByMs > nowMs + windowMs) continue;

    due.push(urgencyOf(entry, now));
  }

  due.sort((a, b) => {
    const ur = URGENCY_RANK[a.urgency] - URGENCY_RANK[b.urgency];
    if (ur !== 0) return ur;
    const aBook = a.entry.bookBy ? Date.parse(a.entry.bookBy) : Number.POSITIVE_INFINITY;
    const bBook = b.entry.bookBy ? Date.parse(b.entry.bookBy) : Number.POSITIVE_INFINITY;
    if (aBook !== bBook) return aBook - bBook;
    return Date.parse(a.entry.startDatetime) - Date.parse(b.entry.startDatetime);
  });

  return due;
}

/**
 * Return the ids of open entries whose event has already started (stale).
 * Callers use this to flip status → "expired" so they stop nagging.
 * Pure.
 */
export function findExpiredIds(entries: BookingLedgerEntry[], now: Date): string[] {
  const nowMs = now.getTime();
  return entries
    .filter((e) => {
      if (e.status !== "open") return false;
      const startMs = Date.parse(e.startDatetime);
      return Number.isFinite(startMs) && startMs <= nowMs;
    })
    .map((e) => e.eventId);
}

// ============================================================================
// Renderers
// ============================================================================

const ACTION_LABEL: Record<BookingAction, string> = {
  "buy-tickets": "Buy tickets",
  reserve: "Make a reservation",
  rsvp: "RSVP / register",
  none: "No booking",
  unclassified: "⚠️ Needs review",
};

const URGENCY_EMOJI: Record<NoticeUrgency, string> = {
  overdue: "🔴",
  urgent: "🟠",
  soon: "🟡",
};

function fmtDatePT(isoStr: string): string {
  try {
    const laIso =
      /[+-]\d{2}:\d{2}$/.test(isoStr) || isoStr.endsWith("Z")
        ? utcIsoToLaIso(new Date(isoStr).toISOString())
        : isoStr;
    return new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Los_Angeles",
      weekday: "short",
      month: "short",
      day: "numeric",
    }).format(new Date(laIso));
  } catch {
    return isoStr.slice(0, 10);
  }
}

function fmtPrice(e: { isFree: boolean; priceMin?: number; priceMax?: number }): string {
  if (e.isFree) return "Free";
  if (e.priceMin !== undefined && e.priceMax !== undefined) {
    return e.priceMin === e.priceMax ? `$${e.priceMin}` : `$${e.priceMin}–$${e.priceMax}`;
  }
  if (e.priceMin !== undefined) return `$${e.priceMin}+`;
  if (e.priceMax !== undefined) return `up to $${e.priceMax}`;
  return "—";
}

function bookByPhrase(n: BookingNotice): string {
  if (!n.entry.bookBy) return "no deadline";
  const by = fmtDatePT(n.entry.bookBy);
  if (n.urgency === "overdue") return `book NOW (was due ${by})`;
  if (n.daysUntilBookBy <= 0) return `book today (${by})`;
  if (n.daysUntilBookBy === 1) return `book by tomorrow (${by})`;
  return `book by ${by} (${n.daysUntilBookBy}d)`;
}

/** Human-readable markdown digest for the terminal / notes. */
export function renderNoticesMarkdown(notices: BookingNotice[], now: Date): string {
  if (notices.length === 0) {
    return "No booking actions due. You're all caught up. ✅";
  }

  const header = `# Booking notices — ${fmtDatePT(now.toISOString())}\n\n${notices.length} action(s) need attention:\n`;
  const lines = notices.map((n, i) => {
    const e = n.entry;
    return [
      `\n${i + 1}. ${URGENCY_EMOJI[n.urgency]} **${ACTION_LABEL[e.action]}: ${e.title}**`,
      `   - When: ${fmtDatePT(e.startDatetime)}${e.venue ? ` · ${e.venue}` : ""}`,
      `   - Price: ${fmtPrice(e)}`,
      `   - Deadline: ${bookByPhrase(n)}`,
      `   - Link: ${e.link}`,
    ].join("\n");
  });
  return header + lines.join("\n");
}

/** Telegram HTML digest (parse_mode=HTML), ≤4096 chars. */
export function renderNoticesTelegram(notices: BookingNotice[], now: Date): string {
  const esc = (s: string): string =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  if (notices.length === 0) {
    return "<b>Booking notices</b>\nNothing to book — you're caught up. ✅";
  }

  const header = `<b>Booking notices</b> — ${notices.length} action(s):\n`;
  const MAX = 4096;
  let out = header;
  for (let i = 0; i < notices.length; i++) {
    const n = notices[i]!;
    const e = n.entry;
    const block =
      `\n${URGENCY_EMOJI[n.urgency]} <b>${esc(ACTION_LABEL[e.action])}: ${esc(e.title)}</b>\n` +
      `📅 ${esc(fmtDatePT(e.startDatetime))}${e.venue ? ` · ${esc(e.venue)}` : ""}\n` +
      `💵 ${esc(fmtPrice(e))}\n` +
      `⏰ ${esc(bookByPhrase(n))}\n` +
      `🔗 ${esc(e.link)}\n`;
    if ((out + block).length > MAX) {
      out += `\n…and ${notices.length - i} more.`;
      break;
    }
    out += block;
  }
  return out.trimEnd();
}
