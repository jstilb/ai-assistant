#!/usr/bin/env bun
/**
 * evvnt.test.ts — Unit tests for EvvntAdapter.
 *
 * Tests the PURE mapEvvntEventToItem() against inline fixture objects (NO network).
 * All assertions verify the mapping logic in isolation.
 *
 * Fixtures:
 *   1. Typical conference event with venue, Conferences category (→ talk),
 *      links array, no images.
 *   2. Live Music event with null venue, images as bare URL string,
 *      original_links (no links) — verifies fallback branches.
 *
 * Run:
 *   bun test ~/.claude/.claude/worktrees/arch-debt-d2-eventscout-buntest/skills/Productivity/EventScout/tests/evvnt.test.ts
 */

import { test } from "bun:test";
import { mapEvvntEventToItem, fetchEvvntEvents } from "../Tools/adapters/EvvntAdapter.ts";
import type { EvvntEvent, EvvntResponse } from "../Tools/adapters/EvvntAdapter.ts";
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
  id: "inewsource-events",
  url: "https://discovery.evvnt.com/api/publisher/11515/home_page_events?hitsPerPage=50&multipleEventInstances=true&page=0&publisher_id=11515",
  name: "inewsource Events (Evvnt)",
  fetchTier: "evvnt",
  categoryHint: "community",
  pollInterval: 720,
  enabled: true,
};

// ============================================================================
// Fixture 1 — Typical conference event
//
// Modeled on the real Evvnt API shape.
// start_time = "2026-06-08T08:00:00-07:00" → already LA offset-aware
// end_time   = "2026-06-10T17:30:00-07:00" → multi-day
// category_name = "Conferences" → should map to "talk"
// ============================================================================

const FIXTURE_1: EvvntEvent = {
  objectID: "3450473-0",
  title: "PFS & Injectable Drug Devices West Coast",
  start_date: "2026-06-08",
  start_time: "2026-06-08T08:00:00-07:00",
  end_time: "2026-06-10T17:30:00-07:00",
  venue: {
    name: "San Diego Marriott La Jolla",
    address_1: "4240 La Jolla Village Drive",
    address_2: null,
    town: "San Diego",
  },
  category_name: "Conferences",
  description: "<p>Foster Innovation</p>",
  // REAL live shapes (verified against discovery.evvnt.com): images = nested
  // objects, links = dict, keywords = comma-separated string, artists = string.
  images: [{ original: { url: "https://cdn.evvnt.com/orig.png" }, featured: { url: "https://cdn.evvnt.com/feat.png" } }],
  links: { Tickets: "https://go.evvnt.com/3450473-0", Website: "https://go.evvnt.com/3450473-2" },
  organiser_name: "Org",
  online_only: false,
  keywords: "pharma, syringes, idd",
  artists: "",
};

// ============================================================================
// Fixture 2 — Live Music event with null venue, images as bare string,
//             original_links only (no links), no keywords
// ============================================================================

const FIXTURE_2: EvvntEvent = {
  objectID: "9999-0",
  title: "Summer Live Music Night",
  start_date: "2026-07-04",
  start_time: "2026-07-04T20:00:00-07:00",
  end_time: null,
  venue: null,
  category_name: "Live Music",
  description: "",
  images: ["https://x/i.jpg"],
  original_links: ["https://go.evvnt.com/x"],
  organiser_name: "Promoter",
  online_only: false,
  keywords: [],
};

// ============================================================================
// Tests — Fixture 1: Conference event
// ============================================================================

console.log("\nEventScout — Evvnt Adapter Unit Tests\n");
console.log("--- Fixture 1: Conference event (Conferences → talk) ---");

test("1. Title is preserved exactly", () => {
  const item = mapEvvntEventToItem(FIXTURE_1, TEST_SOURCE);
  assert(
    item.title === "PFS & Injectable Drug Devices West Coast",
    `Expected exact title, got "${item.title}"`
  );
});

test("2. startDatetime contains 2026-06-08", () => {
  const item = mapEvvntEventToItem(FIXTURE_1, TEST_SOURCE);
  assert(
    item.startDatetime.includes("2026-06-08"),
    `Expected startDatetime to include "2026-06-08", got "${item.startDatetime}"`
  );
});

test("3. startDatetime contains LA offset -07:00", () => {
  const item = mapEvvntEventToItem(FIXTURE_1, TEST_SOURCE);
  assert(
    item.startDatetime.includes("-07:00"),
    `Expected startDatetime to include "-07:00", got "${item.startDatetime}"`
  );
});

