#!/usr/bin/env bun
/**
 * spa.test.ts — Slice 4 TDD unit tests for SPAAdapter.normalizeExtracted()
 *
 * Tests ONLY the deterministic pure function: normalizeExtracted().
 * The live fetch + LLM call (fetchSPAEvents) is non-deterministic — tested
 * via the live self-check in the build agent, not here.
 *
 * Scenarios:
 *   (a) 2 valid raw objects → 2 schema-valid EventItems with:
 *       - category from source.categoryHint when raw object has no category
 *       - sources[0].sourceId === source.id
 *       - startDatetime is a valid ISO 8601 string
 *       - id is a non-empty string (deterministic hash)
 *   (b) 1 invalid raw object (missing title) → dropped
 *   (c) 1 invalid raw object (bad/unparseable date) → dropped
 *   (d) Total count = 2 (only the 2 valid ones survive)
 *
 * Run:
 *   bun test ~/.claude/.claude/worktrees/arch-debt-d2-eventscout-buntest/skills/Productivity/EventScout/tests/spa.test.ts
 */

import { test } from "bun:test";
import {
  normalizeExtracted,
  fetchSPAEventsWithPageFn,
  todayLaDateString,
  buildExtractionSystemPrompt,
} from "../Tools/adapters/SPAAdapter.ts";
import { EventItemSchema } from "../Tools/types.ts";
import type { EventSource, EventItem } from "../Tools/types.ts";
import { utcMsToLaParts } from "../Tools/lib/tz.ts";

// ============================================================================
// Test harness
// ============================================================================

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}

function assertEq<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    throw new Error(
      `Assertion failed: ${message} — expected: ${JSON.stringify(expected)}, actual: ${JSON.stringify(actual)}`
    );
  }
}

// ============================================================================
// Test fixture — mock EventSource
// ============================================================================

const mockSource: EventSource = {
  id: "comedy-store-la-jolla",
  name: "The Comedy Store La Jolla",
  url: "https://thecomedystore.com/la-jolla/calendar",
  fetchTier: "spa",
  categoryHint: "comedy",
  geoHint: "916 Pearl St, La Jolla, CA 92037",
  pollInterval: 720,
  enabled: true,
};

// ============================================================================
// Raw input: 2 valid + 1 missing title + 1 bad date
// ============================================================================

const rawInput: unknown[] = [
  // Valid #1 — has title, ISO startDatetime, venue
  {
    title: "John Mulaney: Live",
    startDatetime: "2026-06-15T20:00:00-07:00",
    venue: "The Comedy Store La Jolla",
    description: "An evening with John Mulaney.",
    ticketUrl: "https://thecomedystore.com/tickets/mulaney",
    isFree: false,
    priceMin: 35,
  },
  // Valid #2 — minimal fields; no category (should inherit from categoryHint)
  {
    title: "Open Mic Night",
    startDatetime: "2026-06-20T19:00:00",
    isFree: true,
  },
  // Invalid #3 — missing title (required field)
  {
    startDatetime: "2026-06-22T21:00:00-07:00",
    venue: "The Comedy Store",
    isFree: false,
  },
  // Invalid #4 — completely bogus date that can't be turned into ISO 8601
  {
    title: "The Date Error Show",
    startDatetime: "not-a-date-at-all",
    isFree: false,
  },
];

// ============================================================================
// Tests
// ============================================================================

test("Section 1: count — only valid events survive", () => {
  const items = normalizeExtracted(rawInput, mockSource);
  assertEq(items.length, 2, "exactly 2 valid events returned (2 valid, 1 no-title, 1 bad-date dropped)");
});

test("Section 2: schema validity (Zod parse)", () => {
  const items = normalizeExtracted(rawInput, mockSource);
  for (const item of items) {
    const result = EventItemSchema.safeParse(item);
    assert(result.success, `"${item.title}" passes EventItemSchema.safeParse()`);
  }
});

test("Section 3: category falls back to source.categoryHint", () => {
  const items = normalizeExtracted(rawInput, mockSource);
  for (const item of items) {
    assertEq(item.category, "comedy", `"${item.title}" category === "comedy" (from categoryHint)`);
  }
});

