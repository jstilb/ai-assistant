#!/usr/bin/env bun
/**
 * sdfc.test.ts — unit tests for SdfcAdapter (ESPN → EventItem, no network).
 *
 * Asserts on inline ESPN scoreboard fixtures:
 *   - isSdfcHome: true for an SDFC home event, false for an away event
 *   - mapMatchToEvent: title "San Diego FC vs <Opponent>", venue, category sports,
 *     tags [mls, soccer], sourceId "sandiego-fc", ticketUrl from the ESPN link
 *   - status mapping (scheduled / cancelled / postponed)
 *   - startDatetime is converted to LA local time (UTC kickoff → PT)
 *
 * Run: bun test ~/.claude/.claude/worktrees/arch-debt-d2-eventscout-buntest/skills/Productivity/EventScout/tests/sdfc.test.ts
 */

import { test } from "bun:test";
import { mapMatchToEvent, isSdfcHome } from "../Tools/adapters/SdfcAdapter.ts";
import type { EspnEvent } from "../Tools/adapters/SdfcAdapter.ts";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}

// ============================================================================
// Fixtures (inline, no network) — shape mirrors ESPN's scoreboard events
// ============================================================================

const SDFC_ID = "22529";

/** SDFC home match vs FC Dallas at Snapdragon — kickoff 2026-07-26T01:30Z (UTC) */
const HOME_MATCH: EspnEvent = {
  id: "761449",
  date: "2026-07-26T01:30Z",
  competitions: [
    {
      venue: { fullName: "Snapdragon Stadium" },
      status: { type: { name: "STATUS_SCHEDULED" } },
      competitors: [
        { homeAway: "home", team: { id: SDFC_ID, displayName: "San Diego FC" } },
        { homeAway: "away", team: { id: "999", displayName: "FC Dallas" } },
      ],
    },
  ],
  links: [{ href: "https://www.espn.com/soccer/match/_/gameId/761449/fc-dallas-san-diego-fc" }],
  status: { type: { name: "STATUS_SCHEDULED" } },
};

/** SDFC AWAY match (LA Galaxy home) — must be filtered out */
const AWAY_MATCH: EspnEvent = {
  id: "761500",
  date: "2026-08-01T02:30Z",
  competitions: [
    {
      venue: { fullName: "Dignity Health Sports Park" },
      status: { type: { name: "STATUS_SCHEDULED" } },
      competitors: [
        { homeAway: "home", team: { id: "187", displayName: "LA Galaxy" } },
        { homeAway: "away", team: { id: SDFC_ID, displayName: "San Diego FC" } },
      ],
    },
  ],
  status: { type: { name: "STATUS_SCHEDULED" } },
};

// ============================================================================
// Tests
// ============================================================================

test("isSdfcHome true for a home match", () => {
  assert(isSdfcHome(HOME_MATCH) === true, "home match recognized");
});

test("isSdfcHome false for an away match", () => {
  assert(isSdfcHome(AWAY_MATCH) === false, "away match excluded");
});

test("mapMatchToEvent: title is 'San Diego FC vs <opponent>'", () => {
  const e = mapMatchToEvent(HOME_MATCH);
  assert(e.title === "San Diego FC vs FC Dallas", `got "${e.title}"`);
});

test("mapMatchToEvent: venue, category, tags, sourceId", () => {
  const e = mapMatchToEvent(HOME_MATCH);
  assert(e.venue === "Snapdragon Stadium", `venue "${e.venue}"`);
  assert(e.category === "sports", `category ${e.category}`);
  assert(e.tags.includes("mls") && e.tags.includes("soccer"), `tags ${e.tags.join(",")}`);
  assert(e.sources[0]!.sourceId === "sandiego-fc", `sourceId ${e.sources[0]!.sourceId}`);
  assert(e.performersOrTeams === "San Diego FC vs FC Dallas", "performersOrTeams set");
});

test("mapMatchToEvent: ticketUrl uses the ESPN match link", () => {
  const e = mapMatchToEvent(HOME_MATCH);
  assert(e.ticketUrl === "https://www.espn.com/soccer/match/_/gameId/761449/fc-dallas-san-diego-fc", `ticketUrl ${e.ticketUrl}`);
});

test("mapMatchToEvent: UTC kickoff converts to LA local time", () => {
  const e = mapMatchToEvent(HOME_MATCH);
  // 2026-07-26T01:30Z = 2026-07-25 18:30 PDT (UTC-7)
  assert(e.startDatetime.startsWith("2026-07-25T18:30"), `startDatetime "${e.startDatetime}" should be 2026-07-25 18:30 PT`);
});

test("status mapping: cancelled / postponed", () => {
  const cancelled = mapMatchToEvent({ ...HOME_MATCH, status: { type: { name: "STATUS_CANCELED" } } });
  assert(cancelled.status === "cancelled", `cancelled → ${cancelled.status}`);
  const postponed = mapMatchToEvent({ ...HOME_MATCH, status: { type: { name: "STATUS_POSTPONED" } } });
  assert(postponed.status === "postponed", `postponed → ${postponed.status}`);
  const scheduled = mapMatchToEvent(HOME_MATCH);
  assert(scheduled.status === "scheduled", `scheduled → ${scheduled.status}`);
});
