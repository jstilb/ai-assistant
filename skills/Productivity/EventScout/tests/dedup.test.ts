#!/usr/bin/env bun
/**
 * dedup.test.ts — Slice 3 TDD unit tests for Dedup.ts
 *
 * Tests dedupeAndMerge() against SYNTHETIC EventItems (NO network).
 *
 * Assertions:
 *   (a) Near-dup same day → merge to 1, sources[] unioned (length 2), richest fields kept.
 *   (b) Two genuinely different events (different titles/days) → stay 2.
 *   (c) Padres sports event + RSS news event → no false merge (stay 2).
 *
 * Run:
 *   bun test skills/Productivity/EventScout/tests/dedup.test.ts
 */

import { test } from "bun:test";
import { dedupeAndMerge } from "../Tools/Dedup.ts";
import type { EventItem } from "../Tools/types.ts";
import { defined } from "../../../../lib/test/defined.ts";

// ============================================================================
// Test harness
// ============================================================================

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

// ============================================================================
// Fixture helpers
// ============================================================================

function makeEvent(
  overrides: Partial<EventItem> & Pick<EventItem, "id" | "title" | "startDatetime" | "sources">,
): EventItem {
  return {
    allDay: false,
    category: "music",
    tags: [],
    isFree: false,
    sourceUrl: "https://example.com/event",
    fetchedAt: new Date().toISOString(),
    status: "scheduled",
    description: undefined,
    venue: undefined,
    ...overrides,
  };
}

// Event (a1): "Tycho @ Observatory" — sparse (no description, no ticketUrl)
const TYCHO_A: EventItem = makeEvent({
  id: "tycho-a",
  title: "Tycho @ Observatory",
  startDatetime: "2026-07-15T20:00:00-07:00",
  venue: "The Observatory",
  sources: [{ sourceId: "songkick", url: "https://songkick.com/events/1" }],
  ticketUrl: undefined,
  description: undefined,
  tags: ["electronic", "indie"],
});

// Event (a2): near-dup of TYCHO_A — different wording, same day, RICHER (description + ticketUrl + full venue name)
const TYCHO_B: EventItem = makeEvent({
  id: "tycho-b",
  title: "Tycho at The Observatory North Park",
  startDatetime: "2026-07-15T20:30:00-07:00",
  venue: "The Observatory North Park",
  sources: [{ sourceId: "bandsintown", url: "https://bandsintown.com/events/2" }],
  ticketUrl: "https://tickets.example.com/tycho",
  description: "Tycho live at The Observatory North Park",
  tags: ["electronic"],
});

// Event (b1): different title, different day
const JAZZ_NIGHT: EventItem = makeEvent({
  id: "jazz-b1",
  title: "Jazz Night at Balboa Park",
  startDatetime: "2026-07-20T19:00:00-07:00",
  venue: "Balboa Park",
  sources: [{ sourceId: "sd-events", url: "https://sd-events.com/jazz" }],
});

// Event (b2): different title and different day
const COMEDY_SHOW: EventItem = makeEvent({
  id: "comedy-b2",
  title: "Stand-Up Comedy Festival San Diego",
  startDatetime: "2026-07-22T21:00:00-07:00",
  venue: "The Comedy Store",
  sources: [{ sourceId: "comedy-store", url: "https://thecomedystore.com/show" }],
});

// Event (c1): Padres sports event
const PADRES_GAME: EventItem = makeEvent({
  id: "padres-c1",
  title: "Padres vs Los Angeles Dodgers",
  startDatetime: "2026-07-15T18:40:00-07:00",
  venue: "Petco Park",
  category: "sports",
  sources: [{ sourceId: "padres-mlb", url: "https://statsapi.mlb.com/api/v1/schedule?gamePk=123" }],
  tags: ["mlb", "baseball"],
});

// Event (c2): RSS news event on the same day — completely different topic
const PRESS_EVENT: EventItem = makeEvent({
  id: "press-c2",
  title: "San Diego Press Club Annual Awards Ceremony",
  startDatetime: "2026-07-15T19:00:00-07:00",
  venue: "Hilton San Diego Bayfront",
  category: "community",
  sources: [{ sourceId: "sd-press-club", url: "https://sdpressclub.org/awards" }],
  tags: ["press", "journalism"],
});

