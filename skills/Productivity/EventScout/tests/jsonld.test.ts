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
 *   bun test skills/Productivity/EventScout/tests/jsonld.test.ts
 */

import { test } from "bun:test";
import { extractJsonLdEvents } from "../Tools/adapters/JsonLd.ts";
import { EventItemSchema } from "../Tools/types.ts";
import type { EventSource } from "../Tools/types.ts";
import { utcMsToLaParts } from "../Tools/lib/tz.ts";
import { defined } from "../../../../lib/test/defined.ts";

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
      `Assertion failed: ${message} — expected: ${JSON.stringify(expected)}, actual: ${JSON.stringify(actual)}`,
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
  const scripts = jsonLdBlocks.map((b) => `<script type="application/ld+json">${b}</script>`).join("\n");
  return `<!DOCTYPE html><html><head>${scripts}</head><body><p>Event page</p></body></html>`;
}

// ============================================================================
// Scenario 1: Single Event object → 1 EventItem
// ============================================================================

test("Scenario 1: Single Event object → 1 EventItem", () => {
  const html = htmlWith([
    JSON.stringify({
      "@context": "https://schema.org",
      "@type": "Event",
      name: "Summer Jazz Night",
      startDate: "2026-07-10T20:00:00-07:00",
      endDate: "2026-07-10T23:00:00-07:00",
      location: {
        "@type": "Place",
        name: "The Casbah",
        address: "2501 Kettner Blvd, San Diego, CA 92101",
      },
      offers: {
        "@type": "Offer",
        price: "25",
        priceCurrency: "USD",
        url: "https://example.com/tickets/jazz",
      },
      image: "https://example.com/jazz.jpg",
      description: "A summer evening of jazz.",
      url: "https://example.com/events/jazz-night",
    }),
  ]);

  const events = extractJsonLdEvents(html, mockSource);
  assertEq(events.length, 1, "single Event → 1 item");
  if (events.length === 1) {
    const ev = defined(events[0]);
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
    assertEq(defined(ev.sources[0]).sourceId, mockSource.id, "sources[0].sourceId = mockSource.id");
    assert(ev.id.length === 16, "id is 16-char hex");
    // Validate against full schema
    const parsed = EventItemSchema.safeParse(ev);
    if (!parsed.success) console.error("    Zod errors:", parsed.error.issues);
    assert(parsed.success, "passes EventItemSchema");
  }
});

test("price range uses the first offer and ignores a nonnumeric maximum", () => {
  const event = {
    "@type": "Event",
    name: "Advertised range",
    startDate: "2026-11-08T16:00:00-08:00",
    offers: [
      { lowPrice: 20.17, highPrice: 30.72, priceCurrency: "USD" },
      { lowPrice: 5, highPrice: 100, priceCurrency: "EUR" },
    ],
  };
  const [item] = extractJsonLdEvents(htmlWith([JSON.stringify(event)]), mockSource);
  assertEq(item?.priceMin, 20.17, "minimum uses first offer");
  assertEq(item?.priceMax, 30.72, "maximum uses first offer");
  assertEq(item?.currency, "USD", "currency uses first offer");
  const [unknownMax] = extractJsonLdEvents(htmlWith([JSON.stringify({
    ...event, offers: { lowPrice: "20.17", highPrice: "not disclosed" },
  })]), mockSource);
  assertEq(unknownMax?.priceMin, 20.17, "invalid maximum preserves known minimum");
  assert(unknownMax?.priceMax === undefined, "nonnumeric maximum stays unknown");
  assert(unknownMax?.currency === undefined, "missing currency stays unknown");
  const invalidCurrency = extractJsonLdEvents(htmlWith([JSON.stringify({
    ...event, offers: { lowPrice: "20.17", highPrice: "30.72", priceCurrency: 123 },
  })]), mockSource);
  assertEq(invalidCurrency.length, 0, "invalid currency type fails the existing schema");
});

