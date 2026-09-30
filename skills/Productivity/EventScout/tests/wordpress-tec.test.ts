#!/usr/bin/env bun
/**
 * wordpress-tec.test.ts — Unit tests for WordPressTecAdapter.
 *
 * Tests the PURE mapTecEventToItem() against inline fixture objects (NO network).
 * All assertions verify the mapping logic in isolation.
 *
 * Fixtures:
 *   1. Typical Balboa Park event with venue, arts category, empty price, image URL.
 *   2. Same event with cost_details.values: ["10","25"] → priceMin=10, priceMax=25.
 *   3. Event with venue:[] and image:false → venue undefined, imageUrl undefined.
 *
 * Run:
 *   bun test ~/.claude/.claude/worktrees/arch-debt-d2-eventscout-buntest/skills/Productivity/EventScout/tests/wordpress-tec.test.ts
 */

import { test } from "bun:test";
import { mapTecEventToItem, fetchWordPressTecEvents } from "../Tools/adapters/WordPressTecAdapter.ts";
import type { TecEvent, TecApiResponse } from "../Tools/adapters/WordPressTecAdapter.ts";
import type { EventSource } from "../Tools/types.ts";

// ============================================================================
// Test harness
// ============================================================================

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

// ============================================================================
// Shared test source
// ============================================================================

const TEST_SOURCE: EventSource = {
  id: "balboa-park",
  url: "https://balboapark.org/events/",
  name: "Balboa Park",
  fetchTier: "wp-tribe",
  categoryHint: "arts",
  pollInterval: 720,
  enabled: true,
};

// ============================================================================
// Fixture 1 — typical Balboa Park event
//
// Modeled on the real API shape for balboapark.org.
// utc_start_date = "2026-06-01 07:00:00" → LA wall-clock = 2026-06-01 00:00:00 PDT (-07:00)
// utc_end_date   = "2026-06-02 00:00:00" → LA wall-clock = 2026-06-01 17:00:00 PDT (-07:00)
// ============================================================================

const FIXTURE_1: TecEvent = {
  id: 12345,
  title: "Backyard Wildnerness",
  url: "https://balboapark.org/event/backyard-wildnerness/",
  all_day: false,
  start_date: "2026-06-01 00:00:00",
  utc_start_date: "2026-06-01 07:00:00",
  end_date: "2026-06-01 17:00:00",
  utc_end_date: "2026-06-02 00:00:00",
  venue: { venue: "Fleet Science Center" },
  categories: [{ name: "Arts", slug: "arts" }],
  cost: "",
  cost_details: { currency_symbol: "$", currency_code: "USD", values: [] },
  image: { url: "https://balboapark.org/x.jpg" },
  description: "<p>Fun</p>",
  excerpt: "Fun",
};

// ============================================================================
// Fixture 2 — paid event: cost_details.values: ["10","25"]
// ============================================================================

const FIXTURE_2: TecEvent = {
  id: 12346,
  title: "Ticketed Science Lecture",
  url: "https://balboapark.org/event/ticketed-lecture/",
  all_day: false,
  start_date: "2026-06-05 18:00:00",
  utc_start_date: "2026-06-06 01:00:00",
  end_date: "2026-06-05 20:00:00",
  utc_end_date: "2026-06-06 03:00:00",
  venue: { venue: "Fleet Science Center" },
  categories: [{ name: "Talk", slug: "talk" }],
  cost: "$10 – $25",
  cost_details: { currency_symbol: "$", currency_code: "USD", values: ["10", "25"] },
  image: { url: "https://balboapark.org/lecture.jpg" },
  description: "<p>Science lecture for the public.</p>",
  excerpt: "Science lecture for the public.",
};

// ============================================================================
// Fixture 3 — no venue (venue = []), no image (image = false)
// ============================================================================

const FIXTURE_3: TecEvent = {
  id: 12347,
  title: "Garden Walk",
  url: "https://balboapark.org/event/garden-walk/",
  all_day: false,
  start_date: "2026-06-10 09:00:00",
  utc_start_date: "2026-06-10 16:00:00",
  venue: [] as unknown as TecEvent["venue"],   // empty array — no venue
  categories: [{ name: "Community", slug: "community" }],
  cost: "",
  cost_details: { currency_symbol: "$", currency_code: "USD", values: [] },
  image: false,
  description: "<p>A lovely walk through the gardens.</p>",
  excerpt: "A lovely walk through the gardens.",
};

// ============================================================================
// Tests — Fixture 1
// ============================================================================

console.log("\nEventScout — WordPress TEC Adapter Unit Tests\n");
console.log("--- Fixture 1: Typical Balboa Park event ---");