// ============================================================================
// Tests
// ============================================================================

console.log("\nEventScout Dedup — Slice 3 Unit Tests\n");

// (a) Near-dup same day merges into 1 enriched record
test("(a1) Two near-dup same-day events collapse to 1", () => {
  const result = dedupeAndMerge([TYCHO_A, TYCHO_B]);
  assert(
    result.length === 1,
    `Expected 1 merged event, got ${result.length}: ${JSON.stringify(result.map((e) => e.title))}`,
  );
});

test("(a2) Merged event sources[] is unioned (length 2)", () => {
  const result = dedupeAndMerge([TYCHO_A, TYCHO_B]);
  assert(result.length === 1, `Expected 1 event, got ${result.length}`);
  const sourceIds = defined(result[0])
    .sources.map((s) => s.sourceId)
    .sort();
  assert(
    sourceIds.length === 2,
    `Expected 2 sources after union, got ${sourceIds.length}: ${JSON.stringify(sourceIds)}`,
  );
  assert(
    sourceIds.includes("songkick") && sourceIds.includes("bandsintown"),
    `Expected both "songkick" and "bandsintown", got ${JSON.stringify(sourceIds)}`,
  );
});

test("(a3) Merged event keeps richest fields (description from TYCHO_B)", () => {
  const result = dedupeAndMerge([TYCHO_A, TYCHO_B]);
  assert(result.length === 1, `Expected 1 event`);
  // TYCHO_B has description; TYCHO_A does not → merged record must have it
  assert(
    defined(result[0]).description === "Tycho live at The Observatory North Park",
    `Expected description from TYCHO_B, got "${defined(result[0]).description}"`,
  );
});

test("(a4) Merged event keeps ticketUrl from TYCHO_B (TYCHO_A had none)", () => {
  const result = dedupeAndMerge([TYCHO_A, TYCHO_B]);
  assert(result.length === 1, `Expected 1 event`);
  assert(
    defined(result[0]).ticketUrl === "https://tickets.example.com/tycho",
    `Expected ticketUrl from TYCHO_B, got "${defined(result[0]).ticketUrl}"`,
  );
});

test("(a5) Merge is commutative — order [B, A] gives same source union", () => {
  const result = dedupeAndMerge([TYCHO_B, TYCHO_A]);
  assert(result.length === 1, `Expected 1 event`);
  const sourceIds = defined(result[0])
    .sources.map((s) => s.sourceId)
    .sort();
  assert(
    sourceIds.length === 2 && sourceIds.includes("songkick") && sourceIds.includes("bandsintown"),
    `Sources not unioned correctly: ${JSON.stringify(sourceIds)}`,
  );
});

// (b) Genuinely different events must NOT merge
test("(b1) Two different events (different titles + days) stay separate — count 2", () => {
  const result = dedupeAndMerge([JAZZ_NIGHT, COMEDY_SHOW]);
  assert(
    result.length === 2,
    `Expected 2 distinct events, got ${result.length}: ${JSON.stringify(result.map((e) => e.title))}`,
  );
});

test("(b2) Same day but very different titles do NOT merge", () => {
  // Give them the same date to stress-test the title threshold
  const jazzSameDay: EventItem = { ...JAZZ_NIGHT, startDatetime: "2026-07-22T19:00:00-07:00" };
  const result = dedupeAndMerge([jazzSameDay, COMEDY_SHOW]);
  assert(
    result.length === 2,
    `Expected 2 distinct events on same day, got ${result.length}: ${JSON.stringify(result.map((e) => e.title))}`,
  );
});

// (c) Padres sports event + RSS community event — NO false merge
test("(c1) Padres sports event + Press Club event on same day stay separate — count 2", () => {
  const result = dedupeAndMerge([PADRES_GAME, PRESS_EVENT]);
  assert(
    result.length === 2,
    `False merge detected! Expected 2 events, got ${result.length}: ${JSON.stringify(result.map((e) => e.title))}`,
  );
});

