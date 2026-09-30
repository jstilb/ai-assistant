#!/usr/bin/env bun
/**
 * jsonld.test.ts — Slice 9: TDD tests for JsonLd.extractJsonLdEvents()
 *
 * Tests the PURE FUNCTION extractJsonLdEvents(html, source) with inline HTML
 * fixtures. No network calls. Fully deterministic.
 *
 * Scenarios:
 *   (1) Single Event JSON-LD block → 1 EventItem with correct title/date/venue/price
 *   (2) @graph array containing 2 Events → 2 EventItems
 *   (3) ItemList of Events → correct count
 *   (4) Malformed JSON-LD block alongside a valid one → valid extracted, malformed skipped
 *   (5) Free event (offers.price: "0") → isFree:true
 *   (6) Free event (offers.price: "Free") → isFree:true
 *   (7) Naive startDate ("2026-07-04T20:00:00") → resolves to LA offset-aware ISO
 *   (8) Date-only startDate ("2026-07-04") → resolves to LA midnight
 *   (9) Nested Array top-level → extracts all Events
 *  (10) Multiple <script> blocks in one HTML document → merges all events
 *  (11) Event with no offers → isFree:false, no priceMin
 *  (12) Event with location.address (PostalAddress) → address field set
 *
 * Run:
 *   bun test ~/.claude/.claude/worktrees/arch-debt-d2-eventscout-buntest/skills/Productivity/EventScout/tests/jsonld.test.ts
 */

import { test } from "bun:test";
import { extractJsonLdEvents } from "../Tools/adapters/JsonLd.ts";
import { EventItemSchema } from "../Tools/types.ts";
import type { EventSource } from "../Tools/types.ts";
import { utcMsToLaParts } from "../Tools/lib/tz.ts";

// ============================================================================
// Test harness
//
// NOTE: assert/assertEq now throw on failure (converted from a non-throwing
// log+counter pattern) so that a failing condition actually fails the
// enclosing bun `test()` block instead of only being tallied at the end.
// ============================================================================

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

function assertEq<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    throw new Error(
      `Assertion failed: ${message} — expected: ${JSON.stringify(expected)}, actual: ${JSON.stringify(actual)}`
    );
  }
}

// ============================================================================
// Mock EventSource
// ============================================================================

const mockSource: EventSource = {
  id: "test-venue",
  name: "Test Venue",
  url: "https://example.com/events",
  fetchTier: "html-llm",
  categoryHint: "music",
  geoHint: "San Diego, CA",
  pollInterval: 720,
  enabled: true,
};

// ============================================================================
// HTML fixture builder
// ============================================================================

function htmlWith(jsonLdBlocks: string[]): string {
  const scripts = jsonLdBlocks
    .map((b) => `<script type="application/ld+json">${b}</script>`)
    .join("\n");
  return `<!DOCTYPE html><html><head>${scripts}</head><body><p>Event page</p></body></html>`;
}

// ============================================================================
// Scenario 1: Single Event object → 1 EventItem
// ============================================================================

test("Scenario 1: Single Event object → 1 EventItem", () => {
  const html = htmlWith([JSON.stringify({
    "@context": "https://schema.org",
    "@type": "Event",
    "name": "Summer Jazz Night",
    "startDate": "2026-07-10T20:00:00-07:00",
    "endDate": "2026-07-10T23:00:00-07:00",
    "location": {
      "@type": "Place",
      "name": "The Casbah",
      "address": "2501 Kettner Blvd, San Diego, CA 92101",
    },
    "offers": {
      "@type": "Offer",
      "price": "25",
      "priceCurrency": "USD",
      "url": "https://example.com/tickets/jazz",
    },
    "image": "https://example.com/jazz.jpg",
    "description": "A summer evening of jazz.",
    "url": "https://example.com/events/jazz-night",
  })]);

  const events = extractJsonLdEvents(html, mockSource);
  assertEq(events.length, 1, "single Event → 1 item");
  if (events.length === 1) {
    const ev = events[0]!;
    assertEq(ev.title, "Summer Jazz Night", "title correct");
    // offset-aware "2026-07-10T20:00:00-07:00" → UTC "2026-07-11T03:00:00.000Z"
    // the stored startDatetime is a valid parseable ISO string; check wall-clock via LA parts
    const laPartsS1 = utcMsToLaParts(new Date(ev.startDatetime).getTime());
    assert(laPartsS1.day === 10 && laPartsS1.month === 7, "startDatetime wall-clock = July 10");
    assertEq(ev.venue, "The Casbah", "venue correct");
    assertEq(ev.address, "2501 Kettner Blvd, San Diego, CA 92101", "address correct");
    assertEq(ev.priceMin, 25, "priceMin = 25");
    assert(ev.isFree === false, "isFree = false");
    assertEq(ev.ticketUrl, "https://example.com/tickets/jazz", "ticketUrl from offers.url");
    assertEq(ev.imageUrl, "https://example.com/jazz.jpg", "imageUrl correct");
    assertEq(ev.description, "A summer evening of jazz.", "description correct");
    assertEq(ev.sources[0]!.sourceId, mockSource.id, "sources[0].sourceId = mockSource.id");
    assert(ev.id.length === 16, "id is 16-char hex");
    // Validate against full schema
    const parsed = EventItemSchema.safeParse(ev);
    if (!parsed.success) console.error("    Zod errors:", parsed.error.issues);
    assert(parsed.success, "passes EventItemSchema");
  }
});

