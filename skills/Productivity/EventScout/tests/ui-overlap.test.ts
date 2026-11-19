import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import { filterEvents } from "../Tools/Filter.ts";
import { laDateIso } from "../Tools/lib/tz.ts";
import type { EventItem } from "../Tools/types.ts";
import { defined } from "../../../../lib/test/defined.ts";

const html = readFileSync(new URL("../ui/index.html", import.meta.url), "utf8");
const script = html.split("<script>")[1]?.split("</script>")[0]?.split("// ---- wire up ----")[0];
if (!script) throw new Error("EventScout UI script is missing");

/** Ids the actual UI filter keeps; `onlyOngoing` returns just the rows it labels "Ongoing until". */
function visible(events: EventItem[], from: string, to: string, onlyOngoing = false): string[] {
  const controls = Object.fromEntries(["q", "from", "to", "maxPrice", "originLat", "originLng", "radiusMiles", "freeOnly", "savedOnly"].map(id => ["#" + id, { value: "", checked: false }]));
  defined(controls["#from"]).value = from;
  defined(controls["#to"]).value = to;
  const sandbox = {
    document: { querySelector: (selector: string) => controls[selector], querySelectorAll: () => [] },
    events: events.map(event => ({ ...event })),
    onlyOngoing,
    result: [] as string[],
  };
  const context = createContext(sandbox);
  runInContext(defined(script, "UI script"), context);
  runInContext("STATE.events = events; STATE.events.forEach(augment); result = currentFiltered().filter(event => !onlyOngoing || event._ongoing).map(event => event.id);", context);
  return Array.from(sandbox.result);
}

function event(startDatetime: string, endDatetime?: string, allDay = false): EventItem {
  return { id: "interval", title: "Interval", startDatetime, endDatetime, allDay, category: "community", tags: [], isFree: false, sourceUrl: "https://example.org/event", sources: [], fetchedAt: "2026-11-04T22:00:00Z", status: "scheduled" };
}

const cases = [
  { name: "all-day inclusive end", event: event("2026-11-20T00:00:00-08:00", "2026-11-22T23:59:59-08:00", true), included: ["2026-11-20", "2026-11-21", "2026-11-22"], excluded: ["2026-11-23"] },
  { name: "timed midnight exclusive", event: event("2026-11-20T22:00:00-08:00", "2026-11-21T00:00:00-08:00"), included: ["2026-11-20"], excluded: ["2026-11-21"] },
  // F-005 review: a timed session of 24 h or less counts on its start day only.
  { name: "timed one millisecond after midnight", event: event("2026-11-20T22:00:00-08:00", "2026-11-21T00:00:00.001-08:00"), included: ["2026-11-20"], excluded: ["2026-11-21"] },
  { name: "UTC midnight equivalent", event: event("2026-11-20T23:00:00-08:00", "2026-11-21T08:00:00Z"), included: ["2026-11-20"], excluded: ["2026-11-21"] },
  { name: "UTC overnight", event: event("2026-11-20T23:00:00-08:00", "2026-11-21T09:00:00Z"), included: ["2026-11-20"], excluded: ["2026-11-21"] },
  { name: "timed run longer than a day", event: event("2026-11-20T22:00:00-08:00", "2026-11-22T02:00:00-08:00"), included: ["2026-11-20", "2026-11-21", "2026-11-22"], excluded: ["2026-11-19", "2026-11-23"] },
  { name: "missing end", event: event("2026-11-20T12:00:00-08:00"), included: ["2026-11-20"], excluded: ["2026-11-21"] },
  { name: "invalid end", event: event("2026-11-20T12:00:00-08:00", "not-a-date"), included: ["2026-11-20"], excluded: ["2026-11-21"] },
  { name: "invalid calendar end", event: event("2026-11-20T12:00:00-08:00", "2026-11-31T12:00:00-08:00"), included: ["2026-11-20"], excluded: ["2026-11-21"] },
  { name: "zero length", event: event("2026-11-20T12:00:00-08:00", "2026-11-20T12:00:00-08:00"), included: ["2026-11-20"], excluded: ["2026-11-21"] },
  { name: "reverse end", event: event("2026-11-20T12:00:00-08:00", "2026-11-19T12:00:00-08:00"), included: ["2026-11-20"], excluded: ["2026-11-21"] },
  { name: "single all-day", event: event("2026-11-21T00:00:00-08:00", "2026-11-21T23:59:59-08:00", true), included: ["2026-11-21"], excluded: ["2026-11-22"] },
  { name: "DST fall back", event: event("2026-10-31T23:00:00-07:00", "2026-11-01T01:30:00-08:00"), included: ["2026-10-31"], excluded: ["2026-11-01"] },
];

