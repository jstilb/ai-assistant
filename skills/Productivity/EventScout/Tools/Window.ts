/**
 * Window.ts — Query date-window construction + validation (markdown-first
 * de-determinization, 2026-07).
 *
 * Replaces the old NL date guesser's regex-based relative-date resolution
 * (deleted with ConstraintParser.ts) with a thin, LOUD, deterministic window
 * builder driven by explicit --from/--to flags. ALL natural-language date
 * interpretation ("Monday through Thursday", "July 6 to July 9") now happens
 * in the calling agent (see SKILL.md) — this module only turns two
 * YYYY-MM-DD strings into a validated, DST-correct { start, end } window, or
 * produces the default next-14-days window when neither flag is given.
 *
 * Root cause this replaces: the old NL date guesser's regex cascade silently
 * collapsed "Monday through Thursday" and "July 6 to July 9" to a single day
 * via partial regex matches — confidently wrong, zero warning. This module
 * never guesses: malformed input is a loud, non-zero-exit error.
 *
 * buildExplicitWindow(fromStr, toStr, now) — validates + builds a window from
 *   explicit YYYY-MM-DD strings. Throws WindowValidationError on:
 *     - malformed ISO date (not YYYY-MM-DD, or not a real calendar date)
 *     - from > to (inverted window)
 *     - window span > MAX_WINDOW_SPAN_DAYS
 *     - start more than MAX_START_YEARS_OUT years out
 *
 * buildDefaultWindow(now) — the next DEFAULT_WINDOW_DAYS days (today → +14d),
 *   LA midnight to LA 23:59:59. Also returns a human-readable `toLabel` for
 *   the CLI's "defaulting to the next 14 days" banner.
 *
 * Date arithmetic is built on the EXISTING tz.ts helpers (laDateIso,
 * utcMsToLaParts) — no reimplementation.
 */

import { laDateIso, utcMsToLaParts } from "./lib/tz.ts";

// ============================================================================
// Constants
// ============================================================================

/** Default home location: central San Diego. */
export const DEFAULT_HOME = { lat: 32.7157, lng: -117.1611 };

export const DEFAULT_RADIUS_MILES = 15;

/** Default window size (days) when no --from/--to is given. */
export const DEFAULT_WINDOW_DAYS = 14;

/** Max allowed --from..--to span, in days. */
export const MAX_WINDOW_SPAN_DAYS = 180;

/** Max allowed years a --from date may sit in the future. */
export const MAX_START_YEARS_OUT = 2;

// ============================================================================
// Errors
// ============================================================================

/** Thrown on any malformed/invalid window input. Callers print + exit non-zero. */
export class WindowValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WindowValidationError";
  }
}

// ============================================================================
// ISO date parsing (strict — YYYY-MM-DD only, real calendar dates only)
// ============================================================================

/**
 * Parse a strict "YYYY-MM-DD" string into calendar parts. Rejects anything
 * that isn't exactly that shape, and rejects dates that don't round-trip
 * through Date.UTC (e.g. "2026-02-30" — February never has 30 days).
 *
 * Exported so other structured-flag parsers (e.g. cli.ts's `--book-by`) reuse
 * the same strict validation instead of re-implementing it.
 */
export function parseIsoDateStrict(s: string): { year: number; month: number; day: number } {
  const trimmed = s.trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
  if (!m) {
    throw new WindowValidationError(
      `Malformed date "${s}" — expected YYYY-MM-DD (e.g. 2026-07-06).`
    );
  }
  const year = parseInt(m[1]!, 10);
  const month = parseInt(m[2]!, 10);
  const day = parseInt(m[3]!, 10);

  const roundTrip = new Date(Date.UTC(year, month - 1, day));
  if (
    roundTrip.getUTCFullYear() !== year ||
    roundTrip.getUTCMonth() !== month - 1 ||
    roundTrip.getUTCDate() !== day
  ) {
    throw new WindowValidationError(
      `Malformed date "${s}" — not a real calendar date.`
    );
  }
  return { year, month, day };
}

// ============================================================================
// buildExplicitWindow
// ============================================================================

/**
 * Build + validate a { start, end } window from explicit YYYY-MM-DD strings.
 *
 * start = LA midnight of `fromStr`; end = LA 23:59:59 of `toStr` — both
 * DST-correct (laDateIso computes the true PDT/PST offset for that specific
 * calendar date, not a fixed offset).
 *
 * @throws WindowValidationError on malformed input, inverted range, an
 *         oversized span, or a start date too far in the future.
 */
export function buildExplicitWindow(
  fromStr: string,
  toStr: string,
  now: Date = new Date()
): { start: string; end: string } {
  const from = parseIsoDateStrict(fromStr);
  const to = parseIsoDateStrict(toStr);

  const start = laDateIso(from.year, from.month, from.day, 0, 0, 0);
  const end = laDateIso(to.year, to.month, to.day, 23, 59, 59);

  const startMs = new Date(start).getTime();
  const endMs = new Date(end).getTime();

  if (startMs > endMs) {
    throw new WindowValidationError(
      `--from (${fromStr}) is after --to (${toStr}) — the window is inverted.`
    );
  }

  const spanDays = (endMs - startMs) / 86_400_000;
  if (spanDays > MAX_WINDOW_SPAN_DAYS) {
    throw new WindowValidationError(
      `Window span (${Math.ceil(spanDays)}d, ${fromStr} → ${toStr}) exceeds the ` +
        `${MAX_WINDOW_SPAN_DAYS}d max — narrow --from/--to.`
    );
  }

  const nowParts = utcMsToLaParts(now.getTime());
  const maxStartMs = new Date(
    laDateIso(nowParts.year + MAX_START_YEARS_OUT, nowParts.month, nowParts.day, 0, 0, 0)
  ).getTime();
  if (startMs > maxStartMs) {
    throw new WindowValidationError(
      `--from (${fromStr}) is more than ${MAX_START_YEARS_OUT} years out — check the date.`
    );
  }

  return { start, end };
}

// ============================================================================
// buildDefaultWindow
// ============================================================================

/**
 * Build the default window: today (LA midnight) → today + DEFAULT_WINDOW_DAYS
 * (LA 23:59:59). Used when neither --from nor --to is given.
 *
 * @returns { window, toLabel } — toLabel is the YYYY-MM-DD end date, for the
 *          CLI's "defaulting to the next 14 days (today → YYYY-MM-DD)" banner.
 */
export function buildDefaultWindow(now: Date = new Date()): {
  window: { start: string; end: string };
  toLabel: string;
} {
  const { year, month, day } = utcMsToLaParts(now.getTime());
  const start = laDateIso(year, month, day, 0, 0, 0);

  // Day arithmetic via UTC calendar math (DST-safe: we only need the target
  // calendar date, and laDateIso independently computes that date's true
  // LA offset — it never inherits an offset from `start`).
  const endDate = new Date(Date.UTC(year, month - 1, day + DEFAULT_WINDOW_DAYS));
  const endYear = endDate.getUTCFullYear();
  const endMonth = endDate.getUTCMonth() + 1;
  const endDay = endDate.getUTCDate();

  const end = laDateIso(endYear, endMonth, endDay, 23, 59, 59);
  const toLabel = `${String(endYear).padStart(4, "0")}-${String(endMonth).padStart(2, "0")}-${String(endDay).padStart(2, "0")}`;

  return { window: { start, end }, toLabel };
}
