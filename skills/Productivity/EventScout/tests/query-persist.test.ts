#!/usr/bin/env bun
/**
 * query-persist.test.ts — regression tests for queryHybrid's persist step.
 *
 * Root cause being guarded: queryHybrid used to call ingestSource() at query
 * time, log the count, then DISCARD the fetched events — readEvents() only ever
 * saw the on-disk cache (written solely by prefetch). So live-refreshed events
 * (incl. highValue sources like Eventbrite) never reached ranking.
 *
 * The fix extracts persistRefreshedEvents(events) — dedup → geo-enrich → upsert,
 * mirroring the prefetch write tail — and calls it after the refresh loop.
 *
 * These tests pin the contract:
 *   1. Refreshed events are MERGED into the cache (existing events survive).
 *   2. Upsert-by-id semantics: a refreshed event replaces an existing same-id one.
 *   3. Empty input is a no-op (returns 0, cache untouched).
 *
 * Fixtures carry lat/lng so enrichWithGeo is a no-op (no Nominatim network call).
 *
 * Env isolation: Cache.ts AND Query.ts (which transitively pulls in
 * SourceManager.ts, Ranker.ts, InterestProfile.ts, etc.) both resolve
 * Tools/types.ts's module-level DEFAULT_CACHE_PATH from KAYA_HOME/KAYA_DIR at
 * import time, falling back to `${HOME}/.claude` — the LIVE main tree — when
 * unset. EVENTSCOUT_CACHE_PATH/EVENTSCOUT_GEOCACHE_PATH always override that
 * default at call time, but per the hazard class documented in
 * project_eventscout_gotchas, KAYA_HOME/KAYA_DIR are pinned to a mkdtempSync
 * dir BEFORE Cache.ts/Query.ts are ever imported (via dynamic import), and
 * restored in afterAll for the shared bun:test process.
 *
 * Run:
 *   bun test ~/.claude/.claude/worktrees/arch-debt-d2-eventscout-buntest/skills/Productivity/EventScout/tests/query-persist.test.ts
 */

