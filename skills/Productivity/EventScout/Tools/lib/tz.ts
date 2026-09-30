/**
 * tz.ts — Shared timezone utilities for EventScout adapters.
 *
 * Single source of truth for America/Los_Angeles datetime conversion.
 * Used by PadresAdapter (UTC → LA ISO) and SPAAdapter (naive → LA ISO).
 */

// ============================================================================
// UTC ISO → America/Los_Angeles offset-aware ISO 8601
//
// Given a UTC ISO string (e.g. "2026-06-15T19:40:00Z"), returns an
// offset-aware ISO 8601 string in America/Los_Angeles wall-clock time,
// e.g. "2026-06-15T12:40:00-07:00" (during PDT).
//
// Uses Intl.DateTimeFormat.formatToParts to retrieve the LA wall-clock
// components, then recomputes the UTC offset for that instant.
// ============================================================================

export function utcIsoToLaIso(utcIso: string): string {
  const utcDate = new Date(utcIso);

  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(utcDate);

  const p = Object.fromEntries(parts.map((x) => [x.type, x.value]));

  // Compute the UTC offset for this specific instant in LA time by constructing
  // a fake "UTC" Date from the local wall-clock parts and diffing against the
  // true UTC timestamp.
  const localMs = Date.UTC(
    parseInt(p["year"]!, 10),
    parseInt(p["month"]!, 10) - 1,
    parseInt(p["day"]!, 10),
    parseInt(p["hour"]!, 10),
    parseInt(p["minute"]!, 10),
    parseInt(p["second"]!, 10),
  );

  const offsetMinutes = (localMs - utcDate.getTime()) / 60_000;
  const offsetSign = offsetMinutes >= 0 ? "+" : "-";
  const absMinutes = Math.abs(Math.round(offsetMinutes));
  const offsetH = String(Math.floor(absMinutes / 60)).padStart(2, "0");
  const offsetM = String(absMinutes % 60).padStart(2, "0");

  // Normalise hour=24 edge case that some Intl engines emit
  const hour = parseInt(p["hour"]!, 10) === 24 ? 0 : parseInt(p["hour"]!, 10);
  const hourStr = String(hour).padStart(2, "0");

  return (
    `${p["year"]!}-${p["month"]!}-${p["day"]!}` +
    `T${hourStr}:${p["minute"]!}:${p["second"]!}` +
    `${offsetSign}${offsetH}:${offsetM}`
  );
}

// ============================================================================
// Naive datetime string → UTC milliseconds treating input as LA local time.
//
// "Naive" means no trailing Z and no ±HH:MM offset in the string.
// Detects naive by checking for absence of Z suffix and ±offset.
//
// Returns the equivalent UTC timestamp in ms, or NaN if the input cannot
// be parsed as a datetime.
//
// Strategy:
//   1. Parse the local wall-clock components using Intl.DateTimeFormat by
//      temporarily finding what UTC instant corresponds to the naive local time.
//      We do this by a binary search / Newton's method equivalent:
//      treat the naive string as if it were UTC, compute what LA wall-clock
//      that maps to, measure the delta, and apply the inverse offset.
//   2. Because DST transitions are non-linear, we iterate once more to handle
//      the rare case where the initial offset guess lands in a DST boundary.
// ============================================================================

/**
 * Return true iff the string has no timezone designator (no trailing Z,
 * no ±HH:MM, no ±HHMM, no standalone ±HH after the time component).
 *
 * Key subtlety: a date-only string like "2026-06-05" ends in digits that look
 * like an offset ("-05") but are actually the day component. We guard against
 * this by requiring the offset to follow a time component (must contain "T").
 */
export function isNaiveDatetime(s: string): boolean {
  const trimmed = s.trim();
  // Has Z suffix → UTC-aware
  if (/Z$/i.test(trimmed)) return false;
  // Offset suffixes only apply if a time component is present (contains "T")
  if (trimmed.includes("T")) {
    // Has ±HH:MM or ±HHMM offset suffix → aware
    if (/[+-]\d{2}:\d{2}$/.test(trimmed)) return false;
    if (/[+-]\d{4}$/.test(trimmed)) return false;
    // Has ±HH offset suffix (e.g. +05, -07) after a time part → aware
    if (/T\d{2}:\d{2}(:\d{2})?[+-]\d{2}$/.test(trimmed)) return false;
  }
  return true;
}

/**
 * Parse a naive datetime string treating it as America/Los_Angeles local time.
 * Returns the UTC milliseconds, or NaN on failure.
 *
 * Algorithm:
 *   Step 1 — Parse the naive string as UTC to get a candidate UTC ms.
 *   Step 2 — Map that candidate to LA wall-clock via Intl.DateTimeFormat.
 *   Step 3 — Compute the offset: offsetMs = utcMs - laMs (where laMs is the
 *             LA wall-clock components treated as a UTC epoch).
 *   Step 4 — Adjust: trueUtcMs = naiveMs + offsetMs (signs cancel correctly).
 *   Step 5 — One-shot refinement: recompute offset at trueUtcMs in case the
 *             first estimate crosses a DST boundary.
 *
 * This is the standard "fake-UTC + offset iteration" technique.
 */
