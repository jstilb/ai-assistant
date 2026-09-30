#!/usr/bin/env bun
/**
 * rss.test.ts — Slice 3 TDD unit tests for RSSAdapter.ts
 *
 * Tests the RSS → EventItem mapper against an INLINE RSS XML fixture (NO network).
 * Verifies:
 *   - title maps correctly from RSS item title
 *   - sourceUrl maps from the item's <link>
 *   - category comes from source.categoryHint
 *   - sources[0].sourceId matches the source.id
 *   - startDatetime is a valid ISO 8601 datetime
 *   - description is populated from item content
 *
 * Run:
 *   bun test ~/.claude/.claude/worktrees/arch-debt-d2-eventscout-buntest/skills/Productivity/EventScout/tests/rss.test.ts
 */

import { test } from "bun:test";
import { mapFeedItemToEvent } from "../Tools/adapters/RSSAdapter.ts";
// cross-skill-allowed: type-only (erased at runtime) — test fixture type mirrors RSSAdapter's deliberate adapter-over-ContentAggregator's RSSParser coupling
import type { FeedItem } from "../../../../skills/Content/ContentAggregator/Tools/RSSParser.ts";
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
// Fixtures
// ============================================================================

/**
 * Minimal EventSource that represents the SD Press Club RSS feed.
 * categoryHint drives the EventItem.category field.
 */
const PRESS_CLUB_SOURCE: EventSource = {
  id: "sd-press-club",
  name: "San Diego Press Club",
  url: "https://sdpressclub.org/category/news-events/feed/",
  fetchTier: "rss",
  categoryHint: "community",
  geoHint: "San Diego, CA",
  pollInterval: 720,
  enabled: true,
};

/**
 * A music source — to verify that categoryHint="music" flows through correctly
 * even with a different source.
 */
const MUSIC_SOURCE: EventSource = {
  id: "sd-music-rss",
  name: "SD Music Events",
  url: "https://example.com/music/feed/",
  fetchTier: "rss",
  categoryHint: "music",
  pollInterval: 720,
  enabled: true,
};

/**
 * Simulated FeedItem from the RSSParser for a Press Club event.
 * This mirrors what parseRSSFeed would produce from a real WordPress RSS item.
 */
const PRESS_CLUB_FEED_ITEM: FeedItem = {
  title: "An Evening with San Diego Police Chief Scott Wahl",
  url: "https://sdpressclub.org/2026/03/30/an-evening-with-san-diego-police-chief-scott-wahl/",
  author: "sdpressclub",
  publishedAt: "2026-03-30T19:59:03.000Z",
  body: "Join the San Diego Press Club on Monday, April 27 at 7 p.m. for a timely Zoom conversation between San Diego Sun Editor Ron Donoho and San Diego Police Chief Scott Wahl.",
  tags: ["News + Events"],
};

/**
 * FeedItem with an empty URL (edge case: fallback to source URL).
 */
const NO_URL_FEED_ITEM: FeedItem = {
  title: "Spring Giving Days Fundraiser",
  url: "",
  author: "sdpressclub",
  publishedAt: "2026-04-03T21:02:09.000Z",
  body: "Help support the San Diego Press Club this spring.",
  tags: [],
};

/**
 * FeedItem from a music source — for category passthrough test.
 */
const MUSIC_FEED_ITEM: FeedItem = {
  title: "Tycho Live at The Observatory",
  url: "https://example.com/tycho-observatory",
  author: "sd-music-rss",
  publishedAt: "2026-07-15T20:00:00.000Z",
  body: "Electronic ambient artist Tycho performs at The Observatory North Park.",
  tags: ["electronic", "ambient"],
};

// ============================================================================
// Tests
// ============================================================================

console.log("\nEventScout RSS Adapter — Slice 3 Unit Tests\n");

test("1. title maps from FeedItem.title", () => {
  const event = mapFeedItemToEvent(PRESS_CLUB_FEED_ITEM, PRESS_CLUB_SOURCE);
  assert(
    event.title === "An Evening with San Diego Police Chief Scott Wahl",
    `Expected original title, got "${event.title}"`
  );
});

