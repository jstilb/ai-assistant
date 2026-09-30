#!/usr/bin/env bun
/**
 * raco.test.ts — unit tests for RaCoAdapter (Resident Advisor San Diego
 * GraphQL listings → EventItem).
 *
 * Asserts on inline RA-event fixtures (no network):
 *   - parseCost: numeric / free / empty / unparseable cost strings
 *   - raTimeToLaIso: naive venue-local → LA-offset ISO; null/malformed → null
 *   - mapRaEventToItem: full listing → times, venue/address, price, artists →
 *     performersOrTeams, contentUrl → ra.co URL, RA-pick blurb → description +
 *     tag; startTime-less listing → all-day at the listing date; missing
 *     title/date → null
 *
 * Run: bun test <absolute path>/tests/raco.test.ts
 */

import { test } from "bun:test";
import {
  mapRaEventToItem,
  parseCost,
  raTimeToLaIso,
} from "../Tools/adapters/RaCoAdapter.ts";
import type { RaEvent } from "../Tools/adapters/RaCoAdapter.ts";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}

const FETCHED_AT = "2026-08-20T12:00:00.000Z";

// ============================================================================
// Fixtures (inline, no network) — shape mirrors the eventListings GraphQL rows
// ============================================================================

function baseEvent(overrides: Partial<RaEvent>): RaEvent {
  return {
    id: "2506774",
    title: "REVERB x MUTANDIS presents 2AT",
    date: "2026-08-20T00:00:00.000",
    startTime: "2026-08-20T21:00:00.000",
    endTime: "2026-08-21T02:00:00.000",
    contentUrl: "/events/2506774",
    cost: "5",
    isTicketed: true,
    venue: { name: "EQ San Diego", address: "1271 University Ave San Diego, CA 92103" },
    artists: [{ name: "2AT" }, { name: "Mutandis" }],
    genres: [{ name: "Tech House" }, { name: "Bass" }],
    pick: null,
    ...overrides,
  };
}

// ============================================================================
// parseCost
// ============================================================================

test("parseCost: numeric strings → priceMin", () => {
  assert(parseCost("5").priceMin === 5, `"5" → 5, got ${parseCost("5").priceMin}`);
  assert(parseCost("5.00").priceMin === 5, `"5.00" → 5`);
  assert(parseCost("$10").priceMin === 10, `"$10" → 10`);
  assert(parseCost("1,200").priceMin === 1200, `"1,200" → 1200`);
  assert(!parseCost("5").isFree, `"5" is not free`);
});

test("parseCost: free markers → isFree, no price", () => {
  for (const c of ["0", "Free", "FREE entry"]) {
    const r = parseCost(c);
    assert(r.isFree, `"${c}" → isFree`);
    assert(r.priceMin === undefined, `"${c}" → no priceMin`);
  }
});

test("parseCost: empty/null/unparseable → unknown (not free, no price)", () => {
  for (const c of ["", null, "TBA"]) {
    const r = parseCost(c);
    assert(!r.isFree, `${JSON.stringify(c)} → not free`);
    assert(r.priceMin === undefined, `${JSON.stringify(c)} → no priceMin`);
  }
});

// ============================================================================
// raTimeToLaIso
// ============================================================================

test("raTimeToLaIso: naive venue-local → LA-offset ISO (PDT)", () => {
  const iso = raTimeToLaIso("2026-08-20T21:00:00.000");
  assert(iso != null && iso.startsWith("2026-08-20T21:00:00"), `wall-clock kept, got ${iso}`);
  assert(iso!.endsWith("-07:00"), `August is PDT (-07:00), got ${iso}`);
});

test("raTimeToLaIso: null and malformed → null", () => {
  assert(raTimeToLaIso(null) === null, "null → null");
  assert(raTimeToLaIso("not a datetime") === null, "garbage → null");
});

// ============================================================================
// mapRaEventToItem
// ============================================================================