for (const fixture of cases) {
  test(`actual UI overlap: ${fixture.name}`, () => {
    for (const day of [...fixture.included, ...fixture.excluded]) {
      const expected = fixture.included.includes(day) ? [fixture.event.id] : [];
      expect(visible([fixture.event], day, day)).toEqual(expected);
      const [year, month, date] = day.split("-").map(Number) as [number, number, number];
      const window = { start: laDateIso(year, month, date, 0, 0, 0), end: laDateIso(year, month, date, 23, 59, 59) };
      expect(filterEvents([fixture.event], { rawQuery: "events", window, home: { lat: 0, lng: 0 }, radiusMiles: Infinity }).map(event => event.id)).toEqual(expected);
    }
  });
}

test("actual UI preserves open date bounds, start ordering and source fields", () => {
  const multiDay = event("2026-11-20T00:00:00-08:00", "2026-11-22T23:59:59-08:00", true);
  const later = { ...event("2026-11-21T12:00:00-08:00"), id: "later" };
  const before = JSON.stringify([later, multiDay]);
  // multiDay started before From: it is "ongoing" and sorts after rows dated in the window (F-005).
  expect(visible([later, multiDay], "2026-11-21", "")).toEqual(["later", "interval"]);
  expect(visible([later, multiDay], "2026-11-20", "")).toEqual(["interval", "later"]);
  // Ongoing rows sit after the From day's dated rows, before the next day (re-review 2026-11-18).
  const nextDay = { ...event("2026-11-22T09:00:00-08:00"), id: "next-day" };
  expect(visible([nextDay, later, multiDay], "2026-11-21", "")).toEqual(["later", "interval", "next-day"]);
  expect(visible([multiDay], "", "2026-11-19")).toEqual([]);
  expect(visible([multiDay], "", "2026-11-21")).toEqual(["interval"]);
  expect(visible([multiDay], "2026-11-23", "")).toEqual([]);
  expect(JSON.stringify([later, multiDay])).toBe(before);
});

// F-004/F-005 (Jm 2026-11-18): a row that started before From and still runs in
// the window stays visible (exhibits, month-long runs) and is labelled
// "Ongoing until <end>" instead of showing its old start date. Ended listings
// are removed at the cache (Cache.ts), not hidden here.
test("actual UI keeps rows still running in the window and labels those that started before From", () => {
  const exhibit = { ...event("2026-06-03T07:00:00-07:00", "2027-02-28T00:00:00-08:00"), id: "exhibit" };
  const festival = { ...event("2026-11-20T00:00:00-08:00", "2026-11-22T23:59:59-08:00", true), id: "festival" };
  const startsInWindow = { ...event("2026-11-21T10:00:00-08:00", "2027-01-03T23:59:00-08:00"), id: "season" };
  const ended = { ...event("2026-06-03T07:00:00-07:00", "2026-11-20T12:00:00-08:00"), id: "ended" };
  const all = [exhibit, festival, startsInWindow, ended];
  expect(visible(all, "2026-11-21", "2026-11-22").sort()).toEqual(["exhibit", "festival", "season"]);
  expect(visible(all, "2026-11-21", "2026-11-22", true).sort()).toEqual(["exhibit", "festival"]);
  // No From date: no row counts as ongoing.
  expect(visible(all, "", "2026-11-22", true)).toEqual([]);
});
