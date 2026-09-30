#!/usr/bin/env bun
/**
 * filter.test.ts — Slice 6 TDD tests for Filter.ts (deterministic, no network).
 * Re-intake (2026-07): QueryContext replaces ConstraintSet as the input shape;
 * assertions are otherwise unchanged from the original Slice 6 test suite.
 *
 * Tests:
 *   1.  Date window: in-range event included, out-of-range excluded.
 *   2.  Haversine radius: ~2mi event included at 5mi, excluded at 1mi.
 *   3.  Null-coords excluded when radius active; included when no location.
 *   3b. Category filter: absent → no filter (soft signal, handled by the
 *       agent/Ranker, not Filter.ts); present → hard filter (see test 7).
 *   4.  Price free: only isFree===true kept.
 *   5.  Price under: isFree OR priceMin≤maxUsd kept.
 *   6.  Price any: all kept regardless of price.
 *   7.  Category filter: only matching categories kept.
 *   8.  TimeOfDay banding: evening keeps 7pm event, excludes 10am event.
 *   9.  Multiple timeOfDay bands: morning+evening returns from both.
 *   10. Result sorted by startDatetime ascending.
 *   11. No constraints → all events returned (except expired not in scope here).
 *   12. Empty events → empty result.
 *
 * Run:
 *   bun test ~/.claude/.claude/worktrees/arch-debt-d2-eventscout-buntest/skills/Productivity/EventScout/tests/filter.test.ts
 */

import { test } from "bun:test";
import { filterEvents } from "../Tools/Filter.ts";
import type { EventItem, QueryContext } from "../Tools/types.ts";

// ============================================================================
// Test harness
// ============================================================================

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

function assertEq<T>(actual: T, expected: T, message: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `${message} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`
    );
  }
}

// ============================================================================
// Fixture helpers
// ============================================================================

/** Build a minimal valid EventItem with overrides. */
function makeEvent(overrides: Partial<EventItem> & { id: string; startDatetime: string }): EventItem {
  return {
    title: `Event ${overrides.id}`,
    allDay: false,
    category: "other",
    tags: [],
    isFree: false,
    sourceUrl: "https://example.com",
    sources: [{ sourceId: "test", url: "https://example.com" }],
    fetchedAt: "2026-05-31T00:00:00Z",
    status: "scheduled",
    ...overrides,
  };
}

// ============================================================================
// Fixed reference points
//
// Central San Diego (home default): 32.7157, -117.1611
// Petco Park (Padres home): 32.7071874, -117.156913  → ~0.58 mi from home
// Comedy Store La Jolla: 32.8404492, -117.2732938    → ~9.4 mi from home
//
// ~2mi from home (32.7157, -117.1611): roughly 32.7338, -117.1611 (0.0181° lat ≈ 1.24mi)
// Use 32.7450, -117.1611 → lat diff = 0.0293° = ~2.02 mi, lng diff = 0
// ============================================================================

const HOME = { lat: 32.7157, lng: -117.1611 };
// ~2.0 miles north of home
const NEARBY_LAT = 32.7450;
const NEARBY_LNG = -117.1611;
// Comedy Store La Jolla (~9.4 miles)
const FAR_LAT = 32.8404;
const FAR_LNG = -117.2733;

// A fixed 7-day window
const WINDOW_START = "2026-06-01T00:00:00-07:00";
const WINDOW_END   = "2026-06-07T23:59:59-07:00";

/** A wide-open window covering every fixture date used below — QueryContext.window
 *  is mandatory (never undefined), so tests that don't care about date filtering
 *  pass this instead of omitting the field. */
const WINDOW_ALL = { start: "2000-01-01T00:00:00-08:00", end: "2100-01-01T23:59:59-08:00" };

/** QueryContext.home/radiusMiles are mandatory too; Infinity == "no radius filter
 *  active" (mirrors the old ConstraintSet-omitted-near behavior for coordless
 *  fixtures, and mathematically never excludes a coordful one either). */
const NO_RADIUS = Infinity;

// ============================================================================
// Test 1 — Date window: in-range vs out-of-range
// ============================================================================

console.log("\nFilter Tests — Slice 6\n");

