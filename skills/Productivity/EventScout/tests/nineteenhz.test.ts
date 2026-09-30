/**
 * nineteenhz.test.ts — NineteenHzAdapter pure-parser tests.
 *
 * Fixture mirrors the live page's quirks exactly: one-line rows, UNCLOSED td
 * in the event cell, dated 7-cell rows (shrink-div date) + recurring 6-cell
 * rows, SoCal-wide cities.
 *
 * Run: bun test ~/.claude/skills/Productivity/EventScout/tests/nineteenhz.test.ts
 */

import { describe, test, expect } from "bun:test";
import {
  parseRows,
  parseTimeRange,
  parsePriceAge,
  parseEventCell,
  isSanDiegoCity,
  nextOccurrenceDate,
  mapRowToItem,
} from "../Tools/adapters/NineteenHzAdapter.ts";

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
    expect(rows[0]!.date).toBe("2026-08-21");
    expect(rows[0]!.genres).toBe("afro house");
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
  test("free with condition stays free", () => {
    expect(parsePriceAge("Free b4 11pm | 21+").isFree).toBe(true);
  });
  test("age-only → unknown price, NOT free", () => {
    expect(parsePriceAge("21+")).toEqual({ isFree: false, ageTag: "21+" });
  });
});

describe("parseEventCell", () => {
  test("anchor + venue + city", () => {
    expect(
      parseEventCell("<a href='https://t.example/x'>Nitefreak</a> @ Spin Nightclub (San Diego)")
    ).toEqual({
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
    expect(tba.isFree).toBe(true);
  });
});
