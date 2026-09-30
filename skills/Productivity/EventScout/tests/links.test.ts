#!/usr/bin/env bun
/**
 * links.test.ts — bestLink resolution (navigable ticket/source URL vs. search
 * fallback for machine feeds like the ICS aggregator).
 *
 * Run: bun test ~/.claude/.claude/worktrees/arch-debt-d2-eventscout-buntest/skills/Productivity/EventScout/tests/links.test.ts
 */

import { test } from "bun:test";
import { bestLink, searchFallbackUrl } from "../Tools/lib/links.ts";
import type { EventItem } from "../Tools/types.ts";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

function ev(partial: Partial<EventItem>): EventItem {
  return {
    id: "x", title: "Open Vinyl Night", startDatetime: "2026-06-05T19:00:00-07:00",
    allDay: false, venue: "Some Bar", category: "music", tags: [], isFree: false,
    sourceUrl: "https://example.com", sources: [], fetchedAt: "2026-06-04T00:00:00Z",
    status: "scheduled", ...partial,
  };
}

/** Shared ICS aggregator-feed fixture for the section-3 tests below. */
function icsFixture(): { e: EventItem; link: string } {
  const ics = "https://calendar.google.com/calendar/ical/32abf07c%40group.calendar.google.com/public/basic.ics";
  const e = ev({ ticketUrl: undefined, sourceUrl: ics });
  const link = bestLink(e);
  return { e, link };
}

// 1. ticketUrl wins when navigable
test("navigable ticketUrl is preferred", () => {
  assert(
    bestLink(ev({ ticketUrl: "https://www.eventbrite.com/e/salsa-123", sourceUrl: "https://www.eventbrite.com/d/ca--san-diego/all-events/" }))
      === "https://www.eventbrite.com/e/salsa-123",
    "navigable ticketUrl is preferred"
  );
});

// 2. falls back to sourceUrl when no ticketUrl
test("navigable sourceUrl used when ticketUrl absent", () => {
  assert(
    bestLink(ev({ ticketUrl: undefined, sourceUrl: "https://www.sandiegoreader.com/events/2026/jun/05/foo/" }))
      === "https://www.sandiegoreader.com/events/2026/jun/05/foo/",
    "navigable sourceUrl used when ticketUrl absent"
  );
});

// 3. ICS aggregator feed → search fallback, NOT the ical blob
test("non-navigable ICS feed is NOT returned", () => {
  const { link } = icsFixture();
  assert(!link.includes("ical"), "non-navigable ICS feed is NOT returned");
});

test("ICS feed falls back to a Google search", () => {
  const { link } = icsFixture();
  assert(link.startsWith("https://www.google.com/search?q="), "falls back to a Google search");
});

test("ICS feed fallback matches searchFallbackUrl()", () => {
  const { e, link } = icsFixture();
  assert(link === searchFallbackUrl(e), "fallback matches searchFallbackUrl()");
});

test("ICS feed search query includes the event title", () => {
  const { link } = icsFixture();
  assert(decodeURIComponent(link).includes("Open Vinyl Night"), "search query includes the event title");
});

// 4. statsapi / xml feeds are also treated as non-navigable
test("statsapi ticketUrl falls back to search", () => {
  assert(
    bestLink(ev({ ticketUrl: "https://statsapi.mlb.com/api/v1/schedule?gamePk=1", sourceUrl: undefined as unknown as string }))
      .startsWith("https://www.google.com/search?q="),
    "statsapi ticketUrl falls back to search"
  );
});