test("1. Date window: in-range included, out-of-range excluded", () => {
  const inRange = makeEvent({ id: "in", startDatetime: "2026-06-05T19:00:00-07:00" });
  const outBefore = makeEvent({ id: "out-before", startDatetime: "2026-05-30T19:00:00-07:00" });
  const outAfter = makeEvent({ id: "out-after", startDatetime: "2026-06-10T19:00:00-07:00" });

  const c: QueryContext = {
    window: { start: WINDOW_START, end: WINDOW_END },
    home: HOME,
    radiusMiles: NO_RADIUS,
    rawQuery: "test",
  };

  const result = filterEvents([inRange, outBefore, outAfter], c);
  assertEq(result.length, 1, "Only 1 in-range event returned");
  assert(result[0].id === "in", "Correct in-range event");
});

// ============================================================================
// Test 2 — Haversine radius: ~2mi included at 5mi, excluded at 1mi
// ============================================================================

test("2. Haversine: ~2mi event included at r=5, excluded at r=1", () => {
  const nearEvent = makeEvent({
    id: "near",
    startDatetime: "2026-06-05T19:00:00-07:00",
    lat: NEARBY_LAT,
    lng: NEARBY_LNG,
  });

  const c5: QueryContext = { window: WINDOW_ALL, home: HOME, radiusMiles: 5, rawQuery: "test" };
  const c1: QueryContext = { window: WINDOW_ALL, home: HOME, radiusMiles: 1, rawQuery: "test" };

  const resultAt5 = filterEvents([nearEvent], c5);
  assert(resultAt5.length === 1, "Included at radius 5 miles");

  const resultAt1 = filterEvents([nearEvent], c1);
  assert(resultAt1.length === 0, "Excluded at radius 1 mile");
});

// ============================================================================
// Test 3 — Null-coords: KEPT even when a radius is active (unknown locality is
// a soft ranker penalty, not a hard gate). Coordful far events still excluded.
// ============================================================================

test("3. Null-coords kept with radius; coordful far event still excluded", () => {
  const nullCoordEvent = makeEvent({
    id: "null-coord",
    startDatetime: "2026-06-05T19:00:00-07:00",
    // no lat/lng
  });
  // ~far event WITH coords (Los Angeles, ~120mi from SD home) → still excluded
  const farCoordEvent = makeEvent({
    id: "far-coord",
    startDatetime: "2026-06-05T19:00:00-07:00",
    lat: 34.0522,
    lng: -118.2437,
  });

  const withRadius: QueryContext = { window: WINDOW_ALL, home: HOME, radiusMiles: 50, rawQuery: "test" };
  const withoutRadius: QueryContext = { window: WINDOW_ALL, home: HOME, radiusMiles: NO_RADIUS, rawQuery: "test" };

  const resultWith = filterEvents([nullCoordEvent, farCoordEvent], withRadius);
  assert(resultWith.some((e) => e.id === "null-coord"), "Null-coord KEPT when radius active");
  assert(!resultWith.some((e) => e.id === "far-coord"), "Coordful far event still excluded");

  const resultWithout = filterEvents([nullCoordEvent], withoutRadius);
  assert(resultWithout.length === 1, "Null-coord included when no location constraint");
});

// ============================================================================
// Test 3b — Category: absent → no filter (soft signal, owned by the calling
// agent/Ranker.ts now — it simply doesn't pass --category for a vibe/goal
// query); present → hard filter (covered fully by test 7).
// ============================================================================

test("3b. Category absent → no filtering; category present hard-filters", () => {
  const community = makeEvent({ id: "comm", startDatetime: "2026-06-05T19:00:00-07:00", category: "community" });
  const music = makeEvent({ id: "mus", startDatetime: "2026-06-05T19:00:00-07:00", category: "music" });

  // No --category flag at all → both kept (soft ranking signal only, handled
  // by Ranker.ts's semantic scoring, not a Filter.ts hard gate).
  const noFilter: QueryContext = { window: WINDOW_ALL, home: HOME, radiusMiles: NO_RADIUS, rawQuery: "meet people" };
  const noFilterResult = filterEvents([community, music], noFilter);
  assert(noFilterResult.length === 2, "Category omitted keeps cross-category events");

  // --category passed → hard filter to that category (the agent only passes
  // this when the user named the category directly).
  const explicit: QueryContext = {
    categories: ["community"],
    window: WINDOW_ALL,
    home: HOME,
    radiusMiles: NO_RADIUS,
    rawQuery: "community events",
  };
  const explicitResult = filterEvents([community, music], explicit);
  assert(explicitResult.length === 1 && explicitResult[0]!.id === "comm", "Category present hard-filters");
});

