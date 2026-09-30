#!/usr/bin/env bun
/**
 * memberlife.test.ts — unit tests for MemberLifeAdapter (Member.life get-data
 * API → EventItem occurrences).
 *
 * Two layers:
 *   1. Granular pure-function tests on inline fixtures (mirrors pike13.test.ts):
 *      secondsToHms, projectWeekdayDates, deriveTags, normalizeWhitespace,
 *      mapTimeslotOccurrenceToEvent.
 *   2. An end-to-end pure-mapper test against the REAL captured response
 *      (tests/fixtures/memberlife-get-data.json, saved 2026-07-10 from the
 *      live `POST https://member.life/api/get-data` endpoint for
 *      name_short=majestyinmotion) — validates the full 46-class/45-timeslot
 *      shape, the day=7 stray guard, and the day=3 (Wednesday) 8-class
 *      cross-validation anchor against the studio's static calendar.
 *
 * No network calls anywhere in this file.
 *
 * Run: bun test <worktree>/skills/Productivity/EventScout/tests/memberlife.test.ts
 */

import { test } from "bun:test";
import { readFileSync } from "fs";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";
import {
  mapTimeslotOccurrenceToEvent,
  mapClassesResponseToEvents,
  projectWeekdayDates,
  secondsToHms,
  deriveTags,
  normalizeWhitespace,
} from "../Tools/adapters/MemberLifeAdapter.ts";
import type {
  MemberLifeClass,
  MemberLifeTimeslot,
  MemberLifeGetDataResponse,
} from "../Tools/adapters/MemberLifeAdapter.ts";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}

function assertEqual<T>(actual: T, expected: T, message: string): void {
  assert(
    JSON.stringify(actual) === JSON.stringify(expected),
    `${message}\n         expected: ${JSON.stringify(expected)}\n         actual:   ${JSON.stringify(actual)}`
  );
}

// ============================================================================
// Inline fixtures — shape mirrors the Member.life get-data API
// ============================================================================

/** Level 1 Salsa, Wednesday 18:30-19:30 (seconds_start 66600 / stop 70200), David Stein. */
const SALSA_TIMESLOT: MemberLifeTimeslot = {
  id: 26282,
  class_id: 3536,
  day: 3,
  room: "",
  seconds_start: 66600,
  seconds_stop: 70200,
  staff_first: "David",
  staff_last: "Stein",
  assistant_first: null,
  assistant_last: null,
};

const SALSA_CLASS: MemberLifeClass = {
  id: 3536,
  title: "Level 1 Salsa",
  description:
    "This class is designed for all levels. In this beginner class, you will learn the basic Salsa steps and turns, along with rhythm, timing, lead, and follow techniques. \r\nNo partner is needed!",
  category: "Salsa",
  timeslots: [SALSA_TIMESLOT],
};

/** Timeslot with an assistant instructor and a named room. */
const ASSISTED_TIMESLOT: MemberLifeTimeslot = {
  id: 26287,
  class_id: 3522,
  day: 5,
  room: "Studio A",
  seconds_start: 70200,
  seconds_stop: 73800,
  staff_first: "David",
  staff_last: "Stein",
  assistant_first: "Jennifer",
  assistant_last: "Stein",
};

const ASSISTED_CLASS: MemberLifeClass = {
  id: 3522,
  title: "Level 2 Salsa",
  description: "",
  category: "Salsa",
  timeslots: [ASSISTED_TIMESLOT],
};

/** No staff assigned (both staff and assistant null) — "Open Practice Sessions" shape. */
const UNSTAFFED_TIMESLOT: MemberLifeTimeslot = {
  id: 25639,
  class_id: 3622,
  day: 2,
  room: "",
  seconds_start: 73800,
  seconds_stop: 81000,
  staff_first: null,
  staff_last: null,
  assistant_first: null,
  assistant_last: null,
};

const UNSTAFFED_CLASS: MemberLifeClass = {
  id: 3622,
  title: "Open Practice Sessions",
  description: "",
  category: "Enhance",
  timeslots: [UNSTAFFED_TIMESLOT],
};

