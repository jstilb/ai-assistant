#!/usr/bin/env bun
/**
 * activenet.test.ts — unit tests for ActiveNetAdapter (SD Parks & Rec
 * ActiveNet list API → EventItem).
 *
 * Asserts on inline activity-row fixtures (no network):
 *   - skipReason: parent / no-date / youth-capped / ended rows are skipped
 *   - mapActivityToEvent: upcoming session → start date + parsed clock time
 *     (LA offset-aware ISO), venue/address split, fee → priceMin, free flag,
 *     enroll link → ticketUrl, session span prefixed into description
 *   - in-progress session → next days_of_week occurrence, "in-progress" tag
 *   - parseClockTime / parseTimeRange / parseFee / parseLocation /
 *     nextOccurrenceYmd / deriveCategory edge cases
 *
 * Run: bun test <absolute path>/tests/activenet.test.ts
 */

import { test } from "bun:test";
import {
  mapActivityToEvent,
  skipReason,
  parseClockTime,
  parseTimeRange,
  parseFee,
  parseLocation,
  nextOccurrenceYmd,
  deriveCategory,
  stripHtml,
} from "../Tools/adapters/ActiveNetAdapter.ts";
import type { ActiveNetActivity } from "../Tools/adapters/ActiveNetAdapter.ts";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}

// ============================================================================
// Fixtures (inline, no network) — shape mirrors the /rest/activities/list rows
// ============================================================================

function baseActivity(overrides: Partial<ActiveNetActivity>): ActiveNetActivity {
  return {
    id: 135000,
    name: "Test Activity",
    desc: "",
    detail_url:
      "https://apm.activecommunities.com/sdparkandrec/Activity_Search/test/135000?locale=en-US",
    parent_activity: false,
    only_one_day: false,
    date_range_start: "2026-09-25",
    date_range_end: "2026-11-06",
    time_range: "4:30 PM - 5:30 PM",
    days_of_week: "Fri",
    ages: "18 and up",
    age_min_year: 18,
    age_max_year: 0,
    location: {
      href: "",
      label: "Balboa Park Club (2150 Pan American Road, 92101)",
    },
    fee: { href: "", label: "$25.00" },
    enroll_now: {
      href: "https://anc.apm.activecommunities.com/sdparkandrec/activity/search/enroll/135000?wishlist_id=0&locale=en-US",
      label: "Enroll Now",
    },
    allow_drop_in_reg: false,
    ...overrides,
  };
}

const TODAY = "2026-08-20"; // Thursday

// ============================================================================
// skipReason
// ============================================================================

test("skipReason: parent activities are skipped", () => {
  const a = baseActivity({ parent_activity: true });
  assert(skipReason(a, TODAY) === "parent", "expected parent skip");
});

test("skipReason: rows without a start date are skipped", () => {
  const a = baseActivity({ date_range_start: "", date_range_end: "" });
  assert(skipReason(a, TODAY) === "no-date", "expected no-date skip");
});

test("skipReason: youth-capped rows are skipped", () => {
  const a = baseActivity({ age_min_year: 6, age_max_year: 12 });
  assert(skipReason(a, TODAY) === "youth", "expected youth skip");
});

test("skipReason: 18+ and all-ages rows are kept", () => {
  assert(skipReason(baseActivity({}), TODAY) === null, "18+ should map");
  const allAges = baseActivity({ age_min_year: 0, age_max_year: 0, ages: "All ages" });
  assert(skipReason(allAges, TODAY) === null, "all-ages should map");
  // ActiveNet encodes "no upper bound entered as 99" — must not count as youth
  const to99 = baseActivity({ age_min_year: 6, age_max_year: 99 });
  assert(skipReason(to99, TODAY) === null, "6-99 should map");
});

test("skipReason: sessions already ended are skipped", () => {
  const a = baseActivity({ date_range_start: "2026-06-01", date_range_end: "2026-08-19" });
  assert(skipReason(a, TODAY) === "ended", "expected ended skip");
  const oneDayPast = baseActivity({
    only_one_day: true,
    date_range_start: "2026-08-19",
    date_range_end: "",
  });
  assert(skipReason(oneDayPast, TODAY) === "ended", "past one-day row should skip");
});

// ============================================================================
// mapActivityToEvent — upcoming session
// ============================================================================

test("mapActivityToEvent: upcoming session maps to start date + LA local time", () => {
  const e = mapActivityToEvent(baseActivity({}), TODAY);
  assert(
    e.startDatetime === "2026-09-25T16:30:00-07:00",
    `startDatetime PDT expected, got ${e.startDatetime}`,
  );
  assert(
    e.endDatetime === "2026-09-25T17:30:00-07:00",
    `endDatetime PDT expected, got ${e.endDatetime}`,
  );
  assert(e.allDay === false, "timed session is not allDay");
  assert(e.venue === "Balboa Park Club", `venue split, got ${e.venue}`);
  assert(
    e.address === "2150 Pan American Road, 92101",
    `address from parens, got ${e.address}`,
  );
  assert(e.isFree === false, "fee $25 is not free");
  assert(e.priceMin === 25, `priceMin 25, got ${e.priceMin}`);
  assert(e.currency === "USD", "currency USD");
  assert(
    e.ticketUrl?.includes("/enroll/135000") === true,
    `enroll link as ticketUrl, got ${e.ticketUrl}`,
  );
  assert(
    e.sources[0]?.sourceId === "sdparkandrec-activenet",
    "sourceId stamped",
  );
  assert(e.tags.includes("class"), "multi-week row tagged class");
  assert(e.tags.includes("adults"), "18+ tagged adults");
  assert(!e.tags.includes("in-progress"), "upcoming session not in-progress");
  assert(e.status === "scheduled", "status scheduled");
});