// ============================================================================
// Test 4 — Price free
// ============================================================================

test("4. Price free: only isFree===true kept", () => {
  const free = makeEvent({ id: "free", startDatetime: "2026-06-05T19:00:00-07:00", isFree: true });
  const paid = makeEvent({
    id: "paid",
    startDatetime: "2026-06-05T20:00:00-07:00",
    isFree: false,
    priceMin: 20,
    priceMax: 40,
  });

  const c: QueryContext = { window: WINDOW_ALL, home: HOME, radiusMiles: NO_RADIUS, free: true, rawQuery: "test" };

  const result = filterEvents([free, paid], c);
  assertEq(result.length, 1, "Only 1 free event");
  assert(result[0].id === "free", "Correct free event");
});

// ============================================================================
// Test 5 — Price under: isFree OR priceMin≤maxUsd
// ============================================================================

test("5. Price under: isFree or priceMin≤maxUsd", () => {
  const free = makeEvent({ id: "free", startDatetime: "2026-06-05T19:00:00-07:00", isFree: true });
  const cheap = makeEvent({
    id: "cheap",
    startDatetime: "2026-06-05T20:00:00-07:00",
    isFree: false,
    priceMin: 15,
    priceMax: 25,
  });
  const expensive = makeEvent({
    id: "expensive",
    startDatetime: "2026-06-05T21:00:00-07:00",
    isFree: false,
    priceMin: 75,
    priceMax: 150,
  });
  const unknownPrice = makeEvent({
    id: "unknown",
    startDatetime: "2026-06-05T22:00:00-07:00",
    isFree: false,
    // no priceMin / priceMax → unknown = excluded (treated as Infinity)
  });

  const c: QueryContext = { window: WINDOW_ALL, home: HOME, radiusMiles: NO_RADIUS, maxPrice: 30, rawQuery: "test" };

  const result = filterEvents([free, cheap, expensive, unknownPrice], c);
  assertEq(result.length, 2, "2 events within budget");
  assert(result.some((e) => e.id === "free"), "free included");
  assert(result.some((e) => e.id === "cheap"), "cheap included");
  assert(!result.some((e) => e.id === "expensive"), "expensive excluded");
  assert(!result.some((e) => e.id === "unknown"), "unknown-price excluded");
});

// ============================================================================
// Test 6 — Price any (neither free nor maxPrice set)
// ============================================================================

test("6. Price any: all events kept regardless of price", () => {
  const free = makeEvent({ id: "free", startDatetime: "2026-06-05T19:00:00-07:00", isFree: true });
  const paid = makeEvent({
    id: "paid",
    startDatetime: "2026-06-05T20:00:00-07:00",
    isFree: false,
    priceMin: 200,
  });

  const c: QueryContext = { window: WINDOW_ALL, home: HOME, radiusMiles: NO_RADIUS, rawQuery: "test" };

  const result = filterEvents([free, paid], c);
  assertEq(result.length, 2, "Both events kept with no price constraint");
});

// ============================================================================
// Test 7 — Category filter
// ============================================================================

test("7. Category filter: only matching categories kept", () => {
  const comedy = makeEvent({
    id: "comedy",
    startDatetime: "2026-06-05T20:00:00-07:00",
    category: "comedy",
  });
  const sports = makeEvent({
    id: "sports",
    startDatetime: "2026-06-05T19:00:00-07:00",
    category: "sports",
  });
  const music = makeEvent({
    id: "music",
    startDatetime: "2026-06-05T21:00:00-07:00",
    category: "music",
  });

  const c: QueryContext = {
    window: WINDOW_ALL,
    home: HOME,
    radiusMiles: NO_RADIUS,
    categories: ["comedy", "music"],
    rawQuery: "test",
  };

  const result = filterEvents([comedy, sports, music], c);
  assertEq(result.length, 2, "2 events from allowed categories");
  assert(result.some((e) => e.id === "comedy"), "comedy included");
  assert(result.some((e) => e.id === "music"), "music included");
  assert(!result.some((e) => e.id === "sports"), "sports excluded");
});