test("malformed or contradictory advertised maximums stay unknown", () => {
  for (const highPrice of [-10, "-10", "20–30", "about 30 tickets", "30abc", "", "Infinity", "1e309", 19]) {
    const [item] = extractJsonLdEvents(htmlWith([JSON.stringify({
      "@type": "Event",
      name: "Invalid advertised maximum",
      startDate: "2026-11-08T16:00:00-08:00",
      offers: { lowPrice: "20.17", highPrice, priceCurrency: "USD" },
    })]), mockSource);
    assertEq(item?.priceMin, 20.17, `minimum survives highPrice ${JSON.stringify(highPrice)}`);
    assertEq(item?.currency, "USD", `currency survives highPrice ${JSON.stringify(highPrice)}`);
    assert(item?.priceMax === undefined, `invalid highPrice ${JSON.stringify(highPrice)} stays unknown`);
  }
});

test("Eventbrite listing date-only fields use exact occurrence metadata", () => {
  const url = "https://www.eventbrite.com/e/example-event-tickets-123456789";
  const event = { "@type": "Event", name: "Example", url, startDate: "2026-11-08", endDate: "2026-11-08" };
  const row = {
    id: "123456789", url, start_date: "2026-11-08", end_date: "2026-11-08",
    start_time: "16:00", end_time: "21:00", timezone: "America/Los_Angeles",
    hide_start_date: false, hide_end_date: false,
  };
  const source = { ...mockSource, url: "https://www.eventbrite.com/d/ca--san-diego/events/" };
  const html = htmlWith([JSON.stringify(event)]) + `<script>window.__SERVER_DATA__ = ${JSON.stringify({ search_data: { events: { results: [row] } } })};</script>`;
  const [item] = extractJsonLdEvents(html, source);
  assertEq(item?.startDatetime, "2026-11-08T16:00:00-08:00", "exact occurrence start uses explicit LA zone");
  assertEq(item?.endDatetime, "2026-11-08T21:00:00-08:00", "exact occurrence end uses explicit LA zone");
});

test("Eventbrite Canada occurrence times accept bounded hosts and exact IDs", () => {
  const source = { ...mockSource, url: "https://www.eventbrite.com/d/ca--san-diego/all-events/" };
  const extract = (host: string, rowId = "1998984113294", protocol = "https:", hideEnd = false) => {
    const url = `${protocol}//${host}/e/networking-event-tickets-1998984113294`;
    const event = { "@type": "Event", name: "Networking event", url, startDate: "2026-11-06", endDate: "2026-11-06" };
    const row = {
      id: rowId, url, start_date: "2026-11-06", end_date: "2026-11-06",
      start_time: "19:00", end_time: "21:00", timezone: "America/Los_Angeles",
      hide_start_date: false, hide_end_date: hideEnd,
    };
    const html = htmlWith([JSON.stringify(event)]) + `<script>window.__SERVER_DATA__ = ${JSON.stringify({ search_data: { events: { results: [row] } } })};</script>`;
    return defined(extractJsonLdEvents(html, source)[0]);
  };
  for (const host of ["eventbrite.ca", "www.eventbrite.ca", "tickets.eventbrite.ca"]) {
    const item = extract(host);
    assertEq(item.startDatetime, "2026-11-06T19:00:00-08:00", `${host} exact occurrence start`);
    assertEq(item.endDatetime, "2026-11-06T21:00:00-08:00", `${host} exact occurrence end`);
    assertEq(item.ticketUrl, `https://${host}/e/networking-event-tickets-1998984113294`, "ticket URL stays unchanged");
  }
  for (const host of ["eventbrite.ca.evil", "www.eventbrite.ca.evil", "fakeeventbrite.ca", "eventbrite-ca.example"]) {
    assertEq(extract(host).startDatetime, "2026-11-06T00:00:00-08:00", `${host} cannot supply times`);
  }
  assertEq(extract("www.eventbrite.ca", "987654321").startDatetime, "2026-11-06T00:00:00-08:00", "Canada occurrence ID must match");
  assertEq(extract("www.eventbrite.ca", "1998984113294", "http:").startDatetime, "2026-11-06T00:00:00-08:00", "Canada metadata requires HTTPS");
  assertEq(extract("www.eventbrite.ca", "1998984113294", "https:", true).startDatetime, "2026-11-06T00:00:00-08:00", "Canada hidden end cannot create reversed interval");
});

