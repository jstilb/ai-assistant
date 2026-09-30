/**
 * weekenddigest.test.ts — WeekendDigest pure helpers (no network, no alerts).
 *
 * Run: bun test ~/.claude/skills/Productivity/EventScout/tests/weekenddigest.test.ts
 */

import { describe, test, expect } from "bun:test";
import { upcomingWeekend, renderWeekendDigest } from "../Tools/WeekendDigest.ts";
import type { RankedEvent } from "../Tools/Ranker.ts";

function ranked(overrides: Partial<RankedEvent>): RankedEvent {
  return {
    id: "x",
    title: "Test Event",
    startDatetime: "2026-08-22T20:00:00-07:00",
    allDay: false,
    category: "music",
    tags: [],
    isFree: false,
    sourceUrl: "https://example.com",
    sources: [{ sourceId: "s", url: "https://example.com" }],
    fetchedAt: "2026-08-20T00:00:00.000Z",
    status: "scheduled",
    score: 90,
    why: "fits",
    ...overrides,
  };
}

describe("upcomingWeekend", () => {
  test("Friday → next-day Saturday", () => {
    // 2026-08-21 is a Friday (noon LA = 19:00 UTC).
    expect(upcomingWeekend(new Date("2026-08-21T19:00:00Z"))).toEqual({
      satIso: "2026-08-22",
      sunIso: "2026-08-23",
    });
  });
  test("Saturday → the current weekend, not next week's", () => {
    expect(upcomingWeekend(new Date("2026-08-22T19:00:00Z"))).toEqual({
      satIso: "2026-08-22",
      sunIso: "2026-08-23",
    });
  });
  test("Monday → the coming Saturday", () => {
    expect(upcomingWeekend(new Date("2026-08-17T19:00:00Z"))).toEqual({
      satIso: "2026-08-22",
      sunIso: "2026-08-23",
    });
  });
  test("LA/UTC boundary: late Friday evening LA is already Saturday UTC", () => {
    // 2026-08-21 22:00 LA = 2026-08-22 05:00 UTC — must still resolve as Friday LA.
    expect(upcomingWeekend(new Date("2026-08-22T05:00:00Z")).satIso).toBe("2026-08-22");
  });
});

describe("renderWeekendDigest", () => {
  const events = [
    ranked({ title: "Salsa Social", venue: "Tango Del Rey", priceMin: 15 }),
    ranked({
      title: "Free Beach Concert",
      startDatetime: "2026-08-23T14:00:00-07:00",
      venue: "OB Pier",
      isFree: true,
    }),
    ranked({ title: "Range Show", priceMin: 20, priceMax: 35 }),
  ];
  const md = renderWeekendDigest(events, "2026-08-22", "2026-08-23");

  test("header names both days and the match count", () => {
    expect(md).toContain("Sat, Aug 22");
    expect(md).toContain("Sun, Aug 23");
    expect(md).toContain("(3 matches)");
  });

  test("lines carry day, time, venue, and price labels", () => {
    expect(md).toContain("• Sat 8pm — Salsa Social · Tango Del Rey · $15+");
    expect(md).toContain("• Sun 2pm — Free Beach Concert · OB Pier · free");
    expect(md).toContain("$20–35");
  });

  test("caps at top 10 but reports the full count", () => {
    const many = Array.from({ length: 25 }, (_, i) => ranked({ title: `E${i}` }));
    const bigMd = renderWeekendDigest(many, "2026-08-22", "2026-08-23");
    expect(bigMd).toContain("(25 matches)");
    expect(bigMd.split("\n").filter((l) => l.startsWith("•")).length).toBe(10);
  });

  test("footer hands the agent the exact follow-up query window", () => {
    expect(md).toContain('--from 2026-08-22 --to 2026-08-23');
  });
});
