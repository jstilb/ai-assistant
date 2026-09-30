/**
 * BookingLedger.ts — persistence for EventScout booking notices.
 *
 * Stores BookingLedgerEntry[] as JSON. This is the state layer over the pure
 * logic in Booking.ts: when an event is committed to the calendar (or saved),
 * we `noteBooking(event)` to record what must be booked and by when; a scheduled
 * `scanNotices()` reads the ledger and returns the entries due for a notice.
 *
 * Ledger file location (priority order):
 *   1. process.env.EVENTSCOUT_BOOKING_LEDGER_PATH  — used in tests to scope /tmp
 *   2. DEFAULT_BOOKING_LEDGER_PATH (State/booking-ledger.json in this skill dir)
 *
 * Dry-run: set EVENTSCOUT_BOOKING_DRY_RUN=1 to make noteBooking() a no-op that
 * returns { noted: false } without touching the ledger file — for live-verification
 * runs that must not write to the production ledger.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname } from "path";
import { KAYA_HOME } from "./types.ts";
import type { EventItem } from "./types.ts";
import type { RankedEvent } from "./Ranker.ts";
import {
  BookingLedgerSchema,
  buildLedgerEntry,
  selectDueNotices,
  findExpiredIds,
} from "./Booking.ts";
import type { BookingAction, BookingLedger, BookingLedgerEntry, BookingNotice } from "./Booking.ts";

// ============================================================================
// Paths
// ============================================================================

export const DEFAULT_BOOKING_LEDGER_PATH = `${KAYA_HOME}/skills/Productivity/EventScout/State/booking-ledger.json`;

function ledgerPath(): string {
  return process.env["EVENTSCOUT_BOOKING_LEDGER_PATH"] ?? DEFAULT_BOOKING_LEDGER_PATH;
}

function ensureDir(filePath: string): void {
  const dir = dirname(filePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

// ============================================================================
// Read / write
// ============================================================================

export function readLedger(): BookingLedger {
  const path = ledgerPath();
  if (!existsSync(path)) {
    return { entries: [], lastUpdated: new Date().toISOString() };
  }
  const raw = readFileSync(path, "utf-8").trim();
  if (raw === "") return { entries: [], lastUpdated: new Date().toISOString() };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { entries: [], lastUpdated: new Date().toISOString() };
  }
  const result = BookingLedgerSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`Booking ledger corrupt: ${result.error.message}`);
  }
  return result.data;
}

export function writeLedger(ledger: BookingLedger): void {
  const path = ledgerPath();
  ensureDir(path);
  const validated = BookingLedgerSchema.parse({
    ...ledger,
    lastUpdated: new Date().toISOString(),
  });
  writeFileSync(path, JSON.stringify(validated, null, 2), "utf-8");
}

// ============================================================================
// Mutations
// ============================================================================

export interface NoteResult {
  noted: boolean;
  /** Present when noted; the created/updated entry. */
  entry?: BookingLedgerEntry;
  /** Reason when not noted (e.g. "no booking required"). */
  reason?: string;
}

/**
 * Record (upsert) an event's booking requirement in the ledger.
 *
 * `action` is CALLER-SUPPLIED — classification has left code entirely (see
 * Booking.ts's module doc comment). Omitting it defaults to "unclassified",
 * which still creates an entry (bookBy null) so it surfaces for review on
 * every scan/digest rather than being silently dropped. `bookByOverride`, if
 * given, wins over the code's computed lead-day default.
 *
 * Idempotent by eventId: re-noting the same event refreshes its booking metadata
 * but preserves a non-"open" status (so a booked/dismissed event isn't reopened).
 * Returns { noted: false } when the caller explicitly passed action "none".
 */
export function noteBooking(
  event: EventItem | RankedEvent,
  now: Date = new Date(),
  action: BookingAction = "unclassified",
  bookByOverride?: string,
): NoteResult {
  if (process.env["EVENTSCOUT_BOOKING_DRY_RUN"] === "1") {
    return { noted: false, reason: "dry-run (EVENTSCOUT_BOOKING_DRY_RUN=1) — ledger not written" };
  }

  const fresh = buildLedgerEntry(event, now, action, bookByOverride);
  if (!fresh) {
    return { noted: false, reason: "No booking required — just show up." };
  }

  const ledger = readLedger();
  const idx = ledger.entries.findIndex((e) => e.eventId === fresh.eventId);
  if (idx >= 0) {
    const prev = ledger.entries[idx]!;
    // Preserve a resolved status; refresh the rest of the booking metadata.
    fresh.status = prev.status === "open" ? "open" : prev.status;
    fresh.notedAt = prev.notedAt;
    ledger.entries[idx] = fresh;
  } else {
    ledger.entries.push(fresh);
  }
  writeLedger(ledger);
  return { noted: true, entry: fresh };
}

/** Flip an entry's status by eventId. Returns false if not found. */
export function setStatus(
  eventId: string,
  status: BookingLedgerEntry["status"],
): boolean {
  const ledger = readLedger();
  const entry = ledger.entries.find((e) => e.eventId === eventId);
  if (!entry) return false;
  entry.status = status;
  writeLedger(ledger);
  return true;
}

export const markBooked = (eventId: string): boolean => setStatus(eventId, "booked");
export const dismiss = (eventId: string): boolean => setStatus(eventId, "dismissed");

// ============================================================================
// Scan
// ============================================================================

export interface ScanResult {
  notices: BookingNotice[];
  /** eventIds whose events have passed and were flipped to "expired". */
  expired: string[];
}

/**
 * Scan the ledger for due notices. Side effect: flips passed events to
 * "expired" (and persists) so they stop appearing — this is the one write
 * `scan` performs, keeping the ledger self-cleaning.
 */
export function scanNotices(now: Date = new Date(), windowDays = 14): ScanResult {
  const ledger = readLedger();

  const expired = findExpiredIds(ledger.entries, now);
  if (expired.length > 0) {
    const expiredSet = new Set(expired);
    for (const e of ledger.entries) {
      if (expiredSet.has(e.eventId) && e.status === "open") e.status = "expired";
    }
    writeLedger(ledger);
  }

  const notices = selectDueNotices(ledger.entries, now, windowDays);
  return { notices, expired };
}

/** All entries (any status), for `booking list`. */
export function listEntries(): BookingLedgerEntry[] {
  return readLedger().entries;
}