test("(c2) Four-event mix: 2 near-dups + 2 distinct → 3 total", () => {
  // TYCHO_A + TYCHO_B merge → 1; JAZZ_NIGHT stays; PADRES_GAME stays
  const result = dedupeAndMerge([TYCHO_A, TYCHO_B, JAZZ_NIGHT, PADRES_GAME]);
  assert(
    result.length === 3,
    `Expected 3 events after merge, got ${result.length}: ${JSON.stringify(result.map((e) => e.title))}`,
  );
});

test("(c3) Empty input returns empty array", () => {
  const result = dedupeAndMerge([]);
  assert(result.length === 0, `Expected 0 events, got ${result.length}`);
});

test("(c4) Single event passthrough unchanged", () => {
  const result = dedupeAndMerge([JAZZ_NIGHT]);
  assert(result.length === 1, `Expected 1 event, got ${result.length}`);
  assert(defined(result[0]).id === JAZZ_NIGHT.id, `Event id changed`);
});

// ============================================================================
// Regression tests — same-day + same-venue false-merge prevention (Slice 3 bug)
//
// These tests reproduce the exact failures that the old combined-Jaccard (0.5)
// predicate produced. All five use SAME DAY to stress the new predicate.
// ============================================================================

// (r-a) Mulaney vs Chappelle @ Comedy Store, same day → NO merge
test("(r-a) Mulaney vs Chappelle @ same venue same day → stay separate", () => {
  const mulaney: EventItem = makeEvent({
    id: "mulaney-r",
    title: "John Mulaney",
    startDatetime: "2026-08-10T20:00:00-07:00",
    venue: "The Comedy Store",
    sources: [{ sourceId: "comedy-store-1", url: "https://thecomedystore.com/mulaney" }],
  });
  const chappelle: EventItem = makeEvent({
    id: "chappelle-r",
    title: "Dave Chappelle",
    startDatetime: "2026-08-10T22:00:00-07:00",
    venue: "The Comedy Store",
    sources: [{ sourceId: "comedy-store-2", url: "https://thecomedystore.com/chappelle" }],
  });
  const result = dedupeAndMerge([mulaney, chappelle]);
  assert(result.length === 2, `False merge: Mulaney and Chappelle merged into 1 (got ${result.length})`);
});

// (r-b) Jazz Night vs Open Mic Night @ Comedy Store, same day → NO merge
test("(r-b) Jazz Night vs Open Mic Night @ same venue same day → stay separate", () => {
  const jazzNight: EventItem = makeEvent({
    id: "jazz-night-r",
    title: "Jazz Night",
    startDatetime: "2026-08-11T19:00:00-07:00",
    venue: "The Comedy Store",
    sources: [{ sourceId: "comedy-store-jazz", url: "https://thecomedystore.com/jazz" }],
  });
  const openMic: EventItem = makeEvent({
    id: "open-mic-r",
    title: "Open Mic Night",
    startDatetime: "2026-08-11T21:00:00-07:00",
    venue: "The Comedy Store",
    sources: [{ sourceId: "comedy-store-mic", url: "https://thecomedystore.com/openmic" }],
  });
  const result = dedupeAndMerge([jazzNight, openMic]);
  assert(result.length === 2, `False merge: Jazz Night and Open Mic Night merged into 1 (got ${result.length})`);
});

// (r-c) Latin Night vs Salsa Night @ Soda Bar, same day → NO merge
test("(r-c) Latin Night vs Salsa Night @ same venue same day → stay separate", () => {
  const latinNight: EventItem = makeEvent({
    id: "latin-night-r",
    title: "Latin Night",
    startDatetime: "2026-08-12T21:00:00-07:00",
    venue: "Soda Bar",
    sources: [{ sourceId: "sodabar-latin", url: "https://sodabar.com/latin" }],
  });
  const salsaNight: EventItem = makeEvent({
    id: "salsa-night-r",
    title: "Salsa Night",
    startDatetime: "2026-08-12T22:00:00-07:00",
    venue: "Soda Bar",
    sources: [{ sourceId: "sodabar-salsa", url: "https://sodabar.com/salsa" }],
  });
  const result = dedupeAndMerge([latinNight, salsaNight]);
  assert(result.length === 2, `False merge: Latin Night and Salsa Night merged into 1 (got ${result.length})`);
});