// ============================================================================
// Scenario 2: @graph containing 2 Events → 2 EventItems
// ============================================================================

test("Scenario 2: @graph with 2 Events → 2 EventItems", () => {
  const html = htmlWith([JSON.stringify({
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "Event",
        "name": "Rock Show Alpha",
        "startDate": "2026-07-15T19:00:00-07:00",
        "location": { "@type": "Place", "name": "Venue Alpha" },
      },
      {
        "@type": "Event",
        "name": "Rock Show Beta",
        "startDate": "2026-07-16T20:00:00-07:00",
        "location": { "@type": "Place", "name": "Venue Beta" },
      },
      {
        "@type": "Organization",
        "name": "Not an Event",
      },
    ],
  })]);

  const events = extractJsonLdEvents(html, mockSource);
  assertEq(events.length, 2, "@graph with 2 Events + 1 Organization → 2 events");
  if (events.length >= 2) {
    assertEq(events[0]!.title, "Rock Show Alpha", "first event title correct");
    assertEq(events[1]!.title, "Rock Show Beta", "second event title correct");
    assertEq(events[0]!.venue, "Venue Alpha", "first event venue correct");
    assertEq(events[1]!.venue, "Venue Beta", "second event venue correct");
  }
});

// ============================================================================
// Scenario 3: ItemList of Events → correct count
// ============================================================================

test("Scenario 3: ItemList of Events → extracts all Event items", () => {
  const html = htmlWith([JSON.stringify({
    "@context": "https://schema.org",
    "@type": "ItemList",
    "itemListElement": [
      {
        "@type": "ListItem",
        "position": 1,
        "item": {
          "@type": "Event",
          "name": "Comedy Showcase A",
          "startDate": "2026-08-01T19:30:00-07:00",
          "location": { "@type": "Place", "name": "Comedy Spot" },
        },
      },
      {
        "@type": "ListItem",
        "position": 2,
        "item": {
          "@type": "Event",
          "name": "Comedy Showcase B",
          "startDate": "2026-08-02T19:30:00-07:00",
          "location": { "@type": "Place", "name": "Comedy Spot" },
        },
      },
      {
        "@type": "ListItem",
        "position": 3,
        "item": {
          "@type": "Event",
          "name": "Comedy Showcase C",
          "startDate": "2026-08-03T20:00:00-07:00",
          "location": { "@type": "Place", "name": "Comedy Spot" },
        },
      },
    ],
  })]);

  const events = extractJsonLdEvents(html, mockSource);
  assertEq(events.length, 3, "ItemList of 3 Event items → 3 events");
  if (events.length === 3) {
    assertEq(events[0]!.title, "Comedy Showcase A", "first item title correct");
    assertEq(events[2]!.title, "Comedy Showcase C", "third item title correct");
  }
});

// ============================================================================
// Scenario 4: Malformed JSON-LD alongside valid → valid extracted, malformed skipped
// ============================================================================

test("Scenario 4: Malformed JSON-LD block + valid → valid extracted, no throw", () => {
  const goodBlock = JSON.stringify({
    "@context": "https://schema.org",
    "@type": "Event",
    "name": "Valid Event",
    "startDate": "2026-09-05T18:00:00-07:00",
    "location": { "@type": "Place", "name": "Good Venue" },
  });
  const malformedBlock = `{ "@type": "Event", "name": "Bad Event", "startDate": INVALID_JSON }`;

  const html = htmlWith([malformedBlock, goodBlock]);

  let threw = false;
  let events: ReturnType<typeof extractJsonLdEvents> = [];
  try {
    events = extractJsonLdEvents(html, mockSource);
  } catch {
    threw = true;
  }

  assert(!threw, "malformed JSON-LD block does not throw");
  assertEq(events.length, 1, "1 valid event extracted despite malformed block");
  if (events.length === 1) {
    assertEq(events[0]!.title, "Valid Event", "correct event extracted");
  }
});