test("1. Title is preserved exactly", () => {
  const item = mapTecEventToItem(FIXTURE_1, TEST_SOURCE);
  assert(item.title === "Backyard Wildnerness", `Expected "Backyard Wildnerness", got "${item.title}"`);
});

test("2. startDatetime contains date 2026-06-01", () => {
  const item = mapTecEventToItem(FIXTURE_1, TEST_SOURCE);
  assert(
    item.startDatetime.includes("2026-06-01"),
    `Expected startDatetime to contain "2026-06-01", got "${item.startDatetime}"`
  );
});

test("3. startDatetime contains LA PDT offset -07:00", () => {
  const item = mapTecEventToItem(FIXTURE_1, TEST_SOURCE);
  assert(
    item.startDatetime.includes("-07:00"),
    `Expected startDatetime to contain "-07:00" (PDT), got "${item.startDatetime}"`
  );
});

test("4. startDatetime reflects local hour 00 (midnight LA time)", () => {
  // utc_start_date = "2026-06-01 07:00:00" UTC → 00:00:00 PDT (-07:00)
  const item = mapTecEventToItem(FIXTURE_1, TEST_SOURCE);
  const hourMatch = item.startDatetime.match(/T(\d{2}):/);
  assert(hourMatch !== null, `Cannot extract hour from "${item.startDatetime}"`);
  const localHour = parseInt(hourMatch![1], 10);
  assert(localHour === 0, `Expected local hour 0 (midnight), got ${localHour} in "${item.startDatetime}"`);
});

test("5. venue === 'Fleet Science Center'", () => {
  const item = mapTecEventToItem(FIXTURE_1, TEST_SOURCE);
  assert(
    item.venue === "Fleet Science Center",
    `Expected venue "Fleet Science Center", got "${item.venue}"`
  );
});

test("6. category === 'arts'", () => {
  const item = mapTecEventToItem(FIXTURE_1, TEST_SOURCE);
  assert(item.category === "arts", `Expected category "arts", got "${item.category}"`);
});

test("7. ticketUrl === event URL", () => {
  const item = mapTecEventToItem(FIXTURE_1, TEST_SOURCE);
  assert(
    item.ticketUrl === "https://balboapark.org/event/backyard-wildnerness/",
    `ticketUrl mismatch: "${item.ticketUrl}"`
  );
});

test("8. imageUrl is set", () => {
  const item = mapTecEventToItem(FIXTURE_1, TEST_SOURCE);
  assert(
    item.imageUrl === "https://balboapark.org/x.jpg",
    `imageUrl mismatch: "${item.imageUrl}"`
  );
});

test("9. isFree === false when values is empty", () => {
  // Empty values array → do NOT assume free
  const item = mapTecEventToItem(FIXTURE_1, TEST_SOURCE);
  assert(item.isFree === false, `Expected isFree=false (no values), got ${item.isFree}`);
});

test("10. priceMin is undefined when values is empty", () => {
  const item = mapTecEventToItem(FIXTURE_1, TEST_SOURCE);
  assert(
    item.priceMin === undefined,
    `Expected priceMin=undefined when no values, got ${item.priceMin}`
  );
});

test("11. id is a non-empty string", () => {
  const item = mapTecEventToItem(FIXTURE_1, TEST_SOURCE);
  assert(typeof item.id === "string" && item.id.length > 0, `id is empty or not a string`);
});

test("12. id is deterministic (same input → same output)", () => {
  const item1 = mapTecEventToItem(FIXTURE_1, TEST_SOURCE);
  const item2 = mapTecEventToItem(FIXTURE_1, TEST_SOURCE);
  assert(item1.id === item2.id, `id not deterministic: "${item1.id}" vs "${item2.id}"`);
});

test("13. allDay === false", () => {
  const item = mapTecEventToItem(FIXTURE_1, TEST_SOURCE);
  assert(item.allDay === false, `Expected allDay=false, got ${item.allDay}`);
});

test("14. status === 'scheduled'", () => {
  const item = mapTecEventToItem(FIXTURE_1, TEST_SOURCE);
  assert(item.status === "scheduled", `Expected status "scheduled", got "${item.status}"`);
});

test("15. sources[0].sourceId === 'balboa-park'", () => {
  const item = mapTecEventToItem(FIXTURE_1, TEST_SOURCE);
  assert(item.sources.length >= 1, `Expected at least 1 source`);
  assert(
    item.sources[0].sourceId === "balboa-park",
    `Expected sourceId "balboa-park", got "${item.sources[0].sourceId}"`
  );
});

