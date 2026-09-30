#!/usr/bin/env bun
/**
 * ctycms.test.ts — unit tests for CtycmsAdapter (ctycms "Picnic" widget → EventItem).
 *
 * Asserts on inline AJAX-card fixtures (no network):
 *   - parseCards: extracts title, slug, venue, time text, date box, image
 *   - classifyPerformanceTitle: comedy / music / theater keyword routing
 *   - mapCardToEvent: timed → LA-local start/end; missing time → all-day;
 *     yearless date resolves against the reference day (rolls to next year);
 *     venue kept for display while geocode address anchors to the complex;
 *     ticketUrl is absolute; stableId is deterministic 16-hex.
 *
 * Run: bun test ~/.claude/.claude/worktrees/arch-debt-d2-eventscout-buntest/skills/Productivity/EventScout/tests/ctycms.test.ts
 */

import { test } from "bun:test";
import {
  parseCards,
  classifyPerformanceTitle,
  mapCardToEvent,
} from "../Tools/adapters/CtycmsAdapter.ts";
import type { EventSource } from "../Tools/types.ts";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}

// ============================================================================
// Fixtures — shape mirrors a real _picnic_list_ajax.php response
// ============================================================================

const SOURCE: EventSource = {
  id: "liberty-station",
  url: "https://libertystation.com/events/calendar",
  name: "Liberty Station",
  fetchTier: "ctycms",
  categoryHint: "community",
  geoHint: "Liberty Station, San Diego, CA 92106",
  pollInterval: 720,
  enabled: true,
};

const GEO = "2640 Historic Decatur Rd, San Diego, CA 92106";

// Reference instant: 2026-06-06 ~noon PDT (used for yearless-date resolution).
const REF_MS = Date.parse("2026-06-06T19:00:00Z");

/** Timed card with venue + image. */
const CARD_TIMED = `
<a class="pcrd" href="/do/cyanotype">
	<div class="pcrd-image">
		<div class="pcrd-image-image lazyload" data-src="https://img.ctykit.com/cdn/ca-liberty-station/images/x.jpg"></div>
	</div>
	<div class="pcrd-content">
		<div class="pcrd-content-headline">Cyanotype &amp; Sun Prints</div>
		<div class="pcrd-content-time"><span><i class="far fa-clock"></i></span> 1pm - 4pm</div>
		<div class="pcrd-content-venue"><span><i class="far fa-location-dot"></i></span>Visions Museum of Textile Art</div>
	</div>
	<div class="pcrd-date-box"><div class="pcrd-date-dow">Sat</div><div class="pcrd-date-day">6</div><div class="pcrd-date-month">Jun</div></div>
</a>`;

/** All-day card (no time div) with a date earlier in the year than REF → next year. */
const CARD_ALLDAY_NEXTYEAR = `
<a class="pcrd" href="/do/winter-market">
	<div class="pcrd-content">
		<div class="pcrd-content-headline">Winter Market</div>
		<div class="pcrd-content-venue"><span></span>North Promenade</div>
	</div>
	<div class="pcrd-date-box"><div class="pcrd-date-dow">Fri</div><div class="pcrd-date-day">15</div><div class="pcrd-date-month">Jan</div></div>
</a>`;

const FIXTURE = `<div class="container-fluid"><div class="row g-3">
<div class="col">${CARD_TIMED}</div>
<div class="col">${CARD_ALLDAY_NEXTYEAR}</div>
</div></div>`;

// ============================================================================
// parseCards
// ============================================================================