import { test, afterAll } from "bun:test";
import { existsSync, rmSync, mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { EventItem } from "../Tools/types.ts";

// ============================================================================
// Env isolation — pin KAYA_HOME/KAYA_DIR AND scope cache/geocache to a
// mkdtempSync dir BEFORE importing any Tools module that resolves paths at
// module-init time.
// ============================================================================

const ORIGINAL_KAYA_HOME = process.env["KAYA_HOME"];
const ORIGINAL_KAYA_DIR = process.env["KAYA_DIR"];

const TEST_KAYA_HOME = mkdtempSync(join(tmpdir(), "eventscout-query-persist-test-"));
process.env["KAYA_HOME"] = TEST_KAYA_HOME;
process.env["KAYA_DIR"] = TEST_KAYA_HOME;

const TMP_CACHE = join(TEST_KAYA_HOME, "events-cache.json");
const TMP_GEOCACHE = join(TEST_KAYA_HOME, "venue-cache.json");
process.env["EVENTSCOUT_CACHE_PATH"] = TMP_CACHE;
process.env["EVENTSCOUT_GEOCACHE_PATH"] = TMP_GEOCACHE;

const { writeEvents, readEvents } = await import("../Tools/Cache.ts");
const { persistRefreshedEvents } = await import("../Tools/Query.ts");

afterAll(() => {
  if (ORIGINAL_KAYA_HOME === undefined) delete process.env["KAYA_HOME"];
  else process.env["KAYA_HOME"] = ORIGINAL_KAYA_HOME;
  if (ORIGINAL_KAYA_DIR === undefined) delete process.env["KAYA_DIR"];
  else process.env["KAYA_DIR"] = ORIGINAL_KAYA_DIR;
  delete process.env["EVENTSCOUT_CACHE_PATH"];
  delete process.env["EVENTSCOUT_GEOCACHE_PATH"];
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

function cleanup(): void {
  for (const p of [TMP_CACHE, TMP_GEOCACHE]) {
    if (existsSync(p)) rmSync(p);
  }
}

// ============================================================================
// Fixtures — lat/lng present so enrichWithGeo is a no-op (hermetic, no network)
// ============================================================================

function makeEvent(id: string, overrides: Partial<EventItem> = {}): EventItem {
  return {
    id,
    title: `Event ${id}`,
    startDatetime: "2026-06-10T19:00:00",
    allDay: false,
    venue: "Some Venue",
    lat: 32.7157,
    lng: -117.1611,
    category: "community",
    tags: [],
    isFree: false,
    sourceUrl: "https://example.com/e/" + id,
    sources: [{ sourceId: "eventbrite-sd", url: "https://example.com/e/" + id }],
    fetchedAt: "2026-06-05T12:00:00Z",
    status: "scheduled",
    ...overrides,
  };
}

// ============================================================================
// Tests
// ============================================================================

test("Test 1: refreshed events merge into the cache; existing survive", async () => {
  cleanup();
  writeEvents([makeEvent("existing-1"), makeEvent("existing-2")]);

  const written = await persistRefreshedEvents([
    makeEvent("fresh-1"),
    makeEvent("fresh-2"),
  ]);

  const afterMerge = readEvents();
  const ids = new Set(afterMerge.map((e) => e.id));
  assert(written === 2, `persistRefreshedEvents returns count of persisted (got ${written})`);
  assert(ids.has("existing-1") && ids.has("existing-2"), "existing cache events survive (not wiped)");
  assert(ids.has("fresh-1") && ids.has("fresh-2"), "refreshed events are now in the cache");
  assert(afterMerge.length === 4, `cache has all 4 events (got ${afterMerge.length})`);
});

test("Test 2: upsert-by-id — refreshed event replaces existing same-id", async () => {
  cleanup();
  writeEvents([makeEvent("dup-1", { title: "OLD TITLE" })]);
  await persistRefreshedEvents([makeEvent("dup-1", { title: "NEW TITLE" })]);
  const afterUpsert = readEvents();
  assert(afterUpsert.length === 1, `same-id upsert does not duplicate (got ${afterUpsert.length})`);
  assert(afterUpsert[0]?.title === "NEW TITLE", "refreshed event wins on id collision");
});

test("Test 3: empty input is a no-op", async () => {
  cleanup();
  writeEvents([makeEvent("keep-1")]);
  const zero = await persistRefreshedEvents([]);
  const afterEmpty = readEvents();
  assert(zero === 0, `empty input returns 0 (got ${zero})`);
  assert(afterEmpty.length === 1 && afterEmpty[0]?.id === "keep-1", "empty input leaves cache untouched");
});

// ============================================================================
// api-tier exemption (2026-07-10) — integration proof that persistRefreshedEvents
// is wired to the REAL sources.json (no EVENTSCOUT_SOURCES_PATH override in this
// file, so loadApiTierSourceIds() reads the actual Tools/sources.json, where
// "majestyinmotion-classes" is fetchTier "api"). Root cause: this function's own
// dedupeAndMerge(events) call — BEFORE anything touches the cache — is where a
// freshly-fetched batch of api-tier events (e.g. MemberLifeAdapter's 44 class
// occurrences) first got fuzzy-collapsed.
// ============================================================================

function makeApiEvent(id: string, title: string, overrides: Partial<EventItem> = {}): EventItem {
  return makeEvent(id, {
    title,
    venue: "Majesty in Motion (Studio A)",
    performersOrTeams: "Carlos Rivera",
    sources: [{ sourceId: "majestyinmotion-classes", url: "https://member.life/majestyinmotion/schedule" }],
    ...overrides,
  });
}

test("Test 4 (api-tier): same-day/venue/instructor api-tier batch is NOT fuzzy-collapsed", async () => {
  cleanup();
  const written = await persistRefreshedEvents([
    makeApiEvent("ml-level1", "Level 1 Salsa"),
    makeApiEvent("ml-level2", "Level 2 Salsa"),
  ]);
  const after = readEvents();
  assert(written === 2, `persistRefreshedEvents reports 2 persisted (got ${written})`);
  assert(after.length === 2, `Both class occurrences survive in the cache (got ${after.length})`);
  const ids = new Set(after.map((e) => e.id));
  assert(ids.has("ml-level1") && ids.has("ml-level2"), "Both stableIds present");
});

test("Test 5 (api-tier): double refresh of the same batch does not duplicate (exact-id upsert)", async () => {
  cleanup();
  const batch = [
    makeApiEvent("ml-level1", "Level 1 Salsa"),
    makeApiEvent("ml-level2", "Level 2 Salsa"),
  ];
  await persistRefreshedEvents(batch);
  await persistRefreshedEvents(batch); // simulate a second refresh returning the same occurrences
  const after = readEvents();
  assert(
    after.length === 2,
    `Refreshing the same api-tier batch twice must not duplicate (got ${after.length})`
  );
});
