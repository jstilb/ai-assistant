#!/usr/bin/env bun
/**
 * pagination-chunk.test.ts — unit tests for the pure helpers that back
 * Eventbrite pagination and multi-window LLM extraction (SPAAdapter).
 *
 * Tests ONLY deterministic pure functions:
 *   - chunkContent  (content windowing for LLM extraction)
 *   - buildPageUrl  (paginated URL construction)
 *   - dedupById     (stable-id dedup of accumulated events)
 *
 * Run:
 *   bun test ~/.claude/.claude/worktrees/arch-debt-d2-eventscout-buntest/skills/Productivity/EventScout/tests/pagination-chunk.test.ts
 */

import { test } from "bun:test";
import { chunkContent, buildPageUrl, dedupById, trimToContentStart } from "../Tools/adapters/SPAAdapter.ts";
import type { EventItem } from "../Tools/types.ts";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}
function assertEq<T>(actual: T, expected: T, msg: string): void {
  if (actual !== expected) {
    throw new Error(
      `Assertion failed: ${msg} — expected: ${JSON.stringify(expected)}, actual: ${JSON.stringify(actual)}`
    );
  }
}

// ── chunkContent ──────────────────────────────────────────────────────────

test("chunkContent: content <= chunkSize → exactly 1 window", () => {
  const short = "x".repeat(1000);
  const c1 = chunkContent(short, 40_000, 4, 2_000);
  assertEq(c1.length, 1, "content <= chunkSize → exactly 1 window");
  assertEq(c1[0], short, "single window equals full content (== old slice behaviour)");
});

test("chunkContent: content == chunkSize → 1 window", () => {
  const exact = "y".repeat(40_000);
  assertEq(chunkContent(exact, 40_000, 4, 2_000).length, 1, "content == chunkSize → 1 window");
});

test("chunkContent: large content → multiple windows, capped at maxChunks", () => {
  const big = "z".repeat(200_000);
  const cBig = chunkContent(big, 40_000, 4, 2_000);
  assertEq(cBig.length, 4, "200k content with maxChunks=4 → capped at 4 windows");
  assertEq(cBig[0]!.length, 40_000, "each window is chunkSize wide");

  // First window is the same first-40k slice the old code used (superset proof).
  assertEq(cBig[0], big.slice(0, 40_000), "window 0 == content.slice(0,40000)");

  // Overlap: window 1 starts at chunkSize - overlap = 38_000.
  assertEq(cBig[1], big.slice(38_000, 78_000), "window 1 starts at (chunkSize - overlap)");

  // Windows collectively reach further than a single 40k slice.
  assert(cBig.length * 1 > 1, "large content yields more coverage than a single window");
});

// ── buildPageUrl ──────────────────────────────────────────────────────────

test("buildPageUrl: appends ?page=2 to a param-less URL", () => {
  assertEq(
    buildPageUrl("https://www.eventbrite.com/d/ca--san-diego/all-events/", "page", 2),
    "https://www.eventbrite.com/d/ca--san-diego/all-events/?page=2",
    "appends ?page=2 to a param-less URL",
  );
});

test("buildPageUrl: overwrites existing page param, keeps other params", () => {
  assertEq(
    buildPageUrl("https://ex.com/e?cat=music&page=1", "page", 3),
    "https://ex.com/e?cat=music&page=3",
    "overwrites existing page param, keeps other params",
  );
});

// ── dedupById ─────────────────────────────────────────────────────────────

test("dedupById: 4 events with one dupe id → 3 unique, first-seen order", () => {
  const mk = (id: string, title: string): EventItem => ({
    id, title, startDatetime: "2026-06-06T19:00:00-07:00", allDay: false,
    category: "music", tags: [], isFree: false,
    sourceUrl: "https://ex.com", sources: [{ sourceId: "s", url: "https://ex.com" }],
    fetchedAt: "2026-06-01T00:00:00.000Z", status: "scheduled",
  });
  const out = dedupById([mk("a", "A"), mk("b", "B"), mk("a", "A-dupe"), mk("c", "C")]);
  assertEq(out.length, 3, "4 events with one dupe id → 3 unique");
  assertEq(out[0]!.title, "A", "keeps first occurrence of a duplicated id");
  assertEq(out.map((e) => e.id).join(","), "a,b,c", "preserves first-seen order");
});

test("dedupById: empty input → empty output", () => {
  assertEq(dedupById([]).length, 0, "empty input → empty output");
});

// ── trimToContentStart ────────────────────────────────────────────────────

// Constants mirrored from SPAAdapter (must match).
const CHUNK_SIZE = 40_000;

test("trimToContentStart 4a: small page (<40 KB) with deep marker → returned unchanged", () => {
  // Even if there's a repeated deep-link cluster, the safety gate requires the
  // cluster to start AFTER the first window (> CHUNK_SIZE). A 30 KB page is
  // trivially within one window so must come back identical.
  const smallLinks: string[] = [];
  for (let i = 0; i < 10; i++) {
    smallLinks.push(`<a href="/events/2026/06/${String(i + 1).padStart(2, "0")}/slug-${i}">Event ${i}</a>`);
  }
  const smallContent = "x".repeat(1_000) + smallLinks.join("") + "x".repeat(1_000);
  // Sanity: confirm it's less than CHUNK_SIZE.
  assert(smallContent.length < CHUNK_SIZE, "4a fixture is < 40 KB (test pre-condition)");
  const resultSmall = trimToContentStart(smallContent);
  assert(resultSmall === smallContent, "4a: small page (<40 KB) → returned unchanged");
});