test("Eventbrite metadata leaves unsupported, ambiguous, and precise fields unchanged", () => {
  const url = "https://www.eventbrite.com/e/example-event-tickets-123456789";
  const event = { "@type": "Event", name: "Example", url, startDate: "2026-11-08", endDate: "2026-11-08" };
  const row = {
    id: "123456789", url, start_date: "2026-11-08", end_date: "2026-11-08",
    start_time: "16:00", end_time: "21:00", timezone: "America/Los_Angeles",
    hide_start_date: false, hide_end_date: false,
  };
  const extract = (rows: unknown[], overrides: Record<string, unknown> = {}, sourceUrl = "https://www.eventbrite.com/d/ca--san-diego/events/") => {
    const html = htmlWith([JSON.stringify({ ...event, ...overrides })]) + `<script>window.__SERVER_DATA__ = ${JSON.stringify({ search_data: { events: { results: rows } } })}; throw new Error("must never execute");</script>`;
    const items = extractJsonLdEvents(html, { ...mockSource, url: sourceUrl });
    assertEq(items.length, 1, "invalid metadata preserves the occurrence");
    return defined(items[0]);
  };
  for (const override of [
    { id: "987654321" }, { url: "https://www.eventbrite.com.evil/e/example-123456789" },
    { url: "https://example.com/e/example-123456789" }, { timezone: "America/Tijuana" },
    { start_time: "24:00" }, { start_time: "16:60" }, { start_time: "16" },
    { start_date: "2026-11-09" }, { hide_start_date: true }, { hide_start_date: undefined },
  ]) {
    assertEq(extract([{ ...row, ...override }]).startDatetime, "2026-11-08T00:00:00-08:00", `unsafe start metadata ${JSON.stringify(override)}`);
  }
  assertEq(extract([row, row]).startDatetime, "2026-11-08T00:00:00-08:00", "duplicate identities stay unchanged");
  assertEq(extract([row, { id: row.id, timezone: 123 }]).startDatetime, "2026-11-08T00:00:00-08:00", "malformed duplicate stays ambiguous");
  assertEq(extract([row], {}, "https://www.eventbrite.com.evil/").startDatetime, "2026-11-08T00:00:00-08:00", "foreign source cannot augment events");
  assertEq(extract([row], { url: "https://www.eventbrite.co.uk/e/example-123456789" }).startDatetime, "2026-11-08T00:00:00-08:00", "unsupported country host stays unchanged");
  const preciseStart = extract([row], { startDate: "2026-11-08T15:00:00-08:00" });
  assertEq(preciseStart.startDatetime, "2026-11-08T23:00:00.000Z", "explicit start is preserved");
  assertEq(preciseStart.endDatetime, "2026-11-08T21:00:00-08:00", "end can independently gain precision");
  const preciseEnd = extract([row], { endDate: "2026-11-08T20:00:00-08:00" });
  assertEq(preciseEnd.startDatetime, "2026-11-08T16:00:00-08:00", "start can independently gain precision");
  assertEq(preciseEnd.endDatetime, "2026-11-09T04:00:00.000Z", "explicit end is preserved");
  assertEq(extract([{ ...row, hide_end_date: true }]).endDatetime, "2026-11-08T00:00:00-08:00", "hidden end stays unchanged");
  assertEq(extract([{ ...row, hide_end_date: true }]).startDatetime, "2026-11-08T00:00:00-08:00", "hidden end cannot create a reversed interval");
  assertEq(extract([{ ...row, end_time: undefined }]).startDatetime, "2026-11-08T00:00:00-08:00", "missing end cannot create a reversed interval");
  assertEq(extract([{ ...row, end_time: "15:00" }]).startDatetime, "2026-11-08T00:00:00-08:00", "reversed structured interval stays unchanged");
  assertEq(extract([row], { endDate: "2026-11-08T15:00:00-08:00" }).startDatetime, "2026-11-08T00:00:00-08:00", "precise earlier end blocks supplementation");
  for (const [date, time] of [["2027-03-14", "02:30"], ["2026-11-01", "01:30"]]) {
    const item = extract([{ ...row, start_date: date, start_time: time }], { startDate: date, endDate: undefined });
    assert(item.startDatetime.startsWith(`${date}T00:00:00`), "nonexistent or ambiguous local start stays unchanged");
  }
});