const OCCURRENCE_DATE = { year: 2026, month: 7, day: 15 }; // a Wednesday

// ============================================================================
// secondsToHms
// ============================================================================

console.log("\nmemberlife.test.ts — MemberLifeAdapter (Member.life get-data API → EventItem)\n");

test("secondsToHms: converts midnight-offset seconds to wall-clock", () => {
  assertEqual(secondsToHms(66600), { hour: 18, minute: 30, second: 0 }, "66600s → 18:30:00");
  assertEqual(secondsToHms(43200), { hour: 12, minute: 0, second: 0 }, "43200s → 12:00:00");
  assertEqual(secondsToHms(0), { hour: 0, minute: 0, second: 0 }, "0s → 00:00:00");
});

// ============================================================================
// projectWeekdayDates
// ============================================================================

test("projectWeekdayDates: 7-day window contains each weekday exactly once", () => {
  // 2026-07-10 is a Friday (day=5). A 7-day window from there covers
  // Fri 07-10 .. Thu 07-16, so Wednesday (day=3) lands on 07-15.
  const dates = projectWeekdayDates(3, { year: 2026, month: 7, day: 10 }, 7);
  assertEqual(dates, [{ year: 2026, month: 7, day: 15 }], `dates ${JSON.stringify(dates)}`);
});

test("projectWeekdayDates: 14-day window yields two occurrences", () => {
  const dates = projectWeekdayDates(3, { year: 2026, month: 7, day: 10 }, 14);
  assertEqual(
    dates,
    [
      { year: 2026, month: 7, day: 15 },
      { year: 2026, month: 7, day: 22 },
    ],
    `dates ${JSON.stringify(dates)}`
  );
});

test("projectWeekdayDates: windowStart itself matches when its weekday equals the target", () => {
  // 07-10-2026 is a Friday (day=5); windowStart is day 0 of the window.
  const dates = projectWeekdayDates(5, { year: 2026, month: 7, day: 10 }, 7);
  assertEqual(dates, [{ year: 2026, month: 7, day: 10 }], `dates ${JSON.stringify(dates)}`);
});

test("projectWeekdayDates: no match within window returns empty array", () => {
  const dates = projectWeekdayDates(3, { year: 2026, month: 7, day: 10 }, 1);
  assertEqual(dates, [], `dates ${JSON.stringify(dates)}`);
});

// ============================================================================
// mapTimeslotOccurrenceToEvent
// ============================================================================

test("mapTimeslotOccurrenceToEvent: title, category, sourceId, isFree", () => {
  const e = mapTimeslotOccurrenceToEvent(SALSA_CLASS, SALSA_TIMESLOT, OCCURRENCE_DATE);
  assert(e.title === "Level 1 Salsa", `title "${e.title}"`);
  assert(e.category === "arts", `category ${e.category}`);
  assert(e.sources[0]!.sourceId === "majestyinmotion-classes", `sourceId ${e.sources[0]!.sourceId}`);
  assert(e.isFree === false, "classes are paid");
});

test("mapTimeslotOccurrenceToEvent: venue + address for geocoding", () => {
  const e = mapTimeslotOccurrenceToEvent(SALSA_CLASS, SALSA_TIMESLOT, OCCURRENCE_DATE);
  assert(e.venue === "Majesty in Motion", `venue "${e.venue}"`);
  assert(e.address === "6380 El Cajon Blvd, San Diego, CA", `address "${e.address}"`);
});

test("mapTimeslotOccurrenceToEvent: named room is appended to venue", () => {
  const e = mapTimeslotOccurrenceToEvent(ASSISTED_CLASS, ASSISTED_TIMESLOT, OCCURRENCE_DATE);
  assert(e.venue === "Majesty in Motion (Studio A)", `venue "${e.venue}"`);
});