test("2. sourceUrl maps from FeedItem.url", () => {
  const event = mapFeedItemToEvent(PRESS_CLUB_FEED_ITEM, PRESS_CLUB_SOURCE);
  assert(
    event.sourceUrl === "https://sdpressclub.org/2026/03/30/an-evening-with-san-diego-police-chief-scott-wahl/",
    `Expected FeedItem.url as sourceUrl, got "${event.sourceUrl}"`
  );
});

test("3. category comes from source.categoryHint (community)", () => {
  const event = mapFeedItemToEvent(PRESS_CLUB_FEED_ITEM, PRESS_CLUB_SOURCE);
  assert(
    event.category === "community",
    `Expected category "community" from categoryHint, got "${event.category}"`
  );
});

test("4. category comes from source.categoryHint (music)", () => {
  const event = mapFeedItemToEvent(MUSIC_FEED_ITEM, MUSIC_SOURCE);
  assert(
    event.category === "music",
    `Expected category "music" from musicSource.categoryHint, got "${event.category}"`
  );
});

test("5. sources[0].sourceId === source.id", () => {
  const event = mapFeedItemToEvent(PRESS_CLUB_FEED_ITEM, PRESS_CLUB_SOURCE);
  assert(
    event.sources.length >= 1,
    `Expected at least 1 source entry, got ${event.sources.length}`
  );
  assert(
    event.sources[0].sourceId === "sd-press-club",
    `Expected sourceId "sd-press-club", got "${event.sources[0].sourceId}"`
  );
});

test("6. startDatetime is a valid ISO 8601 datetime", () => {
  const event = mapFeedItemToEvent(PRESS_CLUB_FEED_ITEM, PRESS_CLUB_SOURCE);
  const parsed = new Date(event.startDatetime);
  assert(
    !isNaN(parsed.getTime()),
    `startDatetime "${event.startDatetime}" did not parse to a valid Date`
  );
  // Must be a non-empty string
  assert(
    event.startDatetime.length > 0,
    `startDatetime is empty`
  );
});

test("7. description is populated from FeedItem.body", () => {
  const event = mapFeedItemToEvent(PRESS_CLUB_FEED_ITEM, PRESS_CLUB_SOURCE);
  assert(
    typeof event.description === "string" && event.description.length > 0,
    `Expected non-empty description, got "${event.description}"`
  );
});

test("8. id is a non-empty deterministic string", () => {
  const event1 = mapFeedItemToEvent(PRESS_CLUB_FEED_ITEM, PRESS_CLUB_SOURCE);
  const event2 = mapFeedItemToEvent(PRESS_CLUB_FEED_ITEM, PRESS_CLUB_SOURCE);
  assert(
    typeof event1.id === "string" && event1.id.length > 0,
    `id is empty or not a string: "${event1.id}"`
  );
  assert(
    event1.id === event2.id,
    `id is not deterministic: "${event1.id}" vs "${event2.id}"`
  );
});

test("9. tags includes FeedItem.tags", () => {
  const event = mapFeedItemToEvent(PRESS_CLUB_FEED_ITEM, PRESS_CLUB_SOURCE);
  // The item has tags ["News + Events"] — these should flow through
  assert(
    Array.isArray(event.tags),
    `tags should be an array, got ${typeof event.tags}`
  );
});

test("10. allDay defaults to false", () => {
  const event = mapFeedItemToEvent(PRESS_CLUB_FEED_ITEM, PRESS_CLUB_SOURCE);
  assert(
    event.allDay === false,
    `Expected allDay=false, got ${event.allDay}`
  );
});

test("11. isFree defaults to false (RSS items don't indicate price)", () => {
  const event = mapFeedItemToEvent(PRESS_CLUB_FEED_ITEM, PRESS_CLUB_SOURCE);
  assert(
    event.isFree === false,
    `Expected isFree=false as default, got ${event.isFree}`
  );
});