test("Eventbrite identity preserves distinct registrations and stable provider occurrence aliases", () => {
  const extract = (url: string, name = "Gaslamp Experience 15 CLUBS IN 1 NIGHT - Party Pass", startDate = "2026-11-06T21:00:00-08:00", venue = "Good Night John Boy") => defined(extractJsonLdEvents(htmlWith([JSON.stringify({
    "@type": "Event", name, url, startDate, location: { "@type": "Place", name: venue },
  })]), mockSource)[0]);
  const first = extract("https://www.eventbrite.com/e/gaslamp-tickets-1983188922453");
  const second = extract("https://www.eventbrite.com/e/gaslamp-tickets-1982829737120");
  assert(first.id !== second.id, "distinct exact source registrations retain distinct normalized IDs");
  const alias = extract("https://www.eventbrite.com/e/renamed-registration-tickets-1983188922453", "Renamed registration", "2026-11-07T05:00:00Z", "Updated venue label");
  assertEq(alias.id, first.id, "same provider ID and instant survives title, venue, slug, and offset aliases");
  assert(extract("https://www.eventbrite.com/e/gaslamp-tickets-1983188922453", undefined, "2026-11-07T21:00:00-08:00").id !== first.id, "different performance start retains distinct identity");
  for (const host of ["eventbrite.com", "www.eventbrite.com", "eventbrite.ca", "www.eventbrite.ca", "tickets.eventbrite.ca"]) {
    assertEq(extract(`https://${host}/e/alias-tickets-1983188922453`).id, first.id, `${host} retains exact provider identity`);
  }
});

test("unsupported Eventbrite identity URLs preserve the existing fallback hash", () => {
  for (const url of [undefined, "https://example.com/e/identity-1983188922453", "https://www.eventbrite.co.uk/e/identity-1983188922453", "https://eventbrite.com.evil/e/identity-1983188922453", "https://fakeeventbrite.ca/e/identity-1983188922453", "http://www.eventbrite.com/e/identity-1983188922453", "https://www.eventbrite.com/e/no-numeric-id", "https://www.eventbrite.com/not-an-event-1983188922453"]) {
    const [item] = extractJsonLdEvents(htmlWith([JSON.stringify({
      "@type": "Event", name: "Identity example", url, startDate: "2026-11-06T21:00:00-08:00",
      location: { "@type": "Place", name: "Test Venue" },
    })]), mockSource);
    assertEq(item?.id, "ed4036a309b05166", `unsupported URL ${url} retains original hash`);
  }
});

test("JSON-LD preserves date-only precision without changing explicit midnight", () => {
  const extract = (startDate: string, endDate?: string) => defined(extractJsonLdEvents(htmlWith([JSON.stringify({
    "@type": "Event", name: "Precision example", startDate, endDate,
  })]), mockSource)[0]);
  const dateOnly = extract("2026-11-15", "2026-11-16");
  assertEq(dateOnly.startTimeKnown, false, "date-only start has no clock");
  assertEq(dateOnly.endTimeKnown, false, "date-only end has no clock");
  assertEq(dateOnly.startDatetime, "2026-11-15T00:00:00-08:00", "normalized start remains stable");
  assertEq(dateOnly.allDay, false, "date-only does not imply all day");
  assertEq(extract(" 2026-11-15 ", " 2026-11-16 ").startTimeKnown, false, "trimmed date-only start has no clock");
  assertEq(extract(" 2026-11-15 ", " 2026-11-16 ").endTimeKnown, false, "trimmed date-only end has no clock");
  const midnight = extract("2026-11-15T00:00:00-08:00", "2026-11-15T01:00:00-08:00");
  assert(midnight.startTimeKnown !== false && midnight.endTimeKnown !== false, "explicit clocks stay known");
  const mixed = extract("2026-11-15T16:00:00-08:00", "2026-11-16");
  assert(mixed.startTimeKnown !== false, "precise start stays known");
  assertEq(mixed.endTimeKnown, false, "date-only end stays unknown");
  assert(extract("2026-11-15").endTimeKnown === undefined, "missing end does not gain metadata");
});

test("JSON-LD location geo preserves complete valid coordinate pairs", () => {
  for (const [latitude, longitude] of [[32.7113749, -117.15255530000002], ["32.7113749", "-117.15255530000002"], [0, 0], [-90, 180]]) {
    const [item] = extractJsonLdEvents(htmlWith([JSON.stringify({
      "@type": "Event", name: "Located event", startDate: "2026-11-08T16:00:00-08:00",
      location: { "@type": "Place", name: "Venue", geo: { "@type": "GeoCoordinates", latitude, longitude } },
    })]), mockSource);
    assertEq(item?.lat, Number(latitude), "latitude preserves the source number");
    assertEq(item?.lng, Number(longitude), "longitude preserves the source number");
  }
});

