#!/usr/bin/env bun
/**
 * render-tiered.test.ts — TDD tests for renderTiered (Slice 4 / D7).
 *
 * Run: bun test skills/Productivity/EventScout/tests/render-tiered.test.ts
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
 *   RT10  Compact entries retain the supplied address when venue is absent
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
import { defined } from "../../../../lib/test/defined.ts";

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
    `Expected to contain: ${JSON.stringify(needle)}\nGot (first 400): ${str.slice(0, 400)}`,
  );
}

function assertNotContains(str: string, needle: string, label: string): void {
  assert(
    !str.includes(needle),
    label,
    `Expected NOT to contain: ${JSON.stringify(needle)}\nGot (first 400): ${str.slice(0, 400)}`,
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
const rankMarkers = out25.match(/^### \d+\. /gm) ?? [];
const markerNumbers = rankMarkers.map((m) => {
  const match = m.match(/### (\d+)\./);
  return match ? parseInt(defined(match[1]), 10) : -1;
});
const whyLines = out25.match(/^> _.*_$/gm) ?? [];
const compactLines = out25.match(/^\d+\. .+ · .+ · .+ · .+ · https?:\/\//gm) ?? [];
const firstCompact = compactLines[0] ?? "";
const bulletCount = (firstCompact.match(/ · /g) ?? []).length;
const allCompactHaveLink = compactLines.every((line) => /https?:\/\//.test(line));

const out5 = renderTiered(EVENTS_5, CONSTRAINT);
const markers5 = out5.match(/^### \d+\. /gm) ?? [];

const out0 = renderTiered(EVENTS_0, CONSTRAINT);

const noVenueEvent = makeRankedEvent(50, { venue: undefined });
const outNoVenue = renderTiered([...EVENTS_25.slice(0, 10), noVenueEvent], CONSTRAINT);

const freeEvent = makeRankedEvent(51, { isFree: true, priceMin: undefined, priceMax: undefined });
const paidEvent = makeRankedEvent(52, { isFree: false, priceMin: 25, priceMax: 25 });
const outPrices = renderTiered([...EVENTS_25.slice(0, 10), freeEvent, paidEvent], CONSTRAINT);

test("requested-date starts precede earlier starts with stable complete groups", () => {
  const earlier = makeEvents(12).map(event => ({ ...event,
    title: `Earlier ${event.id}`, startDatetime: "2026-05-01T19:00:00-07:00", endDatetime: "2026-07-01T21:00:00-07:00",
  }));
  const dated = makeEvents(13).map(event => ({ ...event, id: `dated-${event.id}`, title: `Dated ${event.id}` }));
  const input = [...earlier.slice(0, 6), ...dated.slice(0, 5), ...earlier.slice(6), ...dated.slice(5)];
  const before = JSON.stringify(input);
  const output = renderTiered(input, CONSTRAINT);
  assertContains(output, "25 matches", "Header states the whole result count");
  assertNotContains(output, "Top 10 of 25", "Grouped output does not claim a global top ten");
  assertContains(output, "Starts within requested dates (13)", "Dated group has its complete count");
  assertContains(output, "Started before requested dates (12)", "Earlier group has its complete count");
  const titles = [...output.matchAll(/^(?:### )?\d+\. ([^\n·]+)(?:\n| ·)/gm)].map(match => defined(match[1]).trim());
  assert(titles.join("|") === [...dated, ...earlier].map(event => event.title).join("|"), "All rows preserve their original order within each group");
  assert((output.match(/^### \d+\. /gm) ?? []).length === 20, "Each group has ten full cards");
  for (const event of input) {
    assertContains(output, defined(event.ticketUrl), "Every supplied event link remains");
    assertContains(output, event.why, "Every supplied reason remains");
  }
  assert(JSON.stringify(input) === before, "The supplied ranking remains unchanged");
});

test("date groups respect LA calendar dates, exact bounds, and unknown start dates", () => {
  const input = [
    makeRankedEvent(1, { startDatetime: "2026-05-01T00:00:00-07:00", endDatetime: "2026-07-01T00:00:00-07:00" }),
    makeRankedEvent(2, { allDay: true, startDatetime: "2026-06-01", endDatetime: undefined }),
    makeRankedEvent(3, { startDatetime: CONSTRAINT.window.start, endDatetime: undefined }),
    makeRankedEvent(4, { startDatetime: CONSTRAINT.window.end, endDatetime: undefined }),
    makeRankedEvent(5, { startDatetime: "not a date", endDatetime: undefined }),
    makeRankedEvent(6, { startDatetime: "2026-07-01T00:00:00-07:00", endDatetime: undefined }),
  ];
  const output = renderTiered(input, CONSTRAINT);
  assertContains(output, "Starts within requested dates (3)", "Date-only LA midnight and both exact bounds belong to the requested dates");
  assertContains(output, "Started before requested dates (1)", "Earlier start is labeled without a current-availability claim");
  assertContains(output, "Start date unavailable (1)", "Unknown start does not imply a known date");
  assertContains(output, "Starts after requested dates (1)", "An out-of-window valid date keeps its actual relation");
  assertContains(output, "not a date", "The unknown source value remains visible");
  const noContext = renderTiered(input);
  assertNotContains(noContext, "Starts within requested dates", "Without requested dates no grouping is inferred");
  assert(noContext.indexOf(defined(input[0]).title) < noContext.indexOf(defined(input[1]).title), "No-context output retains its supplied order");
});

test("every compact result exposes its complete supplied reason or an honest unavailable label", () => {
  const reasons = [
    "Existing supplied reason.", "", " \t\n ", "First line.\nSecond line.\r\nThird line.",
    `Long supplied reason ${"preserve every word ".repeat(60)}THE END`,
    "Literal **source emphasis** and [source detail](https://example.invalid/detail).",
  ];
  const tail = reasons.map((why, index) => makeRankedEvent(index + 11, { why, lat: undefined, lng: undefined }));
  const events = [...EVENTS_25.slice(0, 10), ...tail];
  const before = JSON.stringify(events);
  const output = renderTiered(events, CONSTRAINT);
  assert(output.split("### More results")[0] === renderTiered(events.slice(0, 10), CONSTRAINT)
    .replace("Top 10 of 10 matches", "Top 10 of 16 results")
    .replace("10 with usable coordinates; 0 with unknown distance", "10 with usable coordinates; 6 with unknown distance") + "\n\n", "Full cards retain their content");
  const lines = output.split("\n");
  for (const [index, why] of reasons.entries()) {
    const row = lines.findIndex(line => line.startsWith(`${index + 11}. `));
    const expected = why.trim().replace(/\s+/g, " ") || "Reason unavailable";
    assert(lines[row + 1] === `    - **Why:** ${expected}`, "Every compact row exposes its full reason on its own labeled continuation");
    assertContains(defined(lines[row]), `https://example.com/tickets/${index + 11}`, "Each compact link stays visible");
    assertContains(defined(lines[row]), "Distance unknown; radius not verified", "Each compact distance label stays visible");
  }
  const titles = [...output.matchAll(/^(?:### )?\d+\. (Event Title \d+)(?:\n| ·)/gm)].map(match => match[1]);
  assert(titles.join("|") === events.map(event => event.title).join("|"), "All rows retain their rank order");
  assert(JSON.stringify(events) === before, "The renderer preserves the input");
});

test("price labels preserve all price shapes in both tiers without changing rows or links", () => {
  const cases: { label: string; overrides: Partial<RankedEvent> }[] = [
    { label: "Price unknown", overrides: { isFree: false, priceMin: undefined, priceMax: undefined } },
    { label: "Free", overrides: { isFree: true, priceMin: undefined, priceMax: undefined } },
    { label: "$0", overrides: { isFree: false, priceMin: 0, priceMax: 0 } },
    { label: "$25", overrides: { isFree: false, priceMin: 25, priceMax: 25 } },
    { label: "$10–$30", overrides: { isFree: false, priceMin: 10, priceMax: 30 } },
    { label: "$15+", overrides: { isFree: false, priceMin: 15, priceMax: undefined } },
    { label: "up to $40", overrides: { isFree: false, priceMin: undefined, priceMax: 40 } },
    { label: "Free", overrides: { isFree: true, priceMin: 20, priceMax: 30 } },
  ];
  const full = cases.map((entry, index) => makeRankedEvent(index + 1, entry.overrides));
  const compact = cases.map((entry, index) => makeRankedEvent(index + 11, entry.overrides));
  const events = [...full, makeRankedEvent(9), makeRankedEvent(10), ...compact];
  const before = JSON.stringify(events);
  const output = renderTiered(events);
  for (const [index, entry] of cases.entries()) {
    const card = defined(defined(output.split(`### ${index + 1}. `)[1]).split("\n### ")[0]);
    assertContains(card, `- **Price:** ${entry.label}\n`, "The full tier shows the exact price label");
    const line = defined(output.split("\n").find(row => row.startsWith(`${index + 11}. `)));
    assertContains(line, ` · ${entry.label} · `, "The compact tier shows the exact price label");
  }
  const titles = [...output.matchAll(/^(?:### )?\d+\. (Event Title \d+)(?:\n| ·)/gm)].map(match => match[1]);
  assert(titles.join("|") === events.map(event => event.title).join("|"), "Every row preserves its rank order");
  const links = [...output.matchAll(/https:\/\/example\.com\/tickets\/\d+/g)].map(match => match[0]);
  assert(links.join("|") === events.map(event => event.ticketUrl).join("|"), "Every row preserves its ticket link");
  assert(JSON.stringify(events) === before, "The renderer does not mutate the events");
});

test("supplied addresses remain visible with honest missing-location fallbacks in both tiers", () => {
  const cases: { venue?: string; address?: string; label: string }[] = [
    { venue: "Cuyamaca College", address: "900 Rancho San Diego Parkway, El Cajon, CA, 92019", label: "Cuyamaca College, 900 Rancho San Diego Parkway, El Cajon, CA, 92019" },
    { venue: "AleSmith Brewing Company", address: "9990 AleSmith Court, San Diego, CA, 92126", label: "AleSmith Brewing Company, 9990 AleSmith Court, San Diego, CA, 92126" },
    { venue: " Venue Name ", address: " 123 Main  Street ", label: "Venue Name, 123 Main  Street" },
    { venue: "Venue Only", label: "Venue Only" },
    { address: "123 Main Street", label: "123 Main Street" },
    { venue: " ", address: "123 Main Street", label: "123 Main Street" },
    { venue: "Venue Only", address: " ", label: "Venue Only" },
    { venue: " ", address: " ", label: "Venue TBD" },
    { label: "Venue TBD" },
    { venue: "Same  Place", address: " same place ", label: "Same  Place" },
  ];
  for (const [index, entry] of cases.entries()) {
    const event = makeRankedEvent(index + 11, { venue: entry.venue, address: entry.address });
    const before = JSON.stringify(event);
    const full = renderTiered([event]);
    const compact = renderTiered([...EVENTS_25.slice(0, 10), event]);
    assertContains(full, `- **Where:** ${entry.label}\n`, "full result retains supplied location");
    const row = compact.split("\n").find(line => line.startsWith("11. "));
    assert(row !== undefined, "compact result remains present");
    assertContains(defined(row), ` · ${entry.label} · `, "compact result retains supplied location");
    assertContains(defined(row), defined(event.ticketUrl), "location retains original ticket link");
    assert(JSON.stringify(event) === before, "location display does not mutate event facts");
  }
});

test("timed full card shows the year, complete same-day interval, and local timezone", () => {
  const output = renderTiered([makeRankedEvent(1, {
    startDatetime: "2026-06-11T19:00:00-07:00", endDatetime: "2026-06-11T21:00:00-07:00",
  })]);
  assertContains(output, "**When:** Thu, Jun 11, 2026 at 7:00 PM PDT – 9:00 PM PDT", "Source interval supports a duration decision");
});

test("timed compact entry preserves both dates and years across New Year", () => {
  const output = renderTiered([...EVENTS_25.slice(0, 10), makeRankedEvent(11, {
    startDatetime: "2026-12-31T23:00:00-08:00", endDatetime: "2027-01-01T01:00:00-08:00",
  })]);
  assertContains(output, "Thu, Dec 31, 2026 at 11:00 PM PST – Fri, Jan 1, 2027 at 1:00 AM PST", "Both calendar dates remain explicit");
});

test("timed interval distinguishes repeated wall-clock times during the DST transition", () => {
  const output = renderTiered([makeRankedEvent(1, {
    startDatetime: "2026-11-01T01:30:00-07:00", endDatetime: "2026-11-01T01:30:00-08:00",
  })]);
  assertContains(output, "Sun, Nov 1, 2026 at 1:30 AM PDT – 1:30 AM PST", "Each endpoint uses its own timezone");
});

test("a missing end time does not invent an interval", () => {
  const output = renderTiered([makeRankedEvent(1, { endDatetime: undefined })]);
  const when = defined(defined(output.split("**When:** ")[1]).split("\n")[0]);
  assertContains(when, "Thu, Jun 11, 2026 at 7:00 PM PDT", "Known start stays explicit");
  assertNotContains(when, " – ", "No end time is inferred");
});

test("unknown source clocks preserve dates in full and compact results", () => {
  const unknown = makeRankedEvent(11, {
    startDatetime: "2026-11-15T00:00:00-08:00", endDatetime: "2026-11-15T00:00:00-08:00",
    startTimeKnown: false, endTimeKnown: false,
  });
  for (const input of [[unknown], [...EVENTS_25.slice(0, 10), unknown]]) {
    const before = JSON.stringify(input);
    const output = renderTiered(input);
    assertContains(output, "Sun, Nov 15, 2026 · Time unavailable", "date-only fields expose unknown clocks");
    assertNotContains(output, "12:00 AM", "unknown clock does not assert midnight");
    assertNotContains(output, "All day", "unknown clock does not assert all day");
    assert(JSON.stringify(input) === before, "precision rendering does not mutate events");
  }
  const range = renderTiered([{ ...unknown, endDatetime: "2027-01-01T00:00:00-08:00" }]);
  assertContains(range, "Sun, Nov 15, 2026 – Fri, Jan 1, 2027 · Time unavailable", "date range retains both years");
});

test("mixed source precision preserves known clocks and explicit midnight", () => {
  const cases = [
    { overrides: { startDatetime: "2026-11-15T16:00:00-08:00", endDatetime: "2026-11-16T00:00:00-08:00", endTimeKnown: false }, label: "Sun, Nov 15, 2026 at 4:00 PM PST – Mon, Nov 16, 2026 · End time unavailable" },
    { overrides: { startDatetime: "2026-11-15T00:00:00-08:00", endDatetime: "2026-11-16T17:30:00-08:00", startTimeKnown: false }, label: "Sun, Nov 15, 2026 – Mon, Nov 16, 2026 at 5:30 PM PST · Start time unavailable" },
    { overrides: { startDatetime: "2026-11-15T00:00:00-08:00", endDatetime: "2026-11-15T01:00:00-08:00" }, label: "Sun, Nov 15, 2026 at 12:00 AM PST – 1:00 AM PST" },
    { overrides: { startDatetime: "2026-11-15T00:00:00-08:00", endDatetime: undefined, startTimeKnown: false }, label: "Sun, Nov 15, 2026 · Time unavailable" },
  ];
  for (const [index, entry] of cases.entries()) {
    const event = makeRankedEvent(index + 11, entry.overrides);
    assertContains(renderTiered([event]), entry.label, "full result preserves known precision");
    assertContains(renderTiered([...EVENTS_25.slice(0, 10), event]), entry.label, "compact result preserves known precision");
  }
});

test("all-day full card shows a calendar date without a midnight session", () => {
  const output = renderTiered([makeRankedEvent(60, {
    allDay: true, startDatetime: "2026-10-30T00:00:00-07:00", endDatetime: "2026-10-30T23:59:59-07:00",
  })]);
  assertContains(output, "**When:** Fri, Oct 30, 2026 · All day", "all-day date label");
  assertNotContains(output, "12:00 AM", "all-day events do not assert midnight sessions");
});

test("all-day compact entry preserves the complete source date range", () => {
  const output = renderTiered([...EVENTS_25.slice(0, 10), makeRankedEvent(61, {
    allDay: true, startDatetime: "2026-07-11T00:00:00-07:00", endDatetime: "2027-05-29T23:59:59-07:00",
  })]);
  assertContains(output, "Sat, Jul 11, 2026 – Sat, May 29, 2027 · All day", "all-day date range");
  assertNotContains(output, "12:00 AM", "range does not assert midnight sessions");
});

test("all-day date-only value keeps its source calendar date", () => {
  const output = renderTiered([makeRankedEvent(62, {
    allDay: true, startDatetime: "2026-10-30", endDatetime: undefined,
  })]);
  assertContains(output, "Fri, Oct 30, 2026 · All day", "date-only calendar label");
});

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
    `Found: ${rankMarkers.length} markers: ${rankMarkers.join(", ")}`,
  );
});

test("RT12: rank markers are 1 through 10 in order", () => {
  assert(
    markerNumbers.every((n, i) => n === i + 1),
    "RT12 rank markers are 1 through 10 in order",
    `Got: ${markerNumbers.join(", ")}`,
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
    `Found: ${compactLines.length}\nFirst 3: ${compactLines.slice(0, 3).join("\n")}`,
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

test("RT10: absent venue retains the supplied address in compact line", () => {
  // noVenueEvent is rank 11 → compact line
  assertContains(outNoVenue, "50 Main St, San Diego, CA", "RT10 absent venue retains its supplied address");
});

test("RT11: free event shows 'Free', paid event shows '$25' in compact line", () => {
  // These are compact (rank 11, 12)
  assertContains(outPrices, "Free", "RT11a free event shows 'Free' in compact line");
  assertContains(outPrices, "$25", "RT11b $25 event shows '$25' in compact line");
});

test("finite radius shows uncertainty in both tiers without changing result order", () => {
  const events = makeEvents(12);
  events[0] = makeRankedEvent(1, { lat: undefined, lng: undefined });
  events[10] = makeRankedEvent(11, { lat: undefined });
  const before = events.map(event => event.id).join(",");
  const output = renderTiered(events, CONSTRAINT);
  assertContains(output, "Top 10 of 12 results", "Unknown distances are not unqualified matches");
  assertContains(output, "radius requested: 15mi", "The radius describes the request");
  assertContains(output, "10 with usable coordinates; 2 with unknown distance", "Counts describe the displayed coordinates");
  assertContains(output, "- **Distance:** Distance unknown; radius not verified", "The full tier states uncertainty");
  assertContains(output, "11. Event Title 11", "The compact rank survives");
  assertContains(defined(defined(output.split("11. Event Title 11")[1]).split("\n")[0]), "Distance unknown; radius not verified", "The compact tier states uncertainty");
  assertContains(output, "More results (2)", "The compact heading states results");
  assertNotContains(output, "within 15mi", "The renderer does not claim universal radius eligibility");
  assert(events.map(event => event.id).join(",") === before, "The renderer does not mutate input order");
  const titlePositions = events.map(event => output.indexOf(event.title + (event === events[0] ? "\n" : "")));
  assert(titlePositions.every((position, index) => index === 0 || position > defined(titlePositions[index - 1])), "All titles preserve their rank order");
});

test("all unknown coordinates retain the full and compact result tail", () => {
  const events = makeEvents(42).map(event => ({ ...event, lat: undefined, lng: undefined }));
  const output = renderTiered(events, CONSTRAINT);
  assertContains(output, "Top 10 of 42 results", "All unknown rows remain results");
  assertContains(output, "0 with usable coordinates; 42 with unknown distance", "No coordinate support is asserted");
  assertContains(output, "More results (32)", "All 32 compact rows remain");
  assert((output.match(/Distance unknown; radius not verified/g) ?? []).length === 42, "Every unknown row has its own label");
  const renderedTitles = [...output.matchAll(/^(?:### )?\d+\. (Event Title \d+)(?:\n| ·)/gm)].map(match => match[1]);
  assert(renderedTitles.join(",") === events.map(event => event.title).join(","), "Every row preserves the original order");
});

test("coordinate labels validate both axes and preserve valid zero values", () => {
  const invalidPairs: [unknown, unknown][] = [
    [undefined, -117], [32, undefined], [null, -117], [32, null], ["32", -117], [32, "-117"],
    [NaN, -117], [32, NaN], [Infinity, -117], [32, -Infinity], [91, -117], [-91, -117], [32, 181], [32, -181],
  ];
  for (const [lat, lng] of invalidPairs) {
    const event = makeRankedEvent(1);
    Object.defineProperties(event, { lat: { value: lat }, lng: { value: lng } });
    const output = renderTiered([event], CONSTRAINT);
    assertContains(output, "0 with usable coordinates; 1 with unknown distance", "Invalid coordinate pairs remain unknown");
    assertContains(output, "Distance unknown; radius not verified", "Invalid coordinate pairs receive the row label");
  }
  const output = renderTiered([makeRankedEvent(1, { lat: 0, lng: 0 }), makeRankedEvent(2, { lat: -90, lng: 180 })], CONSTRAINT);
  assertContains(output, "2 with usable coordinates; 0 with unknown distance", "Zero and boundary coordinates remain usable");
  assertNotContains(output, "radius not verified", "Usable coordinates do not receive the unknown label");
  assertNotContains(output, "verified radius match", "Usable coordinates alone do not prove a radius match");
});

test("no-context, infinite-radius and empty output make no finite-radius guarantee", () => {
  const event = makeRankedEvent(1, { lat: undefined, lng: undefined });
  for (const context of [undefined, { ...CONSTRAINT, radiusMiles: Infinity }]) {
    const output = renderTiered([event], context);
    assertNotContains(output, "radius requested:", "No finite radius is requested");
    assertNotContains(output, "Radius checked", "No finite radius check is asserted");
    assertNotContains(output, "within Infinity", "Infinity is not a location guarantee");
    assertContains(output, event.title, "The unknown event remains visible");
  }
  const empty = renderTiered([], CONSTRAINT);
  assertContains(empty, "No results", "The empty result remains clear");
  assertContains(empty, "radius requested: 15mi", "Empty output states only the requested radius");
  assertNotContains(empty, "within 15mi", "Empty output makes no universal location claim");
});


test("conditional source admission remains visible in full and compact prices", () => {
  const admissionNote = "Free w/RSVP b4 9 / $5";
  const conditional = makeRankedEvent(50, { isFree: false, priceMin: 5, priceMax: undefined, admissionNote });
  const full = renderTiered([conditional]);
  const compact = renderTiered([...EVENTS_25.slice(0, 10), conditional]);
  assertContains(full, `- **Price:** Source admission: ${admissionNote}\n`, "Full price preserves the raw condition and fallback");
  assertContains(compact, ` · Source admission: ${admissionNote} · `, "Compact price preserves the raw condition and fallback");
});


test("source recurrence projections remain explicit in full and compact dates", () => {
  const event = makeRankedEvent(50, { recurrenceRule: "Wednesdays (9pm-2am)" });
  const label = "Source recurrence projection: Wednesdays (9pm-2am); occurrence not independently confirmed";
  assertContains(renderTiered([event]), label, "The full date labels its source projection");
  assertContains(renderTiered([...EVENTS_25.slice(0, 10), event]), label, "The compact date labels its source projection");
});

test("ICS rules retain projection uncertainty in full and compact dates", () => {
  const recurrenceRule = "RRULE:FREQ=WEEKLY;BYDAY=MO";
  const event = makeRankedEvent(50, { recurrenceRule });
  const label = `Source recurrence projection: ${recurrenceRule}; occurrence not independently confirmed`;
  assertContains(renderTiered([event]), label, "The full ICS date labels its source projection");
  assertContains(renderTiered([...EVENTS_25.slice(0, 10), event]), label, "The compact ICS date labels its source projection");
});

test("explicit ICS overrides identify their date separately from the series rule", () => {
  const event = makeRankedEvent(50, { recurrenceRule: "RRULE:FREQ=WEEKLY;BYDAY=FR", recurrenceOverride: true });
  const label = "Source recurrence override: explicit occurrence date; series rule: RRULE:FREQ=WEEKLY;BYDAY=FR; occurrence not independently confirmed";
  for (const markdown of [renderTiered([event]), renderTiered([...EVENTS_25.slice(0, 10), event])]) {
    assertContains(markdown, label, "The explicit override date is distinct from the series rule");
    assertNotContains(markdown, "Source recurrence projection:", "An explicit override is not labeled as a rule projection");
  }
});

test("source descriptions remain subordinate, attributed and bounded in both tiers", () => {
  const event = makeRankedEvent(50, { sourceDescription: "Source date or place may differ. " + "x".repeat(500) + "hidden tail" });
  for (const markdown of [renderTiered([event]), renderTiered([...EVENTS_25.slice(0, 10), event])]) {
    assertContains(markdown, "**Source description:** Source date or place may differ.", "Source text remains visible");
    assertContains(markdown, "… (excerpt; full text in source)", "A clipped source description is explicit");
    assertContains(markdown, `[Source](${event.sourceUrl})`, "Source evidence keeps its exact link");
    assertContains(markdown, "Source descriptions quote calendar text and may disagree with the displayed date or place. Neither is independently confirmed.", "Conflicting statements remain unresolved");
    assert(markdown.split("Neither is independently confirmed.").length === 2, "The caveat appears once per result set");
    assertNotContains(markdown, "hidden tail", "Source text cannot consume the result tail");
  }
  const short = renderTiered([makeRankedEvent(50, { sourceDescription: "[source](https://example.org) *statement*" })]);
  assertContains(short, "\\[source\\](https://example.org) \\*statement\\*", "Source Markdown remains attributed text");
  assertNotContains(short, "excerpt; full text", "Short descriptions have no truncation label");
  assertNotContains(renderTiered(EVENTS_5), "**Source description:**", "Unchanged sources gain no invented source note");
});
