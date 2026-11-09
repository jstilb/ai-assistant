#!/usr/bin/env bun
/**
 * cache.test.ts — Slice 1 TDD test for EventScout Cache module.
 *
 * Tests:
 *   1. Round-trip: write EventItem[] → read back → deep equal.
 *   2. pruneExpired: past event removed, future event kept.
 *
 * Env isolation: Cache.ts's module (via Tools/types.ts) computes
 * DEFAULT_CACHE_PATH from KAYA_HOME/KAYA_DIR at import time, falling back to
 * `${HOME}/.claude` — the LIVE main tree — when unset. EVENTSCOUT_CACHE_PATH
 * always overrides that default at call time, but per the hazard class
 * documented in project_eventscout_gotchas, KAYA_HOME/KAYA_DIR are pinned to
 * a mkdtempSync dir BEFORE Cache.ts is ever imported (via dynamic import),
 * so the module-level constant never captures a real-tree path even
 * transiently, and restored in afterAll for the shared bun:test process.
 *
 * Run:
 *   bun test skills/Productivity/EventScout/tests/cache.test.ts
 */

import { test, afterAll } from "bun:test";
import { existsSync, unlinkSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EventItem } from "../Tools/types.ts";
import { defined } from "../../../../lib/test/defined.ts";

// ============================================================================
// Env isolation — pin KAYA_HOME/KAYA_DIR to a scratch dir BEFORE importing
// any Tools module that resolves paths at module-init time.
// ============================================================================

const ORIGINAL_KAYA_HOME = process.env["KAYA_HOME"];
const ORIGINAL_KAYA_DIR = process.env["KAYA_DIR"];

const TEST_KAYA_HOME = mkdtempSync(join(tmpdir(), "eventscout-cache-test-"));
process.env["KAYA_HOME"] = TEST_KAYA_HOME;
process.env["KAYA_DIR"] = TEST_KAYA_HOME;

const TEMP_CACHE_PATH = join(TEST_KAYA_HOME, "events-cache.json");
process.env["EVENTSCOUT_CACHE_PATH"] = TEMP_CACHE_PATH;

const { writeEvents, readEvents, pruneExpired, upsertEventsDeduped, supersededRowIds } = await import(
  "../Tools/Cache.ts"
);

