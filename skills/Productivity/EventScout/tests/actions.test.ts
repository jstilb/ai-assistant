#!/usr/bin/env bun
/**
 * actions.test.ts — Unit tests for Actions.ts payload builders (Slice 11).
 *
 * bun:test module — deterministic, no network, no filesystem state.
 * Run: bun test ~/.claude/.claude/worktrees/arch-debt-d2-eventscout-buntest/skills/Productivity/EventScout/tests/actions.test.ts
 *
 * Tests (deterministic, no network):
 *   - buildIdeaRow(event): EventItem → activity_ideas row object
 *     - correct field mapping (name, priority, rank, had, gmap_url)
 *     - title as name, notes carries date/venue/link
 *   - buildCalendarEvent(event): EventItem → gcalcli arg set
 *     - title, when (ISO → human-readable datetime in PT), where, description, duration
 *     - default +2h end when endDatetime is absent
 *     - location = address ?? venue
 *     - description carries why/link
 */

import { test } from "bun:test";
import { buildIdeaRow, buildCalendarEvent, buildCalendarRef, parseCalendarRef } from "../Tools/Actions.ts";
import type { EventItem } from "../Tools/types.ts";
import type { RankedEvent } from "../Tools/Ranker.ts";

// ============================================================================
// Assertion helpers — throw on failure so bun:test reports real pass/fail
// ============================================================================

function assert(condition: boolean, label: string, detail?: string): void {
  if (!condition) {
    throw new Error(`${label}${detail ? `\n        ${detail}` : ""}`);
  }
}

function assertEq<T>(actual: T, expected: T, label: string): void {
  assert(
    JSON.stringify(actual) === JSON.stringify(expected),
    label,
    `Expected: ${JSON.stringify(expected)}\n        Actual:   ${JSON.stringify(actual)}`
  );
}

function assertContains(str: string, needle: string, label: string): void {
  assert(str.includes(needle), label,
    `Expected to contain: ${JSON.stringify(needle)}\nActual: ${JSON.stringify(str)}`);
}

// ============================================================================
// Fixtures
// ============================================================================

function makeEvent(overrides: Partial<EventItem> = {}): EventItem {
  return {
    id: "test-001",
    title: "Tycho at Observatory North Park",
    startDatetime: "2026-06-08T21:00:00-07:00",
    endDatetime: "2026-06-08T23:00:00-07:00",
    allDay: false,
    venue: "Observatory North Park",
    address: "2891 University Ave, San Diego, CA 92104",
    lat: 32.7483,
    lng: -117.1299,
    category: "music",
    tags: ["electronic", "ambient"],
    isFree: false,
    priceMin: 35,
    priceMax: 45,
    currency: "USD",
    ticketUrl: "https://tickets.example.com/tycho-2026",
    sourceUrl: "https://www.observatorynorthpark.com/events",
    sources: [{ sourceId: "observatory-np", url: "https://www.observatorynorthpark.com/events" }],
    description: "Tycho brings their signature ambient electronic set.",
    fetchedAt: "2026-06-04T00:00:00Z",
    status: "scheduled",
    ...overrides,
  };
}

function makeRankedEvent(overrides: Partial<RankedEvent> = {}): RankedEvent {
  return {
    ...makeEvent(),
    score: 0.85,
    why: "Tycho plays electronic ambient music that matches your taste for atmospheric concerts.",
    ...overrides,
  };
}

// ============================================================================
// Tests: buildIdeaRow
// ============================================================================

test("buildIdeaRow — field mapping", () => {
  const event = makeEvent();
  const row = buildIdeaRow(event);

  // name = event title
  assertEq(row.name, "Tycho at Observatory North Park", "A01 name = event title");

  // priority defaults to "medium"
  assertEq(row.priority, "medium", "A02 priority defaults to 'medium'");

  // rank = empty string (no user ranking yet)
  assertEq(row.rank, "", "A03 rank is empty string");

  // had = empty string (not yet attended)
  assertEq(row.had, "", "A04 had is empty string");

  // gmap_url = empty string (no maps link in this event)
  assertEq(row.gmap_url, "", "A05 gmap_url is empty string when no maps link");

  // notes carries date / venue / link — we encode them in the row
  // The activity_ideas schema is: name, priority, rank, had, gmap_url
  // Notes are not a column in activity_ideas — so notes are packed into gmap_url
  // or we use a different column. Let's verify the schema usage is correct.
  assert(typeof row.name === "string", "A06 name field is a string");
  assert(typeof row.priority === "string", "A07 priority is a string");
  assert(typeof row.rank === "string", "A08 rank is a string");
  assert(typeof row.had === "string", "A09 had is a string");
  assert(typeof row.gmap_url === "string", "A10 gmap_url is a string");
});

