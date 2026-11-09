/**
 * nineteenhz.test.ts — NineteenHzAdapter pure-parser tests.
 *
 * Fixture mirrors the live page's quirks exactly: one-line rows, UNCLOSED td
 * in the event cell, dated 7-cell rows (shrink-div date) + recurring 6-cell
 * rows, SoCal-wide cities.
 *
 * Run: bun test skills/Productivity/EventScout/tests/nineteenhz.test.ts
 */

import { describe, test, expect } from "bun:test";
import { filterEvents } from "../Tools/Filter.ts";
import { EventItemSchema } from "../Tools/types.ts";
import { renderTiered } from "../Tools/Render.ts";
import {
  parseRows,
  parseTimeRange,
  parsePriceAge,
  parseEventCell,
  isSanDiegoCity,
  nextOccurrenceDate,
  mapRowToItem,
  projectNineteenHzOccurrences,
} from "../Tools/adapters/NineteenHzAdapter.ts";
import { defined } from "../../../../lib/test/defined.ts";

const PAGE_URL = "https://19hz.info/eventlisting_LosAngeles.php";
const TODAY = "2026-08-20"; // a Thursday

const FIXTURE = `
<table><thead><tr><th>Date</th><th>Event</th></tr></thead><tbody>
<tr><td>Fri: Aug 21 <br />(9pm-2am)</td><td><a href='https://tickets.example/a'>Nitefreak</a> @ Spin Nightclub (San Diego)<td>afro house</td><td>$15-25 | 21+</td><td></td><td></td><td><div class='shrink'>2026/08/21</div></td></tr>
<tr><td>Fri: Aug 21 <br />(8pm)</td><td><a href='https://tickets.example/b'>Maddix</a> @ Hollywood Palladium (Los Angeles)<td>big room house</td><td>$48-103 | 18+</td><td></td><td></td><td><div class='shrink'>2026/08/21</div></td></tr>
<tr><td>Sat: Aug 22 <br />(10pm)</td><td>Warehouse TBA @ TBA (San Diego)<td>techno</td><td>Free b4 11pm | 21+</td><td>Collective X</td><td></td><td><div class='shrink'>2026/08/22</div></td></tr>
</tbody></table>
<table><tbody>
<tr class='even'><td>Mondays <br />(8pm-1:30am)</td><td><a href='https://tickets.example/c'>Blue Monday</a> @ Eq (San Diego)<td>synthpop, goth</td><td>Free | 21+</td><td></td><td></td></tr>
<tr><td>2nd Saturdays (9pm-2am)</td><td><a href='https://tickets.example/d'>Club Sabbat</a> @ Eq (San Diego)<td>goth, industrial</td><td>$10 | 21+</td><td></td><td></td></tr>
</tbody></table>
`;

describe("parseRows", () => {
  test("parses dated (7-cell) and recurring (6-cell) rows, skips headers", () => {
    const rows = parseRows(FIXTURE);
    expect(rows.length).toBe(5);
    expect(rows.filter((r) => r.date != null).length).toBe(3);
    expect(rows.filter((r) => r.date == null).length).toBe(2);
    expect(defined(rows[0]).date).toBe("2026-08-21");
    expect(defined(rows[0]).genres).toBe("afro house");
  });
});

describe("parseTimeRange", () => {
  test("range with minutes", () => {
    expect(parseTimeRange("Mondays <br />(8pm-1:30am)")).toEqual({
      start: { hour: 20, minute: 0 },
      end: { hour: 1, minute: 30 },
    });
  });
  test("single time", () => {
    expect(parseTimeRange("Fri: Aug 21 <br />(8pm)")).toEqual({ start: { hour: 20, minute: 0 } });
  });
  test("noon/midnight boundaries", () => {
    expect(parseTimeRange("(12pm-12am)")).toEqual({
      start: { hour: 12, minute: 0 },
      end: { hour: 0, minute: 0 },
    });
  });
  test("no parens → null", () => {
    expect(parseTimeRange("Fri: Aug 21")).toBeNull();
  });
});

