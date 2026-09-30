#!/usr/bin/env bun
/**
 * pike13.test.ts — unit tests for Pike13Adapter (Pike13 front API → EventItem).
 *
 * Asserts on inline Pike13 occurrence fixtures (no network):
 *   - mapOccurrenceToEvent: title, venue (with studio room), category arts,
 *     instructor → performersOrTeams, sourceId "cultureshock-sd", ticketUrl
 *     from the per-class …/e/<id> link, address set for geocoding
 *   - UTC start/end convert to LA local time
 *   - deriveTags: style + level + youth tags from the class name
 *   - stripHtml: collapses Pike13 rich-text into a plain one-liner
 *
 * Run: bun test ~/.claude/.claude/worktrees/arch-debt-d2-eventscout-buntest/skills/Productivity/EventScout/tests/pike13.test.ts
 */

import { test } from "bun:test";
import {
  mapOccurrenceToEvent,
  deriveTags,
  stripHtml,
} from "../Tools/adapters/Pike13Adapter.ts";
import type { Pike13Occurrence } from "../Tools/adapters/Pike13Adapter.ts";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}

// ============================================================================
// Fixtures (inline, no network) — shape mirrors Pike13 front API occurrences
// ============================================================================

/** Int. Hip Hop Choreography — 2026-06-06T01:30Z, Studio 1, two instructors */
const CLASS: Pike13Occurrence = {
  id: 265290277,
  event_id: 8482817,
  name: "Int. Hip Hop Choreography",
  description:
    "<b><p>A <span style=\"font-size:11pt\">fun &amp; sweaty</span> choreography class.</p></b>",
  location_id: 37073,
  start_at: "2026-06-06T01:30:00Z",
  end_at: "2026-06-06T02:30:00Z",
  url: "https://cultureshocksandiego.pike13.com/e/265290277",
  timezone: "America/Los_Angeles",
  state: "active",
  full: false,
  staff_members: [
    { id: 1, name: "Sean Memije" },
    { id: 2, name: "Paul Reed" },
  ],
  resources: [{ id: 10143, name: "Studio 1" }],
};

/** Youth class with no per-class url and no resource → falls back gracefully */
const YOUTH_CLASS: Pike13Occurrence = {
  id: 265290300,
  event_id: 8482900,
  name: "Youth Beg. Hip Hop (Ages 8-12)",
  location_id: 37073,
  start_at: "2026-06-07T17:00:00Z",
  state: "active",
  staff_members: [{ id: 3, name: "Jane Doe" }],
};

// ============================================================================
// Tests
// ============================================================================

console.log("\npike13.test.ts — Pike13Adapter (Pike13 front API → EventItem)\n");

test("mapOccurrenceToEvent: title, category, sourceId", () => {
  const e = mapOccurrenceToEvent(CLASS);
  assert(e.title === "Int. Hip Hop Choreography", `title "${e.title}"`);
  assert(e.category === "arts", `category ${e.category}`);
  assert(e.sources[0]!.sourceId === "cultureshock-sd", `sourceId ${e.sources[0]!.sourceId}`);
  assert(e.isFree === false, "classes are paid");
});

test("mapOccurrenceToEvent: venue includes the studio room + address", () => {
  const e = mapOccurrenceToEvent(CLASS);
  assert(e.venue === "Culture Shock Dance Studio (Studio 1)", `venue "${e.venue}"`);
  assert(e.address === "2110 Hancock St #200, San Diego, CA 92110", `address "${e.address}"`);
});

test("mapOccurrenceToEvent: instructors → performersOrTeams", () => {
  const e = mapOccurrenceToEvent(CLASS);
  assert(e.performersOrTeams === "Sean Memije, Paul Reed", `performers "${e.performersOrTeams}"`);
});

test("mapOccurrenceToEvent: ticketUrl uses the per-class registration link", () => {
  const e = mapOccurrenceToEvent(CLASS);
  assert(
    e.ticketUrl === "https://cultureshocksandiego.pike13.com/e/265290277",
    `ticketUrl ${e.ticketUrl}`
  );
});

test("mapOccurrenceToEvent: UTC start/end convert to LA local time", () => {
  const e = mapOccurrenceToEvent(CLASS);
  // 2026-06-06T01:30Z = 2026-06-05 18:30 PDT (UTC-7)
  assert(e.startDatetime.startsWith("2026-06-05T18:30"), `start "${e.startDatetime}"`);
  assert(e.endDatetime?.startsWith("2026-06-05T19:30") === true, `end "${e.endDatetime}"`);
});

test("mapOccurrenceToEvent: description is stripped of HTML", () => {
  const e = mapOccurrenceToEvent(CLASS);
  assert(e.description === "A fun & sweaty choreography class.", `description "${e.description}"`);
});

test("mapOccurrenceToEvent: missing url/resource fall back gracefully", () => {
  const e = mapOccurrenceToEvent(YOUTH_CLASS);
  assert(e.venue === "Culture Shock Dance Studio", `venue "${e.venue}"`);
  assert(
    e.ticketUrl === "https://cultureshocksandiego.org/hip-hop-class-schedule/",
    `ticketUrl falls back to schedule page, got ${e.ticketUrl}`
  );
  assert(e.endDatetime === undefined, "no end → endDatetime omitted");
});

test("deriveTags: style + level tags from the class name", () => {
  const tags = deriveTags("Int. Hip Hop Choreography");
  assert(tags.includes("dance") && tags.includes("class"), `base tags ${tags.join(",")}`);
  assert(tags.includes("hip-hop"), `hip-hop tag ${tags.join(",")}`);
  assert(tags.includes("choreography"), `choreography tag ${tags.join(",")}`);
  assert(tags.includes("intermediate"), `intermediate tag ${tags.join(",")}`);
});

test("deriveTags: youth/family tags on age-gated classes", () => {
  const tags = deriveTags("Youth Beg. Hip Hop (Ages 8-12)");
  assert(tags.includes("youth") && tags.includes("family"), `youth tags ${tags.join(",")}`);
  assert(tags.includes("beginner"), `beginner tag ${tags.join(",")}`);
});

test("stripHtml: collapses entities and whitespace", () => {
  const out = stripHtml("<p>Cardio&nbsp;Hip&nbsp;Hop &amp;   more</p>");
  assert(out === "Cardio Hip Hop & more", `got "${out}"`);
});

test("stableId is deterministic for the same class+time+venue", () => {
  const a = mapOccurrenceToEvent(CLASS);
  const b = mapOccurrenceToEvent(CLASS);
  assert(a.id === b.id, "ids match");
  assert(a.id.length === 16, `id length ${a.id.length}`);
});