// (r-d) Tycho @ Observatory vs Tycho @ Observatory North Park, same day → MERGE
test("(r-d) Tycho @ Observatory vs Tycho @ Observatory North Park same day → merge to 1", () => {
  const tychoA: EventItem = makeEvent({
    id: "tycho-reg-a",
    title: "Tycho",
    startDatetime: "2026-08-15T20:00:00-07:00",
    venue: "The Observatory",
    sources: [{ sourceId: "songkick-reg", url: "https://songkick.com/tycho-reg" }],
  });
  const tychoB: EventItem = makeEvent({
    id: "tycho-reg-b",
    title: "Tycho",
    startDatetime: "2026-08-15T20:00:00-07:00",
    venue: "The Observatory North Park",
    sources: [{ sourceId: "bandsintown-reg", url: "https://bandsintown.com/tycho-reg" }],
  });
  const result = dedupeAndMerge([tychoA, tychoB]);
  assert(result.length === 1, `Failed to merge Tycho duplicates (got ${result.length})`);
  const sourceIds = defined(result[0])
    .sources.map((s) => s.sourceId)
    .sort();
  assert(sourceIds.length === 2, `Expected 2 unioned sources, got ${sourceIds.length}: ${JSON.stringify(sourceIds)}`);
});

// (r-e) Padres game vs Press Club news same day → NO merge
test("(r-e) Padres game vs Press Club news item same day → stay separate", () => {
  const padres: EventItem = makeEvent({
    id: "padres-reg",
    title: "Padres vs Los Angeles Dodgers",
    startDatetime: "2026-08-15T18:40:00-07:00",
    venue: "Petco Park",
    category: "sports",
    sources: [{ sourceId: "padres-reg", url: "https://mlb.com/padres" }],
    tags: ["baseball"],
  });
  const pressClub: EventItem = makeEvent({
    id: "press-reg",
    title: "San Diego Press Club Annual Awards Ceremony",
    startDatetime: "2026-08-15T19:00:00-07:00",
    venue: "Hilton San Diego Bayfront",
    category: "community",
    sources: [{ sourceId: "press-reg", url: "https://sdpressclub.org" }],
    tags: ["journalism"],
  });
  const result = dedupeAndMerge([padres, pressClub]);
  assert(result.length === 2, `False merge: Padres game and Press Club news merged into 1 (got ${result.length})`);
});

// ============================================================================
// Cross-source twins: divergent titles + mixed datetime representations, shared
// performer (regression for the Songkick/Bandsintown duplicate explosion)
// ============================================================================

test("twins: diff titles + UTC-vs-offset datetime + shared performer → merge to 1", () => {
  const songkick: EventItem = makeEvent({
    id: "quintron-sk",
    title: "Quintron at Casbah",
    startDatetime: "2026-06-05T03:30:00.000Z", // UTC form (= Jun-04 20:30 PDT)
    venue: "Casbah, San Diego, CA",
    performersOrTeams: "Quintron",
    sources: [{ sourceId: "songkick-sd", url: "https://songkick.com/q" }],
  });
  const bandsintown: EventItem = makeEvent({
    id: "quintron-bit",
    title: "Quintron & Miss Pussycat",
    startDatetime: "2026-06-04T20:30:00-07:00", // SAME instant, offset-local form
    venue: "Casbah",
    performersOrTeams: "Quintron, Miss Pussycat",
    sources: [{ sourceId: "bandsintown-sd", url: "https://bandsintown.com/q" }],
  });
  const result = dedupeAndMerge([songkick, bandsintown]);
  assert(result.length === 1, `Twins should merge to 1 via LA-day bucketing + performer match (got ${result.length})`);
  assert(
    defined(result[0]).sources.length === 2,
    `Merged twin should union both sources (got ${defined(result[0]).sources.length})`,
  );
});

test("same venue + same day, DIFFERENT performer → stay separate (no false merge)", () => {
  const showA: EventItem = makeEvent({
    id: "perf-a",
    title: "Quintron at Casbah",
    startDatetime: "2026-06-05T03:30:00.000Z",
    venue: "Casbah, San Diego, CA",
    performersOrTeams: "Quintron",
    sources: [{ sourceId: "songkick-sd", url: "https://songkick.com/a" }],
  });
  const showB: EventItem = makeEvent({
    id: "perf-b",
    title: "Witch Face at Casbah",
    startDatetime: "2026-06-05T03:30:00.000Z",
    venue: "Casbah, San Diego, CA",
    performersOrTeams: "Witch Face",
    sources: [{ sourceId: "songkick-sd", url: "https://songkick.com/b" }],
  });
  const result = dedupeAndMerge([showA, showB]);
  assert(result.length === 2, `Different performers at the same venue must NOT merge (got ${result.length})`);
});

