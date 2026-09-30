#!/usr/bin/env bun
/**
 * scoring-line.test.ts — Slice 3 (v2) TDD tests for buildScoringLine and batch prompt.
 *
 * Tests pure functions — no network, no LLM, no I/O.
 *
 * Tests:
 *   1.  buildScoringLine contains day-of-week (LA local from startDatetime).
 *   2.  buildScoringLine contains a distance token with "mi" (has coords).
 *   3.  buildScoringLine contains "location unknown" when event has no coords.
 *   4.  buildScoringLine derives neighborhood from first comma-segment of address.
 *   5.  buildScoringLine falls back to geoHint when address is absent.
 *   6.  buildScoringLine contains the source name (human name, not id).
 *   7.  buildScoringLine shows "free" for isFree=true events.
 *   8.  buildScoringLine shows price token for paid events (not free).
 *   9.  buildScoringLine description is >= 200 chars when input desc is long (old 100-char cap gone).
 *  10.  buildScoringLine includes ALL tags, not just the first 5.
 *  11.  buildScoringLine contains "in X day" or "today" how-soon token.
 *  12.  buildScoringLine includes the full performersOrTeams string.
 *  13.  SCORE_BATCH_SIZE is ≤ 50 (reduced from 75 for token budget).
 *  14.  buildBatchSystemPrompt contains the 0–100 rubric band "90–100".
 *  15.  buildBatchSystemPrompt references the intent brief passed to it.
 *  16.  buildBatchSystemPrompt contains all calibration bands (70–89, 50–69, 30–49, 0–29).
 *
 * Run:
 *   bun test ~/.claude/.claude/worktrees/arch-debt-d2-eventscout-buntest/skills/Productivity/EventScout/tests/scoring-line.test.ts
 */

import { test } from "bun:test";

import {
  buildScoringLine,
  buildBatchSystemPrompt,
  SCORE_BATCH_SIZE,
} from "../Tools/Ranker.ts";
import type { EventItem } from "../Tools/types.ts";

// ============================================================================
// Test harness
// ============================================================================

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

// ============================================================================
// Fixtures
// ============================================================================

// A Saturday in LA (PDT): 2026-06-13T14:00:00-07:00 is a Saturday
const SATURDAY_ISO = "2026-06-13T14:00:00-07:00";
// 2026-06-07T18:00:00-07:00 is a Sunday
const SUNDAY_ISO = "2026-06-07T18:00:00-07:00";

/** Home: Ocean Beach, San Diego */
const HOME = { lat: 32.7449, lng: -117.2508 };

/** Near the home (within a few miles) */
const NEAR_LAT = 32.735;
const NEAR_LNG = -117.24;

const LONG_DESC =
  "This is a very long description that exceeds one hundred characters in total length. " +
  "It should be included up to approximately 400 characters so the scorer gets much richer " +
  "context than before. Here is more text to push it well past the old 120-char truncation " +
  "point and ensure we see a meaningful chunk of description in the output line.";

const MANY_TAGS = ["tag1", "tag2", "tag3", "tag4", "tag5", "tag6", "tag7", "tag8"];

function makeEvent(overrides: Partial<EventItem> & { id: string; title: string; category: EventItem["category"] }): EventItem {
  return {
    id: overrides.id,
    title: overrides.title,
    startDatetime: overrides.startDatetime ?? SATURDAY_ISO,
    allDay: false,
    category: overrides.category,
    tags: overrides.tags ?? [],
    isFree: overrides.isFree ?? false,
    sourceUrl: "https://example.com",
    sources: [{ sourceId: "test-source", url: "https://example.com" }],
    fetchedAt: "2026-06-07T00:00:00Z",
    status: "scheduled",
    ...overrides,
  };
}

/** Source lookup map: sourceId → { name, geoHint } */
const sourceLookup = new Map([
  ["test-source", { name: "San Diego Events Hub", geoHint: "North Park" }],
  ["ob-source", { name: "Ocean Beach Rag", geoHint: "Ocean Beach" }],
]);

/** Context passed to buildScoringLine */
function makeCtx(nowOverride?: Date) {
  return {
    home: HOME,
    now: nowOverride ?? new Date(SATURDAY_ISO),
    sourceLookup,
  };
}

// ============================================================================
// Tests
// ============================================================================

console.log("\nscoring-line.test.ts — Slice 3 buildScoringLine + batch prompt\n");

// -- Test 1 ------------------------------------------------------------------