afterAll(() => {
  if (ORIGINAL_KAYA_HOME === undefined) delete process.env["KAYA_HOME"];
  else process.env["KAYA_HOME"] = ORIGINAL_KAYA_HOME;
  if (ORIGINAL_KAYA_DIR === undefined) delete process.env["KAYA_DIR"];
  else process.env["KAYA_DIR"] = ORIGINAL_KAYA_DIR;
  delete process.env["EVENTSCOUT_CACHE_PATH"];
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

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function cleanup(): void {
  if (existsSync(TEMP_CACHE_PATH)) {
    unlinkSync(TEMP_CACHE_PATH);
  }
}

// ============================================================================
// Fixture data
// ============================================================================

const PAST_DATE = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(); // 7 days ago
const FUTURE_DATE = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(); // 7 days ahead

const pastEvent: EventItem = {
  id: "past-event-001",
  title: "Padres vs Dodgers (Past)",
  startDatetime: PAST_DATE,
  endDatetime: PAST_DATE,
  allDay: false,
  venue: "Petco Park",
  address: "100 Park Blvd, San Diego, CA 92101",
  category: "sports",
  tags: ["baseball", "mlb"],
  isFree: false,
  priceMin: 25,
  priceMax: 150,
  currency: "USD",
  ticketUrl: "https://www.mlb.com/padres/tickets",
  sourceUrl: "https://www.mlb.com/padres/schedule",
  sources: [{ sourceId: "padres-mlb", url: "https://www.mlb.com/padres/schedule" }],
  performersOrTeams: "Padres vs Dodgers",
  description: "A past game.",
  fetchedAt: PAST_DATE,
  status: "scheduled",
};

const futureEvent: EventItem = {
  id: "future-event-001",
  title: "Open Mic Night",
  startDatetime: FUTURE_DATE,
  allDay: false,
  venue: "The Comedy Store La Jolla",
  address: "916 Pearl St, La Jolla, CA 92037",
  category: "comedy",
  tags: ["standup", "open-mic"],
  isFree: true,
  sourceUrl: "https://thecomedystore.com/la-jolla/calendar",
  sources: [{ sourceId: "comedy-store-la-jolla", url: "https://thecomedystore.com/la-jolla/calendar" }],
  fetchedAt: new Date().toISOString(),
  status: "scheduled",
};

const testEvents: EventItem[] = [pastEvent, futureEvent];

// ============================================================================
// Tests
// ============================================================================

// Setup: clean slate
cleanup();

test("1. writeEvents + readEvents: round-trip is lossless", () => {
  writeEvents(testEvents);
  const loaded = readEvents();
  assert(loaded.length === 2, `Expected 2 events, got ${loaded.length}`);
  assert(deepEqual(loaded[0], testEvents[0]), "First event deep equal failed");
  assert(deepEqual(loaded[1], testEvents[1]), "Second event deep equal failed");
});

test("2. pruneExpired: removes past event, keeps future event", () => {
  // Ensure we have both events written
  writeEvents(testEvents);

  const now = new Date();
  pruneExpired(now);

  const remaining = readEvents();
  assert(remaining.length === 1, `Expected 1 event after prune, got ${remaining.length}`);
  assert(defined(remaining[0]).id === "future-event-001", `Expected future-event-001, got ${defined(remaining[0]).id}`);
  assert(!remaining.some((e: EventItem) => e.id === "past-event-001"), "Past event should have been pruned");
});

test("3. pruneExpired: event with only startDatetime (past) is pruned", () => {
  const eventWithNoEnd: EventItem = {
    id: "no-end-past-001",
    title: "Old Event No End",
    startDatetime: PAST_DATE,
    allDay: true,
    category: "community",
    tags: [],
    isFree: true,
    sourceUrl: "https://example.com",
    sources: [{ sourceId: "test-src", url: "https://example.com" }],
    fetchedAt: PAST_DATE,
    status: "scheduled",
  };
  const eventWithFutureStart: EventItem = {
    id: "no-end-future-001",
    title: "Future Event No End",
    startDatetime: FUTURE_DATE,
    allDay: true,
    category: "community",
    tags: [],
    isFree: true,
    sourceUrl: "https://example.com",
    sources: [{ sourceId: "test-src", url: "https://example.com" }],
    fetchedAt: new Date().toISOString(),
    status: "scheduled",
  };

  writeEvents([eventWithNoEnd, eventWithFutureStart]);
  pruneExpired(new Date());

  const remaining = readEvents();
  assert(remaining.length === 1, `Expected 1 event, got ${remaining.length}`);
  assert(
    defined(remaining[0]).id === "no-end-future-001",
    `Expected no-end-future-001, got ${defined(remaining[0]).id}`,
  );
});

test("4. upsertEventsDeduped: collapses a cross-source twin already in the cache", () => {
  cleanup();
  // A twin of the SAME real show already sits in the cache from an earlier run,
  // under a different id + source (so upsert-by-id can't see it).
  const existing: EventItem = {
    id: "tycho-songkick",
    title: "Tycho at The Observatory North Park",
    startDatetime: FUTURE_DATE,
    allDay: false,
    venue: "The Observatory North Park",
    category: "music",
    tags: ["electronic"],
    isFree: false,
    sourceUrl: "https://songkick.com/tycho",
    sources: [{ sourceId: "songkick", url: "https://songkick.com/tycho" }],
    fetchedAt: new Date().toISOString(),
    status: "scheduled",
  };
  writeEvents([existing]);

  // Now a fresh refresh brings the same show from a different source/id.
  const incoming: EventItem = {
    id: "tycho-bandsintown",
    title: "Tycho @ Observatory",
    startDatetime: FUTURE_DATE,
    allDay: false,
    venue: "The Observatory",
    category: "music",
    tags: ["indie"],
    isFree: false,
    sourceUrl: "https://bandsintown.com/tycho",
    sources: [{ sourceId: "bandsintown", url: "https://bandsintown.com/tycho" }],
    fetchedAt: new Date().toISOString(),
    status: "scheduled",
  };
  upsertEventsDeduped([incoming]);

  const after = readEvents();
  assert(after.length === 1, `Expected the cross-source twin to collapse to 1, got ${after.length}`);
  const sourceIds = defined(after[0])
    .sources.map((s) => s.sourceId)
    .sort();
  assert(
    sourceIds.length === 2 && sourceIds.includes("songkick") && sourceIds.includes("bandsintown"),
    `Expected both sources unioned, got ${JSON.stringify(sourceIds)}`,
  );
});

test("5. upsertEventsDeduped: distinct events are preserved (no over-merge)", () => {
  cleanup();
  // Future-dated: upsertEventsDeduped now prunes expired events (test 7).
  writeEvents([{ ...pastEvent, id: "future-game-001", startDatetime: FUTURE_DATE, endDatetime: FUTURE_DATE }]);
  upsertEventsDeduped([futureEvent]);
  const after = readEvents();
  assert(after.length === 2, `Expected 2 distinct events preserved, got ${after.length}`);
});

// ============================================================================
// api-tier exemption (2026-07-10) — integration proof against the REAL
// sources.json (this file sets no EVENTSCOUT_SOURCES_PATH override, so
// upsertEventsDeduped's loadApiTierSourceIds() reads the actual
// Tools/sources.json, where "padres-mlb" is fetchTier "api"). Two same-
// day/venue api-tier events with short titles that WOULD fuzzy-merge
// (tokenize drops "1"/"2") must survive the whole-cache re-dedup pass.
// ============================================================================

test("6. upsertEventsDeduped: api-tier events (padres-mlb) survive the whole-cache re-dedup", () => {
  cleanup();
  const gameOne: EventItem = {
    id: "padres-doubleheader-g1",
    title: "Padres Game 1",
    startDatetime: FUTURE_DATE,
    allDay: false,
    venue: "Petco Park",
    category: "sports",
    tags: ["mlb"],
    isFree: false,
    sourceUrl: "https://www.mlb.com/padres/schedule",
    sources: [{ sourceId: "padres-mlb", url: "https://www.mlb.com/padres/schedule" }],
    fetchedAt: new Date().toISOString(),
    status: "scheduled",
  };
  const gameTwo: EventItem = {
    ...gameOne,
    id: "padres-doubleheader-g2",
    title: "Padres Game 2",
  };
  writeEvents([gameOne]);
  upsertEventsDeduped([gameTwo]);
  const after = readEvents();
  assert(
    after.length === 2,
    `api-tier events must not be fuzzy-collapsed by the whole-cache re-dedup pass (got ${after.length})`,
  );
});

test("7. upsertEventsDeduped: prunes expired events, keeps ones inside the 24h grace", () => {
  cleanup();
  const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
  const endedToday: EventItem = {
    ...pastEvent,
    id: "ended-today-001",
    startDatetime: twoHoursAgo,
    endDatetime: twoHoursAgo,
  };
  writeEvents([pastEvent, endedToday]);
  upsertEventsDeduped([futureEvent]);
  const ids = readEvents()
    .map((e: EventItem) => e.id)
    .sort();
  assert(
    deepEqual(ids, ["ended-today-001", "future-event-001"]),
    `Expected [ended-today-001, future-event-001], got ${JSON.stringify(ids)}`,
  );
});

// ============================================================================
// Superseded rows (2026-11-08): a source moved a weekly event 14:00 → 13:30;
// the cache kept the stale 14:00 rows and the whole-cache dedup let them win.
// ============================================================================

const NOW = new Date("2026-11-08T22:00:00Z");

function row(id: string, title: string, startDatetime: string, sourceIds: string[]): EventItem {
  return {
    id,
    title,
    startDatetime,
    allDay: false,
    venue: "Otay Mesa",
    category: "community",
    tags: [],
    isFree: true,
    sourceUrl: "https://example.org/cal",
    sources: sourceIds.map((sourceId) => ({ sourceId, url: `https://example.org/${sourceId}` })),
    fetchedAt: "2026-09-15T21:01:07.724Z",
    status: "scheduled",
  };
}

const ICS = new Set(["feed-ics"]);

test("8. supersededRowIds rule 1: the newest fetch wins on that day (any tier)", () => {
  const stale = row("stale-1400", "Occupy Otay Demonstration", "2026-11-15T14:00:00-08:00", ["html-src"]);
  const fresh = row("fresh-1330", "Occupy Otay Demonstration!", "2026-11-15T13:30:00-08:00", ["html-src"]);
  const r = supersededRowIds([stale], [fresh], ICS, NOW);
  assert(deepEqual([...r.ids], ["stale-1400"]), `Expected stale-1400 dropped, got ${JSON.stringify([...r.ids])}`);
  assert(r.sameDay === 1 && r.leftFeed === 0, `Expected 1 same-day, 0 left-feed, got ${r.sameDay}/${r.leftFeed}`);
});

test("9. supersededRowIds rule 2: an ICS row the feed no longer lists is dropped up to the run's latest date", () => {
  const gone = row("gone", "Teach-in", "2026-11-20T18:00:00-08:00", ["feed-ics"]);
  const beyond = row("beyond", "Teach-in", "2027-03-01T18:00:00-08:00", ["feed-ics"]);
  const fresh = row("fresh", "Vigil", "2026-12-01T10:00:00-08:00", ["feed-ics"]);
  const r = supersededRowIds([gone, beyond], [fresh], ICS, NOW);
  assert(deepEqual([...r.ids], ["gone"]), `Expected only 'gone' dropped, got ${JSON.stringify([...r.ids])}`);
  assert(r.leftFeed === 1, `Expected 1 left-feed, got ${r.leftFeed}`);
});

test("10. supersededRowIds keeps rows the rules do not prove stale", () => {
  const fresh = row("fresh", "Salsa Social", "2026-12-01T19:00:00-08:00", ["html-src"]);
  const cached = [
    // non-ICS source, other title, earlier date: rule 2 does not apply to scrape tiers
    row("other-title", "Bachata Night", "2026-11-20T19:00:00-08:00", ["html-src"]),
    // another source also lists it
    row("multi", "Salsa Social", "2026-12-01T21:00:00-08:00", ["html-src", "other-src"]),
    // the source failed / returned nothing this run
    row("failed-src", "Salsa Social", "2026-12-01T21:00:00-08:00", ["failed-src"]),
    // past row
    row("past", "Salsa Social", "2026-11-01T19:00:00-07:00", ["html-src"]),
    // returned again this run (same id)
    { ...fresh },
    // same title, different LA day
    row("next-week", "Salsa Social", "2026-12-08T19:00:00-08:00", ["html-src"]),
  ];
  const r = supersededRowIds(cached, [fresh], ICS, NOW);
  assert(r.ids.size === 0, `Expected nothing dropped, got ${JSON.stringify([...r.ids])}`);
});

test("11. supersededRowIds rule 1 buckets by the LA day, not the UTC date", () => {
  // 2026-11-16T03:00Z is Nov 15, 19:00 in Los Angeles.
  const stale = row("stale-utc", "Open Mic", "2026-11-16T03:00:00Z", ["html-src"]);
  const fresh = row("fresh-la", "Open Mic", "2026-11-15T19:30:00-08:00", ["html-src"]);
  const r = supersededRowIds([stale], [fresh], ICS, NOW);
  assert(deepEqual([...r.ids], ["stale-utc"]), `Expected stale-utc dropped, got ${JSON.stringify([...r.ids])}`);
});

test("13. supersededRowIds rule 1 keeps a 2nd session a scraped source missed this run (recent row)", () => {
  // Review 2026-11-08: "Bluey's Big Play" 13:00 + 18:00 on one day; a run that returns only 13:00.
  const recent = "2026-11-07T22:00:00Z";
  const matinee = { ...row("bluey-1300", "Bluey's Big Play", "2026-11-14T13:00:00-08:00", ["html-src"]), fetchedAt: recent };
  const evening = { ...row("bluey-1800", "Bluey's Big Play", "2026-11-14T18:00:00-08:00", ["html-src"]), fetchedAt: recent };
  const r = supersededRowIds([matinee, evening], [{ ...matinee }], ICS, NOW);
  assert(r.ids.size === 0, `Expected the 18:00 session kept, got ${JSON.stringify([...r.ids])}`);
});

test("14. supersededRowIds rule 1 drops a session unseen for 7+ days while the source re-lists that day", () => {
  const matinee = { ...row("bluey-1300", "Bluey's Big Play", "2026-11-14T13:00:00-08:00", ["html-src"]), fetchedAt: "2026-11-08T21:00:00Z" };
  const evening = { ...row("bluey-1800", "Bluey's Big Play", "2026-11-14T18:00:00-08:00", ["html-src"]), fetchedAt: "2026-10-20T21:00:00Z" };
  const r = supersededRowIds([matinee, evening], [{ ...matinee }], ICS, NOW);
  assert(deepEqual([...r.ids], ["bluey-1800"]), `Expected bluey-1800 dropped, got ${JSON.stringify([...r.ids])}`);
});

test("15. supersededRowIds rule 1: a moved session of a 2-session day is dropped (count kept)", () => {
  const recent = "2026-11-07T22:00:00Z";
  const a = { ...row("s-1300", "Storytime", "2026-11-14T13:00:00-08:00", ["html-src"]), fetchedAt: recent };
  const b = { ...row("s-1800", "Storytime", "2026-11-14T18:00:00-08:00", ["html-src"]), fetchedAt: recent };
  const moved = { ...row("s-1900", "Storytime", "2026-11-14T19:00:00-08:00", ["html-src"]), fetchedAt: recent };
  const r = supersededRowIds([a, b], [{ ...a }, moved], ICS, NOW);
  assert(deepEqual([...r.ids], ["s-1800"]), `Expected s-1800 dropped, got ${JSON.stringify([...r.ids])}`);
});

test("16. supersededRowIds: titles without letters or digits never match; non-Latin titles keep their letters", () => {
  const stale = row("sym-stale", "!!!", "2026-11-15T14:00:00-08:00", ["html-src"]);
  const fresh = row("sym-fresh", "???", "2026-11-15T13:30:00-08:00", ["html-src"]);
  assert(supersededRowIds([stale], [fresh], ICS, NOW).ids.size === 0, "symbol-only titles must not match");
  const jaStale = row("ja-stale", "ジャズの夜", "2026-11-15T14:00:00-08:00", ["html-src"]);
  const jaOther = row("ja-other", "ロックの夜", "2026-11-15T13:30:00-08:00", ["html-src"]);
  assert(supersededRowIds([jaStale], [jaOther], ICS, NOW).ids.size === 0, "different non-Latin titles must not match");
  const jaFresh = row("ja-fresh", "ジャズの夜", "2026-11-15T13:30:00-08:00", ["html-src"]);
  assert(
    deepEqual([...supersededRowIds([jaStale], [jaFresh], ICS, NOW).ids], ["ja-stale"]),
    "the same non-Latin title must match",
  );
});

test("17. supersededRowIds rule 2 is skipped for a feed at the ICSAdapter safety cap", async () => {
  const { MAX_EVENTS_SAFETY } = await import("../Tools/adapters/ICSAdapter.ts");
  const { ICS_FEED_CAP } = await import("../Tools/Cache.ts");
  assert(ICS_FEED_CAP === MAX_EVENTS_SAFETY, `ICS_FEED_CAP ${ICS_FEED_CAP} != MAX_EVENTS_SAFETY ${MAX_EVENTS_SAFETY}`);
  const gone = row("gone", "Teach-in", "2026-11-20T18:00:00-08:00", ["feed-ics"]);
  const full = Array.from({ length: ICS_FEED_CAP }, (_, i) =>
    row(`f${i}`, `Event ${i}`, "2026-12-01T10:00:00-08:00", ["feed-ics"]),
  );
  assert(supersededRowIds([gone], full, ICS, NOW).ids.size === 0, "a truncated feed must not drop rows by rule 2");
});

test("12. upsertEventsDeduped: a moved event shows the source's new time", () => {
  cleanup();
  const day = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000);
  const ymd = day.toISOString().slice(0, 10);
  const stale = row("moved-stale", "Weekly Demonstration", `${ymd}T14:00:00-08:00`, ["moved-src"]);
  const fresh = {
    ...row("moved-fresh", "Weekly Demonstration", `${ymd}T13:30:00-08:00`, ["moved-src"]),
    fetchedAt: new Date().toISOString(),
  };
  writeEvents([stale]);
  upsertEventsDeduped([fresh]);
  const after = readEvents();
  assert(after.length === 1, `Expected 1 row, got ${after.length}`);
  assert(
    defined(after[0]).startDatetime === `${ymd}T13:30:00-08:00`,
    `Expected the source's new 13:30 time, got ${defined(after[0]).startDatetime}`,
  );
});