test("malformed or partial JSON-LD geo stays unknown without losing the occurrence", () => {
  for (const geo of [
    undefined, null, "32,-117", {}, { latitude: 32 }, { longitude: -117 },
    { latitude: "", longitude: "" }, { latitude: null, longitude: -117 },
    { latitude: true, longitude: -117 }, { latitude: "32abc", longitude: -117 },
    { latitude: "32–33", longitude: -117 }, { latitude: 91, longitude: -117 },
    { latitude: 32, longitude: -181 }, { latitude: "1e309", longitude: -117 },
    { latitude: 32, longitude: "NaN" }, { latitude: [32], longitude: -117 },
  ]) {
    const items = extractJsonLdEvents(htmlWith([JSON.stringify({
      "@type": "Event", name: "Unknown location", startDate: "2026-11-08T16:00:00-08:00",
      location: { name: "Venue", geo },
    })]), mockSource);
    assertEq(items.length, 1, "invalid coordinates preserve the occurrence");
    assert(defined(items[0]).lat === undefined && defined(items[0]).lng === undefined, "invalid coordinate pair stays unknown");
  }
});

// ============================================================================
// Scenario 2: @graph containing 2 Events → 2 EventItems
// ============================================================================

test("Scenario 2: @graph with 2 Events → 2 EventItems", () => {
  const html = htmlWith([
    JSON.stringify({
      "@context": "https://schema.org",
      "@graph": [
        {
          "@type": "Event",
          name: "Rock Show Alpha",
          startDate: "2026-07-15T19:00:00-07:00",
          location: { "@type": "Place", name: "Venue Alpha" },
        },
        {
          "@type": "Event",
          name: "Rock Show Beta",
          startDate: "2026-07-16T20:00:00-07:00",
          location: { "@type": "Place", name: "Venue Beta" },
        },
        {
          "@type": "Organization",
          name: "Not an Event",
        },
      ],
    }),
  ]);

  const events = extractJsonLdEvents(html, mockSource);
  assertEq(events.length, 2, "@graph with 2 Events + 1 Organization → 2 events");
  if (events.length >= 2) {
    assertEq(defined(events[0]).title, "Rock Show Alpha", "first event title correct");
    assertEq(defined(events[1]).title, "Rock Show Beta", "second event title correct");
    assertEq(defined(events[0]).venue, "Venue Alpha", "first event venue correct");
    assertEq(defined(events[1]).venue, "Venue Beta", "second event venue correct");
  }
});

// ============================================================================
// Scenario 3: ItemList of Events → correct count
// ============================================================================

test("Scenario 3: ItemList of Events → extracts all Event items", () => {
  const html = htmlWith([
    JSON.stringify({
      "@context": "https://schema.org",
      "@type": "ItemList",
      itemListElement: [
        {
          "@type": "ListItem",
          position: 1,
          item: {
            "@type": "Event",
            name: "Comedy Showcase A",
            startDate: "2026-08-01T19:30:00-07:00",
            location: { "@type": "Place", name: "Comedy Spot" },
          },
        },
        {
          "@type": "ListItem",
          position: 2,
          item: {
            "@type": "Event",
            name: "Comedy Showcase B",
            startDate: "2026-08-02T19:30:00-07:00",
            location: { "@type": "Place", name: "Comedy Spot" },
          },
        },
        {
          "@type": "ListItem",
          position: 3,
          item: {
            "@type": "Event",
            name: "Comedy Showcase C",
            startDate: "2026-08-03T20:00:00-07:00",
            location: { "@type": "Place", name: "Comedy Spot" },
          },
        },
      ],
    }),
  ]);

  const events = extractJsonLdEvents(html, mockSource);
  assertEq(events.length, 3, "ItemList of 3 Event items → 3 events");
  if (events.length === 3) {
    assertEq(defined(events[0]).title, "Comedy Showcase A", "first item title correct");
    assertEq(defined(events[2]).title, "Comedy Showcase C", "third item title correct");
  }
});

// ============================================================================
// Scenario 4: Malformed JSON-LD alongside valid → valid extracted, malformed skipped
// ============================================================================

