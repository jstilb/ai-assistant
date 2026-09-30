#!/usr/bin/env bun
/**
 * render-tiered.test.ts — TDD tests for renderTiered (Slice 4 / D7).
 *
 * Run: bun test ~/.claude/.claude/worktrees/arch-debt-d2-eventscout-buntest/skills/Productivity/EventScout/tests/render-tiered.test.ts
 *
 * Tests:
 *   RT01  25 events → exactly 10 full cards (rank markers ### 1.–### 10.)
 *   RT02  25 events → 15 compact lines under "### More matches (15)"
 *   RT03  25 events → compact line format: N. Title · When · Venue · Price · Link
 *   RT04  25 events → compact entries include a resolved link (not empty)
 *   RT05  25 events → header contains "Top 10 of 25"
 *   RT06  5 events  → 5 full cards, NO compact section heading
 *   RT07  0 events  → graceful no-results message
 *   RT08  Constraint rawQuery appears in header
 *   RT09  Each full card contains a > _why_ blockquote line
 *   RT10  Compact entries include venue; absent venue renders "Venue TBD"
 *   RT11  Compact price shows "Free" for free events, dollar amount for paid
 *   RT12  Exactly 10 full-card rank markers (### 1. through ### 10.) for 25 events
 *
 * NOTE (bun:test conversion): this file originally ran its RT01-RT12 checks as
 * flat top-level assertions with no per-test grouping. Converted here into one
 * bun `test()` block per RT-number so failures localize to the right label;
 * the fixture computations (out25, rankMarkers, compactLines, etc.) are pure
 * and side-effect-free, so hoisting them to module scope and referencing them
 * from each test's closure is equivalent to the original flat execution order.
 * Every original assertion is preserved.
 */

import { test } from "bun:test";
import { renderTiered } from "../Tools/Render.ts";
import type { RankedEvent } from "../Tools/Ranker.ts";
import type { QueryContext } from "../Tools/types.ts";

// ============================================================================
// Test harness
// ============================================================================

function assert(condition: boolean, message: string, detail?: string): void {
  if (!condition) {
    throw new Error(`${message}${detail ? `\n        ${detail}` : ""}`);
  }
}

function assertContains(str: string, needle: string, label: string): void {
  assert(
    str.includes(needle),
    label,
    `Expected to contain: ${JSON.stringify(needle)}\nGot (first 400): ${str.slice(0, 400)}`
  );
}

function assertNotContains(str: string, needle: string, label: string): void {
  assert(
    !str.includes(needle),
    label,
    `Expected NOT to contain: ${JSON.stringify(needle)}\nGot (first 400): ${str.slice(0, 400)}`
  );
}

// ============================================================================
// Fixtures
// ============================================================================

function makeRankedEvent(n: number, overrides: Partial<RankedEvent> = {}): RankedEvent {
  return {
    id: `event-${n}`,
    title: `Event Title ${n}`,
    startDatetime: `2026-06-${String(10 + (n % 20)).padStart(2, "0")}T19:00:00-07:00`,
    endDatetime: `2026-06-${String(10 + (n % 20)).padStart(2, "0")}T21:00:00-07:00`,
    allDay: false,
    venue: `Venue ${n}`,
    address: `${n} Main St, San Diego, CA`,
    lat: 32.7157 + n * 0.001,
    lng: -117.1611 - n * 0.001,
    category: "music",
    tags: ["music"],
    isFree: false,
    priceMin: 10 + n,
    priceMax: 20 + n,
    currency: "USD",
    ticketUrl: `https://example.com/tickets/${n}`,
    sourceUrl: `https://example.com/events/${n}`,
    sources: [{ sourceId: "test-source", url: `https://example.com/events/${n}` }],
    description: `Description for event ${n}`,
    fetchedAt: "2026-06-07T00:00:00Z",
    status: "scheduled",
    score: 100 - n,
    why: `Why event ${n} fits your interests.`,
    ...overrides,
  };
}

function makeEvents(count: number): RankedEvent[] {
  return Array.from({ length: count }, (_, i) => makeRankedEvent(i + 1));
}

const EVENTS_25 = makeEvents(25);
const EVENTS_5 = makeEvents(5);
const EVENTS_0: RankedEvent[] = [];

const CONSTRAINT: QueryContext = {
  rawQuery: "music this weekend",
  categories: ["music"],
  window: { start: "2026-06-01T00:00:00-07:00", end: "2026-06-30T23:59:59-07:00" },
  home: { lat: 32.7157, lng: -117.1611 },
  radiusMiles: 15,
};

// ============================================================================
// Shared renders (pure, computed once — reused across the RT-labeled tests
// below exactly as they were reused in the original flat script)
// ============================================================================