// ============================================================================
// Tests — Fixture 2 (paid event)
// ============================================================================

console.log("\n--- Fixture 2: Paid event with cost_details.values: ['10','25'] ---");

test("16. priceMin === 10", () => {
  const item = mapTecEventToItem(FIXTURE_2, TEST_SOURCE);
  assert(item.priceMin === 10, `Expected priceMin=10, got ${item.priceMin}`);
});

test("17. priceMax === 25", () => {
  const item = mapTecEventToItem(FIXTURE_2, TEST_SOURCE);
  assert(item.priceMax === 25, `Expected priceMax=25, got ${item.priceMax}`);
});

test("18. isFree === false (min price is 10, not 0)", () => {
  const item = mapTecEventToItem(FIXTURE_2, TEST_SOURCE);
  assert(item.isFree === false, `Expected isFree=false for priceMin=10, got ${item.isFree}`);
});

test("19. category === 'talk' (from categories[].slug)", () => {
  const item = mapTecEventToItem(FIXTURE_2, TEST_SOURCE);
  assert(item.category === "talk", `Expected category "talk", got "${item.category}"`);
});

test("20. Fixture 2 id is non-empty and distinct from Fixture 1", () => {
  const item1 = mapTecEventToItem(FIXTURE_1, TEST_SOURCE);
  const item2 = mapTecEventToItem(FIXTURE_2, TEST_SOURCE);
  assert(item2.id.length > 0, `Fixture 2 id is empty`);
  assert(item1.id !== item2.id, `Fixture 1 and 2 should have different ids`);
});

// ============================================================================
// Tests — Fixture 3 (no venue, no image)
// ============================================================================

console.log("\n--- Fixture 3: venue=[], image=false → no crash, venue/imageUrl undefined ---");

test("21. venue=[] → venue field is undefined", () => {
  const item = mapTecEventToItem(FIXTURE_3, TEST_SOURCE);
  assert(item.venue === undefined, `Expected venue=undefined when raw.venue=[], got "${item.venue}"`);
});

test("22. image=false → imageUrl is undefined", () => {
  const item = mapTecEventToItem(FIXTURE_3, TEST_SOURCE);
  assert(
    item.imageUrl === undefined,
    `Expected imageUrl=undefined when raw.image=false, got "${item.imageUrl}"`
  );
});

test("23. No crash when venue=[] and image=false", () => {
  // Just verifying the mapper doesn't throw on these edge cases
  let threw = false;
  try {
    mapTecEventToItem(FIXTURE_3, TEST_SOURCE);
  } catch {
    threw = true;
  }
  assert(!threw, "mapTecEventToItem should not throw for venue=[] or image=false");
});

test("24. Fixture 3 id is non-empty", () => {
  const item = mapTecEventToItem(FIXTURE_3, TEST_SOURCE);
  assert(item.id.length > 0, `Fixture 3 id is empty`);
});

test("25. Fixture 3 isFree === false (empty values)", () => {
  const item = mapTecEventToItem(FIXTURE_3, TEST_SOURCE);
  assert(item.isFree === false, `Expected isFree=false (empty values), got ${item.isFree}`);
});

test("26. Fixture 3 category === 'community'", () => {
  const item = mapTecEventToItem(FIXTURE_3, TEST_SOURCE);
  assert(item.category === "community", `Expected category "community", got "${item.category}"`);
});

// ============================================================================
// Pagination tests (Slice 6) — fetchWordPressTecEvents with mocked fetch
//
// These tests verify the NEW horizon-driven pagination:
//   - Multi-page accumulation: total_pages=10, 10 full pages → all collected
//     (OLD code capped at max(total_pages, MAX_PAGES=4), i.e. 4 pages / 200 events)
//   - Empty page stops early
//   - Safety bound (MAX_PAGES_SAFETY) stops runaway + logs loudly
//   - MAX_TOTAL cap (200) is REMOVED — more than 200 events are collected
// ============================================================================

console.log("\n--- Slice 6: fetchWordPressTecEvents pagination (mocked fetch) ---");

const WP_PER_PAGE = 50;

/** Build a minimal future TecEvent for pagination testing. */
function makeFutureTecEvent(id: number, page: number): TecEvent {
  return {
    id,
    title: `Event ${id}`,
    url: `https://balboapark.org/event/${id}/`,
    all_day: false,
    start_date: `2030-01-${String((id % 28) + 1).padStart(2, "0")} 10:00:00`,
    utc_start_date: `2030-01-${String((id % 28) + 1).padStart(2, "0")} 17:00:00`,
    venue: { venue: "Test Hall" },
    categories: [{ name: "Arts", slug: "arts" }],
    cost: "",
    cost_details: { currency_symbol: "$", currency_code: "USD", values: [] },
    image: false,
    description: `Test event on page ${page}`,
  };
}