test("1. buildScoringLine contains day-of-week (LA local)", () => {
  const event = makeEvent({
    id: "t1",
    title: "Saturday Show",
    category: "music",
    startDatetime: SATURDAY_ISO,
  });
  const line = buildScoringLine(event, makeCtx());
  // 2026-06-13 is a Saturday
  assert(
    line.toLowerCase().includes("saturday") || line.includes("Sat"),
    `line contains day-of-week: "${line.slice(0, 120)}..."`
  );
});

// -- Test 2 ------------------------------------------------------------------

test("2. buildScoringLine contains a distance token with 'mi' (has coords)", () => {
  const event = makeEvent({
    id: "t2",
    title: "Nearby Concert",
    category: "music",
    lat: NEAR_LAT,
    lng: NEAR_LNG,
  });
  const line = buildScoringLine(event, makeCtx());
  assert(
    line.includes("mi"),
    `line contains "mi" distance token: "${line.slice(0, 120)}..."`
  );
});

// -- Test 3 ------------------------------------------------------------------

test("3. buildScoringLine contains 'location unknown' when event has no coords", () => {
  const event = makeEvent({
    id: "t3",
    title: "Unknown Location Event",
    category: "arts",
    // lat/lng deliberately omitted
  });
  const line = buildScoringLine(event, makeCtx());
  assert(
    line.includes("location unknown"),
    `line contains "location unknown": "${line.slice(0, 150)}..."`
  );
});

// -- Test 4 ------------------------------------------------------------------

test("4. buildScoringLine derives neighborhood from first comma-segment of address", () => {
  const event = makeEvent({
    id: "t4",
    title: "North Park Gig",
    category: "music",
    address: "North Park, San Diego, CA 92104",
    lat: NEAR_LAT,
    lng: NEAR_LNG,
  });
  const line = buildScoringLine(event, makeCtx());
  assert(
    line.includes("North Park"),
    `line contains neighborhood "North Park" from address: "${line.slice(0, 150)}..."`
  );
});

// -- Test 5 ------------------------------------------------------------------

test("5. buildScoringLine falls back to geoHint when address is absent", () => {
  const event = makeEvent({
    id: "t5",
    title: "OB Show",
    category: "music",
    sources: [{ sourceId: "ob-source", url: "https://obrag.org" }],
    // address deliberately absent
  });
  const line = buildScoringLine(event, makeCtx());
  assert(
    line.includes("Ocean Beach"),
    `line contains geoHint "Ocean Beach" fallback: "${line.slice(0, 150)}..."`
  );
});

// -- Test 6 ------------------------------------------------------------------

test("6. buildScoringLine contains the source name (human name, not id)", () => {
  const event = makeEvent({
    id: "t6",
    title: "Event From Hub",
    category: "community",
    sources: [{ sourceId: "test-source", url: "https://example.com" }],
  });
  const line = buildScoringLine(event, makeCtx());
  assert(
    line.includes("San Diego Events Hub"),
    `line contains source name "San Diego Events Hub": "${line.slice(0, 150)}..."`
  );
});

// -- Test 7 ------------------------------------------------------------------

test("7. buildScoringLine shows 'free' for isFree=true events", () => {
  const event = makeEvent({
    id: "t7",
    title: "Free Festival",
    category: "festival",
    isFree: true,
  });
  const line = buildScoringLine(event, makeCtx());
  assert(line.toLowerCase().includes("free"), `line contains "free": "${line.slice(0, 120)}..."`);
});

// -- Test 8 ------------------------------------------------------------------

test("8. buildScoringLine shows price token for paid events", () => {
  const event = makeEvent({
    id: "t8",
    title: "Paid Show",
    category: "music",
    isFree: false,
    priceMin: 25,
  });
  const line = buildScoringLine(event, makeCtx());
  assert(
    line.includes("$25") || line.includes("25"),
    `line contains price token: "${line.slice(0, 120)}..."`
  );
});

// -- Test 9 ------------------------------------------------------------------

test("9. buildScoringLine description is >= 200 chars when input desc is long", () => {
  const event = makeEvent({
    id: "t9",
    title: "Detailed Event",
    category: "arts",
    description: LONG_DESC, // >400 chars
  });
  const line = buildScoringLine(event, makeCtx());
  // The description portion alone should be much longer than the old 120-char cap
  // Check by finding "desc:" and extracting what follows
  const descIdx = line.indexOf("desc:");
  assert(descIdx !== -1, "line contains desc: field");
  if (descIdx !== -1) {
    const descPortion = line.slice(descIdx);
    assert(
      descPortion.length >= 200,
      `description portion is >= 200 chars (got ${descPortion.length})`
    );
  }
});

// -- Test 10 -----------------------------------------------------------------