const out25 = renderTiered(EVENTS_25, CONSTRAINT);
const rankMarkers = out25.match(/^### \d+\. /mg) ?? [];
const markerNumbers = rankMarkers.map((m) => {
  const match = m.match(/### (\d+)\./);
  return match ? parseInt(match[1]!, 10) : -1;
});
const whyLines = out25.match(/^> _.*_$/mg) ?? [];
const compactLines = out25.match(/^\d+\. .+ · .+ · .+ · .+ · https?:\/\//mg) ?? [];
const firstCompact = compactLines[0] ?? "";
const bulletCount = (firstCompact.match(/ · /g) ?? []).length;
const allCompactHaveLink = compactLines.every((line) => /https?:\/\//.test(line));

const out5 = renderTiered(EVENTS_5, CONSTRAINT);
const markers5 = out5.match(/^### \d+\. /mg) ?? [];

const out0 = renderTiered(EVENTS_0, CONSTRAINT);

const noVenueEvent = makeRankedEvent(50, { venue: undefined });
const outNoVenue = renderTiered([...EVENTS_25.slice(0, 10), noVenueEvent], CONSTRAINT);

const freeEvent = makeRankedEvent(51, { isFree: true, priceMin: undefined, priceMax: undefined });
const paidEvent = makeRankedEvent(52, { isFree: false, priceMin: 25, priceMax: 25 });
const outPrices = renderTiered([...EVENTS_25.slice(0, 10), freeEvent, paidEvent], CONSTRAINT);

// ============================================================================
// Tests
// ============================================================================

test("RT05: header contains 'Top 10 of 25'", () => {
  assertContains(out25, "Top 10 of 25", "RT05 header contains 'Top 10 of 25'");
});

test("RT08: header contains rawQuery", () => {
  assertContains(out25, `"music this weekend"`, "RT08 header contains rawQuery");
});

test("RT01: exactly 10 rank markers for 25 events", () => {
  assert(
    rankMarkers.length === 10,
    "RT01 exactly 10 rank markers for 25 events",
    `Found: ${rankMarkers.length} markers: ${rankMarkers.join(", ")}`
  );
});

test("RT12: rank markers are 1 through 10 in order", () => {
  assert(
    markerNumbers.every((n, i) => n === i + 1),
    "RT12 rank markers are 1 through 10 in order",
    `Got: ${markerNumbers.join(", ")}`
  );
});

test("RT09: exactly 10 why-lines (one per full card)", () => {
  assert(whyLines.length === 10, "RT09 exactly 10 why-lines (one per full card)", `Found: ${whyLines.length}`);
});

test("RT02: compact section heading shows (15) and has 15 compact lines", () => {
  assertContains(out25, "### More matches (15)", "RT02 compact section heading shows (15)");
  assert(
    compactLines.length === 15,
    "RT02b 15 compact lines present",
    `Found: ${compactLines.length}\nFirst 3: ${compactLines.slice(0, 3).join("\n")}`
  );
});

test("RT03: compact line format N. Title · When · Venue · Price · Link", () => {
  // Should be line 11 (the 11th event)
  assert(firstCompact.startsWith("11."), "RT03a first compact line starts with '11.'", `Got: ${firstCompact}`);
  assert(bulletCount >= 4, "RT03b compact line has >= 4 ' · ' separators", `Got ${bulletCount} in: ${firstCompact}`);
});

test("RT04: all compact lines contain a resolved link", () => {
  assert(allCompactHaveLink, "RT04 all compact lines contain a resolved link (http/https)");
});

test("RT06: 5 events → 5 full cards, no compact section", () => {
  assert(markers5.length === 5, "RT06a 5 events → 5 full rank markers", `Found: ${markers5.length}`);
  assertNotContains(out5, "### More matches", "RT06b 5 events → no compact section heading");
  assertContains(out5, "Top 5 of 5", "RT06c 5 events → header says 'Top 5 of 5'");
});

test("RT07: 0 events → graceful no-results message", () => {
  assert(out0.length > 0, "RT07a empty list returns non-empty string");
  assertContains(out0, "No", "RT07b empty list contains 'No' (no-results message)");
  assertNotContains(out0, "### More matches", "RT07c empty list has no compact section");
});

test("RT10: absent venue renders 'Venue TBD' in compact line", () => {
  // noVenueEvent is rank 11 → compact line
  assertContains(outNoVenue, "Venue TBD", "RT10 absent venue renders 'Venue TBD' in compact line");
});

test("RT11: free event shows 'Free', paid event shows '$25' in compact line", () => {
  // These are compact (rank 11, 12)
  assertContains(outPrices, "Free", "RT11a free event shows 'Free' in compact line");
  assertContains(outPrices, "$25", "RT11b $25 event shows '$25' in compact line");
});