// ============================================================================
// Diacritics: accented vs ASCII spelling of the same venue → merge
// (regression for the "Négociant Winery" vs "Negociant Winery" twin explosion)
// ============================================================================

test("accents: 'Négociant Winery' vs 'Negociant Winery' same title/day → merge to 1", () => {
  const accented: EventItem = makeEvent({
    id: "kogee-acc",
    title: "Kogee Soul & Friends",
    startDatetime: "2026-06-05T18:00:00-07:00",
    venue: "Négociant Winery",
    sources: [{ sourceId: "bandsintown-sd", url: "https://bandsintown.com/kogee" }],
  });
  const ascii: EventItem = makeEvent({
    id: "kogee-asc",
    title: "Kogee Soul & Friends",
    startDatetime: "2026-06-05T18:00:00-07:00",
    venue: "Negociant Winery, San Diego, CA",
    sources: [{ sourceId: "eventbrite-sd", url: "https://eventbrite.com/kogee" }],
  });
  const result = dedupeAndMerge([accented, ascii]);
  assert(result.length === 1, `Accented + ASCII venue spelling should merge to 1 (got ${result.length})`);
  assert(
    defined(result[0]).sources.length === 2,
    `Merged twin should union both sources (got ${defined(result[0]).sources.length})`,
  );
});

// ============================================================================
// Address-suffix venue: "<Venue>" vs "<Venue>, <street>, <city>, ST zip" → merge
// (regression for the "House of Blues San Diego" vs "House of Blues, 1055 5th
//  Avenue, San Diego, CA 92101" straggler that scored venue-Jaccard 0.57)
// ============================================================================

test("address-suffix: bare venue vs venue+postal-address, same act/day → merge", () => {
  const bare: EventItem = makeEvent({
    id: "qveen-a",
    title: "Qveen Herby",
    startDatetime: "2026-06-05T19:00:00-07:00",
    venue: "House of Blues San Diego",
    performersOrTeams: "Qveen Herby",
    sources: [{ sourceId: "songkick-sd", url: "https://songkick.com/qveen" }],
  });
  const withAddress: EventItem = makeEvent({
    id: "qveen-b",
    title: "Qveen Herby, THOT SQUAD",
    startDatetime: "2026-06-05T19:00:00-07:00",
    venue: "House of Blues, 1055 5th Avenue, San Diego, CA 92101",
    performersOrTeams: "Qveen Herby, THOT SQUAD",
    sources: [{ sourceId: "sd-reader", url: "https://sandiegoreader.com/qveen" }],
  });
  const result = dedupeAndMerge([bare, withAddress]);
  assert(result.length === 1, `Bare venue + venue-with-address should merge to 1 (got ${result.length})`);
});

test("address-suffix safety: different acts at same address venue stay separate", () => {
  // venueCore is permissive, but the title/performer gate must still keep
  // genuinely different shows apart.
  const showA: EventItem = makeEvent({
    id: "hob-jazz",
    title: "Jazz Night",
    startDatetime: "2026-06-05T19:00:00-07:00",
    venue: "House of Blues San Diego",
    sources: [{ sourceId: "src-a", url: "https://example.com/a" }],
  });
  const showB: EventItem = makeEvent({
    id: "hob-metal",
    title: "Death Metal Showcase",
    startDatetime: "2026-06-05T22:00:00-07:00",
    venue: "House of Blues, 1055 5th Avenue, San Diego, CA 92101",
    sources: [{ sourceId: "src-b", url: "https://example.com/b" }],
  });
  const result = dedupeAndMerge([showA, showB]);
  assert(result.length === 2, `Different acts at the same address-venue must NOT merge (got ${result.length})`);
});