test("Scenario 4: Malformed JSON-LD block + valid → valid extracted, no throw", () => {
  const goodBlock = JSON.stringify({
    "@context": "https://schema.org",
    "@type": "Event",
    name: "Valid Event",
    startDate: "2026-09-05T18:00:00-07:00",
    location: { "@type": "Place", name: "Good Venue" },
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
    assertEq(defined(events[0]).title, "Valid Event", "correct event extracted");
  }
});

// ============================================================================
// Scenario 5: Free event (offers.price: "0") → isFree:true
// ============================================================================

test("Scenario 5: offers.price=0 → isFree:true", () => {
  const html = htmlWith([
    JSON.stringify({
      "@context": "https://schema.org",
      "@type": "Event",
      name: "Free Concert",
      startDate: "2026-07-20T17:00:00-07:00",
      offers: {
        "@type": "Offer",
        price: "0",
        priceCurrency: "USD",
      },
    }),
  ]);

  const events = extractJsonLdEvents(html, mockSource);
  assertEq(events.length, 1, "free event (price=0) → 1 item");
  if (events.length === 1) {
    assert(defined(events[0]).isFree === true, 'offers.price="0" → isFree=true');
    assertEq(defined(events[0]).priceMin, 0, "priceMin = 0");
  }
});

// ============================================================================
// Scenario 6: Free event (offers.price: "Free") → isFree:true
// ============================================================================

test('Scenario 6: offers.price="Free" → isFree:true', () => {
  const html = htmlWith([
    JSON.stringify({
      "@context": "https://schema.org",
      "@type": "Event",
      name: "Free Film Screening",
      startDate: "2026-07-25T19:00:00-07:00",
      offers: {
        "@type": "Offer",
        price: "Free",
      },
    }),
  ]);

  const events = extractJsonLdEvents(html, mockSource);
  assertEq(events.length, 1, 'free event (price="Free") → 1 item');
  if (events.length === 1) {
    assert(defined(events[0]).isFree === true, 'offers.price="Free" → isFree=true');
  }
});

// ============================================================================
// Scenario 7: Naive startDate → resolves to LA offset-aware ISO
// ============================================================================

test("Scenario 7: Naive startDate → resolves to America/Los_Angeles", () => {
  const html = htmlWith([
    JSON.stringify({
      "@context": "https://schema.org",
      "@type": "Event",
      name: "Independence Day Show",
      startDate: "2026-07-04T20:00:00",
      location: { "@type": "Place", name: "Petco Park" },
    }),
  ]);

  const events = extractJsonLdEvents(html, mockSource);
  assertEq(events.length, 1, "naive startDate → 1 item");
  if (events.length === 1) {
    const ev = defined(events[0]);
    const utcMs = new Date(ev.startDatetime).getTime();
    assert(!Number.isNaN(utcMs), "startDatetime parses as valid Date");
    const la = utcMsToLaParts(utcMs);
    // 2026-07-04T20:00:00 naive LA (PDT = UTC-7) → UTC = 2026-07-05T03:00:00Z
    assertEq(la.hour, 20, "naive 20:00 → LA wall-clock hour = 20");
    assertEq(la.day, 4, "naive July-4 → LA wall-clock day = 4");
    assertEq(la.month, 7, "naive July → LA wall-clock month = 7");
    // String must contain the offset (not be UTC Z)
    assert(
      ev.startDatetime.includes("-07:00") || ev.startDatetime.includes("+00:00"),
      "startDatetime has timezone offset",
    );
  }
});

// ============================================================================
// Scenario 8: Date-only startDate → LA midnight
// ============================================================================

test("Scenario 8: Date-only startDate → LA local midnight", () => {
  const html = htmlWith([
    JSON.stringify({
      "@context": "https://schema.org",
      "@type": "Event",
      name: "All Day Festival",
      startDate: "2026-07-04",
      location: { "@type": "Place", name: "Balboa Park" },
    }),
  ]);

  const events = extractJsonLdEvents(html, mockSource);
  assertEq(events.length, 1, "date-only startDate → 1 item");
  if (events.length === 1) {
    const ev = defined(events[0]);
    const utcMs = new Date(ev.startDatetime).getTime();
    assert(!Number.isNaN(utcMs), "startDatetime parses as valid Date");
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
  const html = htmlWith([
    JSON.stringify([
      {
        "@context": "https://schema.org",
        "@type": "Event",
        name: "Array Event One",
        startDate: "2026-08-10T18:00:00-07:00",
      },
      {
        "@context": "https://schema.org",
        "@type": "Event",
        name: "Array Event Two",
        startDate: "2026-08-11T19:00:00-07:00",
      },
    ]),
  ]);

  const events = extractJsonLdEvents(html, mockSource);
  assertEq(events.length, 2, "top-level array of 2 Events → 2 items");
  if (events.length === 2) {
    assertEq(defined(events[0]).title, "Array Event One", "first array event title correct");
    assertEq(defined(events[1]).title, "Array Event Two", "second array event title correct");
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
      name: "Block One Event",
      startDate: "2026-09-01T19:00:00-07:00",
    }),
    JSON.stringify({
      "@context": "https://schema.org",
      "@type": "Event",
      name: "Block Two Event",
      startDate: "2026-09-02T20:00:00-07:00",
    }),
  ]);

  const events = extractJsonLdEvents(html, mockSource);
  assertEq(events.length, 2, "two script blocks → 2 events combined");
  if (events.length === 2) {
    assertEq(defined(events[0]).title, "Block One Event", "first block event");
    assertEq(defined(events[1]).title, "Block Two Event", "second block event");
  }
});

