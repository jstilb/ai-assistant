#!/usr/bin/env bun
/**
 * cache.test.ts — Slice 1 TDD test for EventScout Cache module.
 *
 * Tests:
 *   1. Round-trip: write EventItem[] → read back → deep equal.
 *   2. pruneExpired: past event removed, future event kept.
 *
 * Env isolation: Cache.ts's module (via Tools/types.ts) computes
 * DEFAULT_CACHE_PATH from KAYA_HOME/KAYA_DIR at import time, falling back to
 * `${HOME}/.claude` — the LIVE main tree — when unset. EVENTSCOUT_CACHE_PATH
 * always overrides that default at call time, but per the hazard class
 * documented in project_eventscout_gotchas, KAYA_HOME/KAYA_DIR are pinned to
 * a mkdtempSync dir BEFORE Cache.ts is ever imported (via dynamic import),
 * so the module-level constant never captures a real-tree path even
 * transiently, and restored in afterAll for the shared bun:test process.
 *
 * Run:
 *   bun test ~/.claude/.claude/worktrees/arch-debt-d2-eventscout-buntest/skills/Productivity/EventScout/tests/cache.test.ts
 */

import { test, afterAll } from "bun:test";
import { existsSync, unlinkSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { EventItem } from "../Tools/types.ts";

// ============================================================================
// Env isolation — pin KAYA_HOME/KAYA_DIR to a scratch dir BEFORE importing
// any Tools module that resolves paths at module-init time.
// ============================================================================

const ORIGINAL_KAYA_HOME = process.env["KAYA_HOME"];
const ORIGINAL_KAYA_DIR = process.env["KAYA_DIR"];

const TEST_KAYA_HOME = mkdtempSync(join(tmpdir(), "eventscout-cache-test-"));
process.env["KAYA_HOME"] = TEST_KAYA_HOME;
process.env["KAYA_DIR"] = TEST_KAYA_HOME;

const TEMP_CACHE_PATH = join(TEST_KAYA_HOME, "events-cache.json");
process.env["EVENTSCOUT_CACHE_PATH"] = TEMP_CACHE_PATH;

const { writeEvents, readEvents, pruneExpired, upsertEventsDeduped } = await import("../Tools/Cache.ts");

afterAll(() => {
  if (ORIGINAL_KAYA_HOME === undefined) delete process.env["KAYA_HOME"];
  else process.env["KAYA_HOME"] = ORIGINAL_KAYA_HOME;
  if (ORIGINAL_KAYA_DIR === undefined) delete process.env["KAYA_DIR"];
  else process.env["KAYA_DIR"] = ORIGINAL_KAYA_DIR;
  delete process.env["EVENTSCOUT_CACHE_PATH"];
  rmSync(TEST_KAYA_HOME, { recursive: true, force: true });
});

// ============================================================================
// Test harness
// ============================================================================

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function cleanup(): void {
  if (existsSync(TEMP_CACHE_PATH)) {
    unlinkSync(TEMP_CACHE_PATH);
  }
}

// ============================================================================
// Fixture data
// ============================================================================

const PAST_DATE = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(); // 7 days ago
const FUTURE_DATE = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(); // 7 days ahead

const pastEvent: EventItem = {
  id: "past-event-001",
  title: "Padres vs Dodgers (Past)",
  startDatetime: PAST_DATE,
  endDatetime: PAST_DATE,
  allDay: false,
  venue: "Petco Park",
  address: "100 Park Blvd, San Diego, CA 92101",
  category: "sports",
  tags: ["baseball", "mlb"],
  isFree: false,
  priceMin: 25,
  priceMax: 150,
  currency: "USD",
  ticketUrl: "https://www.mlb.com/padres/tickets",
  sourceUrl: "https://www.mlb.com/padres/schedule",
  sources: [{ sourceId: "padres-mlb", url: "https://www.mlb.com/padres/schedule" }],
  performersOrTeams: "Padres vs Dodgers",
  description: "A past game.",
  fetchedAt: PAST_DATE,
  status: "scheduled",
};

const futureEvent: EventItem = {
  id: "future-event-001",
  title: "Open Mic Night",
  startDatetime: FUTURE_DATE,
  allDay: false,
  venue: "The Comedy Store La Jolla",
  address: "916 Pearl St, La Jolla, CA 92037",
  category: "comedy",
  tags: ["standup", "open-mic"],
  isFree: true,
  sourceUrl: "https://thecomedystore.com/la-jolla/calendar",
  sources: [{ sourceId: "comedy-store-la-jolla", url: "https://thecomedystore.com/la-jolla/calendar" }],
  fetchedAt: new Date().toISOString(),
  status: "scheduled",
};

const testEvents: EventItem[] = [pastEvent, futureEvent];

// ============================================================================
// Tests
// ============================================================================

// Setup: clean slate
cleanup();

test("1. writeEvents + readEvents: round-trip is lossless", () => {
  writeEvents(testEvents);
  const loaded = readEvents();
  assert(loaded.length === 2, `Expected 2 events, got ${loaded.length}`);
  assert(
    deepEqual(loaded[0], testEvents[0]),
    "First event deep equal failed"
  );
  assert(
    deepEqual(loaded[1], testEvents[1]),
    "Second event deep equal failed"
  );
});

test("2. pruneExpired: removes past event, keeps future event", () => {
  // Ensure we have both events written
  writeEvents(testEvents);

  const now = new Date();
  pruneExpired(now);

  const remaining = readEvents();
  assert(remaining.length === 1, `Expected 1 event after prune, got ${remaining.length}`);
  assert(remaining[0].id === "future-event-001", `Expected future-event-001, got ${remaining[0].id}`);
  assert(
    !remaining.some((e: EventItem) => e.id === "past-event-001"),
    "Past event should have been pruned"
  );
});

test("3. pruneExpired: event with only startDatetime (past) is pruned", () => {
  const eventWithNoEnd: EventItem = {
    id: "no-end-past-001",
    title: "Old Event No End",
    startDatetime: PAST_DATE,
    allDay: true,
    category: "community",
    tags: [],
    isFree: true,
    sourceUrl: "https://example.com",
    sources: [{ sourceId: "test-src", url: "https://example.com" }],
    fetchedAt: PAST_DATE,
    status: "scheduled",
  };
  const eventWithFutureStart: EventItem = {
    id: "no-end-future-001",
    title: "Future Event No End",
    startDatetime: FUTURE_DATE,
    allDay: true,
    category: "community",
    tags: [],
    isFree: true,
    sourceUrl: "https://example.com",
    sources: [{ sourceId: "test-src", url: "https://example.com" }],
    fetchedAt: new Date().toISOString(),
    status: "scheduled",
  };

  writeEvents([eventWithNoEnd, eventWithFutureStart]);
  pruneExpired(new Date());

  const remaining = readEvents();
  assert(remaining.length === 1, `Expected 1 event, got ${remaining.length}`);
  assert(remaining[0].id === "no-end-future-001", `Expected no-end-future-001, got ${remaining[0].id}`);
});

test("4. upsertEventsDeduped: collapses a cross-source twin already in the cache", () => {
  cleanup();
  // A twin of the SAME real show already sits in the cache from an earlier run,
  // under a different id + source (so upsert-by-id can't see it).
  const existing: EventItem = {
    id: "tycho-songkick",
    title: "Tycho at The Observatory North Park",
    startDatetime: FUTURE_DATE,
    allDay: false,
    venue: "The Observatory North Park",
    category: "music",
    tags: ["electronic"],
    isFree: false,
    sourceUrl: "https://songkick.com/tycho",
    sources: [{ sourceId: "songkick", url: "https://songkick.com/tycho" }],
    fetchedAt: new Date().toISOString(),
    status: "scheduled",
  };
  writeEvents([existing]);

  // Now a fresh refresh brings the same show from a different source/id.
  const incoming: EventItem = {
    id: "tycho-bandsintown",
    title: "Tycho @ Observatory",
    startDatetime: FUTURE_DATE,
    allDay: false,
    venue: "The Observatory",
    category: "music",
    tags: ["indie"],
    isFree: false,
    sourceUrl: "https://bandsintown.com/tycho",
    sources: [{ sourceId: "bandsintown", url: "https://bandsintown.com/tycho" }],
    fetchedAt: new Date().toISOString(),
    status: "scheduled",
  };
  upsertEventsDeduped([incoming]);

  const after = readEvents();
  assert(after.length === 1, `Expected the cross-source twin to collapse to 1, got ${after.length}`);
  const sourceIds = after[0].sources.map((s) => s.sourceId).sort();
  assert(
    sourceIds.length === 2 && sourceIds.includes("songkick") && sourceIds.includes("bandsintown"),
    `Expected both sources unioned, got ${JSON.stringify(sourceIds)}`
  );
});

test("5. upsertEventsDeduped: distinct events are preserved (no over-merge)", () => {
  cleanup();
  writeEvents([pastEvent]);
  upsertEventsDeduped([futureEvent]);
  const after = readEvents();
  assert(after.length === 2, `Expected 2 distinct events preserved, got ${after.length}`);
});

// ============================================================================
// api-tier exemption (2026-07-10) — integration proof against the REAL
// sources.json (this file sets no EVENTSCOUT_SOURCES_PATH override, so
// upsertEventsDeduped's loadApiTierSourceIds() reads the actual
// Tools/sources.json, where "padres-mlb" is fetchTier "api"). Two same-
// day/venue api-tier events with short titles that WOULD fuzzy-merge
// (tokenize drops "1"/"2") must survive the whole-cache re-dedup pass.
// ============================================================================

test("6. upsertEventsDeduped: api-tier events (padres-mlb) survive the whole-cache re-dedup", () => {
  cleanup();
  const gameOne: EventItem = {
    id: "padres-doubleheader-g1",
    title: "Padres Game 1",
    startDatetime: FUTURE_DATE,
    allDay: false,
    venue: "Petco Park",
    category: "sports",
    tags: ["mlb"],
    isFree: false,
    sourceUrl: "https://www.mlb.com/padres/schedule",
    sources: [{ sourceId: "padres-mlb", url: "https://www.mlb.com/padres/schedule" }],
    fetchedAt: new Date().toISOString(),
    status: "scheduled",
  };
  const gameTwo: EventItem = {
    ...gameOne,
    id: "padres-doubleheader-g2",
    title: "Padres Game 2",
  };
  writeEvents([gameOne]);
  upsertEventsDeduped([gameTwo]);
  const after = readEvents();
  assert(
    after.length === 2,
    `api-tier events must not be fuzzy-collapsed by the whole-cache re-dedup pass (got ${after.length})`
  );
});
