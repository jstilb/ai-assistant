/**
 * weekenddigest.test.ts — WeekendDigest pure helpers (no network, no alerts).
 *
 * Run: bun test skills/Productivity/EventScout/tests/weekenddigest.test.ts
 */

import { describe, test, expect } from "bun:test";
import { upcomingWeekend, renderWeekendDigest, weeknightDays, weeknightPool } from "../Tools/WeekendDigest.ts";
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

  test("a Friday-night event in the window reads Fri, not Sun (review 1, 2026-11-08)", () => {
    const fri = ranked({ title: "Fridays Salsa", startDatetime: "2026-08-21T20:30:00-07:00", venue: "Tango Del Rey" });
    expect(renderWeekendDigest([fri], "2026-08-22", "2026-08-23")).toContain("• Fri 8:30pm — Fridays Salsa");
  });

  test("caps at top 10 but reports the full count", () => {
    const many = Array.from({ length: 25 }, (_, i) => ranked({ title: `E${i}` }));
    const bigMd = renderWeekendDigest(many, "2026-08-22", "2026-08-23");
    expect(bigMd).toContain("(25 matches)");
    expect(bigMd.split("\n").filter((l) => l.startsWith("•")).length).toBe(10);
  });

  test("footer hands the agent the exact follow-up query window", () => {
    expect(md).toContain("--from 2026-08-22 --to 2026-08-23");
  });
});

describe("weeknights (review 1, 2026-11-08)", () => {
  test("a Thursday run plans this Friday and next Monday–Thursday", () => {
    expect(weeknightDays("2026-11-14", "2026-11-15")).toEqual([
      "2026-11-13",
      "2026-11-16",
      "2026-11-17",
      "2026-11-18",
      "2026-11-19",
    ]);
  });

  test("the pool keeps only evening events of a recurring series of the whole cache", () => {
    const days = weeknightDays("2026-11-14", "2026-11-15");
    const club = ranked({ id: "c1", title: "Run Club", venue: "Pier", startDatetime: "2026-11-17T18:30:00-08:00" });
    const later = { ...club, id: "c2", startDatetime: "2026-11-24T18:30:00-08:00" }; // outside the window
    const lunch = ranked({ id: "l1", title: "Lunch Yoga", venue: "Studio", startDatetime: "2026-11-17T12:00:00-08:00" });
    const lunch2 = { ...lunch, id: "l2", startDatetime: "2026-11-24T12:00:00-08:00" };
    const oneOff = ranked({ id: "o1", title: "Concert", venue: "Hall", startDatetime: "2026-11-18T19:00:00-08:00" });
    const sat = ranked({ id: "s1", title: "Saturday Social", venue: "Bar", startDatetime: "2026-11-14T18:30:00-08:00" });
    const sat2 = { ...sat, id: "s2", startDatetime: "2026-11-21T18:30:00-08:00" };
    const inWindow = [club, lunch, oneOff, sat];
    const pool = weeknightPool(inWindow, days, [...inWindow, later, lunch2, sat2]);
    expect(pool.map((e) => e.id)).toEqual(["c1"]);
  });
});