// ============================================================================
// Test 8 — TimeOfDay banding: evening (17-22) keeps 7pm, excludes 10am
// ============================================================================

test("8. TimeOfDay evening: 7pm included, 10am excluded", () => {
  // 7pm LA time = 19:00 LA local
  const eveningEvent = makeEvent({
    id: "evening",
    startDatetime: "2026-06-05T19:00:00-07:00", // 19:00 PDT = evening
  });
  // 10am LA time
  const morningEvent = makeEvent({
    id: "morning",
    startDatetime: "2026-06-05T10:00:00-07:00", // 10:00 PDT = morning
  });

  const c: QueryContext = {
    window: WINDOW_ALL,
    home: HOME,
    radiusMiles: NO_RADIUS,
    timeOfDay: ["evening"],
    rawQuery: "test",
  };

  const result = filterEvents([eveningEvent, morningEvent], c);
  assertEq(result.length, 1, "Only evening event kept");
  assert(result[0].id === "evening", "Correct evening event");
});

// ============================================================================
// Test 9 — Multiple timeOfDay bands: morning+evening returns from both
// ============================================================================

test("9. TimeOfDay morning+evening: both bands included", () => {
  const morningEvent = makeEvent({
    id: "morning",
    startDatetime: "2026-06-05T09:00:00-07:00", // 9am PDT = morning (5-12)
  });
  const afternoonEvent = makeEvent({
    id: "afternoon",
    startDatetime: "2026-06-05T14:00:00-07:00", // 2pm PDT = afternoon (12-17)
  });
  const eveningEvent = makeEvent({
    id: "evening",
    startDatetime: "2026-06-05T20:00:00-07:00", // 8pm PDT = evening (17-22)
  });

  const c: QueryContext = {
    window: WINDOW_ALL,
    home: HOME,
    radiusMiles: NO_RADIUS,
    timeOfDay: ["morning", "evening"],
    rawQuery: "test",
  };

  const result = filterEvents([morningEvent, afternoonEvent, eveningEvent], c);
  assertEq(result.length, 2, "Morning and evening events both included");
  assert(result.some((e) => e.id === "morning"), "morning included");
  assert(result.some((e) => e.id === "evening"), "evening included");
  assert(!result.some((e) => e.id === "afternoon"), "afternoon excluded");
});

// ============================================================================
// Test 10 — Result sorted by startDatetime ascending
// ============================================================================

test("10. Sort: result sorted by startDatetime ascending", () => {
  const c = makeEvent({ id: "c", startDatetime: "2026-06-07T19:00:00-07:00" });
  const a = makeEvent({ id: "a", startDatetime: "2026-06-05T09:00:00-07:00" });
  const b = makeEvent({ id: "b", startDatetime: "2026-06-06T12:00:00-07:00" });

  const ctx: QueryContext = { window: WINDOW_ALL, home: HOME, radiusMiles: NO_RADIUS, rawQuery: "test" };
  const result = filterEvents([c, a, b], ctx);
  assertEq(result.length, 3, "All 3 events returned");
  assertEq(result[0].id, "a", "First: a (earliest)");
  assertEq(result[1].id, "b", "Second: b");
  assertEq(result[2].id, "c", "Third: c (latest)");
});

// ============================================================================
// Test 11 — No constraints: all events returned
// ============================================================================

test("11. No constraints: all events returned", () => {
  const e1 = makeEvent({ id: "e1", startDatetime: "2026-06-05T19:00:00-07:00" });
  const e2 = makeEvent({ id: "e2", startDatetime: "2026-06-06T20:00:00-07:00" });

  const ctx: QueryContext = { window: WINDOW_ALL, home: HOME, radiusMiles: NO_RADIUS, rawQuery: "anything" };
  const result = filterEvents([e1, e2], ctx);
  assertEq(result.length, 2, "Both events returned with no constraints");
});