// ============================================================================
// Scenario 5: Free event (offers.price: "0") → isFree:true
// ============================================================================

test("Scenario 5: offers.price=0 → isFree:true", () => {
  const html = htmlWith([JSON.stringify({
    "@context": "https://schema.org",
    "@type": "Event",
    "name": "Free Concert",
    "startDate": "2026-07-20T17:00:00-07:00",
    "offers": {
      "@type": "Offer",
      "price": "0",
      "priceCurrency": "USD",
    },
  })]);

  const events = extractJsonLdEvents(html, mockSource);
  assertEq(events.length, 1, "free event (price=0) → 1 item");
  if (events.length === 1) {
    assert(events[0]!.isFree === true, 'offers.price="0" → isFree=true');
    assertEq(events[0]!.priceMin, 0, "priceMin = 0");
  }
});

// ============================================================================
// Scenario 6: Free event (offers.price: "Free") → isFree:true
// ============================================================================

test('Scenario 6: offers.price="Free" → isFree:true', () => {
  const html = htmlWith([JSON.stringify({
    "@context": "https://schema.org",
    "@type": "Event",
    "name": "Free Film Screening",
    "startDate": "2026-07-25T19:00:00-07:00",
    "offers": {
      "@type": "Offer",
      "price": "Free",
    },
  })]);

  const events = extractJsonLdEvents(html, mockSource);
  assertEq(events.length, 1, 'free event (price="Free") → 1 item');
  if (events.length === 1) {
    assert(events[0]!.isFree === true, 'offers.price="Free" → isFree=true');
  }
});

// ============================================================================
// Scenario 7: Naive startDate → resolves to LA offset-aware ISO
// ============================================================================

test("Scenario 7: Naive startDate → resolves to America/Los_Angeles", () => {
  const html = htmlWith([JSON.stringify({
    "@context": "https://schema.org",
    "@type": "Event",
    "name": "Independence Day Show",
    "startDate": "2026-07-04T20:00:00",
    "location": { "@type": "Place", "name": "Petco Park" },
  })]);

  const events = extractJsonLdEvents(html, mockSource);
  assertEq(events.length, 1, "naive startDate → 1 item");
  if (events.length === 1) {
    const ev = events[0]!;
    const utcMs = new Date(ev.startDatetime).getTime();
    assert(!isNaN(utcMs), "startDatetime parses as valid Date");
    const la = utcMsToLaParts(utcMs);
    // 2026-07-04T20:00:00 naive LA (PDT = UTC-7) → UTC = 2026-07-05T03:00:00Z
    assertEq(la.hour, 20, "naive 20:00 → LA wall-clock hour = 20");
    assertEq(la.day, 4, "naive July-4 → LA wall-clock day = 4");
    assertEq(la.month, 7, "naive July → LA wall-clock month = 7");
    // String must contain the offset (not be UTC Z)
    assert(
      ev.startDatetime.includes("-07:00") || ev.startDatetime.includes("+00:00"),
      "startDatetime has timezone offset"
    );
  }
});

// ============================================================================
// Scenario 8: Date-only startDate → LA midnight
// ============================================================================

test("Scenario 8: Date-only startDate → LA local midnight", () => {
  const html = htmlWith([JSON.stringify({
    "@context": "https://schema.org",
    "@type": "Event",
    "name": "All Day Festival",
    "startDate": "2026-07-04",
    "location": { "@type": "Place", "name": "Balboa Park" },
  })]);

  const events = extractJsonLdEvents(html, mockSource);
  assertEq(events.length, 1, "date-only startDate → 1 item");
  if (events.length === 1) {
    const ev = events[0]!;
    const utcMs = new Date(ev.startDatetime).getTime();
    assert(!isNaN(utcMs), "startDatetime parses as valid Date");
    const la = utcMsToLaParts(utcMs);
    // LA midnight on July 4 during PDT (UTC-7) = 2026-07-04T07:00:00Z
    assertEq(la.hour, 0, "date-only → LA wall-clock hour = 0 (midnight)");
    assertEq(la.day, 4, "date-only July 4 → LA day = 4");
    assertEq(la.month, 7, "date-only July → LA month = 7");
  }
});

// ============================================================================
// Scenario 9: Top-level array of Events → extracts all
// ============================================================================