describe("parsePriceAge", () => {
  test("single price + age", () => {
    expect(parsePriceAge("$21 | 18+")).toEqual({ isFree: false, priceMin: 21, ageTag: "18+" });
  });
  test("price range", () => {
    expect(parsePriceAge("$48-103 | 18+")).toEqual({
      isFree: false,
      priceMin: 48,
      priceMax: 103,
      ageTag: "18+",
    });
  });
  test("only unconditional free admission is free", () => {
    expect(parsePriceAge("Free | 21+").isFree).toBe(true);
    expect(parsePriceAge("Free b4 11pm | 21+")).toEqual({
      isFree: false, ageTag: "21+", admissionNote: "Free b4 11pm",
    });
  });
  test.each([
    ["free w/rsvp b4 10pm / $6.50", 6.5, undefined],
    ["free w/rsvp b4 11pm / $15-20", 15, 20],
    ["Free w/RSVP b4 9 / $5", 5, undefined],
    ["Free w/RSVP b4 10 / $5", 5, undefined],
  ])("preserves conditional source admission: %s", (admission, min, max) => {
    expect(parsePriceAge(`${admission} | 21+`)).toEqual({
      isFree: false, priceMin: min, ...(max === undefined ? {} : { priceMax: max }),
      ageTag: "21+", admissionNote: admission,
    });
  });
  test("age-only → unknown price, NOT free", () => {
    expect(parsePriceAge("21+")).toEqual({ isFree: false, ageTag: "21+" });
  });
});

describe("parseEventCell", () => {
  test("anchor + venue + city", () => {
    expect(parseEventCell("<a href='https://t.example/x'>Nitefreak</a> @ Spin Nightclub (San Diego)")).toEqual({
      title: "Nitefreak",
      url: "https://t.example/x",
      venue: "Spin Nightclub",
      city: "San Diego",
    });
  });
  test("no anchor (TBA row) still yields title/venue/city", () => {
    const cell = parseEventCell("Warehouse TBA @ TBA (San Diego)");
    expect(cell?.title).toBe("Warehouse TBA");
    expect(cell?.url).toBeNull();
    expect(cell?.city).toBe("San Diego");
  });
});

describe("isSanDiegoCity", () => {
  test("SD-county cities pass, LA cities don't", () => {
    expect(isSanDiegoCity("San Diego")).toBe(true);
    expect(isSanDiegoCity("Oceanside")).toBe(true);
    expect(isSanDiegoCity("Los Angeles")).toBe(false);
    expect(isSanDiegoCity("Long Beach/Los Angeles")).toBe(false);
  });
});

describe("nextOccurrenceDate", () => {
  test("plain weekday → next occurrence (today counts)", () => {
    expect(nextOccurrenceDate("Mondays (8pm)", TODAY)).toBe("2026-08-24");
    expect(nextOccurrenceDate("Thursdays (9pm)", TODAY)).toBe(TODAY);
  });
  test("ordinal already past this month rolls to next month", () => {
    // 2nd Saturday of Aug 2026 = Aug 8 (< Aug 20) → Sep 12.
    expect(nextOccurrenceDate("2nd Saturdays (9pm-2am)", TODAY)).toBe("2026-09-12");
  });
  test("ordinal still ahead this month stays in month", () => {
    // 4th Friday of Aug 2026 = Aug 28.
    expect(nextOccurrenceDate("4th Fridays", TODAY)).toBe("2026-08-28");
  });
  test("a missing fifth weekday can require a fourth month", () => {
    expect(nextOccurrenceDate("5th Saturdays", "2026-02-01")).toBe("2026-05-30");
  });
  test("unmodeled pattern → null", () => {
    expect(nextOccurrenceDate("Every full moon", TODAY)).toBeNull();
  });
});

describe("mapRowToItem", () => {
  const items = parseRows(FIXTURE)
    .map((r) => mapRowToItem(r, "19hz-socal", PAGE_URL, "2026-08-20T12:00:00.000Z", TODAY))
    .filter((i) => i != null);

  test("keeps only San Diego-area rows", () => {
    expect(items.length).toBe(4); // Maddix (Los Angeles) dropped
    expect(items.map((i) => i.title)).not.toContain("Maddix");
  });

  test("midnight-crossing end lands next day", () => {
    const nitefreak = items.find((i) => i.title === "Nitefreak")!;
    expect(nitefreak.startDatetime).toBe("2026-08-21T21:00:00-07:00");
    expect(nitefreak.endDatetime).toBe("2026-08-22T02:00:00-07:00");
    expect(nitefreak.priceMin).toBe(15);
    expect(nitefreak.priceMax).toBe(25);
    expect(nitefreak.tags).toContain("21+");
  });

  test("recurring weekly row dated to next occurrence with recurring tag", () => {
    const blueMonday = items.find((i) => i.title === "Blue Monday")!;
    expect(blueMonday.startDatetime).toBe("2026-08-24T20:00:00-07:00");
    expect(blueMonday.tags).toContain("recurring");
    expect(blueMonday.isFree).toBe(true);
    expect(blueMonday.description).toContain("Recurring: Mondays");
  });

  test("recurring ordinal row dated to next 2nd Saturday", () => {
    const sabbat = items.find((i) => i.title === "Club Sabbat")!;
    expect(sabbat.startDatetime.slice(0, 10)).toBe("2026-09-12");
  });

  test("anchorless row falls back to the page URL", () => {
    const tba = items.find((i) => i.title === "Warehouse TBA")!;
    expect(tba.ticketUrl).toBe(PAGE_URL);
    expect(tba.isFree).toBe(false);
    expect(tba.admissionNote).toBe("Free b4 11pm");
  });
});