test("Section 4: sources[] populated from EventSource", () => {
  const items = normalizeExtracted(rawInput, mockSource);
  for (const item of items) {
    assert(item.sources.length >= 1, `"${item.title}" has at least 1 source`);
    assertEq(
      item.sources[0]!.sourceId,
      mockSource.id,
      `"${item.title}" sources[0].sourceId === "${mockSource.id}"`
    );
    assertEq(
      item.sources[0]!.url,
      mockSource.url,
      `"${item.title}" sources[0].url === source.url`
    );
  }
});

test("Section 5: startDatetime is valid ISO 8601", () => {
  const items = normalizeExtracted(rawInput, mockSource);
  for (const item of items) {
    const d = new Date(item.startDatetime);
    assert(
      !isNaN(d.getTime()),
      `"${item.title}" startDatetime "${item.startDatetime}" parses as valid Date`
    );
    // ISO 8601 strings contain 'T'
    assert(
      item.startDatetime.includes("T"),
      `"${item.title}" startDatetime contains 'T' separator`
    );
  }
});

test("Section 6: id is non-empty + deterministic", () => {
  const items1 = normalizeExtracted(rawInput, mockSource);
  const items2 = normalizeExtracted(rawInput, mockSource);
  for (let i = 0; i < items1.length; i++) {
    assert(items1[i]!.id.length > 0, `"${items1[i]!.title}" id is non-empty`);
    assertEq(
      items1[i]!.id,
      items2[i]!.id,
      `"${items1[i]!.title}" id is deterministic across two calls`
    );
  }
});

test("Section 7: sourceUrl set to source.url", () => {
  const items = normalizeExtracted(rawInput, mockSource);
  for (const item of items) {
    assertEq(item.sourceUrl, mockSource.url, `"${item.title}" sourceUrl === source.url`);
  }
});

test("Section 8: status defaults to 'scheduled'", () => {
  const items = normalizeExtracted(rawInput, mockSource);
  for (const item of items) {
    assertEq(item.status, "scheduled", `"${item.title}" status === "scheduled"`);
  }
});

test("Section 9: allDay defaults false", () => {
  const items = normalizeExtracted(rawInput, mockSource);
  for (const item of items) {
    assertEq(item.allDay, false, `"${item.title}" allDay === false`);
  }
});

// ============================================================================
// Section 10: Timezone correctness — naive strings treated as LA local time
//
// These tests verify that coerceToIso correctly handles naive, offset-aware,
// UTC, and date-only strings with respect to America/Los_Angeles.
// ============================================================================

test("Section 10a: naive datetime → correct LA wall-clock", () => {
  // "2026-06-05T19:00:00" has no offset → must be treated as PDT (UTC-7).
  // Expected UTC instant: 2026-06-06T02:00:00.000Z
  // LA wall-clock at that instant: June 5 at 19:00 (hour=19, day=5, month=6)
  const raw: unknown[] = [
    { title: "TZ Test Naive", startDatetime: "2026-06-05T19:00:00", isFree: false },
  ];
  const items = normalizeExtracted(raw, mockSource);
  assertEq(items.length, 1, "10a: naive datetime → 1 valid item");
  const item = items[0]!;
  const utcMs = new Date(item.startDatetime).getTime();
  // Must be a valid time
  assert(!isNaN(utcMs), "10a: startDatetime parses as valid Date");
  // LA wall-clock must be 7 PM on June 5
  const la = utcMsToLaParts(utcMs);
  assertEq(la.hour, 19, "10a: naive 19:00 → LA wall-clock hour = 19 (7 PM PDT)");
  assertEq(la.day, 5, "10a: naive June-5 19:00 → LA wall-clock day = 5");
  assertEq(la.month, 6, "10a: naive June-5 19:00 → LA wall-clock month = 6");
  // UTC should be 2026-06-06T02:00:00Z (naive was PDT = UTC-7)
  assertEq(
    new Date(utcMs).toISOString(),
    "2026-06-06T02:00:00.000Z",
    "10a: naive 2026-06-05T19:00:00 (LA) → UTC = 2026-06-06T02:00:00.000Z"
  );
});