test("Scenario 9: Top-level JSON array of Event objects → extracts all", () => {
  const html = htmlWith([JSON.stringify([
    {
      "@context": "https://schema.org",
      "@type": "Event",
      "name": "Array Event One",
      "startDate": "2026-08-10T18:00:00-07:00",
    },
    {
      "@context": "https://schema.org",
      "@type": "Event",
      "name": "Array Event Two",
      "startDate": "2026-08-11T19:00:00-07:00",
    },
  ])]);

  const events = extractJsonLdEvents(html, mockSource);
  assertEq(events.length, 2, "top-level array of 2 Events → 2 items");
  if (events.length === 2) {
    assertEq(events[0]!.title, "Array Event One", "first array event title correct");
    assertEq(events[1]!.title, "Array Event Two", "second array event title correct");
  }
});

// ============================================================================
// Scenario 10: Multiple <script> blocks → merges all events
// ============================================================================

test("Scenario 10: Multiple <script type=application/ld+json> blocks → merged", () => {
  const html = htmlWith([
    JSON.stringify({
      "@context": "https://schema.org",
      "@type": "Event",
      "name": "Block One Event",
      "startDate": "2026-09-01T19:00:00-07:00",
    }),
    JSON.stringify({
      "@context": "https://schema.org",
      "@type": "Event",
      "name": "Block Two Event",
      "startDate": "2026-09-02T20:00:00-07:00",
    }),
  ]);

  const events = extractJsonLdEvents(html, mockSource);
  assertEq(events.length, 2, "two script blocks → 2 events combined");
  if (events.length === 2) {
    assertEq(events[0]!.title, "Block One Event", "first block event");
    assertEq(events[1]!.title, "Block Two Event", "second block event");
  }
});

// ============================================================================
// Scenario 11: Event with no offers → isFree:false, no priceMin
// ============================================================================

test("Scenario 11: No offers field → isFree:false, priceMin undefined", () => {
  const html = htmlWith([JSON.stringify({
    "@context": "https://schema.org",
    "@type": "Event",
    "name": "Mystery Pricing Show",
    "startDate": "2026-10-01T20:00:00-07:00",
    "location": { "@type": "Place", "name": "Mystery Venue" },
  })]);

  const events = extractJsonLdEvents(html, mockSource);
  assertEq(events.length, 1, "no offers → 1 item");
  if (events.length === 1) {
    assert(events[0]!.isFree === false, "no offers → isFree=false (default)");
    assert(events[0]!.priceMin === undefined, "no offers → priceMin undefined");
  }
});

// ============================================================================
// Scenario 12: PostalAddress object in location.address → address set
// ============================================================================

test("Scenario 12: PostalAddress in location.address → address extracted", () => {
  const html = htmlWith([JSON.stringify({
    "@context": "https://schema.org",
    "@type": "Event",
    "name": "Address Test Event",
    "startDate": "2026-11-15T18:00:00-08:00",
    "location": {
      "@type": "Place",
      "name": "Rady Shell",
      "address": {
        "@type": "PostalAddress",
        "streetAddress": "222 Marina Park Way",
        "addressLocality": "San Diego",
        "addressRegion": "CA",
        "postalCode": "92101",
      },
    },
  })]);

  const events = extractJsonLdEvents(html, mockSource);
  assertEq(events.length, 1, "PostalAddress location → 1 item");
  if (events.length === 1) {
    assertEq(events[0]!.venue, "Rady Shell", "venue from location.name");
    assert(
      typeof events[0]!.address === "string" && events[0]!.address!.length > 0,
      "address extracted from PostalAddress"
    );
    assert(
      events[0]!.address!.includes("222 Marina Park Way"),
      "address contains street address"
    );
  }
});

// ============================================================================
// Scenario 13: offers.lowPrice used when price absent
// ============================================================================

test("Scenario 13: offers.lowPrice (no price) → priceMin set", () => {
  const html = htmlWith([JSON.stringify({
    "@context": "https://schema.org",
    "@type": "Event",
    "name": "Low Price Show",
    "startDate": "2026-12-01T20:00:00-08:00",
    "offers": {
      "@type": "AggregateOffer",
      "lowPrice": "15",
      "highPrice": "50",
      "priceCurrency": "USD",
    },
  })]);

  const events = extractJsonLdEvents(html, mockSource);
  assertEq(events.length, 1, "offers.lowPrice → 1 item");
  if (events.length === 1) {
    assertEq(events[0]!.priceMin, 15, "priceMin from offers.lowPrice");
    assert(events[0]!.isFree === false, "priceMin=15 → isFree=false");
  }
});
