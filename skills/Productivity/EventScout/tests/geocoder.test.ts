#!/usr/bin/env bun
/**
 * geocoder.test.ts — Slice 5 TDD unit tests for Geocoder.ts
 *
 * All tests are deterministic (cache-only, no network) except where noted.
 *
 * Test scenarios:
 *   1. Cache hit path: pre-seeded cache → enrichWithGeo uses cached coords,
 *      and does NOT call network (fetch monkey-patched to throw).
 *   2. enrichWithGeo:
 *      (a) event with matching venue → gets lat/lng from cache.
 *      (b) event already has coords → unchanged.
 *      (c) event has no venue → coords-less.
 *   3. Query construction: buildGeoQueries order, region suffix, units; usableMatch distance rules.
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
 *   bun test skills/Productivity/EventScout/tests/geocoder.test.ts
 */

import { test, afterAll } from "bun:test";
import { existsSync, unlinkSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EventItem } from "../Tools/types.ts";
import { defined } from "../../../../lib/test/defined.ts";

// ============================================================================
// Env isolation — pin KAYA_HOME/KAYA_DIR before importing Tools code.
// ============================================================================

const ORIGINAL_KAYA_HOME = process.env["KAYA_HOME"];
const ORIGINAL_KAYA_DIR = process.env["KAYA_DIR"];

const TEST_KAYA_HOME = mkdtempSync(join(tmpdir(), "eventscout-geocoder-test-"));
process.env["KAYA_HOME"] = TEST_KAYA_HOME;
process.env["KAYA_DIR"] = TEST_KAYA_HOME;

const { enrichWithGeo, buildGeoQueries, usableMatch } = await import("../Tools/Geocoder.ts");

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

const queriesOf = (event: { venue?: string; address?: string }) => buildGeoQueries(event).map((query) => query.q);

test("1a. buildGeoQueries prefers a street address over the bare venue", () => {
  const [first] = buildGeoQueries({ venue: "Belly Up Tavern", address: "143 S. Cedros Avenue, Solana Beach" });
  assert(first?.q === "143 S. Cedros Avenue, Solana Beach, CA", `street first, CA added: "${first?.q}"`);
  assert(first?.assumed === true, "the CA region was assumed, so far matches are checked");
});

test("1b. buildGeoQueries removes suite/unit parts and duplicate segments", () => {
  assert(
    queriesOf({ venue: "Tender Hooligan, 221 Third Ave Suite 3" })[0] === "221 Third Ave, San Diego, CA",
    `suite removed: ${JSON.stringify(queriesOf({ venue: "Tender Hooligan, 221 Third Ave Suite 3" }))}`,
  );
  assert(
    queriesOf({ address: "4455 Morena Blvd, Ste. 101, San Diego, CA" })[0] === "4455 Morena Blvd, San Diego, CA",
    "Ste. removed",
  );
  assert(
    queriesOf({ address: "3940 Fourth Ave #200, San Diego" })[0] === "3940 Fourth Ave, San Diego, CA",
    "#200 removed",
  );
  const dup = queriesOf({ venue: "Spreckels Park", address: "601 Orange Ave, Coronado, CA, Coronado, CA" })[0] ?? "";
  assert((dup.match(/Coronado/g) || []).length === 1, `collapses duplicate segments: "${dup}"`);
});

test("1c. buildGeoQueries adds San Diego only when the text names no region", () => {
  const bare = buildGeoQueries({ venue: "Nationals Park" });
  // Then the bare name, still assumed (Nominatim finds "San Diego Civic Theatre" only bare; F-006).
  assert(
    bare.length === 2 && bare[0]?.q === "Nationals Park, San Diego, CA" && bare[0].assumed && bare[1]?.q === "Nationals Park" && bare[1].assumed,
    `bare venue → assumed San Diego, then the bare name: ${JSON.stringify(bare)}`,
  );
  const away = buildGeoQueries({ venue: "The Queen Mary Waterfront - Long Beach, CA" });
  assert(away[0]?.q === "The Queen Mary Waterfront - Long Beach, CA" && !away[0].assumed, "named region → no suffix");
  assert(away[1]?.q === "Long Beach, CA" && away[1].placeOnly === true, `city-level fallback: ${JSON.stringify(away)}`);
  const mexico = queriesOf({ venue: "Autódromo Hermanos Rodríguez - Granjas México, Mexico" });
  assert(mexico[1] === "Granjas México, Mexico", `country named: ${JSON.stringify(mexico)}`);
  // A region word in the venue NAME (first segment) is not a named region.
  assert(buildGeoQueries({ venue: "Mexico Lindo Restaurant" })[0]?.assumed === true, "name word ≠ region");
  assert(buildGeoQueries({}).length === 0, "no venue/address → no queries");
});

test("1d. a source's street geoHint is the last query; a region-only hint adds none (F-006)", () => {
  const hint = "Mic Drop Comedy San Diego, 8878 Clairemont Mesa Blvd, San Diego, CA 92123";
  const q = buildGeoQueries({ venue: "Mic Drop Comedy San Diego" }, hint);
  assert(q.at(-1)?.q === "8878 Clairemont Mesa Blvd, San Diego, CA 92123" && q.at(-1)?.assumed === false, `source address last: ${JSON.stringify(q)}`);
  assert(buildGeoQueries({ venue: "Mic Drop Comedy San Diego" }, "San Diego, CA").length === 2, "region-only hint → no extra query");
  assert(buildGeoQueries({}, hint).length === 1, "no venue → the source address alone");
});

// ============================================================================
// Test Group 2: which matches stand
// ============================================================================

const downtown = { lat: 32.7157, lng: -117.1611 };
const losAngeles = { lat: 34.0403, lng: -118.2696 };

