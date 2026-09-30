#!/usr/bin/env bun
/**
 * padres.test.ts — Slice 2 TDD unit tests for PadresAdapter.
 *
 * Tests mapGameToEvent() against inline fixture objects (NO network).
 * Asserts:
 *   - Home game title: "Padres vs <Opponent>"
 *   - Away game title: "Padres @ <Opponent>"
 *   - category === "sports"
 *   - sources[0].sourceId === "padres-mlb"
 *   - status mapping (Preview→scheduled, Final/Cancelled→cancelled, Postponed→postponed)
 *   - startDatetime parses to a valid Date AND reflects correct LA local hour for a known UTC input
 *
 * Run:
 *   bun test ~/.claude/.claude/worktrees/arch-debt-d2-eventscout-buntest/skills/Productivity/EventScout/tests/padres.test.ts
 */

import { test } from "bun:test";
import { mapGameToEvent } from "../Tools/adapters/PadresAdapter.ts";
import type { MlbGame } from "../Tools/adapters/PadresAdapter.ts";

// ============================================================================
// Test harness
// ============================================================================

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

// ============================================================================
// Fixture data (inline, no network)
// ============================================================================

/** Home game: Padres (135) as home team vs Dodgers */
const HOME_GAME: MlbGame = {
  gamePk: 800001,
  gameDate: "2026-06-15T19:40:00Z",
  status: {
    abstractGameState: "Preview",
    detailedState: "Scheduled",
  },
  teams: {
    away: {
      team: { id: 119, name: "Los Angeles Dodgers" },
    },
    home: {
      team: { id: 135, name: "San Diego Padres" },
    },
  },
  venue: {
    id: 2680,
    name: "Petco Park",
  },
};

/** Away game: Padres (135) as away team @ Nationals */
const AWAY_GAME: MlbGame = {
  gamePk: 800002,
  gameDate: "2026-05-31T17:35:00Z",
  status: {
    abstractGameState: "Live",
    detailedState: "In Progress",
  },
  teams: {
    away: {
      team: { id: 135, name: "San Diego Padres" },
    },
    home: {
      team: { id: 120, name: "Washington Nationals" },
    },
  },
  venue: {
    id: 3309,
    name: "Nationals Park",
  },
};

/** Cancelled game fixture */
const CANCELLED_GAME: MlbGame = {
  gamePk: 800003,
  gameDate: "2026-07-01T22:10:00Z",
  status: {
    abstractGameState: "Final",
    detailedState: "Cancelled",
  },
  teams: {
    away: {
      team: { id: 119, name: "Los Angeles Dodgers" },
    },
    home: {
      team: { id: 135, name: "San Diego Padres" },
    },
  },
  venue: {
    id: 2680,
    name: "Petco Park",
  },
};

/** Postponed game fixture */
const POSTPONED_GAME: MlbGame = {
  gamePk: 800004,
  gameDate: "2026-07-04T22:10:00Z",
  status: {
    abstractGameState: "Final",
    detailedState: "Postponed",
  },
  teams: {
    away: {
      team: { id: 119, name: "Los Angeles Dodgers" },
    },
    home: {
      team: { id: 135, name: "San Diego Padres" },
    },
  },
  venue: {
    id: 2680,
    name: "Petco Park",
  },
};

// ============================================================================
// Tests
// ============================================================================

test("1. Home game title: 'Padres vs <Opponent>'", () => {
  const event = mapGameToEvent(HOME_GAME);
  assert(
    event.title === "Padres vs Los Angeles Dodgers",
    `Expected "Padres vs Los Angeles Dodgers", got "${event.title}"`
  );
});

test("2. Away game title: 'Padres @ <Opponent>'", () => {
  const event = mapGameToEvent(AWAY_GAME);
  assert(
    event.title === "Padres @ Washington Nationals",
    `Expected "Padres @ Washington Nationals", got "${event.title}"`
  );
});

test("3. performersOrTeams carries the matchup", () => {
  const home = mapGameToEvent(HOME_GAME);
  assert(
    home.performersOrTeams === "Padres vs Los Angeles Dodgers",
    `Home performersOrTeams wrong: "${home.performersOrTeams}"`
  );
  const away = mapGameToEvent(AWAY_GAME);
  assert(
    away.performersOrTeams === "Padres @ Washington Nationals",
    `Away performersOrTeams wrong: "${away.performersOrTeams}"`
  );
});

test("4. category === 'sports'", () => {
  const event = mapGameToEvent(HOME_GAME);
  assert(event.category === "sports", `Expected "sports", got "${event.category}"`);
});