// ============================================================================
// api-tier exemption (2026-07-10) — structured api-tier sources (collision-
// resistant stableIds) are NEVER fuzzy-merged: not with each other, and not
// absorbed into/by non-api events. Their only dedup is exact `id` equality.
// Root cause: MemberLifeAdapter's "Level 1 Salsa"/"Level 2 Salsa" same-day,
// same-venue, same-instructor class occurrences collapsed to 1 under the
// fuzzy predicate (tokenize() drops "1"/"2" as <=2-char noise tokens, and
// sharePerformer() fires on the shared instructor) — 44 correct occurrences
// collapsed to 22 in the persisted cache.
// ============================================================================

const API_TIER = new Set(["majestyinmotion-classes"]);

test("(api-1) api-tier: 'Level 1 Salsa' / 'Level 2 Salsa' same day/venue/instructor survive as 2", () => {
  const level1: EventItem = makeEvent({
    id: "ml-level1",
    title: "Level 1 Salsa",
    startDatetime: "2026-08-20T18:00:00-07:00",
    venue: "Majesty in Motion (Studio A)",
    category: "arts",
    performersOrTeams: "Carlos Rivera",
    sources: [{ sourceId: "majestyinmotion-classes", url: "https://member.life/majestyinmotion/schedule" }],
  });
  const level2: EventItem = makeEvent({
    id: "ml-level2",
    title: "Level 2 Salsa",
    startDatetime: "2026-08-20T19:00:00-07:00",
    venue: "Majesty in Motion (Studio A)",
    category: "arts",
    performersOrTeams: "Carlos Rivera",
    sources: [{ sourceId: "majestyinmotion-classes", url: "https://member.life/majestyinmotion/schedule" }],
  });

  // Sanity check: WITHOUT the exemption, the old fuzzy predicate DOES collapse
  // these (tokenize drops "1"/"2" → identical {level, salsa} title tokens;
  // same venue; shared performer) — this is the exact reported bug.
  const withoutExemption = dedupeAndMerge([level1, level2]);
  assert(
    withoutExemption.length === 1,
    `Sanity check failed: expected the OLD fuzzy predicate to still collapse these (got ${withoutExemption.length}) — the reproduction no longer matches the reported bug`,
  );

  const result = dedupeAndMerge([level1, level2], API_TIER);
  assert(result.length === 2, `api-tier events must NOT be fuzzy-merged with each other (got ${result.length})`);
});

test("(api-2) api-tier: duplicate stableId within one batch collapses to 1 (exact-id upsert)", () => {
  const original: EventItem = makeEvent({
    id: "ml-bachata-basics",
    title: "Bachata Basics",
    startDatetime: "2026-08-21T18:00:00-07:00",
    venue: "Majesty in Motion",
    sources: [{ sourceId: "majestyinmotion-classes", url: "https://member.life/majestyinmotion/schedule" }],
  });
  const refetched: EventItem = { ...original, fetchedAt: new Date().toISOString(), description: "updated" };

  const result = dedupeAndMerge([original, refetched], API_TIER);
  assert(
    result.length === 1,
    `Same stableId must collapse to 1 via exact-id upsert, not fuzzy merge (got ${result.length})`,
  );
  assert(
    defined(result[0]).id === "ml-bachata-basics",
    `Expected the shared id to survive, got "${defined(result[0]).id}"`,
  );
});

test("(api-3) api-tier event is NOT absorbed into a fuzzy-tier twin (cross-source non-absorption)", () => {
  // Same title/venue/day — WOULD merge under the plain fuzzy predicate — but
  // one source is api-tier, so they must stay separate.
  const apiClass: EventItem = makeEvent({
    id: "ml-salsa-night",
    title: "Salsa Night",
    startDatetime: "2026-08-22T20:00:00-07:00",
    venue: "Majesty in Motion",
    sources: [{ sourceId: "majestyinmotion-classes", url: "https://member.life/majestyinmotion/schedule" }],
  });
  const scrapedTwin: EventItem = makeEvent({
    id: "scraped-salsa-night",
    title: "Salsa Night",
    startDatetime: "2026-08-22T20:00:00-07:00",
    venue: "Majesty in Motion",
    sources: [{ sourceId: "majestyinmotion-events", url: "https://majestyinmotion.com/events/" }],
  });

  // Sanity check: without the exemption these WOULD merge (identical title+venue+day).
  const withoutExemption = dedupeAndMerge([apiClass, scrapedTwin]);
  assert(
    withoutExemption.length === 1,
    `Sanity check failed: expected the plain fuzzy predicate to merge an exact title/venue/day twin (got ${withoutExemption.length})`,
  );

  const result = dedupeAndMerge([apiClass, scrapedTwin], API_TIER);
  assert(
    result.length === 2,
    `api-tier event must not be absorbed into a non-api twin, and vice versa (got ${result.length})`,
  );
});

