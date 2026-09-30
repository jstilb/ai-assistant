#!/usr/bin/env bun
/**
 * geocoder.test.ts — Slice 5 TDD unit tests for Geocoder.ts
 *
 * All tests are deterministic (cache-only, no network) except where noted.
 *
 * Test scenarios:
 *   1. Cache hit path: pre-seeded cache → geocodeVenue returns cached coords,
 *      and does NOT call network (fetch monkey-patched to throw).
 *   2. enrichWithGeo:
 *      (a) event with matching venue → gets lat/lng from cache.
 *      (b) event already has coords → unchanged.
 *      (c) event has no venue → coords-less.
 *   3. Query construction: buildNominatimQuery uses hint or default "San Diego, CA".
 *   4. Cache negative: venue→null cached → no network call on repeat.
 *
 * Env isolation: Geocoder.ts only has a type-only import from Tools/types.ts
 * (no runtime module evaluation) and resolves its geocache path from
 * EVENTSCOUT_GEOCACHE_PATH (always set per-test below) or, failing that, a
 * path relative to its own file location (never KAYA_HOME) — it has no
 * actual KAYA_HOME coupling. KAYA_HOME/KAYA_DIR are still pinned to a
 * mkdtempSync dir before the dynamic import, as defense-in-depth for the
 * shared bun:test process (project_eventscout_gotchas hazard class), and
 * restored in afterAll.
 *
 * Run:
 *   bun test ~/.claude/.claude/worktrees/arch-debt-d2-eventscout-buntest/skills/Productivity/EventScout/tests/geocoder.test.ts
 */