test("mapActivityToEvent: session span + cadence prefixed into description", () => {
  const a = baseActivity({
    desc: "<div>Learn <b>baton twirling</b> &amp; more.</div>",
  });
  const e = mapActivityToEvent(a, TODAY);
  assert(
    e.description?.startsWith("[Session 2026-09-25 to 2026-11-06, Fri]") === true,
    `span prefix expected, got ${e.description}`,
  );
  assert(
    e.description?.includes("Learn baton twirling & more.") === true,
    `stripped desc expected, got ${e.description}`,
  );
});

test("mapActivityToEvent: free one-day event, no time → allDay", () => {
  const a = baseActivity({
    only_one_day: true,
    date_range_start: "2026-10-24",
    date_range_end: "",
    time_range: "",
    fee: { href: "", label: "Free" },
    enroll_now: null,
  });
  const e = mapActivityToEvent(a, TODAY);
  assert(e.allDay === true, "no time_range → allDay");
  assert(e.startDatetime.startsWith("2026-10-24T00:00:00"), "midnight start");
  assert(e.isFree === true, "Free label → isFree");
  assert(e.priceMin === undefined, "no priceMin when free");
  assert(e.ticketUrl === a.detail_url, "falls back to detail_url");
  assert(e.description === undefined, "no desc → no description field");
});

// ============================================================================
// mapActivityToEvent — in-progress session
// ============================================================================

test("mapActivityToEvent: in-progress session → next days_of_week occurrence", () => {
  const a = baseActivity({
    date_range_start: "2026-06-03",
    date_range_end: "2026-08-26",
    days_of_week: "Sun,Wed,Fri",
    time_range: "5:00 PM - 6:15 PM",
  });
  // TODAY is Thursday 2026-08-20 → next of Sun/Wed/Fri is Friday 2026-08-21
  const e = mapActivityToEvent(a, TODAY);
  assert(
    e.startDatetime === "2026-08-21T17:00:00-07:00",
    `next Friday expected, got ${e.startDatetime}`,
  );
  assert(e.tags.includes("in-progress"), "tagged in-progress");
});

test("mapActivityToEvent: in-progress without days_of_week falls back to today", () => {
  const a = baseActivity({
    date_range_start: "2026-06-15",
    date_range_end: "2026-08-28",
    days_of_week: "",
    time_range: "",
  });
  const e = mapActivityToEvent(a, TODAY);
  assert(e.startDatetime.startsWith(TODAY), `today fallback, got ${e.startDatetime}`);
});

// ============================================================================
// Pure helpers
// ============================================================================

test("parseClockTime: meridiem + edge cases", () => {
  assert(parseClockTime("4:30 PM") === "16:30", "4:30 PM");
  assert(parseClockTime("12:00 PM") === "12:00", "noon");
  assert(parseClockTime("12:15 AM") === "00:15", "past midnight");
  assert(parseClockTime("8:00 AM") === "08:00", "morning pad");
  assert(parseClockTime("garbage") === null, "unparseable → null");
  assert(parseClockTime("13:00 PM") === null, "hour 13 → null");
});

test("parseTimeRange: full range and partial failures", () => {
  const r = parseTimeRange("7:30 AM - 5:30 PM");
  assert(r?.start === "07:30" && r?.end === "17:30", "full range");
  assert(parseTimeRange("") === null, "empty → null");
  assert(parseTimeRange("5:00 PM") === null, "no dash → null");
});

test("parseFee: dollar amounts and free labels", () => {
  assert(parseFee("$25.00") === 25, "$25.00");
  assert(parseFee("$1,250.50") === 1250.5, "thousands separator");
  assert(parseFee("Free") === null, "Free → null");
  assert(parseFee("") === null, "empty → null");
});

test("parseLocation: paren address, comma address, room-only", () => {
  const p = parseLocation("Balboa Park Club (2150 Pan American Road, 92101)");
  assert(p.venue === "Balboa Park Club" && p.address === "2150 Pan American Road, 92101", "paren form");
  const c = parseLocation("Stockton Recreation Center, 330 32nd Street, San Diego, CA 92102");
  assert(c.venue === "Stockton Recreation Center", "comma form venue");
  assert(c.address === "Stockton Recreation Center, 330 32nd Street, San Diego, CA 92102", "comma form keeps full label as address");
  const r = parseLocation("Fitness Room");
  assert(r.venue === "Fitness Room" && r.address === undefined, "room-only → no address");
});

test("nextOccurrenceYmd: weekday walk from a Thursday", () => {
  assert(nextOccurrenceYmd("Sun,Wed,Fri", "2026-08-20") === "2026-08-21", "next Fri");
  assert(nextOccurrenceYmd("Thu", "2026-08-20") === "2026-08-20", "today matches");
  assert(nextOccurrenceYmd("Mon,Tue", "2026-08-20") === "2026-08-24", "next Mon");
  assert(nextOccurrenceYmd("", "2026-08-20") === "2026-08-20", "empty → fallback");
});

test("deriveCategory: name heuristics", () => {
  assert(deriveCategory("Cooking- Whisk Takers") === "food", "cooking → food");
  assert(deriveCategory("Dance Hip Hop JunkYard") === "arts", "dance → arts");
  assert(deriveCategory("Futsal League - Adult") === "sports", "futsal → sports");
  assert(deriveCategory("Community Yard Sale") === "community", "default community");
});

test("stripHtml: collapses rich text", () => {
  assert(
    stripHtml("<div>Be a <b>tourist</b> for&nbsp;a night &amp; relax.</div>") ===
      "Be a tourist for a night & relax.",
    "html stripped",
  );
});