test("12. status defaults to 'scheduled'", () => {
  const event = mapFeedItemToEvent(PRESS_CLUB_FEED_ITEM, PRESS_CLUB_SOURCE);
  assert(
    event.status === "scheduled",
    `Expected status "scheduled", got "${event.status}"`
  );
});

test("13. sourceUrl falls back to source.url when FeedItem.url is empty", () => {
  const event = mapFeedItemToEvent(NO_URL_FEED_ITEM, PRESS_CLUB_SOURCE);
  assert(
    event.sourceUrl === PRESS_CLUB_SOURCE.url,
    `Expected source.url fallback "${PRESS_CLUB_SOURCE.url}", got "${event.sourceUrl}"`
  );
});

test("14. sources[0].url is FeedItem.url (or source.url as fallback)", () => {
  const event = mapFeedItemToEvent(PRESS_CLUB_FEED_ITEM, PRESS_CLUB_SOURCE);
  assert(
    event.sources[0].url === PRESS_CLUB_FEED_ITEM.url,
    `Expected sources[0].url = "${PRESS_CLUB_FEED_ITEM.url}", got "${event.sources[0].url}"`
  );
});

test("15. Two different feed items produce different ids", () => {
  const event1 = mapFeedItemToEvent(PRESS_CLUB_FEED_ITEM, PRESS_CLUB_SOURCE);
  const event2 = mapFeedItemToEvent(NO_URL_FEED_ITEM, PRESS_CLUB_SOURCE);
  assert(
    event1.id !== event2.id,
    `Different items must not produce the same id: both got "${event1.id}"`
  );
});

// ============================================================================
// SD Reader-style fixtures
// ============================================================================

/**
 * EventSource for the San Diego Reader RSS feed.
 */
const READER_SOURCE: EventSource = {
  id: "sd-reader-events",
  name: "San Diego Reader Events",
  url: "https://www.sandiegoreader.com/rss/events/",
  fetchTier: "rss",
  categoryHint: "community",
  pollInterval: 720,
  enabled: true,
};

/**
 * FeedItem simulating what RSSParser produces for a San Diego Reader event item.
 * - No pubDate → publishedAt = "now" (we simulate with a fixed "today" stamp)
 * - body contains the structured When:/Where:/Cost: labels after stripHtml
 * - title has the weekday/date prefix "Mon 6/1: ..."
 */
const READER_FEED_ITEM_PAID: FeedItem = {
  title: "Mon 6/1: Musical Theater Summer Camps",
  url: "https://www.sandiegoreader.com/events/2026/jun/1/musical-theater-summer-camps/",
  author: "sandiegoreader",
  // Simulates publishedAt = "now" (what RSSParser sets when pubDate is absent)
  publishedAt: new Date().toISOString(),
  body: "When: Monday, June 1, 2026, 8:30 a.m. to 3:30 p.m. Where: Theatre for Young Professionals, 7960 University Avenue Suite 240, San Diego Cost: $250 - $450 Age limit: All ages Description: Musical theater workshops for children ages 8-18.",
  tags: ["theater", "community"],
};

/**
 * Press Club item — NO "When:" in body — must be byte-for-byte unchanged by enrichment.
 * We reuse PRESS_CLUB_FEED_ITEM / PRESS_CLUB_SOURCE defined above.
 */

// ============================================================================
// Reader enrichment — deterministic pieces
//
// Extraction itself is model-delegated (extractReaderEnrichments → inference
// with a JSON schema; see the markdown-regex remediation note in RSSAdapter).
// The old parseReaderDescription regex tests died with the parser — measured
// live 2026-08-01, it missed 100% of start times after the feed's prose
// drifted to abbreviated months ("Aug. 1"). What stays deterministic and
// hermetically tested: enrichmentFromModelRow (structural validation + LA
// offset conversion) and the enrichment merge in mapFeedItemToEvent.
// ============================================================================

import { enrichmentFromModelRow } from "../Tools/adapters/RSSAdapter.ts";
import type { ReaderDescriptionFields } from "../Tools/adapters/RSSAdapter.ts";

console.log("\n--- Reader enrichment validation tests ---\n");