test("4. startDatetime local hour is 08 (input is 08:00:00-07:00)", () => {
  const item = mapEvvntEventToItem(FIXTURE_1, TEST_SOURCE);
  const hourMatch = item.startDatetime.match(/T(\d{2}):/);
  assert(hourMatch !== null, `Cannot extract hour from "${item.startDatetime}"`);
  const localHour = parseInt(hourMatch![1], 10);
  assert(localHour === 8, `Expected local hour 8, got ${localHour} in "${item.startDatetime}"`);
});

test("5. endDatetime is present", () => {
  const item = mapEvvntEventToItem(FIXTURE_1, TEST_SOURCE);
  assert(
    typeof item.endDatetime === "string" && item.endDatetime.length > 0,
    `Expected endDatetime to be set, got "${item.endDatetime}"`
  );
});

test("6. venue === 'San Diego Marriott La Jolla'", () => {
  const item = mapEvvntEventToItem(FIXTURE_1, TEST_SOURCE);
  assert(
    item.venue === "San Diego Marriott La Jolla",
    `Expected venue "San Diego Marriott La Jolla", got "${item.venue}"`
  );
});

test("7. address contains the street (4240 La Jolla Village Drive)", () => {
  const item = mapEvvntEventToItem(FIXTURE_1, TEST_SOURCE);
  assert(
    typeof item.address === "string" && item.address.includes("4240 La Jolla Village Drive"),
    `Expected address to contain street, got "${item.address}"`
  );
});

test("8. address contains the town (San Diego)", () => {
  const item = mapEvvntEventToItem(FIXTURE_1, TEST_SOURCE);
  assert(
    typeof item.address === "string" && item.address.includes("San Diego"),
    `Expected address to contain "San Diego", got "${item.address}"`
  );
});

test("9. category === 'talk' (Conferences → talk)", () => {
  const item = mapEvvntEventToItem(FIXTURE_1, TEST_SOURCE);
  assert(
    item.category === "talk",
    `Expected category "talk", got "${item.category}"`
  );
});

test("10. ticketUrl === 'https://go.evvnt.com/3450473-0'", () => {
  const item = mapEvvntEventToItem(FIXTURE_1, TEST_SOURCE);
  assert(
    item.ticketUrl === "https://go.evvnt.com/3450473-0",
    `Expected ticketUrl "https://go.evvnt.com/3450473-0", got "${item.ticketUrl}"`
  );
});

test("11. id is non-empty and deterministic", () => {
  const item1 = mapEvvntEventToItem(FIXTURE_1, TEST_SOURCE);
  const item2 = mapEvvntEventToItem(FIXTURE_1, TEST_SOURCE);
  assert(item1.id.length > 0, `id is empty`);
  assert(item1.id === item2.id, `id not deterministic: "${item1.id}" vs "${item2.id}"`);
});

test("12. isFree === false", () => {
  const item = mapEvvntEventToItem(FIXTURE_1, TEST_SOURCE);
  assert(item.isFree === false, `Expected isFree=false, got ${item.isFree}`);
});

test("13. status === 'scheduled'", () => {
  const item = mapEvvntEventToItem(FIXTURE_1, TEST_SOURCE);
  assert(item.status === "scheduled", `Expected status "scheduled", got "${item.status}"`);
});

test("14. allDay === false", () => {
  const item = mapEvvntEventToItem(FIXTURE_1, TEST_SOURCE);
  assert(item.allDay === false, `Expected allDay=false, got ${item.allDay}`);
});

test("15. sources[0].sourceId === 'inewsource-events'", () => {
  const item = mapEvvntEventToItem(FIXTURE_1, TEST_SOURCE);
  assert(item.sources.length >= 1, `Expected at least 1 source`);
  assert(
    item.sources[0].sourceId === "inewsource-events",
    `Expected sourceId "inewsource-events", got "${item.sources[0].sourceId}"`
  );
});

// Real-shape coverage (regression for the live "{} is not iterable" bug):
test("15b. imageUrl extracted from nested images[0].original.url (live shape)", () => {
  const item = mapEvvntEventToItem(FIXTURE_1, TEST_SOURCE);
  assert(
    item.imageUrl === "https://cdn.evvnt.com/orig.png",
    `Expected nested image url, got "${item.imageUrl}"`
  );
});