test("mapTimeslotOccurrenceToEvent: seconds_start/seconds_stop convert to LA-local start/end", () => {
  const e = mapTimeslotOccurrenceToEvent(SALSA_CLASS, SALSA_TIMESLOT, OCCURRENCE_DATE);
  // 2026-07-15 is within PDT (UTC-7): 66600s = 18:30, 70200s = 19:30.
  assert(e.startDatetime === "2026-07-15T18:30:00-07:00", `start "${e.startDatetime}"`);
  assert(e.endDatetime === "2026-07-15T19:30:00-07:00", `end "${e.endDatetime}"`);
});

test("mapTimeslotOccurrenceToEvent: single instructor → performersOrTeams", () => {
  const e = mapTimeslotOccurrenceToEvent(SALSA_CLASS, SALSA_TIMESLOT, OCCURRENCE_DATE);
  assert(e.performersOrTeams === "David Stein", `performers "${e.performersOrTeams}"`);
});

test("mapTimeslotOccurrenceToEvent: staff + assistant → both joined", () => {
  const e = mapTimeslotOccurrenceToEvent(ASSISTED_CLASS, ASSISTED_TIMESLOT, OCCURRENCE_DATE);
  assert(e.performersOrTeams === "David Stein, Jennifer Stein", `performers "${e.performersOrTeams}"`);
});

test("mapTimeslotOccurrenceToEvent: no staff assigned → performersOrTeams omitted", () => {
  const e = mapTimeslotOccurrenceToEvent(UNSTAFFED_CLASS, UNSTAFFED_TIMESLOT, OCCURRENCE_DATE);
  assert(e.performersOrTeams === undefined, `performers "${e.performersOrTeams}"`);
});

test("mapTimeslotOccurrenceToEvent: description is normalized and set", () => {
  const e = mapTimeslotOccurrenceToEvent(SALSA_CLASS, SALSA_TIMESLOT, OCCURRENCE_DATE);
  assert(
    e.description ===
      "This class is designed for all levels. In this beginner class, you will learn the basic Salsa steps and turns, along with rhythm, timing, lead, and follow techniques. No partner is needed!",
    `description "${e.description}"`
  );
});

test("mapTimeslotOccurrenceToEvent: empty description omitted", () => {
  const e = mapTimeslotOccurrenceToEvent(ASSISTED_CLASS, ASSISTED_TIMESLOT, OCCURRENCE_DATE);
  assert(e.description === undefined, `description "${e.description}"`);
});

test("mapTimeslotOccurrenceToEvent: stableId is deterministic for same class+time+venue", () => {
  const a = mapTimeslotOccurrenceToEvent(SALSA_CLASS, SALSA_TIMESLOT, OCCURRENCE_DATE);
  const b = mapTimeslotOccurrenceToEvent(SALSA_CLASS, SALSA_TIMESLOT, OCCURRENCE_DATE);
  assert(a.id === b.id, "ids match");
  assert(a.id.length === 16, `id length ${a.id.length}`);
});

test("mapTimeslotOccurrenceToEvent: different occurrence dates get different ids", () => {
  const a = mapTimeslotOccurrenceToEvent(SALSA_CLASS, SALSA_TIMESLOT, OCCURRENCE_DATE);
  const b = mapTimeslotOccurrenceToEvent(SALSA_CLASS, SALSA_TIMESLOT, { year: 2026, month: 7, day: 22 });
  assert(a.id !== b.id, "ids differ across dated occurrences");
});

// ============================================================================
// deriveTags
// ============================================================================

test("deriveTags: base + category tag", () => {
  const tags = deriveTags("Body Movement", "Enhance");
  assert(tags.includes("dance") && tags.includes("class"), `base tags ${tags.join(",")}`);
  assert(tags.includes("enhance"), `category tag ${tags.join(",")}`);
});

test("deriveTags: multi-word category is slugified", () => {
  const tags = deriveTags("Cha Cha Cha Footwork", "Cha Cha Cha");
  assert(tags.includes("cha-cha-cha"), `category tag ${tags.join(",")}`);
});

test("deriveTags: level tags from title", () => {
  assert(deriveTags("Level 1 Salsa", "Salsa").includes("beginner"), "level 1 → beginner");
  assert(deriveTags("Level 2 Bachata", "Bachata").includes("intermediate"), "level 2 → intermediate");
  assert(deriveTags("Level 3 Mambo (Salsa On2)", "Mambo").includes("advanced"), "level 3 → advanced");
});