test("conditional admission without a paid fallback preserves unknown price through schema, filter and render", () => {
  const row = defined(parseRows(FIXTURE).find(row => row.priceAge === "Free b4 11pm | 21+"), "19hz free-before-11pm row");
  const item = EventItemSchema.parse(mapRowToItem(row, "19hz-socal", PAGE_URL, "2026-08-20T12:00:00.000Z", TODAY));
  const context = {
    rawQuery: "events", window: { start: "2026-08-20T00:00:00-07:00", end: "2026-08-27T23:59:59-07:00" },
    home: { lat: 32.7, lng: -117.1 }, radiusMiles: 25,
  };
  expect(item.isFree).toBe(false);
  expect(item.priceMin).toBeUndefined();
  expect(item.priceMax).toBeUndefined();
  expect(item.admissionNote).toBe("Free b4 11pm");
  expect(filterEvents([item], context)).toEqual([item]);
  expect(filterEvents([item], { ...context, free: true })).toEqual([]);
  expect(filterEvents([item], { ...context, maxPrice: 100 })).toEqual([]);
  expect(renderTiered([{ ...item, score: 0, why: "Source listing" }], context))
    .toContain("- **Price:** Source admission: Free b4 11pm");
});


describe("source recurrence projections", () => {
  const recurring = (dayTime: string, today = "2026-11-04") => EventItemSchema.parse(mapRowToItem({
    dayTime, eventHtml: "<a href='https://example.com/weekly'>Weekly</a> @ Office Bar (San Diego)",
    genres: "house", priceAge: "Free w/RSVP b4 10 / $5 | 21+", organizer: "Collective", linksHtml: "", date: null,
  }, "19hz-socal", PAGE_URL, `${today}T12:00:00Z`, today));
  const context = (start: string, end: string) => ({ rawQuery: "events", window: { start, end },
    home: { lat: 32.7, lng: -117.1 }, radiusMiles: 25 });
  const query = (item: ReturnType<typeof recurring>, start: string, end: string) => {
    const c = context(start, end);
    return filterEvents(projectNineteenHzOccurrences([item], c.window), c);
  };

  test("weekly rule projects every requested date with stable identity and source facts", () => {
    const seed = recurring("Wednesdays (9pm-2am)");
    expect(seed.recurrenceRule).toBe("Wednesdays (9pm-2am)");
    const before = JSON.stringify(seed);
    const events = query(seed, "2026-11-04T00:00:00-08:00", "2026-11-11T23:59:59-08:00");
    expect(events.map(e => e.startDatetime)).toEqual(["2026-11-04T21:00:00-08:00", "2026-11-11T21:00:00-08:00"]);
    expect(events[0]).toEqual(seed);
    expect(defined(events[1]).endDatetime).toBe("2026-11-12T02:00:00-08:00");
    const nextSeed = recurring("Wednesdays (9pm-2am)", "2026-11-11");
    expect(defined(events[1]).id).toBe(nextSeed.id);
    expect(defined(events[1]).admissionNote).toBe(seed.admissionNote);
    expect(defined(events[1]).ticketUrl).toBe(seed.ticketUrl);
    expect(defined(events[1]).isFree).toBe(false);
    expect(defined(events[1]).priceMin).toBe(5);
    expect(JSON.stringify(seed)).toBe(before);
    expect(projectNineteenHzOccurrences(events, context("2026-11-04T00:00:00-08:00", "2026-11-11T23:59:59-08:00").window)).toEqual(events);
  });

  test("exact clock bounds, midnight overlap and source anchor control projections", () => {
    const seed = recurring("Wednesdays (9pm-2am)");
    expect(query(seed, "2026-11-11T21:00:00-08:00", "2026-11-11T21:00:00-08:00")).toHaveLength(1);
    expect(query(seed, "2026-11-05T03:00:00-08:00", "2026-11-11T20:59:59-08:00")).toEqual([]);
    expect(query(seed, "2026-11-12T01:00:00-08:00", "2026-11-12T01:30:00-08:00")).toHaveLength(1);
    expect(query(seed, "2026-11-12T02:00:00-08:00", "2026-11-12T03:00:00-08:00")).toEqual([]);
    expect(query(seed, "2026-10-28T00:00:00-07:00", "2026-10-28T23:59:59-07:00")).toEqual([]);
  });

  test("ordinal rules skip months without their occurrence", () => {
    const seed = recurring("5th Saturdays (9pm-2am)", "2026-08-01");
    expect(query(seed, "2026-09-01T00:00:00-07:00", "2026-10-31T23:59:59-07:00").map(e => e.startDatetime))
      .toEqual(["2026-10-31T21:00:00-07:00"]);
  });

  test("projected overnight clocks use each calendar day's DST offset", () => {
    const seed = recurring("Saturdays (9pm-2am)", "2026-10-24");
    const [event] = query(seed, "2026-10-31T00:00:00-07:00", "2026-10-31T23:59:59-07:00");
    expect(defined(event).startDatetime).toBe("2026-10-31T21:00:00-07:00");
    expect(defined(event).endDatetime).toBe("2026-11-01T02:00:00-08:00");
  });

  test("dated source rows never gain recurrence projections", () => {
    const dated = EventItemSchema.parse(mapRowToItem(defined(parseRows(FIXTURE)[0]), "19hz-socal", PAGE_URL, "2026-08-20T12:00:00Z", TODAY));
    expect(dated.recurrenceRule).toBeUndefined();
    expect(projectNineteenHzOccurrences([dated], context("2026-08-20T00:00:00-07:00", "2026-09-30T23:59:59-07:00").window)).toEqual([dated]);
  });
});