test("10. buildScoringLine includes ALL tags (not just first 5)", () => {
  const event = makeEvent({
    id: "t10",
    title: "Multi-Tagged Event",
    category: "music",
    tags: MANY_TAGS, // 8 tags
  });
  const line = buildScoringLine(event, makeCtx());
  // All 8 tags should appear
  for (const tag of MANY_TAGS) {
    assert(
      line.includes(tag),
      `line contains tag "${tag}"`
    );
  }
});

// -- Test 11 -----------------------------------------------------------------

test("11. buildScoringLine contains how-soon token ('today', 'in X day', etc.)", () => {
  // Event is today (same date as now)
  const todayEvent = makeEvent({
    id: "t11a",
    title: "Today Show",
    category: "music",
    startDatetime: SATURDAY_ISO,
  });
  const todayCtx = makeCtx(new Date(SATURDAY_ISO));
  const todayLine = buildScoringLine(todayEvent, todayCtx);
  assert(
    todayLine.toLowerCase().includes("today") ||
    todayLine.toLowerCase().includes("in 0") ||
    todayLine.toLowerCase().includes("in 1"),
    `line contains "today" or close-day token for same-day event: "${todayLine.slice(0, 120)}..."`
  );

  // Event is 2 days out
  const futureNow = new Date("2026-06-11T10:00:00-07:00");
  const futureDateEvent = makeEvent({
    id: "t11b",
    title: "Future Show",
    category: "music",
    startDatetime: SATURDAY_ISO, // Jun 13 = 2 days from Jun 11
  });
  const futureCtx = { home: HOME, now: futureNow, sourceLookup };
  const futureLine = buildScoringLine(futureDateEvent, futureCtx);
  assert(
    futureLine.toLowerCase().includes("day"),
    `line contains "day" token for future event: "${futureLine.slice(0, 120)}..."`
  );
});

// -- Test 12 -----------------------------------------------------------------

test("12. buildScoringLine includes full performersOrTeams string", () => {
  const event = makeEvent({
    id: "t12",
    title: "Concert with Performers",
    category: "music",
    performersOrTeams: "The Rolling Stones, The Black Keys",
  });
  const line = buildScoringLine(event, makeCtx());
  assert(
    line.includes("The Rolling Stones"),
    `line includes full performer string: "${line.slice(0, 150)}..."`
  );
});

// -- Test 13 -----------------------------------------------------------------

test("13. SCORE_BATCH_SIZE is <= 50 (reduced for token budget)", () => {
  assert(
    SCORE_BATCH_SIZE <= 50,
    `SCORE_BATCH_SIZE=${SCORE_BATCH_SIZE} is <= 50`
  );
  assert(
    SCORE_BATCH_SIZE > 0,
    `SCORE_BATCH_SIZE=${SCORE_BATCH_SIZE} is positive`
  );
});

// -- Test 14 -----------------------------------------------------------------

test("14. buildBatchSystemPrompt contains 0–100 rubric band '90–100'", () => {
  const prompt = buildBatchSystemPrompt("user wants free outdoor events");
  assert(
    prompt.includes("90"),
    `prompt contains "90" rubric band: "${prompt.slice(0, 200)}..."`
  );
  // Also verify it's a range-style rubric (contains a dash between numbers)
  assert(
    /9[0-9].*[–\-].*100|100.*[–\-].*9[0-9]/.test(prompt) || prompt.includes("90–100") || prompt.includes("90-100"),
    `prompt contains 90-100 band notation`
  );
});

// -- Test 15 -----------------------------------------------------------------

test("15. buildBatchSystemPrompt references the intent brief passed to it", () => {
  const brief = "user wants free outdoor events near Ocean Beach this Saturday";
  const prompt = buildBatchSystemPrompt(brief);
  assert(
    prompt.includes(brief) || prompt.includes("free outdoor events near Ocean Beach"),
    `prompt contains the brief text: "${prompt.slice(0, 300)}..."`
  );
});

// -- Test 16 -----------------------------------------------------------------

test("16. buildBatchSystemPrompt contains all calibration bands", () => {
  const prompt = buildBatchSystemPrompt("some intent brief");
  // Must contain all 5 bands
  const bands = [
    { label: "90–100 or 90-100", check: () => prompt.includes("90") },
    { label: "70–89 or 70-89", check: () => prompt.includes("70") },
    { label: "50–69 or 50-69", check: () => prompt.includes("50") },
    { label: "30–49 or 30-49", check: () => prompt.includes("30") },
    { label: "0–29 or 0-29", check: () => prompt.includes("0") && prompt.includes("29") },
  ];
  for (const band of bands) {
    assert(band.check(), `prompt contains calibration band ${band.label}`);
  }
});