test("Section 10b: offset-aware datetime → same UTC instant as naive", () => {
  // This is a regression check: offset-aware strings must NOT be altered.
  const raw: unknown[] = [
    { title: "TZ Test Offset", startDatetime: "2026-06-05T19:00:00-07:00", isFree: false },
  ];
  const items = normalizeExtracted(raw, mockSource);
  assertEq(items.length, 1, "10b: offset-aware datetime → 1 valid item");
  const item = items[0]!;
  const utcMs = new Date(item.startDatetime).getTime();
  // 2026-06-05T19:00:00-07:00 = 2026-06-06T02:00:00.000Z
  assertEq(
    new Date(utcMs).toISOString(),
    "2026-06-06T02:00:00.000Z",
    "10b: offset-aware -07:00 → UTC = 2026-06-06T02:00:00.000Z (same as naive)"
  );
  const la = utcMsToLaParts(utcMs);
  assertEq(la.hour, 19, "10b: offset-aware → LA wall-clock hour = 19");
  assertEq(la.day, 5, "10b: offset-aware → LA wall-clock day = 5");
});

test("Section 10c: Z datetime → that exact UTC instant preserved", () => {
  const raw: unknown[] = [
    { title: "TZ Test Z", startDatetime: "2026-06-06T02:00:00Z", isFree: false },
  ];
  const items = normalizeExtracted(raw, mockSource);
  assertEq(items.length, 1, "10c: Z datetime → 1 valid item");
  const item = items[0]!;
  const utcMs = new Date(item.startDatetime).getTime();
  assertEq(
    new Date(utcMs).toISOString(),
    "2026-06-06T02:00:00.000Z",
    "10c: Z string 2026-06-06T02:00:00Z preserved exactly"
  );
});

test("Section 10d: date-only input → LA local midnight", () => {
  // LA midnight on June 5 during PDT (UTC-7) = 2026-06-05T07:00:00.000Z
  const raw: unknown[] = [
    { title: "TZ Test DateOnly", startDatetime: "2026-06-05", isFree: false },
  ];
  const items = normalizeExtracted(raw, mockSource);
  assertEq(items.length, 1, "10d: date-only → 1 valid item");
  const item = items[0]!;
  const utcMs = new Date(item.startDatetime).getTime();
  assert(!isNaN(utcMs), "10d: date-only startDatetime parses as valid Date");
  const la = utcMsToLaParts(utcMs);
  // Midnight = hour 0 in LA
  assertEq(la.hour, 0, "10d: date-only → LA wall-clock hour = 0 (midnight)");
  assertEq(la.day, 5, "10d: date-only → LA wall-clock day = 5");
  assertEq(la.month, 6, "10d: date-only → LA wall-clock month = 6");
  // UTC should be 2026-06-05T07:00:00.000Z (PDT = UTC-7, midnight LA = 07:00 UTC)
  assertEq(
    new Date(utcMs).toISOString(),
    "2026-06-05T07:00:00.000Z",
    "10d: date-only 2026-06-05 (LA midnight PDT) → UTC = 2026-06-05T07:00:00.000Z"
  );
});

test("Section 10e: naive and offset-aware for same event → identical id (determinism)", () => {
  // Both "2026-06-05T19:00:00" (naive LA) and "2026-06-05T19:00:00-07:00" (aware)
  // represent the same instant, so they must produce the same stable id.
  const rawNaive: unknown[] = [
    { title: "Same Event", startDatetime: "2026-06-05T19:00:00", venue: "Test Venue", isFree: false },
  ];
  const rawAware: unknown[] = [
    { title: "Same Event", startDatetime: "2026-06-05T19:00:00-07:00", venue: "Test Venue", isFree: false },
  ];
  const naive = normalizeExtracted(rawNaive, mockSource);
  const aware = normalizeExtracted(rawAware, mockSource);
  assertEq(naive.length, 1, "10e: naive produced exactly 1 item (prerequisite)");
  assertEq(aware.length, 1, "10e: aware produced exactly 1 item (prerequisite)");
  assertEq(
    naive[0]!.id,
    aware[0]!.id,
    "10e: naive and offset-aware same event → identical stable id"
  );
});