test("parseCards: extracts both cards with core fields", () => {
  const cards = parseCards(FIXTURE);
  assert(cards.length === 2, `got ${cards.length} cards`);
  const [a, b] = cards;
  assert(a!.title === "Cyanotype & Sun Prints", `title "${a!.title}"`);
  assert(a!.slug === "cyanotype", `slug "${a!.slug}"`);
  assert(a!.venue === "Visions Museum of Textile Art", `venue "${a!.venue}"`);
  assert(a!.timeText === "1pm - 4pm", `time "${a!.timeText}"`);
  assert(a!.day === 6 && a!.month === 5, `date ${a!.month}/${a!.day}`);
  assert(a!.imageUrl?.includes("ctykit.com") === true, "image captured");
  assert(b!.timeText === undefined, "all-day card has no time text");
  assert(b!.day === 15 && b!.month === 0, `b date ${b!.month}/${b!.day}`);
});

test("parseCards: skips a block with no parseable date box", () => {
  const bad = `<a class="pcrd" href="/do/x"><div class="pcrd-content-headline">No Date</div></a>`;
  assert(parseCards(bad).length === 0, "card without date box is skipped");
});

// ============================================================================
// classifyPerformanceTitle
// ============================================================================

test("classifyPerformanceTitle: comedy / music / theater routing", () => {
  assert(classifyPerformanceTitle("Improv VS Standup") === "comedy", "improv→comedy");
  assert(classifyPerformanceTitle("Liberty Station Comedy Night!") === "comedy", "comedy→comedy");
  assert(classifyPerformanceTitle("Apt 4 Live Music Day") === "music", "live music→music");
  assert(classifyPerformanceTitle("The SpongeBob Musical") === "music", "musical→music");
  assert(classifyPerformanceTitle("High Moon: A Space Western") === "theater", "default→theater");
});

// ============================================================================
// mapCardToEvent
// ============================================================================

test("mapCardToEvent: timed event → LA-local start/end, category, links", () => {
  const [card] = parseCards(CARD_TIMED);
  const ev = mapCardToEvent(card!, "arts", SOURCE, REF_MS, GEO);
  assert(ev.startDatetime === "2026-06-06T13:00:00-07:00", `start ${ev.startDatetime}`);
  assert(ev.endDatetime === "2026-06-06T16:00:00-07:00", `end ${ev.endDatetime}`);
  assert(ev.allDay === false, "not all-day");
  assert(ev.category === "arts", "category passed through");
  assert(ev.venue === "Visions Museum of Textile Art", "venue kept for display");
  assert(ev.address === `Visions Museum of Textile Art, ${GEO}`, `address "${ev.address}"`);
  assert(ev.ticketUrl === "https://libertystation.com/do/cyanotype", `ticketUrl ${ev.ticketUrl}`);
  assert(ev.sources[0]!.sourceId === "liberty-station", "sourceId set");
  assert(ev.tags.includes("liberty-station"), "liberty-station tag");
  assert(ev.isFree === false, "no price → not assumed free");
});

test("mapCardToEvent: missing time → all-day, no endDatetime", () => {
  const [card] = parseCards(CARD_ALLDAY_NEXTYEAR);
  const ev = mapCardToEvent(card!, "community", SOURCE, REF_MS, GEO);
  assert(ev.allDay === true, "all-day true");
  assert(ev.endDatetime === undefined, "no end datetime");
  assert(/T00:00:00/.test(ev.startDatetime), `start at midnight: ${ev.startDatetime}`);
});

test("mapCardToEvent: yearless date before reference resolves to next year", () => {
  const [card] = parseCards(CARD_ALLDAY_NEXTYEAR); // Jan 15, ref is Jun 2026
  const ev = mapCardToEvent(card!, "community", SOURCE, REF_MS, GEO);
  assert(ev.startDatetime.startsWith("2027-01-15"), `resolved to 2027: ${ev.startDatetime}`);
});

test("mapCardToEvent: stableId deterministic, 16-hex", () => {
  const [card] = parseCards(CARD_TIMED);
  const a = mapCardToEvent(card!, "arts", SOURCE, REF_MS, GEO);
  const b = mapCardToEvent(card!, "arts", SOURCE, REF_MS, GEO);
  assert(a.id === b.id, "ids match");
  assert(/^[0-9a-f]{16}$/.test(a.id), `id format ${a.id}`);
});