import { test, afterAll } from "bun:test";
import { existsSync, unlinkSync, writeFileSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { EventItem } from "../Tools/types.ts";

// ============================================================================
// Env isolation — pin KAYA_HOME/KAYA_DIR before importing Tools code.
// ============================================================================

const ORIGINAL_KAYA_HOME = process.env["KAYA_HOME"];
const ORIGINAL_KAYA_DIR = process.env["KAYA_DIR"];

const TEST_KAYA_HOME = mkdtempSync(join(tmpdir(), "eventscout-geocoder-test-"));
process.env["KAYA_HOME"] = TEST_KAYA_HOME;
process.env["KAYA_DIR"] = TEST_KAYA_HOME;

const { geocodeVenue, enrichWithGeo, buildNominatimQuery, buildGeoQuery } = await import(
  "../Tools/Geocoder.ts"
);

afterAll(() => {
  if (ORIGINAL_KAYA_HOME === undefined) delete process.env["KAYA_HOME"];
  else process.env["KAYA_HOME"] = ORIGINAL_KAYA_HOME;
  if (ORIGINAL_KAYA_DIR === undefined) delete process.env["KAYA_DIR"];
  else process.env["KAYA_DIR"] = ORIGINAL_KAYA_DIR;
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

// ============================================================================
// Temp cache path for these tests
// ============================================================================

const TEMP_GEOCACHE = join(TEST_KAYA_HOME, "geocoder-test.json");

function cleanupGeoCache(): void {
  if (existsSync(TEMP_GEOCACHE)) {
    unlinkSync(TEMP_GEOCACHE);
  }
}

function seedGeoCache(entries: Record<string, { lat: number; lng: number } | null>): void {
  writeFileSync(TEMP_GEOCACHE, JSON.stringify(entries, null, 2), "utf-8");
}

// ============================================================================
// Fixtures
// ============================================================================

const FUTURE_DATE = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

function makeEvent(overrides: Partial<EventItem>): EventItem {
  return {
    id: "test-event-001",
    title: "Test Event",
    startDatetime: FUTURE_DATE,
    allDay: false,
    category: "music",
    tags: [],
    isFree: false,
    sourceUrl: "https://example.com",
    sources: [{ sourceId: "test-src", url: "https://example.com" }],
    fetchedAt: new Date().toISOString(),
    status: "scheduled",
    ...overrides,
  };
}

// ============================================================================
// Test Group 1: Query construction — pure helpers, no I/O
// ============================================================================

test("1a. buildNominatimQuery uses provided hint", () => {
  const q = buildNominatimQuery("Petco Park", "San Diego, CA");
  assert(
    q.includes("Petco Park"),
    `query includes venue name: "${q}"`
  );
  assert(
    q.includes("San Diego, CA"),
    `query includes hint: "${q}"`
  );
});

test("1b. buildNominatimQuery defaults to 'San Diego, CA' when no hint", () => {
  const q = buildNominatimQuery("Petco Park", undefined);
  assert(
    q.includes("San Diego, CA"),
    `query includes default hint: "${q}"`
  );
});

test("1d. buildGeoQuery prefers a street address over the bare venue", () => {
  const q = buildGeoQuery({ venue: "Belly Up Tavern", address: "143 S. Cedros Avenue, Solana Beach" });
  assert(q.includes("143 S. Cedros Avenue"), `uses the address: "${q}"`);
  assert(!q.startsWith("Belly Up Tavern,"), `does not lead with the bare venue: "${q}"`);
  assert(/\bCA\b/.test(q), `appends a CA region hint: "${q}"`);
});

test("1e. buildGeoQuery dedupes repeated address segments and falls back to venue", () => {
  const dup = buildGeoQuery({ venue: "Spreckels Park", address: "601 Orange Ave, Coronado, CA, Coronado, CA" });
  assert((dup.match(/Coronado/g) || []).length === 1, `collapses duplicate segments: "${dup}"`);

  // No street anywhere → fall back to "venue, San Diego, CA"
  const bare = buildGeoQuery({ venue: "Nationals Park" });
  assert(bare.includes("Nationals Park") && bare.includes("San Diego, CA"), `bare venue falls back to hint query: "${bare}"`);

  // Nothing geocodable → empty string
  assert(buildGeoQuery({}) === "", "no venue/address → empty query");
});

test("1c. buildNominatimQuery encodes the combined string", () => {
  const q = buildNominatimQuery("Petco Park", "San Diego, CA");
  // Should be a URL-ready string (either raw or URL-encoded, both acceptable)
  assert(q.length > 0, "query is non-empty");
  assert(typeof q === "string", "query is a string");
});

// ============================================================================
// Test Group 2: Cache hit path — no network call
// ============================================================================

test("2a. geocodeVenue returns cached coords on cache hit", async () => {
  cleanupGeoCache();
  // Keys in the cache are stored normalized (lowercase) — match the implementation
  const cacheKey = "petco park, san diego, ca";
  seedGeoCache({ [cacheKey]: { lat: 32.7073, lng: -117.1566 } });

  process.env["EVENTSCOUT_GEOCACHE_PATH"] = TEMP_GEOCACHE;

  // Monkey-patch global fetch to throw — proves cache short-circuits before network
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error("NETWORK CALL FORBIDDEN IN CACHE-HIT TEST"); };

  try {
    const result = await geocodeVenue("Petco Park", "San Diego, CA");
    assert(result !== null, "result is non-null");
    assert(Math.abs((result?.lat ?? 0) - 32.7073) < 0.0001, `lat ≈ 32.7073, got ${result?.lat}`);
    assert(Math.abs((result?.lng ?? 0) - (-117.1566)) < 0.0001, `lng ≈ -117.1566, got ${result?.lng}`);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("2b. geocodeVenue with wrong venue returns null from cache (miss)", async () => {
  cleanupGeoCache();
  seedGeoCache({}); // empty cache

  process.env["EVENTSCOUT_GEOCACHE_PATH"] = TEMP_GEOCACHE;

  // Monkey-patch fetch to return a Nominatim-shaped empty response
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify([]), { status: 200, headers: { "Content-Type": "application/json" } });

  try {
    const result = await geocodeVenue("Nonexistent Venue XYZ123", "San Diego, CA");
    assert(result === null, "returns null when no results");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("2c. negative result (null) is cached — no second network call", async () => {
  cleanupGeoCache();
  seedGeoCache({}); // empty

  process.env["EVENTSCOUT_GEOCACHE_PATH"] = TEMP_GEOCACHE;

  let fetchCallCount = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    fetchCallCount++;
    return new Response(JSON.stringify([]), { status: 200, headers: { "Content-Type": "application/json" } });
  };

  try {
    // First call: cache miss → network call (returns empty → null cached)
    const r1 = await geocodeVenue("NoSuchVenue", "San Diego, CA");
    assert(r1 === null, "first call returns null");
    assert(fetchCallCount === 1, `first call made exactly 1 network request, got ${fetchCallCount}`);

    // Second call: should be a cache hit → NO network call
    const r2 = await geocodeVenue("NoSuchVenue", "San Diego, CA");
    assert(r2 === null, "second call returns null (from cache)");
    assert(fetchCallCount === 1, `second call did NOT make a network request (still 1), got ${fetchCallCount}`);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ============================================================================
// Test Group 3: enrichWithGeo
// ============================================================================

test("3a. enrichWithGeo: event with venue matching cache → gets lat/lng", async () => {
  cleanupGeoCache();
  // Keys stored normalized (lowercase)
  const cacheKey = "petco park, san diego, ca";
  seedGeoCache({ [cacheKey]: { lat: 32.7073, lng: -117.1566 } });

  process.env["EVENTSCOUT_GEOCACHE_PATH"] = TEMP_GEOCACHE;

  // No network allowed
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error("NETWORK CALL FORBIDDEN IN ENRICH TEST"); };

  try {
    const event = makeEvent({ id: "ev-1", venue: "Petco Park" });
    const enriched = await enrichWithGeo([event]);
    assert(enriched.length === 1, "array length preserved");
    assert(enriched[0].lat !== undefined, "lat set after enrich");
    assert(enriched[0].lng !== undefined, "lng set after enrich");
    assert(Math.abs((enriched[0].lat ?? 0) - 32.7073) < 0.0001, `lat ≈ 32.7073, got ${enriched[0].lat}`);
    assert(Math.abs((enriched[0].lng ?? 0) - (-117.1566)) < 0.0001, `lng ≈ -117.1566, got ${enriched[0].lng}`);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("3b. enrichWithGeo: event already has coords → unchanged", async () => {
  cleanupGeoCache();
  seedGeoCache({});

  process.env["EVENTSCOUT_GEOCACHE_PATH"] = TEMP_GEOCACHE;

  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error("NETWORK CALL FORBIDDEN — already-coordinated event"); };

  try {
    const event = makeEvent({
      id: "ev-2",
      venue: "Some Venue",
      lat: 32.999,
      lng: -117.222,
    });
    const enriched = await enrichWithGeo([event]);
    assert(enriched[0].lat === 32.999, "existing lat preserved exactly");
    assert(enriched[0].lng === -117.222, "existing lng preserved exactly");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("3c. enrichWithGeo: event with no venue → stays coordinate-less", async () => {
  cleanupGeoCache();
  seedGeoCache({});

  process.env["EVENTSCOUT_GEOCACHE_PATH"] = TEMP_GEOCACHE;

  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error("NETWORK CALL FORBIDDEN — no-venue event"); };

  try {
    const event = makeEvent({ id: "ev-3", venue: undefined });
    const enriched = await enrichWithGeo([event]);
    assert(enriched[0].lat === undefined, "lat remains undefined when no venue");
    assert(enriched[0].lng === undefined, "lng remains undefined when no venue");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("3d. enrichWithGeo: mixed array — only the venue-with-cache-match gets coords", async () => {
  cleanupGeoCache();
  // Keys stored normalized (lowercase)
  const cacheKey = "petco park, san diego, ca";
  seedGeoCache({ [cacheKey]: { lat: 32.7073, lng: -117.1566 } });

  process.env["EVENTSCOUT_GEOCACHE_PATH"] = TEMP_GEOCACHE;

  const originalFetch = globalThis.fetch;
  // Allow fetch for the venue miss (returns empty)
  globalThis.fetch = async () =>
    new Response(JSON.stringify([]), { status: 200, headers: { "Content-Type": "application/json" } });

  try {
    const events = [
      makeEvent({ id: "ev-A", venue: "Petco Park" }),           // cache hit → get coords
      makeEvent({ id: "ev-B", venue: undefined }),                // no venue → no coords
      makeEvent({ id: "ev-C", venue: undefined, lat: 32.1, lng: -117.5 }), // already has coords
    ];
    const enriched = await enrichWithGeo(events);

    assert(enriched.length === 3, "array length unchanged");
    assert(Math.abs((enriched[0].lat ?? 0) - 32.7073) < 0.0001, "ev-A got cached lat");
    assert(enriched[1].lat === undefined, "ev-B (no venue) stays coordinate-less");
    assert(enriched[2].lat === 32.1, "ev-C (already has coords) unchanged");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