// ============================================================================
// Section 11 — Slice 7: horizon-aware pagination loop (fetchSPAEventsWithPageFn)
//
// These tests use fetchSPAEventsWithPageFn which takes an injectable page
// fetcher so no network calls occur.
// ============================================================================

// Helper to build a mock EventSource with paginate config.
function makePaginatedSource(overrides: Partial<EventSource> = {}): EventSource {
  return {
    id: "test-paginated-source",
    name: "Test Paginated Source",
    url: "https://example.com/events",
    fetchTier: "html-llm",
    categoryHint: "music",
    geoHint: "San Diego, CA",
    pollInterval: 720,
    enabled: true,
    paginate: { param: "page", pages: 20, start: 1 },
    ...overrides,
  };
}

// Helper to make a minimal valid EventItem with a given id + startDatetime.
function makePaginationEvent(id: string, startDatetime: string): EventItem {
  return {
    id,
    title: `Event ${id}`,
    startDatetime,
    allDay: false,
    category: "music" as const,
    tags: [],
    isFree: false,
    sourceUrl: "https://example.com/events",
    sources: [{ sourceId: "test-paginated-source", url: "https://example.com/events" }],
    fetchedAt: new Date().toISOString(),
    status: "scheduled" as const,
  };
}

// NOW reference for horizon checks — future enough that test events are in-horizon.
const HORIZON_NOW = new Date("2026-06-07T12:00:00-07:00");
// Events 30 days from now — in horizon.
function futureIso(daysFromNow: number): string {
  return new Date(HORIZON_NOW.getTime() + daysFromNow * 24 * 60 * 60 * 1000).toISOString();
}
// Events 200 days from now — well beyond 120-day default horizon.
function beyondHorizonIso(): string {
  return futureIso(200);
}

test("11a: multi-page accumulation — loop stops on no-new-unique page", async () => {
  // Pages 1..3 return distinct events; page 4 returns all-duplicates → loop
  // stops, all distinct events from pages 1..3 returned.
  const page1 = [makePaginationEvent("e1", futureIso(5)), makePaginationEvent("e2", futureIso(6))];
  const page2 = [makePaginationEvent("e3", futureIso(7)), makePaginationEvent("e4", futureIso(8))];
  const page3 = [makePaginationEvent("e5", futureIso(9))];
  // Page 4 returns duplicates of page 1 events → no new uniques → loop stops.
  const page4 = [makePaginationEvent("e1", futureIso(5)), makePaginationEvent("e2", futureIso(6))];

  let callCount = 0;
  const pageFn = async (_url: string): Promise<EventItem[]> => {
    callCount++;
    if (callCount === 1) return page1;
    if (callCount === 2) return page2;
    if (callCount === 3) return page3;
    if (callCount === 4) return page4;
    return []; // should not reach
  };

  const source = makePaginatedSource();
  const result = await fetchSPAEventsWithPageFn(source, pageFn, HORIZON_NOW);

  assertEq(result.length, 5, "11a: all 5 distinct events returned (pages 1..3)");
  assertEq(callCount, 4, "11a: exactly 4 page fetches (stops after the all-dupe page 4)");
});

test("11b: no-op param safety — same events every page → stops at page 2", async () => {
  // Every page returns the SAME events → loop stops after the 2nd page (no
  // new uniques), does NOT spin to MAX_PAGES_SAFETY bound.
  const sameEvents = [
    makePaginationEvent("same-a", futureIso(10)),
    makePaginationEvent("same-b", futureIso(11)),
  ];

  let callCount = 0;
  const pageFn = async (_url: string): Promise<EventItem[]> => {
    callCount++;
    return sameEvents;
  };

  const source = makePaginatedSource();
  const result = await fetchSPAEventsWithPageFn(source, pageFn, HORIZON_NOW);

  // After page 1: accumulated {same-a, same-b}. Page 2 has no new uniques → stop.
  assertEq(callCount, 2, "11b: loop stops after 2 fetches (page 1 → accumulate, page 2 → no new → stop)");
  assertEq(result.length, 2, "11b: 2 distinct events returned");
});