test("5. sources[0].sourceId === 'padres-mlb'", () => {
  const event = mapGameToEvent(HOME_GAME);
  assert(
    event.sources.length >= 1,
    `Expected at least 1 source, got ${event.sources.length}`
  );
  assert(
    event.sources[0].sourceId === "padres-mlb",
    `Expected sourceId "padres-mlb", got "${event.sources[0].sourceId}"`
  );
});

test("6. status: Preview→scheduled", () => {
  const event = mapGameToEvent(HOME_GAME);
  assert(
    event.status === "scheduled",
    `Expected "scheduled" for Preview, got "${event.status}"`
  );
});

test("7. status: Live/In Progress→scheduled", () => {
  const event = mapGameToEvent(AWAY_GAME);
  assert(
    event.status === "scheduled",
    `Expected "scheduled" for In Progress, got "${event.status}"`
  );
});

test("8. status: Final/Cancelled→cancelled", () => {
  const event = mapGameToEvent(CANCELLED_GAME);
  assert(
    event.status === "cancelled",
    `Expected "cancelled" for Final/Cancelled, got "${event.status}"`
  );
});

test("9. status: Final/Postponed→postponed", () => {
  const event = mapGameToEvent(POSTPONED_GAME);
  assert(
    event.status === "postponed",
    `Expected "postponed" for Final/Postponed, got "${event.status}"`
  );
});

test("10. startDatetime parses to a valid Date", () => {
  const event = mapGameToEvent(HOME_GAME);
  const parsed = new Date(event.startDatetime);
  assert(!isNaN(parsed.getTime()), `"${event.startDatetime}" did not parse to valid Date`);
});

test("11. startDatetime reflects correct LA local time for known UTC input", () => {
  // HOME_GAME: gameDate = "2026-06-15T19:40:00Z"
  // America/Los_Angeles in June is PDT = UTC-7
  // Expected local time: 12:40 PM PDT
  // Verifiable: the offset in the ISO string should be -07:00 (PDT)
  // and the local hour should be 12.
  const event = mapGameToEvent(HOME_GAME);
  const dt = event.startDatetime;

  // Must contain a UTC offset (not 'Z')
  assert(
    !dt.endsWith("Z"),
    `startDatetime should have explicit offset, not Z: "${dt}"`
  );

  // Parse the offset from the string: last +/-HH:MM or -HH:MM
  const offsetMatch = dt.match(/([+-]\d{2}):(\d{2})$/);
  assert(
    offsetMatch !== null,
    `startDatetime missing UTC offset: "${dt}"`
  );

  const offsetHours = parseInt(offsetMatch![1], 10);
  // June in LA = PDT = UTC-7
  assert(
    offsetHours === -7,
    `Expected PDT offset -7, got ${offsetHours} in "${dt}"`
  );

  // The local hour embedded in the string: "2026-06-15T12:40:00-07:00"
  const hourMatch = dt.match(/T(\d{2}):\d{2}:\d{2}/);
  assert(hourMatch !== null, `Cannot extract local hour from "${dt}"`);
  const localHour = parseInt(hourMatch![1], 10);
  assert(
    localHour === 12,
    `Expected local hour 12 (12:40 PM PDT), got ${localHour} in "${dt}"`
  );
});

test("12. allDay === false", () => {
  const event = mapGameToEvent(HOME_GAME);
  assert(event.allDay === false, `Expected allDay=false, got ${event.allDay}`);
});

test("13. isFree === false", () => {
  const event = mapGameToEvent(HOME_GAME);
  assert(event.isFree === false, `Expected isFree=false, got ${event.isFree}`);
});

test("14. tags include 'mlb' and 'baseball'", () => {
  const event = mapGameToEvent(HOME_GAME);
  assert(event.tags.includes("mlb"), `Missing "mlb" tag: ${JSON.stringify(event.tags)}`);
  assert(event.tags.includes("baseball"), `Missing "baseball" tag: ${JSON.stringify(event.tags)}`);
});

test("15. venue populated from game.venue.name", () => {
  const event = mapGameToEvent(HOME_GAME);
  assert(
    event.venue === "Petco Park",
    `Expected "Petco Park", got "${event.venue}"`
  );
});

test("16. id is a non-empty string (stable hash)", () => {
  const event = mapGameToEvent(HOME_GAME);
  assert(typeof event.id === "string" && event.id.length > 0, `id is empty or not a string`);
  // Calling again with same input should produce the same id (deterministic)
  const event2 = mapGameToEvent(HOME_GAME);
  assert(event.id === event2.id, `id is not deterministic: ${event.id} vs ${event2.id}`);
});