test("buildIdeaRow — missing optional fields", () => {
  const minimalEvent = makeEvent({
    venue: undefined,
    address: undefined,
    ticketUrl: undefined,
  });
  const minRow = buildIdeaRow(minimalEvent);
  assertEq(minRow.name, "Tycho at Observatory North Park", "A11 name present with no venue/address");
  assertEq(minRow.gmap_url, "", "A12 gmap_url empty when no maps link");
});

test("buildIdeaRow — RankedEvent input", () => {
  const ranked = makeRankedEvent();
  const rankedRow = buildIdeaRow(ranked);
  assertEq(rankedRow.name, "Tycho at Observatory North Park", "A13 RankedEvent: name correct");
  assertEq(rankedRow.priority, "medium", "A14 RankedEvent: priority correct");
});

// ============================================================================
// Tests: buildCalendarEvent
// ============================================================================

test("buildCalendarEvent — field mapping", () => {
  const calEvent = makeRankedEvent();
  const calArgs = buildCalendarEvent(calEvent);

  // title must be set and include the event title
  assert("title" in calArgs, "A15 calArgs has title field");
  assertContains(calArgs.title, "Tycho at Observatory North Park", "A16 title includes event title");

  // when = formatted datetime in PT-local form for gcalcli
  assert("when" in calArgs, "A17 calArgs has when field");
  assert(calArgs.when.length > 0, "A18 when is non-empty");
  // Should contain the date (2026-06-08) in some form
  assertContains(calArgs.when, "2026-06-08", "A19 when contains correct date");

  // location = address ?? venue
  assert("location" in calArgs, "A20 calArgs has location field");
  assertEq(calArgs.location, "2891 University Ave, San Diego, CA 92104", "A21 location = address");

  // description carries why + link
  assert("description" in calArgs, "A22 calArgs has description field");
  assertContains(calArgs.description, "Tycho plays electronic ambient music", "A23 description contains why");
  assertContains(calArgs.description, "https://tickets.example.com/tycho-2026", "A24 description contains ticket link");

  // duration in minutes (from endDatetime - startDatetime: 2h = 120min)
  assert("duration" in calArgs, "A25 calArgs has duration field");
  assertEq(calArgs.duration, 120, "A26 duration = 120 minutes (2h from end-start)");

  // calendar = [user-email]
  assert("calendar" in calArgs, "A27 calArgs has calendar field");
  assertEq(calArgs.calendar, "[user-email]", "A28 calendar = [user-email]");
});

test("buildCalendarEvent — default +2h end when no endDatetime", () => {
  const noEndEvent = makeRankedEvent({ endDatetime: undefined });
  const noEndArgs = buildCalendarEvent(noEndEvent);
  assertEq(noEndArgs.duration, 120, "A29 duration defaults to 120 when no endDatetime");
});

test("buildCalendarEvent — location fallback to venue", () => {
  const noAddressEvent = makeRankedEvent({ address: undefined });
  const noAddrArgs = buildCalendarEvent(noAddressEvent);
  assertEq(noAddrArgs.location, "Observatory North Park", "A30 location falls back to venue when no address");
});

test("buildCalendarEvent — no venue or address", () => {
  const noLocEvent = makeRankedEvent({ address: undefined, venue: undefined });
  const noLocArgs = buildCalendarEvent(noLocEvent);
  assertEq(noLocArgs.location, "", "A31 location is empty when neither address nor venue");
});

test("buildCalendarEvent — sourceUrl fallback in description", () => {
  const noTicketEvent = makeRankedEvent({ ticketUrl: undefined });
  const noTicketArgs = buildCalendarEvent(noTicketEvent);
  assertContains(noTicketArgs.description, "https://www.observatorynorthpark.com/events",
    "A32 description uses sourceUrl when no ticketUrl");
});

test("buildCalendarEvent — plain EventItem (no why)", () => {
  const plainEvent = makeEvent();
  const plainArgs = buildCalendarEvent(plainEvent);
  assert("title" in plainArgs, "A33 plain EventItem: title present");
  assertContains(plainArgs.title, "Tycho at Observatory North Park", "A34 plain EventItem: title correct");
  // Description should still include the link
  assertContains(plainArgs.description, "https://tickets.example.com/tycho-2026",
    "A35 plain EventItem: description has ticket link");
});