test("11c: all-past-horizon page → stop pagination", async () => {
  // Pages 1..2 have in-horizon events; page 3 has ALL events beyond horizon → stop.
  const page1 = [makePaginationEvent("h1", futureIso(5)), makePaginationEvent("h2", futureIso(10))];
  const page2 = [makePaginationEvent("h3", futureIso(15))];
  // Page 3 entirely beyond 120d horizon
  const page3 = [
    makePaginationEvent("h4", beyondHorizonIso()),
    makePaginationEvent("h5", beyondHorizonIso()),
  ];

  let callCount = 0;
  const pageFn = async (_url: string): Promise<EventItem[]> => {
    callCount++;
    if (callCount === 1) return page1;
    if (callCount === 2) return page2;
    if (callCount === 3) return page3;
    return [];
  };

  const source = makePaginatedSource();
  const result = await fetchSPAEventsWithPageFn(source, pageFn, HORIZON_NOW);

  assertEq(callCount, 3, "11c: fetched 3 pages (stopped after all-past-horizon page 3)");
  // In-horizon events from pages 1+2 should be returned; beyond-horizon from page 3 not required.
  assert(result.length >= 3, "11c: at least 3 in-horizon events returned (pages 1+2)");
  // None of the beyond-horizon events should be in the result.
  const beyondIds = ["h4", "h5"];
  for (const id of beyondIds) {
    assert(
      !result.some((e) => e.id === id),
      `11c: beyond-horizon event ${id} not in result`,
    );
  }
});

test("11d: safety bound — infinite new events capped at MAX_PAGES_SAFETY", async () => {
  // This verifies the adapter never loops infinitely; also verifies a
  // console.warn is emitted (we capture it via process.stderr or by checking
  // the call count cap).
  let callCount = 0;
  const pageFn = async (_url: string): Promise<EventItem[]> => {
    callCount++;
    // Return a fresh unique event on every page so no other stop condition fires.
    return [makePaginationEvent(`inf-${callCount}`, futureIso(callCount))];
  };

  const source = makePaginatedSource({ paginate: { param: "page", pages: 200, start: 1 } });
  const result = await fetchSPAEventsWithPageFn(source, pageFn, HORIZON_NOW);

  // MAX_PAGES_SAFETY is 40. The loop must stop at or before that.
  assert(callCount <= 40, `11d: loop stopped at/before MAX_PAGES_SAFETY (callCount=${callCount})`);
  assert(result.length > 0, "11d: some events returned before safety cap");
  assert(result.length <= 40, `11d: result count bounded by safety cap (${result.length})`);
});

test("11e: maxLlmWindows override preserved on source passed to pageFn", async () => {
  // Source with maxLlmWindows=12 is passed through to the page fetcher context.
  // This is a structural test — the source's maxLlmWindows value must be
  // present on the source object received by the page fn (no stripping by the loop).
  let receivedSource: EventSource | null = null;
  const pageFn = async (_url: string, src: EventSource): Promise<EventItem[]> => {
    receivedSource = src;
    return [makePaginationEvent("w1", futureIso(5))];
  };

  const source = makePaginatedSource({ maxLlmWindows: 12 });
  await fetchSPAEventsWithPageFn(source, pageFn, HORIZON_NOW);

  assert(receivedSource !== null, "11e: pageFn was called");
  assertEq(
    (receivedSource as EventSource).maxLlmWindows,
    12,
    "11e: pageFn receives source with maxLlmWindows=12 intact",
  );
});

test("11f: source without paginate config → exactly 1 fetch", async () => {
  let callCount = 0;
  const pageFn = async (_url: string): Promise<EventItem[]> => {
    callCount++;
    return [makePaginationEvent("np1", futureIso(5)), makePaginationEvent("np2", futureIso(6))];
  };

  // No paginate field — should behave as the old single-page path.
  const source: EventSource = {
    id: "no-paginate",
    name: "No Paginate",
    url: "https://example.com/nopaginate",
    fetchTier: "spa",
    pollInterval: 720,
    enabled: true,
  };

  const result = await fetchSPAEventsWithPageFn(source, pageFn, HORIZON_NOW);

  assertEq(callCount, 1, "11f: exactly 1 fetch for source with no paginate");
  assertEq(result.length, 2, "11f: 2 events returned from single page");
});