/** Build a TecApiResponse page. */
function makeTecPage(pageNum: number, totalPages: number, count: number): TecApiResponse {
  const startId = (pageNum - 1) * WP_PER_PAGE + 1;
  return {
    total: totalPages * WP_PER_PAGE,
    total_pages: totalPages,
    events: Array.from({ length: count }, (_, i) => makeFutureTecEvent(startId + i, pageNum)),
  };
}

const WP_TEST_SOURCE: EventSource = {
  id: "balboa-park",
  url: "https://balboapark.org/events/",
  name: "Balboa Park",
  fetchTier: "wp-tribe",
  categoryHint: "arts",
  pollInterval: 720,
  enabled: true,
};

// Test W1: 10-page source accumulates all 500 events (OLD code max was 200 events / 4 pages)
test("W1. accumulates all events from 10-page source, no 200-event cap", async () => {
  const originalFetch = globalThis.fetch;
  let callCount = 0;
  globalThis.fetch = async (url: RequestInfo | URL) => {
    const u = new URL(String(url));
    const page = parseInt(u.searchParams.get("page") ?? "1", 10);
    callCount++;
    const data = makeTecPage(page, 10, page <= 10 ? WP_PER_PAGE : 0);
    return new Response(JSON.stringify(data), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  try {
    const result = await fetchWordPressTecEvents(WP_TEST_SOURCE);
    assert(
      result.length === 500,
      `W1. 10 pages × 50 = 500 events expected, got ${result.length}`
    );
    assert(callCount === 10, `W1. 10 fetch calls expected, got ${callCount}`);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// Test W2: Empty page stops pagination early (event list empty before total_pages)
test("W2. stops on empty event list even when total_pages > current page", async () => {
  const originalFetch = globalThis.fetch;
  let callCount = 0;
  globalThis.fetch = async (url: RequestInfo | URL) => {
    const u = new URL(String(url));
    const page = parseInt(u.searchParams.get("page") ?? "1", 10);
    callCount++;
    const events = page <= 2 ? makeTecPage(page, 10, WP_PER_PAGE).events : [];
    const data: TecApiResponse = { total: 500, total_pages: 10, events };
    return new Response(JSON.stringify(data), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  try {
    const result = await fetchWordPressTecEvents(WP_TEST_SOURCE);
    assert(result.length === 100, `W2. 2 pages before empty → 100 events, got ${result.length}`);
    assert(callCount === 3, `W2. 3 calls (2 data + 1 empty), got ${callCount}`);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// Test W3: Safety bound stops runaway (total_pages = 9999) + logs warning
test("W3. safety bound stops runaway total_pages and logs warning", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url: RequestInfo | URL) => {
    const u = new URL(String(url));
    const page = parseInt(u.searchParams.get("page") ?? "1", 10);
    const data = makeTecPage(page, 9999, WP_PER_PAGE);
    return new Response(JSON.stringify(data), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  const logMessages: string[] = [];
  const origLog = console.log;
  const origWarn = console.warn;
  console.log = (...args: unknown[]) => { logMessages.push(args.join(" ")); origLog(...args); };
  console.warn = (...args: unknown[]) => { logMessages.push(args.join(" ")); origWarn(...args); };
  try {
    const result = await fetchWordPressTecEvents(WP_TEST_SOURCE);
    assert(result.length < 100000, `W3. safety bound should cap the result, got ${result.length}`);
    assert(result.length > 0, `W3. safety bound should still return events, got ${result.length}`);
    const safetyLogged = logMessages.some(m => m.includes("safety bound") || m.includes("safety"));
    assert(safetyLogged, `W3. should log safety bound warning — got: ${logMessages.join("; ")}`);
  } finally {
    globalThis.fetch = originalFetch;
    console.log = origLog;
    console.warn = origWarn;
  }
});

// Test W4: Under 200 events — existing behavior unchanged (regression)
test("W4. regression: 3-page source (150 events) still fully collected", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url: RequestInfo | URL) => {
    const u = new URL(String(url));
    const page = parseInt(u.searchParams.get("page") ?? "1", 10);
    const data = makeTecPage(page, 3, page <= 3 ? WP_PER_PAGE : 0);
    return new Response(JSON.stringify(data), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  try {
    const result = await fetchWordPressTecEvents(WP_TEST_SOURCE);
    assert(result.length === 150, `W4. 3 pages × 50 = 150 events, got ${result.length}`);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