/** A well-formed model row mirroring READER_FEED_ITEM_PAID's body. */
const MODEL_ROW_PAID = {
  index: 0,
  title: "Musical Theater Summer Camps",
  startDatetime: "2026-06-01T08:30",
  endDatetime: "2026-06-01T15:30",
  venue: "Theatre for Young Professionals",
  address: "Theatre for Young Professionals, 7960 University Avenue Suite 240, San Diego",
  priceMin: 250,
  priceMax: 450,
  isFree: false,
};

test("16. enrichmentFromModelRow converts naive start to LA offset ISO (PDT, hour 08)", () => {
  const v = enrichmentFromModelRow(MODEL_ROW_PAID, 1);
  assert(v !== null, "row should validate");
  assert(
    v!.fields.startDatetime !== undefined && v!.fields.startDatetime.includes("2026-06-01"),
    `startDatetime "${v!.fields.startDatetime}" should contain "2026-06-01"`
  );
  assert(
    v!.fields.startDatetime!.includes("-07:00"),
    `startDatetime "${v!.fields.startDatetime}" should carry the -07:00 PDT offset`
  );
  assert(
    v!.fields.startDatetime!.includes("T08:30"),
    `startDatetime "${v!.fields.startDatetime}" should keep local wall-clock 08:30`
  );
});

test("17. enrichmentFromModelRow converts end time (15:30 local)", () => {
  const v = enrichmentFromModelRow(MODEL_ROW_PAID, 1);
  assert(
    v!.fields.endDatetime !== undefined && v!.fields.endDatetime.includes("T15:30"),
    `endDatetime "${v!.fields.endDatetime}" should contain "T15:30"`
  );
});

test("18. enrichmentFromModelRow passes venue/address/prices through", () => {
  const v = enrichmentFromModelRow(MODEL_ROW_PAID, 1);
  assert(v!.fields.venue === "Theatre for Young Professionals", `venue: "${v!.fields.venue}"`);
  assert(
    v!.fields.address !== undefined && v!.fields.address.includes("7960 University Avenue"),
    `address: "${v!.fields.address}"`
  );
  assert(v!.fields.priceMin === 250 && v!.fields.priceMax === 450, "prices should pass through");
  assert(v!.fields.isFree === false, "isFree should be false");
});

test("19. enrichmentFromModelRow: null datetimes stay absent (no fabricated times)", () => {
  const v = enrichmentFromModelRow(
    { ...MODEL_ROW_PAID, startDatetime: null, endDatetime: null },
    1
  );
  assert(v !== null, "row should still validate");
  assert(v!.fields.startDatetime === undefined, "no startDatetime should be set");
  assert(v!.fields.endDatetime === undefined, "no endDatetime should be set");
});

test("20. enrichmentFromModelRow: malformed datetime drops the field, keeps the row", () => {
  const v = enrichmentFromModelRow(
    { ...MODEL_ROW_PAID, startDatetime: "next Saturday at 8" },
    1
  );
  assert(v !== null, "row should survive a malformed datetime");
  assert(v!.fields.startDatetime === undefined, "malformed start must be dropped");
  assert(v!.fields.venue === "Theatre for Young Professionals", "other fields keep flowing");
});

test("21. enrichmentFromModelRow: out-of-bounds index is rejected", () => {
  assert(enrichmentFromModelRow({ ...MODEL_ROW_PAID, index: 5 }, 1) === null, "index 5 of 1 must be rejected");
  assert(enrichmentFromModelRow({ ...MODEL_ROW_PAID, index: -1 }, 1) === null, "negative index must be rejected");
});

test("22. enrichmentFromModelRow: empty title is rejected", () => {
  assert(enrichmentFromModelRow({ ...MODEL_ROW_PAID, title: "  " }, 1) === null, "blank title must be rejected");
});

test("23. enrichmentFromModelRow: free event (isFree, priceMin 0)", () => {
  const v = enrichmentFromModelRow(
    { ...MODEL_ROW_PAID, priceMin: 0, priceMax: null, isFree: true },
    1
  );
  assert(v!.fields.isFree === true, "isFree should be true");
  assert(v!.fields.priceMin === 0, `priceMin should be 0, got ${v!.fields.priceMin}`);
  assert(v!.fields.priceMax === undefined, "priceMax should be absent");
});

