#!/usr/bin/env bun
/**
 * queryflags.test.ts — TDD tests for cli.ts's buildQueryContext (markdown-first
 * de-determinization, 2026-07).
 *
 * Root cause being guarded: the old NL date resolver silently
 * collapsed "Monday through Thursday" and "July 6 to July 9" to a SINGLE DAY
 * via partial regex matches — confidently wrong, zero warning. buildQueryContext
 * replaces ALL of that with explicit --from/--to flags + LOUD validation: any
 * malformed input is a thrown QueryFlagError (the CLI turns that into a
 * non-zero exit), never a silent best-guess.
 *
 * Tests:
 *   1.  Flag parsing: --free sets context.free=true.
 *   2.  Flag parsing: --max-price 30 sets context.maxPrice=30.
 *   3.  Flag parsing: repeated --category collects ALL values (not just the last).
 *   4.  Flag parsing: repeated --time-of-day collects ALL values.
 *   5.  Flag parsing: invalid --category throws QueryFlagError.
 *   6.  Flag parsing: invalid --time-of-day throws QueryFlagError.
 *   7.  Flag parsing: invalid --max-price (negative/NaN) throws QueryFlagError.
 *   8.  Flag parsing: --refresh sets refresh=true; absent → false.
 *   9.  Flag parsing: empty query text throws QueryFlagError.
 *  10.  Validation: malformed --from (not YYYY-MM-DD) throws QueryFlagError.
 *  11.  Validation: malformed --from (invalid calendar date, e.g. Feb 30) throws.
 *  12.  Validation: --from without --to (and vice versa) throws QueryFlagError.
 *  13.  Validation: inverted window (--from after --to) throws QueryFlagError.
 *  14.  Validation: window span > 180 days throws QueryFlagError.
 *  15.  Validation: --from more than 2 years out throws QueryFlagError.
 *  16.  Default window: no --from/--to → next 14 days + banner is set.
 *  17.  Default window: with --from/--to → banner is null.
 *  18.  Window boundary attachment: --from/--to → LA midnight start, 23:59:59 end.
 *  19.  Window boundary attachment: DST transition (2026-03-08 spring-forward) —
 *       start offset -08:00 (PST, before), end offset -07:00 (PDT, after).
 *  20.  THE REGRESSION CASE: explicit 4-day window (Mon–Thu equivalent,
 *       2026-07-06 → 2026-07-09) resolves to the FULL 4-day span, not 1 day.
 *  21.  home/radiusMiles pass through from the caller-supplied defaults.
 *
 * Run:
 *   bun test skills/Productivity/EventScout/tests/queryflags.test.ts  (absolute path)
 */

import { test } from "bun:test";
import { buildQueryContext, QueryFlagError } from "../cli.ts";

// ============================================================================
// Test harness — helpers THROW on failure so bun:test marks the test failed.
// ============================================================================

function assert(condition: boolean, message: string, detail?: string): void {
  if (!condition) {
    throw new Error(`${message}${detail ? ` — ${detail}` : ""}`);
  }
}

function assertThrows(fn: () => void, message: string, errType: unknown = QueryFlagError): void {
  let threw = false;
  try {
    fn();
  } catch (err) {
    threw = true;
    if (errType && !(err instanceof (errType as new (...a: unknown[]) => Error))) {
      throw new Error(`${message} — threw wrong type: ${(err as Error).constructor.name}`);
    }
  }
  if (!threw) {
    throw new Error(`${message} — did not throw`);
  }
}

// ============================================================================
// Fixed reference time: Friday 2026-07-03 noon LA local
// PDT = UTC-7, so 2026-07-03T12:00:00-07:00 = 2026-07-03T19:00:00Z
// ============================================================================

const NOW = new Date("2026-07-03T19:00:00Z");
const HOME = { lat: 32.7157, lng: -117.1611 };

test("1. --free sets context.free=true", () => {
  const built = buildQueryContext(["free", "stuff", "--free"], NOW, HOME, 15);
  assert(built.context.free === true, "1. --free sets context.free=true");
});

test("2. --max-price 30 sets context.maxPrice=30", () => {
  const built = buildQueryContext(["cheap", "stuff", "--max-price", "30"], NOW, HOME, 15);
  assert(built.context.maxPrice === 30, "2. --max-price 30 sets context.maxPrice=30");
});