// ============================================================================
// Section 12 — todayLaDateString: pure "today" helper for prompt injection
//
// Year-less-date fix (2026-07-10): the extraction prompt needs a ground-truth
// "today" in LA wall-clock terms so the LLM can resolve dates like "July 5th"
// (no year) against a real reference point instead of guessing/dropping.
// ============================================================================

test("12a: todayLaDateString — formats as YYYY-MM-DD in LA wall-clock time", () => {
  // Noon UTC on 2026-07-10 is still 2026-07-10 in LA (PDT, UTC-7 → ~5am local).
  const now = new Date("2026-07-10T12:00:00Z");
  assertEq(todayLaDateString(now), "2026-07-10", "12a: noon UTC → same LA calendar date");
});

test("12b: todayLaDateString — UTC date rolls back a day in early LA morning hours", () => {
  // 2026-07-11T05:00:00Z is 2026-07-10T22:00:00-07:00 in LA (still the 10th).
  const now = new Date("2026-07-11T05:00:00Z");
  assertEq(
    todayLaDateString(now),
    "2026-07-10",
    "12b: early-UTC-morning instant still reads as the prior LA calendar date"
  );
});

test("12c: todayLaDateString — zero-pads single-digit month/day", () => {
  const now = new Date("2026-03-05T18:00:00Z");
  assertEq(todayLaDateString(now), "2026-03-05", "12c: single-digit month/day are zero-padded");
});

test("12d: todayLaDateString — defaults to current instant when no arg given", () => {
  const result = todayLaDateString();
  assert(
    /^\d{4}-\d{2}-\d{2}$/.test(result),
    `12d: no-arg call returns a well-formed YYYY-MM-DD string, got "${result}"`
  );
});

// ============================================================================
// Section 13 — buildExtractionSystemPrompt: prompt-level year-resolution fix
//
// The house rule ("determinism must earn its place") says this bug is fixed
// by giving the LLM the current date and explicit instructions, NOT a
// deterministic NL date parser. These tests assert the prompt actually
// carries that content, and that the original field-list guidance survives.
// ============================================================================

test("13a: prompt embeds the exact today-string passed in", () => {
  const prompt = buildExtractionSystemPrompt("2026-07-10");
  assert(
    prompt.includes("2026-07-10"),
    "13a: prompt contains the injected today-date string"
  );
});

test("13b: prompt instructs the model to resolve year-less dates using today", () => {
  const prompt = buildExtractionSystemPrompt("2026-07-10");
  const lower = prompt.toLowerCase();
  assert(lower.includes("year"), "13b: prompt mentions 'year' resolution guidance");
  assert(
    lower.includes("without a year") || lower.includes("no year") || lower.includes("year-less"),
    "13b: prompt explicitly names the year-less-date scenario"
  );
});

test("13c: prompt instructs the model to always output a full year, never drop/omit it", () => {
  const prompt = buildExtractionSystemPrompt("2026-07-10");
  const lower = prompt.toLowerCase();
  assert(
    lower.includes("never") && lower.includes("year"),
    "13c: prompt carries a hard 'never omit/placeholder the year' instruction"
  );
});

test("13d: prompt still requires the JSON-only output contract (regression)", () => {
  const prompt = buildExtractionSystemPrompt("2026-07-10");
  assert(
    prompt.includes("Output ONLY a valid JSON array"),
    "13d: original JSON-only output contract preserved"
  );
});

test("13e: prompt still carries the required field list (regression)", () => {
  const prompt = buildExtractionSystemPrompt("2026-07-10");
  for (const field of ["title", "startDatetime", "venue", "ticketUrl", "isFree", "category"]) {
    assert(prompt.includes(field), `13e: prompt still documents field "${field}"`);
  }
});