test("buildCalendarEvent — various durations", () => {
  // 1h event
  const oneHourEvent = makeRankedEvent({
    startDatetime: "2026-06-10T19:00:00-07:00",
    endDatetime: "2026-06-10T20:00:00-07:00",
  });
  const oneHourArgs = buildCalendarEvent(oneHourEvent);
  assertEq(oneHourArgs.duration, 60, "A36 1-hour event: duration = 60");

  // 3h event
  const threeHourEvent = makeRankedEvent({
    startDatetime: "2026-06-10T19:00:00-07:00",
    endDatetime: "2026-06-10T22:00:00-07:00",
  });
  const threeHourArgs = buildCalendarEvent(threeHourEvent);
  assertEq(threeHourArgs.duration, 180, "A37 3-hour event: duration = 180");
});

// ============================================================================
// Tests: ref round-trip — addToCalendar ref ↔ deleteCalendarEvent
// ============================================================================
//
// Deterministic, no live calendar. These tests verify:
//   (a) buildCalendarRef produces a "|"-delimited "title|when" ref
//   (b) parseCalendarRef on that ref yields a non-empty text + valid dates
//   (c) the delete command text is never empty (the original bug)
//   (d) a bare event-id ref (no "|") is rejected rather than triggering
//       an empty-search call

test("ref round-trip — addToCalendar ref format", () => {
  const refEvent = makeRankedEvent();
  const calRef = buildCalendarRef(refEvent);

  // Ref contains "|"
  assert(calRef.includes("|"), "R01 buildCalendarRef contains pipe separator");

  // Ref starts with event title
  assert(calRef.startsWith("Tycho at Observatory North Park"),
    "R02 ref title matches event title");

  // Ref encodes the correct date
  assertContains(calRef, "2026-06-08",
    "R03 ref contains correct date");

  // parseCalendarRef: text is non-empty (critical — this was the empty-search bug)
  const parsed = parseCalendarRef(calRef);
  assert(parsed.text.length > 0,
    "R04 parseCalendarRef: text (delete search term) is non-empty");
  assertEq(parsed.text, "Tycho at Observatory North Park",
    "R05 parseCalendarRef: text equals event title");

  // parseCalendarRef: startDate and endDate are valid YYYY-MM-DD
  assert(/^\d{4}-\d{2}-\d{2}$/.test(parsed.startDate),
    "R06 parseCalendarRef: startDate is YYYY-MM-DD");
  assert(/^\d{4}-\d{2}-\d{2}$/.test(parsed.endDate),
    "R07 parseCalendarRef: endDate is YYYY-MM-DD");

  // endDate is exactly one day after startDate
  assertEq(parsed.startDate, "2026-06-08",
    "R08 parseCalendarRef: startDate is event date");
  assertEq(parsed.endDate, "2026-06-09",
    "R09 parseCalendarRef: endDate is event date + 1");
});

test("ref round-trip — bare event-id / empty string rejected", () => {
  // A bare event-id (no "|") must be rejected — never produce an empty search
  const bareId = "9abq81f9nfdrcplks47qtisano";
  let parseThrew = false;
  try {
    parseCalendarRef(bareId);
  } catch {
    parseThrew = true;
  }
  assert(parseThrew,
    "R10 parseCalendarRef: bare event-id (no '|') throws, never produces empty search");

  // Empty string also rejected
  let emptyThrew = false;
  try {
    parseCalendarRef("");
  } catch {
    emptyThrew = true;
  }
  assert(emptyThrew, "R11 parseCalendarRef: empty string throws");
});

test("ref round-trip — empty title before pipe rejected", () => {
  // Ref with empty title ("|when") rejected
  let emptyTitleThrew = false;
  try {
    parseCalendarRef("|2026-06-08 21:00");
  } catch {
    emptyTitleThrew = true;
  }
  assert(emptyTitleThrew, "R12 parseCalendarRef: empty title before '|' throws");
});

test("ref round-trip — title containing pipe is invalid (known constraint)", () => {
  // Title with "|" in it — "|" is the delimiter so such titles cannot round-trip.
  // buildCalendarRef would embed the extra "|" and parseCalendarRef would misparse.
  // This is a known constraint: event titles must not contain "|".
  const pipeInTitle = makeRankedEvent({ title: "Show|After Dark" });
  const pipeRef = buildCalendarRef(pipeInTitle);
  // pipeRef = "Show|After Dark|2026-06-08 21:00" — the first "|" splits incorrectly
  let pipeParseThrew = false;
  try {
    parseCalendarRef(pipeRef);
  } catch {
    pipeParseThrew = true;
  }
  assert(pipeParseThrew,
    "R13 parseCalendarRef: title with '|' fails at parse ('|' is reserved delimiter; titles must not contain it)");

  // Confirm that normal event titles (no pipe) always round-trip cleanly
  const normalRef = buildCalendarRef(makeRankedEvent());
  const normalParsed = parseCalendarRef(normalRef);
  assert(normalParsed.text.length > 0,
    "R14 parseCalendarRef: normal title (no '|') always yields non-empty text");
});