test("3. repeated --category collects ALL values", () => {
  const built = buildQueryContext(
    ["shows", "--category", "comedy", "--category", "music"],
    NOW,
    HOME,
    15
  );
  assert(
    JSON.stringify(built.context.categories) === JSON.stringify(["comedy", "music"]),
    "3. repeated --category collects ALL values",
    `got: ${JSON.stringify(built.context.categories)}`
  );
});

test("4. repeated --time-of-day collects ALL values", () => {
  const built = buildQueryContext(
    ["shows", "--time-of-day", "morning", "--time-of-day", "evening"],
    NOW,
    HOME,
    15
  );
  assert(
    JSON.stringify(built.context.timeOfDay) === JSON.stringify(["morning", "evening"]),
    "4. repeated --time-of-day collects ALL values",
    `got: ${JSON.stringify(built.context.timeOfDay)}`
  );
});

test("5. invalid --category throws QueryFlagError", () => {
  assertThrows(
    () => buildQueryContext(["shows", "--category", "concerts"], NOW, HOME, 15),
    "5. invalid --category throws QueryFlagError"
  );
});

test("6. invalid --time-of-day throws QueryFlagError", () => {
  assertThrows(
    () => buildQueryContext(["shows", "--time-of-day", "midnight"], NOW, HOME, 15),
    "6. invalid --time-of-day throws QueryFlagError"
  );
});

test("7. invalid --max-price (negative/NaN) throws QueryFlagError", () => {
  assertThrows(
    () => buildQueryContext(["shows", "--max-price", "-5"], NOW, HOME, 15),
    "7a. negative --max-price throws QueryFlagError"
  );
  assertThrows(
    () => buildQueryContext(["shows", "--max-price", "notanumber"], NOW, HOME, 15),
    "7b. NaN --max-price throws QueryFlagError"
  );
});

test("8. --refresh sets refresh=true; absent → false", () => {
  const withRefresh = buildQueryContext(["latest", "shows", "--refresh"], NOW, HOME, 15);
  assert(withRefresh.refresh === true, "8a. --refresh sets refresh=true");
  const withoutRefresh = buildQueryContext(["shows"], NOW, HOME, 15);
  assert(withoutRefresh.refresh === false, "8b. no --refresh → refresh=false");
});

test("9. empty query text throws QueryFlagError", () => {
  assertThrows(
    () => buildQueryContext(["--refresh"], NOW, HOME, 15),
    "9. empty query text throws QueryFlagError"
  );
});

test("10. malformed --from (wrong shape) throws QueryFlagError", () => {
  assertThrows(
    () => buildQueryContext(["x", "--from", "07-06-2026", "--to", "07-09-2026"], NOW, HOME, 15),
    "10. malformed --from (wrong shape) throws QueryFlagError"
  );
});

test("11. invalid calendar date (Feb 30) throws QueryFlagError", () => {
  assertThrows(
    () => buildQueryContext(["x", "--from", "2026-02-30", "--to", "2026-03-01"], NOW, HOME, 15),
    "11. invalid calendar date (Feb 30) throws QueryFlagError"
  );
});

test("12. --from without --to (and vice versa) throws QueryFlagError", () => {
  assertThrows(
    () => buildQueryContext(["x", "--from", "2026-07-06"], NOW, HOME, 15),
    "12a. --from without --to throws QueryFlagError"
  );
  assertThrows(
    () => buildQueryContext(["x", "--to", "2026-07-09"], NOW, HOME, 15),
    "12b. --to without --from throws QueryFlagError"
  );
});

test("13. inverted window (--from after --to) throws QueryFlagError", () => {
  assertThrows(
    () => buildQueryContext(["x", "--from", "2026-07-09", "--to", "2026-07-06"], NOW, HOME, 15),
    "13. inverted window (--from after --to) throws QueryFlagError"
  );
});

test("14. window span > 180 days throws QueryFlagError", () => {
  assertThrows(
    () => buildQueryContext(["x", "--from", "2026-01-01", "--to", "2026-12-31"], NOW, HOME, 15),
    "14. window span > 180 days throws QueryFlagError"
  );
});