test("trimToContentStart 4b: large page — boilerplate prefix, then deep event links", () => {
  // Layout:
  //   [50 KB of nav boilerplate (no event links)]
  //   [10 event detail links at /events/2026/06/XX/slug-X]
  //   [more filler to push total > 154 KB]
  // Expected: trimmed result starts at/just before the first event link;
  //           the first event link falls within the first 40 KB of the trimmed result.
  const boilerplate = "<div>nav</div>".repeat(Math.ceil(50_000 / "<div>nav</div>".length));
  // Pad/trim exactly to 50 000 chars.
  const prefix = boilerplate.slice(0, 50_000);
  assert(prefix.length === 50_000, "4b fixture: prefix is exactly 50 000 chars");

  const eventLinks: string[] = [];
  for (let i = 0; i < 10; i++) {
    eventLinks.push(
      `<a href="https://x.org/events/2026/06/${String(i + 1).padStart(2, "0")}/slug-${i}">Event ${i}</a>`
    );
  }
  const eventBlock = eventLinks.join("\n");
  // firstEventLinkText will appear in the trimmed result within the first window.
  const firstEventLinkText = eventLinks[0]!;

  // Filler to push total beyond 154 KB.
  const fillerNeeded = Math.max(0, 160_000 - prefix.length - eventBlock.length);
  const filler = "<div>footer</div>".repeat(Math.ceil(fillerNeeded / "<div>footer</div>".length)).slice(0, fillerNeeded);

  const bigContent = prefix + eventBlock + filler;
  assert(bigContent.length > 154_000, "4b fixture: total content > 154 KB (test pre-condition)");

  const resultBig = trimToContentStart(bigContent);
  assert(resultBig.length < bigContent.length, "4b: large page with deep event links → result is shorter than input");
  assert(
    resultBig.includes(firstEventLinkText),
    "4b: trimmed result contains the first event link"
  );
  // The first event link must be reachable within the first 40 KB of the trimmed result.
  const positionInTrimmed = resultBig.indexOf(firstEventLinkText);
  assert(positionInTrimmed !== -1, "4b: first event link found in trimmed result");
  assert(
    positionInTrimmed < CHUNK_SIZE,
    `4b: first event link is within the first ${CHUNK_SIZE} chars of the trimmed result (position: ${positionInTrimmed})`
  );
  // The boilerplate-only prefix must be gone from the start.
  assert(
    !resultBig.startsWith(prefix),
    "4b: boilerplate prefix is removed from the start of the trimmed result"
  );
});

test("trimToContentStart 4c: repeated links at ~10 KB (<= 40 KB) → UNCHANGED", () => {
  // Safety gate requires startOffset > CHUNK_SIZE; a shallow cluster must not
  // cause trimming.
  const shallowLinks: string[] = [];
  for (let i = 0; i < 10; i++) {
    shallowLinks.push(`<a href="/events/2026/06/${String(i + 1).padStart(2, "0")}/slug-${i}">E${i}</a>`);
  }
  // Put the cluster at ~10 KB, then pad to > 154 KB.
  const shallowPrefix = "p".repeat(10_000);
  const shallowFiller = "q".repeat(150_000);
  const shallowContent = shallowPrefix + shallowLinks.join("") + shallowFiller;
  assert(shallowContent.length > 154_000, "4c fixture: total content > 154 KB (test pre-condition)");
  const resultShallow = trimToContentStart(shallowContent);
  assert(
    resultShallow === shallowContent,
    "4c: repeated links at ~10 KB (< CHUNK_SIZE) → returned unchanged (safety gate)"
  );
});

test("trimToContentStart 4d: no repeated deep-link cluster, no ld+json → UNCHANGED", () => {
  const noLinksContent = "<div>plain content without any event links</div>".repeat(4_000);
  assert(noLinksContent.length > 154_000, "4d fixture: total content > 154 KB (test pre-condition)");
  const resultNoLinks = trimToContentStart(noLinksContent);
  assert(
    resultNoLinks === noLinksContent,
    "4d: no repeated deep-link cluster, no ld+json → returned unchanged"
  );
});

test("trimToContentStart 4e: KPBS regression — high-count NAV link must NOT outvote the deep DETAIL cluster", () => {
  // nav "/events/all" repeated 300× near byte 0 (no digit segment) competes
  // with "/events/2026/MM/DD/slug" detail links starting past byte 40 KB
  // (digit-collapsed). Winner must be the detail cluster, so the page IS
  // trimmed to the deep event region — not returned whole.
  const navBlock = `<a href="/events/all">All Events</a>`.repeat(300); // ~byte 0, no '#'
  const navPad = "z".repeat(45_000); // push the detail cluster past CHUNK_SIZE
  const detailLinks: string[] = [];
  for (let i = 0; i < 20; i++) {
    detailLinks.push(
      `<a href="https://x.org/events/2026/06/${String((i % 28) + 1).padStart(2, "0")}/slug-${i}">E${i}</a>`
    );
  }
  const firstDetail = detailLinks[0]!;
  const kpbsLike = navBlock + navPad + detailLinks.join("\n") + "w".repeat(120_000);
  assert(kpbsLike.length > 154_000, "4e fixture: total content > 154 KB (test pre-condition)");
  const resultKpbs = trimToContentStart(kpbsLike);
  assert(
    resultKpbs.length < kpbsLike.length,
    "4e: high-count nav link does NOT block trim — deep detail cluster wins"
  );
  const detailPos = resultKpbs.indexOf(firstDetail);
  assert(detailPos !== -1 && detailPos < CHUNK_SIZE,
    `4e: first detail link is within the first ${CHUNK_SIZE} chars of trimmed result (pos: ${detailPos})`);
  assert(
    !resultKpbs.includes(`href="/events/all"`),
    "4e: the byte-~0 nav-link prefix is removed (all 300 nav links trimmed away)"
  );
});