test("(api-4) non-api sources are unaffected when apiTierSourceIds is passed but doesn't cover them", () => {
  // Regression guard: passing a non-empty apiTierSourceIds must not change
  // fuzzy behavior for sources NOT in that set — TYCHO_A/TYCHO_B (songkick/
  // bandsintown) must still merge exactly as the (a1) test proves with no arg.
  const result = dedupeAndMerge([TYCHO_A, TYCHO_B], API_TIER);
  assert(
    result.length === 1,
    `Non-api events must still fuzzy-merge normally when apiTierSourceIds is present but irrelevant (got ${result.length})`,
  );
});

// F-005 (Jm 2026-11-18, "many 'ongoing' events have clearly ended"): a scraper
// re-extracts an ongoing listing with the fetch day as its start (and a varying
// end time), so one KPBS tour sat in the cache 20+ times. Multi-day rows from
// one source with the same title whose spans overlap = one listing.
test("overlapping multi-day copies of one listing merge across start days", () => {
  const src = [{ sourceId: "kpbs-events", url: "https://www.kpbs.org/events/all" }];
  const copy = (id: string, start: string, end: string, fetchedAt: string) =>
    makeEvent({
      id,
      title: "Carlsbad GPS-guided Walking Tour",
      startDatetime: start,
      endDatetime: end,
      sources: src,
      fetchedAt,
    });
  const camp = (id: string, start: string, end: string) =>
    makeEvent({ id, title: "Winter Art Camp", startDatetime: start, endDatetime: end, sources: src });
  const result = dedupeAndMerge([
    copy("c1", "2026-06-04T08:00:00-07:00", "2027-12-31T00:00:00-08:00", "2026-06-04T21:00:00Z"),
    copy("c2", "2026-08-10T08:00:00-07:00", "2027-12-31T19:00:00-08:00", "2026-08-10T21:00:00Z"),
    copy("c3", "2026-11-04T08:00:00-08:00", "2027-12-31T00:00:00.000Z", "2026-11-04T22:00:00Z"),
    // The same title from another source: not merged by this rule.
    makeEvent({
      id: "other-src",
      title: "Carlsbad GPS-guided Walking Tour",
      startDatetime: "2026-11-04T08:00:00-08:00",
      endDatetime: "2027-12-31T00:00:00-08:00",
      sources: [{ sourceId: "sandiego-org-events", url: "https://www.sandiego.org/" }],
    }),
    // Two sessions of a class that do not overlap: both stay.
    camp("camp-dec", "2026-12-20T09:00:00-08:00", "2026-12-31T15:00:00-08:00"),
    camp("camp-jan", "2027-01-05T09:00:00-08:00", "2027-01-16T15:00:00-08:00"),
    // Same title, sessions under a day on two days: distinct sessions, not copies.
    makeEvent({
      id: "s1",
      title: "Salsa Night",
      startDatetime: "2026-11-20T20:00:00-08:00",
      endDatetime: "2026-11-21T01:00:00-08:00",
      sources: src,
    }),
    makeEvent({
      id: "s2",
      title: "Salsa Night",
      startDatetime: "2026-11-27T20:00:00-08:00",
      endDatetime: "2026-11-28T01:00:00-08:00",
      sources: src,
    }),
  ]);
  const tours = result.filter(
    (e) => e.sources.some((s) => s.sourceId === "kpbs-events") && e.title.startsWith("Carlsbad"),
  );
  assert(tours.length === 1, `expected one merged listing, got ${tours.length}`);
  const tour = defined(tours[0]);
  assert(tour.startDatetime === "2026-06-04T08:00:00-07:00", `earliest start kept, got ${tour.startDatetime}`);
  assert(tour.endDatetime === "2027-12-31T19:00:00-08:00", `latest end kept, got ${tour.endDatetime}`);
  assert(tour.fetchedAt === "2026-11-04T22:00:00Z", `latest fetch kept, got ${tour.fetchedAt}`);
  assert(
    result.some((e) => e.id === "other-src"),
    "another source's row is not merged by this rule",
  );
  assert(result.filter((e) => e.title === "Winter Art Camp").length === 2, "non-overlapping sessions stay separate");
  assert(result.filter((e) => e.title === "Salsa Night").length === 2, "sessions on two days stay separate");
});