// ============================================================================
// mapFeedItemToEvent integration tests for enriched Reader items
// ============================================================================

console.log("\n--- SD Reader mapFeedItemToEvent Integration Tests ---\n");

/** Enrichment as extractReaderEnrichments would deliver it for the paid item. */
const PAID_ENRICHMENT: ReaderDescriptionFields =
  enrichmentFromModelRow(MODEL_ROW_PAID, 1)!.fields;

test("24. Enriched item: startDatetime comes from the enrichment (NOT publishedAt)", () => {
  const event = mapFeedItemToEvent(READER_FEED_ITEM_PAID, READER_SOURCE, PAID_ENRICHMENT);
  assert(
    event.startDatetime.includes("2026-06-01"),
    `startDatetime "${event.startDatetime}" must contain "2026-06-01", not today`
  );
  assert(
    !event.startDatetime.endsWith("Z"),
    `startDatetime "${event.startDatetime}" should not be a UTC "Z" timestamp (publishedAt passthrough)`
  );
});

test("25. Enriched item: title comes from the enrichment (prefix stripped)", () => {
  const event = mapFeedItemToEvent(READER_FEED_ITEM_PAID, READER_SOURCE, PAID_ENRICHMENT);
  assert(
    event.title === "Musical Theater Summer Camps",
    `Expected cleaned title, got "${event.title}"`
  );
});

test("26. Enriched item: venue is set", () => {
  const event = mapFeedItemToEvent(READER_FEED_ITEM_PAID, READER_SOURCE, PAID_ENRICHMENT);
  assert(
    event.venue === "Theatre for Young Professionals",
    `Expected venue to be set, got "${event.venue}"`
  );
});

test("27. Enriched item: priceMin/priceMax are set", () => {
  const event = mapFeedItemToEvent(READER_FEED_ITEM_PAID, READER_SOURCE, PAID_ENRICHMENT);
  assert(event.priceMin === 250, `Expected priceMin=250, got ${event.priceMin}`);
  assert(event.priceMax === 450, `Expected priceMax=450, got ${event.priceMax}`);
});

test("28. Reader item WITHOUT enrichment falls back to standard RSS mapping", () => {
  // Extraction failed / unavailable → raw title + publish date, never a guess.
  const event = mapFeedItemToEvent(READER_FEED_ITEM_PAID, READER_SOURCE);
  assert(
    event.title === READER_FEED_ITEM_PAID.title,
    `Expected raw title fallback, got "${event.title}"`
  );
  assert(
    event.startDatetime === READER_FEED_ITEM_PAID.publishedAt,
    `Expected publishedAt fallback, got "${event.startDatetime}"`
  );
});

test("29. Press Club item (no 'When:') — startDatetime == publishedAt unchanged", () => {
  const event = mapFeedItemToEvent(PRESS_CLUB_FEED_ITEM, PRESS_CLUB_SOURCE);
  // The press club item has no "When:" in its body — should be unaffected
  assert(
    event.startDatetime === PRESS_CLUB_FEED_ITEM.publishedAt,
    `Expected startDatetime to equal publishedAt "${PRESS_CLUB_FEED_ITEM.publishedAt}", got "${event.startDatetime}"`
  );
});

test("30. Press Club item (no 'When:') — title unchanged", () => {
  const event = mapFeedItemToEvent(PRESS_CLUB_FEED_ITEM, PRESS_CLUB_SOURCE);
  assert(
    event.title === PRESS_CLUB_FEED_ITEM.title,
    `Expected title to be unchanged "${PRESS_CLUB_FEED_ITEM.title}", got "${event.title}"`
  );
});

test("31. Press Club item (no 'When:') — venue is undefined", () => {
  const event = mapFeedItemToEvent(PRESS_CLUB_FEED_ITEM, PRESS_CLUB_SOURCE);
  assert(
    event.venue === undefined,
    `Expected venue=undefined for press club item, got "${event.venue}"`
  );
});