// ============================================================================
// Scenario 11: Event with no offers → isFree:false, no priceMin
// ============================================================================

test("Scenario 11: No offers field → isFree:false, priceMin undefined", () => {
  const html = htmlWith([
    JSON.stringify({
      "@context": "https://schema.org",
      "@type": "Event",
      name: "Mystery Pricing Show",
      startDate: "2026-10-01T20:00:00-07:00",
      location: { "@type": "Place", name: "Mystery Venue" },
    }),
  ]);

  const events = extractJsonLdEvents(html, mockSource);
  assertEq(events.length, 1, "no offers → 1 item");
  if (events.length === 1) {
    assert(defined(events[0]).isFree === false, "no offers → isFree=false (default)");
    assert(defined(events[0]).priceMin === undefined, "no offers → priceMin undefined");
  }
});

// ============================================================================
// Scenario 12: PostalAddress object in location.address → address set
// ============================================================================

test("Scenario 12: PostalAddress in location.address → address extracted", () => {
  const html = htmlWith([
    JSON.stringify({
      "@context": "https://schema.org",
      "@type": "Event",
      name: "Address Test Event",
      startDate: "2026-11-15T18:00:00-08:00",
      location: {
        "@type": "Place",
        name: "Rady Shell",
        address: {
          "@type": "PostalAddress",
          streetAddress: "222 Marina Park Way",
          addressLocality: "San Diego",
          addressRegion: "CA",
          postalCode: "92101",
        },
      },
    }),
  ]);

  const events = extractJsonLdEvents(html, mockSource);
  assertEq(events.length, 1, "PostalAddress location → 1 item");
  if (events.length === 1) {
    assertEq(defined(events[0]).venue, "Rady Shell", "venue from location.name");
    assert(
      typeof defined(events[0]).address === "string" && defined(defined(events[0]).address).length > 0,
      "address extracted from PostalAddress",
    );
    assert(defined(defined(events[0]).address).includes("222 Marina Park Way"), "address contains street address");
  }
});

// ============================================================================
// Scenario 13: offers.lowPrice used when price absent
// ============================================================================

test("Scenario 13: offers.lowPrice (no price) → priceMin set", () => {
  const html = htmlWith([
    JSON.stringify({
      "@context": "https://schema.org",
      "@type": "Event",
      name: "Low Price Show",
      startDate: "2026-12-01T20:00:00-08:00",
      offers: {
        "@type": "AggregateOffer",
        lowPrice: "15",
        highPrice: "50",
        priceCurrency: "USD",
      },
    }),
  ]);

  const events = extractJsonLdEvents(html, mockSource);
  assertEq(events.length, 1, "offers.lowPrice → 1 item");
  if (events.length === 1) {
    assertEq(defined(events[0]).priceMin, 15, "priceMin from offers.lowPrice");
    assertEq(defined(events[0]).priceMax, 50, "priceMax from the same offer's highPrice");
    assertEq(defined(events[0]).currency, "USD", "currency from the same offer's priceCurrency");
    assert(defined(events[0]).isFree === false, "priceMin=15 → isFree=false");
  }
});