describe("six-cell dated rows", () => {
  const rowHtml = (day: string, url: string, hiddenDate?: string, extraLink = "") =>
    `<table><tr><td>${day} <br />(3pm-10pm)</td><td><a href='${url}'>Example Festival</a> @ Park (San Diego)<td>house</td><td>$60 | 18+</td><td>Organizer</td><td>${extraLink}</td>${hiddenDate ? `<td><div class='shrink'>${hiddenDate}</div></td>` : ""}</tr></table>`;

  test("primary URL year plus matching visible day yields a dated occurrence without a title special case", () => {
    const [row] = parseRows(rowHtml("Fri: Nov 13", "https://example.org/event/festival-13-nov-2026"));
    expect(defined(row).date).toBe("2026-11-13");
    const item = defined(mapRowToItem(defined(row), "19hz-socal", PAGE_URL, "2026-11-04T12:00:00Z", "2030-01-01"));
    expect(item.startDatetime).toBe("2026-11-13T15:00:00-08:00");
    expect(item.endDatetime).toBe("2026-11-13T22:00:00-08:00");
    expect(item.priceMin).toBe(60);
    expect(item.tags).toContain("18+");
    expect(item.tags).not.toContain("recurring");
    expect(item.recurrenceRule).toBeUndefined();
  });

  test.each([
    ["Fri: Nov 13", "https://example.org/event/festival"],
    ["Fri: Nov 13", "https://example.org/event/festival-13-nov"],
    ["Fri: Nov 13", "https://example.org/event/festival-14-nov-2026"],
    ["Fri: Nov 13", "https://example.org/event/festival-13-dec-2026"],
    ["Thu: Nov 13", "https://example.org/event/festival-13-nov-2026"],
    ["Tue: Feb 31", "https://example.org/event/festival-31-feb-2026"],
    ["Thu: Feb 29", "https://example.org/event/festival-29-feb-2026"],
    ["Fri: Nov 13", "https://example.org/event/13-nov-2026-13-nov-2037"],
    ["Fri: Nov 13", "https://example.org/event/13-nov-2026-2026-11-14"],
    ["Fri: Nov 13", "https://example.org/event/festival?date=13-nov-2026"],
  ])("absent, conflicting, invalid or ambiguous source date remains unresolved: %s %s", (day, url) => {
    const [row] = parseRows(rowHtml(day, url));
    expect(defined(row).date).toBeNull();
    expect(mapRowToItem(defined(row), "19hz-socal", PAGE_URL, "2026-11-04T12:00:00Z", "2026-11-04")).toBeNull();
  });

  test("an explicit ISO primary-URL date must also agree with the visible date", () => {
    expect(defined(parseRows(rowHtml("Fri: Nov 13", "https://example.org/event/festival-2026-11-13"))[0]).date).toBe("2026-11-13");
  });

  test("extra links cannot supply a missing primary URL year", () => {
    const [row] = parseRows(rowHtml("Fri: Nov 13", "https://example.org/event/festival", undefined,
      "<a href='https://example.org/post/13-nov-2026'>Post</a>"));
    expect(defined(row).date).toBeNull();
  });

  test("hidden-date rows keep their existing authoritative path", () => {
    const [row] = parseRows(rowHtml("Fri: Nov 13", "https://example.org/event/festival-13-nov-2026", "2026/11/13"));
    expect(defined(row).date).toBe("2026-11-13");
    const [missingHidden] = parseRows(rowHtml("Fri: Nov 13", "https://example.org/event/festival-13-nov-2026", "unavailable"));
    expect(missingHidden).toBeUndefined();
  });
});