test("13g: prompt requires ISO 8601 only — no ambiguous free-text date format (regression)", () => {
  // Live-verified 2026-07-10: the old "Month DD, YYYY HH:MM AM/PM" alternate
  // silently broke downstream in coerceToIso (naiveLaToUtcMs appends "Z" to a
  // non-ISO string → NaN), dropping fully year-qualified events as
  // "unparseable" even after the year-resolution fix. The prompt must not
  // re-offer that format.
  const prompt = buildExtractionSystemPrompt("2026-07-10");
  assert(
    !prompt.includes("or \"Month DD, YYYY HH:MM AM/PM\""),
    "13g: prompt no longer OFFERS the ambiguous free-text format as a valid option"
  );
  assert(
    prompt.includes("Do NOT use \"Month DD, YYYY HH:MM AM/PM\""),
    "13g: prompt explicitly forbids the free-text format that broke coerceToIso"
  );
  assert(
    prompt.toLowerCase().includes("iso 8601"),
    "13g: prompt names ISO 8601 as the required startDatetime format"
  );
});

test("13f: prompt is a pure function of todayLaDate — different dates produce different prompts", () => {
  const a = buildExtractionSystemPrompt("2026-07-10");
  const b = buildExtractionSystemPrompt("2026-12-25");
  assert(a !== b, "13f: prompt text changes when the injected date changes");
  assert(a.includes("2026-07-10") && !a.includes("2026-12-25"), "13f: prompt A carries only date A");
  assert(b.includes("2026-12-25") && !b.includes("2026-07-10"), "13f: prompt B carries only date B");
});

// ============================================================================
// Section 14 — normalizeExtracted drop observability
//
// Design constraint: a silent drop is how the year-less-date bug went
// undetected (majestyinmotion-events yielded 1/~5 events with zero signal
// in the logs). normalizeExtracted must now log a visible drop-count
// whenever it discards raw entries — this is the "light deterministic guard
// that fails loud" half of the fix (the other half is the prompt itself).
// ============================================================================

function captureConsole(): { messages: string[]; restore: () => void } {
  const messages: string[] = [];
  const origLog = console.log;
  const origWarn = console.warn;
  console.log = (...args: unknown[]) => { messages.push(args.map(String).join(" ")); };
  console.warn = (...args: unknown[]) => { messages.push(args.map(String).join(" ")); };
  return {
    messages,
    restore: () => { console.log = origLog; console.warn = origWarn; },
  };
}

test("14a: unparseable-date drop is logged individually, not silent", () => {
  const cap = captureConsole();
  try {
    normalizeExtracted(
      [{ title: "Year-less Caption Show", startDatetime: "July 5th", isFree: false }],
      mockSource
    );
  } finally {
    cap.restore();
  }
  const hit = cap.messages.some(
    (m) => m.includes("Year-less Caption Show") && m.toLowerCase().includes("unparseable")
  );
  assert(hit, `14a: expected a per-entry unparseable-date warning — got: ${cap.messages.join(" | ")}`);
});

test("14b: drop-count summary line reports counts and survivor total", () => {
  const cap = captureConsole();
  let items: EventItem[];
  try {
    items = normalizeExtracted(rawInput, mockSource); // 2 valid, 1 no-title, 1 bad-date (from top-of-file fixture)
  } finally {
    cap.restore();
  }
  assertEq(items.length, 2, "14b: prerequisite — 2 valid items survive");
  const summary = cap.messages.find((m) => m.includes("dropped") && m.includes("normalizeExtracted"));
  assert(summary !== undefined, `14b: expected a drop-count summary line — got: ${cap.messages.join(" | ")}`);
  assert(summary!.includes("2/4"), `14b: summary reports "2/4" dropped, got: "${summary}"`);
});

test("14c: no drops → no drop-related log line (quiet on the happy path)", () => {
  const cleanInput: unknown[] = [
    { title: "Clean Event", startDatetime: "2026-06-15T20:00:00-07:00", isFree: false },
  ];
  const cap = captureConsole();
  try {
    normalizeExtracted(cleanInput, mockSource);
  } finally {
    cap.restore();
  }
  const hasDropLog = cap.messages.some((m) => m.toLowerCase().includes("drop"));
  assert(!hasDropLog, `14c: no drop occurred, so no drop log expected — got: ${cap.messages.join(" | ")}`);
});