test("deriveTags: team + youth/family tags", () => {
  assert(deriveTags("Bachata Ladies Team", "Bachata").includes("team"), "team tag");
  const kidsTags = deriveTags("FREE Kids Salsa/Bachata", "Enhance");
  assert(kidsTags.includes("youth") && kidsTags.includes("family"), `kids tags ${kidsTags.join(",")}`);
});

// ============================================================================
// normalizeWhitespace
// ============================================================================

test("normalizeWhitespace: collapses CRLF and repeated spaces", () => {
  const out = normalizeWhitespace("Line one.\r\nLine   two.\r\n\r\nLine three.");
  assert(out === "Line one. Line two. Line three.", `got "${out}"`);
});

// ============================================================================
// mapClassesResponseToEvents — end-to-end against the REAL captured fixture
// ============================================================================

const FIXTURE_PATH = resolve(dirname(fileURLToPath(import.meta.url)), "fixtures/memberlife-get-data.json");
const REAL_RESPONSE = JSON.parse(readFileSync(FIXTURE_PATH, "utf-8")) as MemberLifeGetDataResponse;

// 07-10-2026 is a Friday; a 7-day window covers Fri 07-10 .. Thu 07-16,
// giving Wednesday 07-15 as the single Wednesday in the window.
const WINDOW_START = { year: 2026, month: 7, day: 10 };

test("mapClassesResponseToEvents: real fixture has the documented shape (46 classes / 45 timeslots)", () => {
  let classCount = 0;
  let timeslotCount = 0;
  for (const arr of Object.values(REAL_RESPONSE.data.classes)) {
    for (const c of arr) {
      classCount++;
      timeslotCount += c.timeslots.length;
    }
  }
  assert(classCount === 46, `classCount ${classCount}`);
  assert(timeslotCount === 45, `timeslotCount ${timeslotCount}`);
});

test("mapClassesResponseToEvents: projects one occurrence per valid weekly timeslot over a 7-day window", () => {
  const events = mapClassesResponseToEvents(REAL_RESPONSE, WINDOW_START, 7);
  // 45 timeslots total, minus the 1 known stray day:7 timeslot (skipped, not projected).
  assertEqual(events.length, 44, `events.length ${events.length}`);
});

test("mapClassesResponseToEvents: day:7 stray is skipped, never crashes, and never appears", () => {
  const events = mapClassesResponseToEvents(REAL_RESPONSE, WINDOW_START, 7);
  const strayTitleHit = events.find((e) => e.title === "Royal Elegance Beginner Team");
  assert(strayTitleHit === undefined, "the day:7-only class produced no occurrence");
});

test("mapClassesResponseToEvents: Wednesday slice matches the known 8-class cross-validation anchor", () => {
  const events = mapClassesResponseToEvents(REAL_RESPONSE, WINDOW_START, 7);
  const wednesday = events.filter((e) => e.startDatetime.startsWith("2026-07-15"));
  assertEqual(
    wednesday.map((e) => e.title).sort(),
    [
      "Body Movement",
      "Level 1 Salsa",
      "Level 2 Salsa",
      "Bachata Ladies Team",
      "Level 1 Bachata",
      "Level 3 Bachata",
      "Mambo Intermediate Partner Team",
      "Mambo Technique Class",
    ].sort(),
    `Wednesday titles: ${wednesday.map((e) => e.title).join(", ")}`
  );
  assertEqual(wednesday.length, 8, `wednesday.length ${wednesday.length}`);
});

test("mapClassesResponseToEvents: every projected occurrence has an LA offset-aware startDatetime", () => {
  const events = mapClassesResponseToEvents(REAL_RESPONSE, WINDOW_START, 7);
  assert(events.length > 0, "has events");
  for (const e of events) {
    assert(
      /T\d{2}:\d{2}:\d{2}-0[78]:00$/.test(e.startDatetime),
      `startDatetime "${e.startDatetime}" is not a PDT/PST offset-aware ISO string`
    );
  }
});