test("15. --from more than 2 years out throws QueryFlagError", () => {
  assertThrows(
    () => buildQueryContext(["x", "--from", "2029-07-06", "--to", "2029-07-09"], NOW, HOME, 15),
    "15. --from more than 2 years out throws QueryFlagError"
  );
});

test("16. default window: no --from/--to → next 14 days + banner is set", () => {
  const built = buildQueryContext(["comedy"], NOW, HOME, 15);
  assert(built.banner !== null, "16a. default window sets a non-null banner");
  assert(
    !!built.banner && built.banner.includes("next 14 days"),
    "16b. banner mentions 'next 14 days'",
    `got: ${built.banner}`
  );
  assert(
    built.context.window.start.startsWith("2026-07-03"),
    "16c. default window start is today (2026-07-03)",
    `got: ${built.context.window.start}`
  );
  assert(
    built.context.window.end.startsWith("2026-07-17"),
    "16d. default window end is +14d (2026-07-17)",
    `got: ${built.context.window.end}`
  );
});

test("17. explicit --from/--to → banner is null", () => {
  const built = buildQueryContext(
    ["comedy", "--from", "2026-07-06", "--to", "2026-07-09"],
    NOW,
    HOME,
    15
  );
  assert(built.banner === null, "17. explicit --from/--to → banner is null");
});

test("18. window boundary attachment: LA midnight start, 23:59:59 end", () => {
  const built = buildQueryContext(
    ["comedy", "--from", "2026-07-06", "--to", "2026-07-09"],
    NOW,
    HOME,
    15
  );
  assert(
    built.context.window.start === "2026-07-06T00:00:00-07:00",
    "18a. window.start is LA midnight of --from",
    `got: ${built.context.window.start}`
  );
  assert(
    built.context.window.end === "2026-07-09T23:59:59-07:00",
    "18b. window.end is LA 23:59:59 of --to",
    `got: ${built.context.window.end}`
  );
});

test("19. DST transition: start PST -08:00, end PDT -07:00", () => {
  // 2026 DST spring-forward is Sunday March 8, 2026 (2nd Sunday in March).
  // 2026-03-07 is PST (-08:00); 2026-03-09 is PDT (-07:00).
  const built = buildQueryContext(
    ["x", "--from", "2026-03-07", "--to", "2026-03-09"],
    NOW,
    HOME,
    15
  );
  assert(
    built.context.window.start === "2026-03-07T00:00:00-08:00",
    "19a. DST: start (before transition) uses PST offset -08:00",
    `got: ${built.context.window.start}`
  );
  assert(
    built.context.window.end === "2026-03-09T23:59:59-07:00",
    "19b. DST: end (after transition) uses PDT offset -07:00",
    `got: ${built.context.window.end}`
  );
});

test("20. REGRESSION: explicit 4-day window spans ~4 days, not 1", () => {
  // "Monday through Thursday" said on Friday 2026-07-03 → the agent resolves
  // this to --from 2026-07-06 --to 2026-07-09 (per SKILL.md). This must
  // produce the FULL 4-day window, not collapse to a single day like the old
  // NL date resolver's regex cascade did.
  const built = buildQueryContext(
    ["dating", "events", "--from", "2026-07-06", "--to", "2026-07-09"],
    NOW,
    HOME,
    15
  );
  const spanDays =
    (new Date(built.context.window.end).getTime() - new Date(built.context.window.start).getTime()) /
    86_400_000;
  assert(
    spanDays > 3.9 && spanDays < 4.1,
    "20. REGRESSION: explicit 4-day window spans ~4 days, not 1",
    `got span: ${spanDays.toFixed(2)} days (start=${built.context.window.start}, end=${built.context.window.end})`
  );
});

test("21. home/radiusMiles pass through from the caller", () => {
  const customHome = { lat: 1, lng: 2 };
  const built = buildQueryContext(["shows"], NOW, customHome, 42);
  assert(
    JSON.stringify(built.context.home) === JSON.stringify(customHome),
    "21a. home passes through from caller"
  );
  assert(built.context.radiusMiles === 42, "21b. radiusMiles passes through from caller");
});