// ============================================================================
// Test 12 — Empty events: empty result
// ============================================================================

test("12. Empty events array: returns empty result", () => {
  const ctx: QueryContext = { window: WINDOW_ALL, home: HOME, radiusMiles: NO_RADIUS, rawQuery: "test" };
  const result = filterEvents([], ctx);
  assertEq(result.length, 0, "Empty result for empty input");
});

// ============================================================================
// Test 13 — Combined: date + free + category + near
// ============================================================================

test("13. Combined filters: date+free+category+near all active", () => {
  // Should pass: in window, free, comedy, nearby
  const match = makeEvent({
    id: "match",
    startDatetime: "2026-06-05T20:00:00-07:00",
    isFree: true,
    category: "comedy",
    lat: NEARBY_LAT,
    lng: NEARBY_LNG,
  });
  // Fails date
  const wrongDate = makeEvent({
    id: "wrong-date",
    startDatetime: "2026-06-15T20:00:00-07:00",
    isFree: true,
    category: "comedy",
    lat: NEARBY_LAT,
    lng: NEARBY_LNG,
  });
  // Fails price
  const wrongPrice = makeEvent({
    id: "wrong-price",
    startDatetime: "2026-06-05T20:00:00-07:00",
    isFree: false,
    priceMin: 50,
    category: "comedy",
    lat: NEARBY_LAT,
    lng: NEARBY_LNG,
  });
  // Fails category
  const wrongCat = makeEvent({
    id: "wrong-cat",
    startDatetime: "2026-06-05T20:00:00-07:00",
    isFree: true,
    category: "sports",
    lat: NEARBY_LAT,
    lng: NEARBY_LNG,
  });
  // Fails location (far away)
  const farAway = makeEvent({
    id: "far",
    startDatetime: "2026-06-05T20:00:00-07:00",
    isFree: true,
    category: "comedy",
    lat: FAR_LAT,
    lng: FAR_LNG,
  });

  const c: QueryContext = {
    window: { start: WINDOW_START, end: WINDOW_END },
    free: true,
    categories: ["comedy"],
    home: HOME,
    radiusMiles: 5,
    rawQuery: "test",
  };

  const result = filterEvents([match, wrongDate, wrongPrice, wrongCat, farAway], c);
  assertEq(result.length, 1, "Only the matching event passes all filters");
  assert(result[0].id === "match", "Correct match");
});

// ============================================================================
// Test 14 — TimeOfDay late band: midnight event (hour 0 = late)
// ============================================================================

test("14. TimeOfDay late band: midnight event (00:00 LA) is 'late'", () => {
  // late = hours 22-5; 00:00 (midnight) = hour 0 → qualifies as late
  const lateEvent = makeEvent({
    id: "late",
    startDatetime: "2026-06-06T00:00:00-07:00", // midnight PDT
  });
  const eveningEvent = makeEvent({
    id: "evening",
    startDatetime: "2026-06-06T21:00:00-07:00", // 9pm PDT = evening
  });

  const c: QueryContext = {
    window: WINDOW_ALL,
    home: HOME,
    radiusMiles: NO_RADIUS,
    timeOfDay: ["late"],
    rawQuery: "test",
  };

  const result = filterEvents([lateEvent, eveningEvent], c);
  assertEq(result.length, 1, "Only late event kept");
  assert(result[0].id === "late", "Correct late event");
});

// ============================================================================
// Test 15 — Radius far event: ~9mi event excluded at radius=5, included at 15
// ============================================================================

test("15. Far event (~9mi): excluded at r=5, included at r=15", () => {
  const farEvent = makeEvent({
    id: "far",
    startDatetime: "2026-06-05T20:00:00-07:00",
    lat: FAR_LAT,
    lng: FAR_LNG,
  });

  const c5: QueryContext = { window: WINDOW_ALL, home: HOME, radiusMiles: 5, rawQuery: "test" };
  const c15: QueryContext = { window: WINDOW_ALL, home: HOME, radiusMiles: 15, rawQuery: "test" };

  assert(filterEvents([farEvent], c5).length === 0, "Far event excluded at 5mi");
  assert(filterEvents([farEvent], c15).length === 1, "Far event included at 15mi");
});