test("15c. tags parsed from comma-separated keywords string (live shape)", () => {
  const item = mapEvvntEventToItem(FIXTURE_1, TEST_SOURCE);
  assert(
    item.tags.includes("pharma") && item.tags.includes("syringes") && item.tags.includes("idd"),
    `Expected tags from comma string, got ${JSON.stringify(item.tags)}`
  );
});

// ============================================================================
// Tests — Fixture 2: Live Music with null venue, bare image string, original_links
// ============================================================================

console.log("\n--- Fixture 2: Live Music, null venue, images=string, original_links ---");

test("16. venue is undefined when venue=null", () => {
  const item = mapEvvntEventToItem(FIXTURE_2, TEST_SOURCE);
  assert(
    item.venue === undefined,
    `Expected venue=undefined when raw.venue=null, got "${item.venue}"`
  );
});

test("17. category === 'music' (Live Music → music)", () => {
  const item = mapEvvntEventToItem(FIXTURE_2, TEST_SOURCE);
  assert(
    item.category === "music",
    `Expected category "music", got "${item.category}"`
  );
});

test("18. imageUrl is set from bare string in images array", () => {
  const item = mapEvvntEventToItem(FIXTURE_2, TEST_SOURCE);
  assert(
    item.imageUrl === "https://x/i.jpg",
    `Expected imageUrl "https://x/i.jpg", got "${item.imageUrl}"`
  );
});

test("19. ticketUrl comes from original_links when links absent", () => {
  const item = mapEvvntEventToItem(FIXTURE_2, TEST_SOURCE);
  assert(
    item.ticketUrl === "https://go.evvnt.com/x",
    `Expected ticketUrl "https://go.evvnt.com/x", got "${item.ticketUrl}"`
  );
});

test("20. No crash when venue=null and end_time=null", () => {
  let threw = false;
  try {
    mapEvvntEventToItem(FIXTURE_2, TEST_SOURCE);
  } catch {
    threw = true;
  }
  assert(!threw, "mapEvvntEventToItem should not throw when venue=null or end_time=null");
});

test("21. endDatetime is undefined when end_time=null", () => {
  const item = mapEvvntEventToItem(FIXTURE_2, TEST_SOURCE);
  assert(
    item.endDatetime === undefined,
    `Expected endDatetime=undefined when end_time=null, got "${item.endDatetime}"`
  );
});

test("22. Fixture 2 id is non-empty and distinct from Fixture 1", () => {
  const item1 = mapEvvntEventToItem(FIXTURE_1, TEST_SOURCE);
  const item2 = mapEvvntEventToItem(FIXTURE_2, TEST_SOURCE);
  assert(item2.id.length > 0, `Fixture 2 id is empty`);
  assert(item1.id !== item2.id, `Fixture 1 and 2 should have different ids`);
});

// ============================================================================
// Pagination tests (Slice 6) — fetchEvvntEvents with mocked fetch
//
// These tests verify the NEW horizon-driven pagination:
//   - Multi-page accumulation: 3 full pages + 1 short page → all 3 pages collected
//   - Empty page stops immediately
//   - Safety bound (MAX_PAGES_SAFETY) stops runaway loops and logs loudly
//
// All dates are far-future to pass the "filter out past events" check.
// ============================================================================

console.log("\n--- Slice 6: fetchEvvntEvents pagination (mocked fetch) ---");

/** Build a minimal future EvvntEvent for testing pagination. */
function makeFutureEvvntEvent(id: string, title: string): EvvntEvent {
  return {
    objectID: id,
    title,
    start_time: "2030-01-01T10:00:00-07:00",
    venue: { name: "Test Venue", address_1: "123 Main St", town: "San Diego" },
    category_name: "Community",
    description: "Test event",
    links: { Website: `https://example.com/${id}` },
  };
}

/** Build a full page of N events. */
function makeEvvntPage(n: number, pageIndex: number): EvvntEvent[] {
  return Array.from({ length: n }, (_, i) =>
    makeFutureEvvntEvent(`p${pageIndex}-e${i}`, `Page ${pageIndex} Event ${i}`)
  );
}

/** Build a mock EvvntResponse. */
function makeEvvntResponse(events: EvvntEvent[]): EvvntResponse {
  return { rawEvents: events };
}