test("2a. an assumed-San Diego query rejects a namesake outside the area", () => {
  assert(usableMatch({ q: "Belly Up Tavern, San Diego, CA", assumed: true }, downtown), "in area → kept");
  assert(
    !usableMatch({ q: "Main Street Theater, San Diego, CA", assumed: true }, losAngeles),
    "LA namesake → rejected",
  );
  assert(
    usableMatch({ q: "Water & Power - Los Angeles, CA", assumed: false }, losAngeles),
    "region named → far match kept",
  );
});

test("2b. a city-level query only places events outside the San Diego area", () => {
  assert(usableMatch({ q: "Long Beach, CA", assumed: false, placeOnly: true }, losAngeles), "far city → kept");
  assert(
    !usableMatch({ q: "San Diego, CA", assumed: false, placeOnly: true }, downtown),
    "SD city centre → rejected (fake distance)",
  );
});

test("2c. enrichWithGeo walks the queries, skips a rejected namesake, and caches misses", async () => {
  cleanupGeoCache();
  seedGeoCache({});
  process.env["EVENTSCOUT_GEOCACHE_PATH"] = TEMP_GEOCACHE;

  const asked: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fakeFetch(async (input) => {
    const q = new URL(String(input)).searchParams.get("q") ?? "";
    asked.push(q);
    const body = q === "Long Beach, CA" ? [{ lat: "33.77", lon: "-118.19", display_name: "Long Beach" }] : [];
    return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
  });

  try {
    const [placed] = await enrichWithGeo([makeEvent({ venue: "The Queen Mary Waterfront - Long Beach, CA" })]);
    assert(Math.abs((placed?.lat ?? 0) - 33.77) < 0.001, `placed by the city fallback, got ${placed?.lat}`);
    assert(asked.length === 2, `full query, then city: ${JSON.stringify(asked)}`);
    await enrichWithGeo([makeEvent({ venue: "The Queen Mary Waterfront - Long Beach, CA" })]);
    assert(asked.length === 2, "second run is served from the cache (miss and hit both cached)");
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
  globalThis.fetch = fakeFetch(() => {
    throw new Error("NETWORK CALL FORBIDDEN IN ENRICH TEST");
  });

  try {
    const event = makeEvent({ id: "ev-1", venue: "Petco Park" });
    const enriched = await enrichWithGeo([event]);
    assert(enriched.length === 1, "array length preserved");
    assert(defined(enriched[0]).lat !== undefined, "lat set after enrich");
    assert(defined(enriched[0]).lng !== undefined, "lng set after enrich");
    assert(
      Math.abs((defined(enriched[0]).lat ?? 0) - 32.7073) < 0.0001,
      `lat ≈ 32.7073, got ${defined(enriched[0]).lat}`,
    );
    assert(
      Math.abs((defined(enriched[0]).lng ?? 0) - -117.1566) < 0.0001,
      `lng ≈ -117.1566, got ${defined(enriched[0]).lng}`,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("3b. enrichWithGeo: event already has coords → unchanged", async () => {
  cleanupGeoCache();
  seedGeoCache({});

  process.env["EVENTSCOUT_GEOCACHE_PATH"] = TEMP_GEOCACHE;

  const originalFetch = globalThis.fetch;
  globalThis.fetch = fakeFetch(() => {
    throw new Error("NETWORK CALL FORBIDDEN — already-coordinated event");
  });

  try {
    const event = makeEvent({
      id: "ev-2",
      venue: "Some Venue",
      lat: 32.999,
      lng: -117.222,
    });
    const enriched = await enrichWithGeo([event]);
    assert(defined(enriched[0]).lat === 32.999, "existing lat preserved exactly");
    assert(defined(enriched[0]).lng === -117.222, "existing lng preserved exactly");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("3c. enrichWithGeo: event with no venue → stays coordinate-less", async () => {
  cleanupGeoCache();
  seedGeoCache({});

  process.env["EVENTSCOUT_GEOCACHE_PATH"] = TEMP_GEOCACHE;

  const originalFetch = globalThis.fetch;
  globalThis.fetch = fakeFetch(() => {
    throw new Error("NETWORK CALL FORBIDDEN — no-venue event");
  });

  try {
    const event = makeEvent({ id: "ev-3", venue: undefined });
    const enriched = await enrichWithGeo([event]);
    assert(defined(enriched[0]).lat === undefined, "lat remains undefined when no venue");
    assert(defined(enriched[0]).lng === undefined, "lng remains undefined when no venue");
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
  globalThis.fetch = fakeFetch(
    async () => new Response(JSON.stringify([]), { status: 200, headers: { "Content-Type": "application/json" } }),
  );

  try {
    const events = [
      makeEvent({ id: "ev-A", venue: "Petco Park" }), // cache hit → get coords
      makeEvent({ id: "ev-B", venue: undefined }), // no venue → no coords
      makeEvent({ id: "ev-C", venue: undefined, lat: 32.1, lng: -117.5 }), // already has coords
    ];
    const enriched = await enrichWithGeo(events);

    assert(enriched.length === 3, "array length unchanged");
    assert(Math.abs((defined(enriched[0]).lat ?? 0) - 32.7073) < 0.0001, "ev-A got cached lat");
    assert(defined(enriched[1]).lat === undefined, "ev-B (no venue) stays coordinate-less");
    assert(defined(enriched[2]).lat === 32.1, "ev-C (already has coords) unchanged");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

/** Adds Bun's `fetch.preconnect` so a plain function satisfies `typeof fetch`. */
function fakeFetch(fn: (...args: Parameters<typeof fetch>) => Promise<Response>): typeof fetch {
  return Object.assign(fn, { preconnect: () => {} });
}