// ============================================================================
// F-006 (2026-11-18): the same event at the same start instant from one run to
// the next, with venue text that changes ("Away", "Loveland, CO", none).
// ============================================================================

test("same instant + shared team merges despite conflicting venue text (sd-gulls)", () => {
  const src = [{ sourceId: "sd-gulls", url: "https://www.sandiegogulls.com/games" }];
  const game = (id: string, venue: string | undefined, performersOrTeams: string) =>
    makeEvent({ id, title: "San Diego Gulls at Colorado Eagles", startDatetime: "2026-11-28T14:05:00-08:00", venue, performersOrTeams, sources: src });
  const result = dedupeAndMerge([
    game("g1", "Loveland, CO", "San Diego Gulls vs Colorado Eagles"),
    game("g2", undefined, "San Diego Gulls, Colorado Eagles"),
    game("g3", "Away", "San Diego Gulls at Colorado Eagles"),
    game("g4", "Blue Arena, Loveland", "San Diego Gulls, Colorado Eagles"),
  ]);
  assert(result.length === 1, `Expected 1 game, got ${result.length}`);
  // A different start instant is a different game, even with the same teams.
  const two = dedupeAndMerge([game("g1", "Away", "San Diego Gulls, Colorado Eagles"), { ...game("g5", "Away", "San Diego Gulls, Colorado Eagles"), startDatetime: "2026-11-29T14:05:00-08:00" }]);
  assert(two.length === 2, `Expected 2 games on 2 days, got ${two.length}`);
});

test("one source, same instant, one row without venue + near-identical title → merge", () => {
  const src = [{ sourceId: "kpbs-events", url: "https://www.kpbs.org/events/all" }];
  const result = dedupeAndMerge([
    makeEvent({ id: "run-a", title: "Family Fun Run", startDatetime: "2026-11-26T07:00:00-08:00", venue: "Del Mar Racetrack", sources: src }),
    makeEvent({ id: "run-b", title: "Family Fun Run", startDatetime: "2026-11-26T07:00:00-08:00", sources: src }),
  ]);
  assert(result.length === 1, `Expected 1, got ${result.length}`);
  assert(result[0]?.venue === "Del Mar Racetrack", `Expected the venue kept, got ${result[0]?.venue}`);
});

test("guards: same title at two real venues, and cross-source date-only rows, stay separate", () => {
  const rec = [{ sourceId: "sdparkandrec-activenet", url: "https://anc.apm.activecommunities.com/sdparkandrec" }];
  const leagues = dedupeAndMerge([
    makeEvent({ id: "v1", title: "Volleyball League - Youth 17 and Under", startDatetime: "2026-11-18T18:00:00-08:00", venue: "Skyline Recreation Center", sources: rec }),
    makeEvent({ id: "v2", title: "Volleyball League - Youth 17 and Under", startDatetime: "2026-11-18T18:00:00-08:00", venue: "Paradise Hills Rec Ctr", sources: rec }),
  ]);
  assert(leagues.length === 2, `Same title at two rec centers must stay 2, got ${leagues.length}`);
  const buffets = dedupeAndMerge([
    makeEvent({ id: "b1", title: "Thanksgiving Brunch Buffet", startDatetime: "2026-11-26T00:00:00-08:00", sources: [{ sourceId: "sd-reader-bestbets", url: "https://www.sandiegoreader.com/" }] }),
    makeEvent({ id: "b2", title: "Thanksgiving Buffet", startDatetime: "2026-11-26T00:00:00-08:00", venue: "Cosmopolitan Hotel", sources: [{ sourceId: "dosd", url: "https://dosd.com/" }] }),
  ]);
  assert(buffets.length === 2, `Cross-source date-only rows without a shared performer must stay 2, got ${buffets.length}`);
});