const EVVNT_PAGE_SIZE = 50;
const EVVNT_TEST_SOURCE: EventSource = {
  id: "inewsource-events",
  url: "https://discovery.evvnt.com/api/publisher/11515/home_page_events?hitsPerPage=50&multipleEventInstances=true&page=0&publisher_id=11515",
  name: "inewsource Events (Evvnt)",
  fetchTier: "evvnt",
  categoryHint: "community",
  pollInterval: 720,
  enabled: true,
};

// Test P1: 3 full pages then empty → accumulates all 150 events (was limited to 3*50=150, same,
// but proving the loop doesn't stop at old MAX_PAGES=3 when there are MORE pages)
// We provide 5 full pages + 1 empty → expect 5*50 = 250 events (OLD code capped at 3*50=150)
test("P1. accumulates all pages when > old MAX_PAGES=3 (5 full pages + empty stop)", async () => {
  const originalFetch = globalThis.fetch;
  let callCount = 0;
  globalThis.fetch = async (url: RequestInfo | URL) => {
    const u = new URL(String(url));
    const page = parseInt(u.searchParams.get("page") ?? "0", 10);
    callCount++;
    let events: EvvntEvent[];
    if (page < 5) {
      events = makeEvvntPage(EVVNT_PAGE_SIZE, page);
    } else {
      events = []; // empty page — stop signal
    }
    return new Response(JSON.stringify(makeEvvntResponse(events)), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  try {
    const result = await fetchEvvntEvents(EVVNT_TEST_SOURCE);
    assert(
      result.length === 250,
      `P1. should return 250 events from 5 full pages, got ${result.length}`
    );
    assert(callCount >= 6, `P1. should have called fetch at least 6 times (5 full + 1 empty), got ${callCount}`);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// Test P2: Stop on empty page immediately
test("P2. stops immediately on first empty page (page 0 empty)", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    return new Response(JSON.stringify(makeEvvntResponse([])), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  try {
    const result = await fetchEvvntEvents(EVVNT_TEST_SOURCE);
    assert(result.length === 0, `P2. empty page 0 → 0 events, got ${result.length}`);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// Test P3: Short page (< HITS_PER_PAGE) stops pagination
test("P3. short final page stops pagination (natural last-page signal)", async () => {
  const originalFetch = globalThis.fetch;
  let callCount = 0;
  globalThis.fetch = async (url: RequestInfo | URL) => {
    const u = new URL(String(url));
    const page = parseInt(u.searchParams.get("page") ?? "0", 10);
    callCount++;
    let events: EvvntEvent[];
    if (page === 0) {
      events = makeEvvntPage(EVVNT_PAGE_SIZE, 0); // full page
    } else {
      events = makeEvvntPage(10, page); // short page → stop
    }
    return new Response(JSON.stringify(makeEvvntResponse(events)), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  try {
    const result = await fetchEvvntEvents(EVVNT_TEST_SOURCE);
    assert(result.length === 60, `P3. 1 full + 1 short → 60 events, got ${result.length}`);
    assert(callCount === 2, `P3. exactly 2 fetch calls (full + short), got ${callCount}`);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// Test P4: Safety bound stops runaway infinite full pages + logs
test("P4. safety bound stops runaway loop and logs warning", async () => {
  const originalFetch = globalThis.fetch;
  // Always return full pages — simulates an infinite paginating API
  globalThis.fetch = async () => {
    return new Response(JSON.stringify(makeEvvntResponse(makeEvvntPage(EVVNT_PAGE_SIZE, 0))), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  const warnMessages: string[] = [];
  const origLog = console.log;
  const origWarn = console.warn;
  // Capture any safety log (could be console.log or console.warn)
  console.log = (...args: unknown[]) => { warnMessages.push(args.join(" ")); origLog(...args); };
  console.warn = (...args: unknown[]) => { warnMessages.push(args.join(" ")); origWarn(...args); };
  try {
    const result = await fetchEvvntEvents(EVVNT_TEST_SOURCE);
    // Should be capped at MAX_PAGES_SAFETY * HITS_PER_PAGE
    assert(result.length < 10000, `P4. should be bounded, got ${result.length}`);
    assert(result.length > 0, `P4. should return events up to safety bound, got ${result.length}`);
    const safetyLogged = warnMessages.some(m => m.includes("safety bound") || m.includes("safety"));
    assert(safetyLogged, `P4. should log safety bound warning — got: ${warnMessages.join("; ")}`);
  } finally {
    globalThis.fetch = originalFetch;
    console.log = origLog;
    console.warn = origWarn;
  }
});