export function naiveLaToUtcMs(naive: string): number {
  // Date-only strings ("YYYY-MM-DD"): expand to midnight before processing.
  // Date.parse("2026-06-05Z") is invalid in most engines; normalise to
  // "2026-06-05T00:00:00" first so that appending "Z" gives a valid UTC parse.
  const normalised = /^\d{4}-\d{2}-\d{2}$/.test(naive.trim())
    ? `${naive.trim()}T00:00:00`
    : naive;

  // Step 1: parse as UTC to get a starting candidate
  const naiveAsUtcMs = Date.parse(normalised + "Z");
  if (isNaN(naiveAsUtcMs)) return NaN;

  // Helper: given a UTC ms value, return the offset (in ms) at that instant
  // for America/Los_Angeles. offsetMs = localWallMs - utcMs.
  function laOffsetMs(utcMs: number): number {
    const d = new Date(utcMs);
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Los_Angeles",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    }).formatToParts(d);
    const p = Object.fromEntries(parts.map((x) => [x.type, x.value]));
    const localMs = Date.UTC(
      parseInt(p["year"]!, 10),
      parseInt(p["month"]!, 10) - 1,
      parseInt(p["day"]!, 10),
      parseInt(p["hour"]!, 10),
      parseInt(p["minute"]!, 10),
      parseInt(p["second"]!, 10),
    );
    return localMs - utcMs; // positive when LA is behind UTC (normal case)
  }

  // Step 2–4: first estimate
  // naiveAsUtcMs is the naive time string parsed as if UTC.
  // We want the UTC instant where LA wall-clock === naive wall-clock.
  // offset = laWall - utc  →  utc = naiveWall - offset
  // But the offset depends on utc — bootstrap from naiveAsUtcMs.
  const offset1Ms = laOffsetMs(naiveAsUtcMs);
  // trueUtc ≈ naive_wall_as_utc - offset
  // offset is negative (LA is behind UTC), so subtracting a negative = adding
  const candidate = naiveAsUtcMs - offset1Ms;

  // Step 5: one-shot refinement — recompute offset at the candidate
  const offset2Ms = laOffsetMs(candidate);
  const refined = naiveAsUtcMs - offset2Ms;

  return refined;
}

/**
 * Construct an offset-aware ISO 8601 string for the given LA calendar
 * date+time, computing the correct PDT/PST offset for that instant.
 *
 * Extracted from ConstraintParser.ts (markdown-first de-determinization,
 * 2026-07) so the query-window builder (Tools/Window.ts) has a single source
 * of truth for "give me an LA wall-clock instant as an ISO string" — no
 * reimplementation, no drift between callers.
 */
export function laDateIso(
  year: number,
  month: number, // 1-based
  day: number,
  hour: number = 0,
  minute: number = 0,
  second: number = 0
): string {
  // Strategy: construct the naive datetime as UTC, then find the LA offset
  // at that approximate moment, then reconstruct.
  const naiveUtcMs = Date.UTC(year, month - 1, day, hour, minute, second);
  const d = new Date(naiveUtcMs);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(d);
  const p = Object.fromEntries(parts.map((x) => [x.type, x.value]));
  const localMs = Date.UTC(
    parseInt(p["year"]!, 10),
    parseInt(p["month"]!, 10) - 1,
    parseInt(p["day"]!, 10),
    parseInt(p["hour"]!, 10),
    parseInt(p["minute"]!, 10),
    parseInt(p["second"]!, 10)
  );
  const offsetMinutes = (localMs - naiveUtcMs) / 60_000;
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const absMin = Math.abs(Math.round(offsetMinutes));
  const offH = String(Math.floor(absMin / 60)).padStart(2, "0");
  const offM = String(absMin % 60).padStart(2, "0");

  return (
    `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}` +
    `T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:${String(second).padStart(2, "0")}` +
    `${sign}${offH}:${offM}`
  );
}

/**
 * Given a UTC ms value, produce the LA wall-clock components.
 * Returns an object with the LA date/time fields.
 */
export function utcMsToLaParts(utcMs: number): {
  year: number;
  month: number; // 1-based
  day: number;
  hour: number;
  minute: number;
  second: number;
} {
  const d = new Date(utcMs);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(d);
  const p = Object.fromEntries(parts.map((x) => [x.type, x.value]));
  const hour = parseInt(p["hour"]!, 10);
  return {
    year: parseInt(p["year"]!, 10),
    month: parseInt(p["month"]!, 10),
    day: parseInt(p["day"]!, 10),
    hour: hour === 24 ? 0 : hour,
    minute: parseInt(p["minute"]!, 10),
    second: parseInt(p["second"]!, 10),
  };
}
