/**
 * Horizon.ts — Slice 5: tunable prefetch horizon knob + uniform future cap.
 *
 * Exports:
 *   horizonDays(): number
 *       Reads EVENTSCOUT_HORIZON_DAYS env var; defaults to 120.
 *       Guards: NaN / 0 / negative all fall back to 120.
 *
 *   withinHorizon(events, now, days?): EventItem[]
 *       PURE filter. Drops events whose startDatetime is strictly AFTER
 *       now + days (exclusive). The horizon is a FAR-FUTURE cap only:
 *       - Past events are intentionally kept — the query date-window filter
 *         handles past exclusion; the horizon should not double-cut from below.
 *       - Events with an unparseable or empty startDatetime are kept so no
 *         data is silently lost; the query filter will handle them at read time.
 *
 * This module is a pure utility — zero I/O, zero side effects.
 * The integration point (applying withinHorizon inside ingestSource) lives
 * in Ingest.ts so every adapter path is bounded uniformly.
 */

import type { EventItem } from "./types.ts";

// ============================================================================
// horizonDays — env-driven knob
// ============================================================================

const DEFAULT_HORIZON_DAYS = 120;

/**
 * Return the configured prefetch horizon in days.
 *
 * Reads `EVENTSCOUT_HORIZON_DAYS` from the process environment.
 * Falls back to 120 for any of: unset, NaN, 0, or negative values.
 */
export function horizonDays(): number {
  const raw = process.env["EVENTSCOUT_HORIZON_DAYS"];
  if (raw == null || raw === "") return DEFAULT_HORIZON_DAYS;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_HORIZON_DAYS;
  return n;
}

// ============================================================================
// withinHorizon — pure event filter
// ============================================================================

/**
 * Return the subset of `events` whose `startDatetime` is NOT after now + days.
 *
 * Design decisions (documented per spec):
 *
 * 1. Horizon is a future cap only.
 *    Past events (startDatetime < now) are kept intact. Dropping past events
 *    is the query date-window filter's responsibility, not the horizon's job.
 *    Double-cutting from below would silently discard recently-past events that
 *    some callers legitimately want to see (e.g. "events from this week").
 *
 * 2. Unparseable / empty startDatetime → KEEP.
 *    We cannot determine whether an unparseable date is within horizon. Keeping
 *    preserves the data so downstream filters (e.g. filterEvents in Filter.ts)
 *    can decide. Silently discarding would be a data-loss bug that's hard to
 *    detect because it would never produce an error.
 *
 * @param events - Array of EventItem to filter. Not mutated.
 * @param now    - Reference instant for the horizon. Pass explicitly for
 *                 deterministic unit tests (do not call Date.now() here).
 * @param days   - Horizon in days. Defaults to horizonDays().
 * @returns      - New array containing only events within or at the horizon.
 */
export function withinHorizon(
  events: EventItem[],
  now: Date,
  days: number = horizonDays(),
): EventItem[] {
  const cutoffMs = now.getTime() + days * 24 * 60 * 60 * 1000;

  return events.filter((event) => {
    const { startDatetime } = event;

    // Unparseable or empty → keep (design decision 2 above)
    if (!startDatetime || startDatetime.trim() === "") return true;
    const startMs = Date.parse(startDatetime);
    if (!Number.isFinite(startMs) || isNaN(startMs)) return true;

    // Keep if at or before the cutoff (strictly AFTER = drop)
    return startMs <= cutoffMs;
  });
}