test("mapRaEventToItem: full listing maps every field", () => {
  const item = mapRaEventToItem(baseEvent({}), FETCHED_AT);
  assert(item !== null, "maps to an item");
  assert(item!.title === "REVERB x MUTANDIS presents 2AT", "title");
  assert(item!.startDatetime.startsWith("2026-08-20T21:00:00"), `start, got ${item!.startDatetime}`);
  assert(item!.endDatetime?.startsWith("2026-08-21T02:00:00") === true, `end, got ${item!.endDatetime}`);
  assert(item!.allDay === false, "timed listing is not all-day");
  assert(item!.venue === "EQ San Diego", "venue");
  assert(item!.address === "1271 University Ave San Diego, CA 92103", "address");
  assert(item!.category === "music", "category");
  assert(item!.priceMin === 5 && item!.currency === "USD", "price");
  assert(item!.isFree === false, "not free");
  assert(item!.ticketUrl === "https://ra.co/events/2506774", "ticketUrl");
  assert(item!.sourceUrl === "https://ra.co/events/2506774", "sourceUrl");
  assert(item!.sources[0]!.sourceId === "ra-co-sandiego", "sourceId");
  assert(item!.performersOrTeams === "2AT, Mutandis", "artists joined");
  assert(item!.tags.includes("resident-advisor"), "provenance tag");
  assert(item!.tags.includes("tech house") && item!.tags.includes("bass"), "real genre tags, lowercased");
  assert(!item!.tags.includes("electronic"), "no electronic fallback when genres present");
  assert(!item!.tags.includes("ra-pick"), "no pick tag without pick");
  assert(item!.fetchedAt === FETCHED_AT, "fetchedAt injected");
  assert(item!.status === "scheduled", "status");
});

test("mapRaEventToItem: no startTime → all-day at the listing date", () => {
  const item = mapRaEventToItem(baseEvent({ startTime: null, endTime: null }), FETCHED_AT);
  assert(item !== null, "maps to an item");
  assert(item!.allDay === true, "all-day");
  assert(item!.startDatetime.startsWith("2026-08-20T00:00:00"), `midnight start, got ${item!.startDatetime}`);
  assert(item!.endDatetime === undefined, "no end");
});

test("mapRaEventToItem: RA pick → blurb description + ra-pick tag", () => {
  const item = mapRaEventToItem(
    baseEvent({ pick: { blurb: "A rare stateside live set." } }),
    FETCHED_AT,
  );
  assert(item !== null, "maps to an item");
  assert(item!.tags.includes("ra-pick"), "ra-pick tag");
  assert(item!.description === "[RA Pick] A rare stateside live set.", `description, got ${item!.description}`);
});

test("mapRaEventToItem: missing title or date → null", () => {
  assert(mapRaEventToItem(baseEvent({ title: "  " }), FETCHED_AT) === null, "blank title");
  assert(mapRaEventToItem(baseEvent({ date: "" }), FETCHED_AT) === null, "no date");
});

test("mapRaEventToItem: no genres → electronic platform-default tag", () => {
  for (const genres of [null, []]) {
    const item = mapRaEventToItem(baseEvent({ genres }), FETCHED_AT);
    assert(item !== null, "maps to an item");
    assert(item!.tags.includes("electronic"), `${JSON.stringify(genres)} → electronic fallback`);
  }
});

test("mapRaEventToItem: hip-hop night carries its own genre, not electronic", () => {
  const item = mapRaEventToItem(baseEvent({ genres: [{ name: "Hip-Hop" }] }), FETCHED_AT);
  assert(item !== null, "maps to an item");
  assert(item!.tags.includes("hip-hop"), "hip-hop tag");
  assert(!item!.tags.includes("electronic"), "no electronic mislabel");
});

test("mapRaEventToItem: venue-less listing still maps (no venue/address)", () => {
  const item = mapRaEventToItem(baseEvent({ venue: null }), FETCHED_AT);
  assert(item !== null, "maps to an item");
  assert(item!.venue === undefined, "no venue");
  assert(item!.address === undefined, "no address");
});
