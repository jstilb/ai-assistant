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

function visible(events: EventItem[], from: string, to: string): string[] {
  const controls = Object.fromEntries(["q", "from", "to", "maxPrice", "originLat", "originLng", "radiusMiles", "freeOnly", "savedOnly"].map(id => ["#" + id, { value: "", checked: false }]));
  defined(controls["#from"]).value = from;
  defined(controls["#to"]).value = to;
  const sandbox = {
    document: { querySelector: (selector: string) => controls[selector], querySelectorAll: () => [] },
    events: events.map(event => ({ ...event })),
    result: [] as string[],
  };
  const context = createContext(sandbox);
  runInContext(defined(script, "UI script"), context);
  runInContext("STATE.events = events; STATE.events.forEach(augment); result = currentFiltered().map(event => event.id);", context);
  return Array.from(sandbox.result);
}

function event(startDatetime: string, endDatetime?: string, allDay = false): EventItem {
  return { id: "interval", title: "Interval", startDatetime, endDatetime, allDay, category: "community", tags: [], isFree: false, sourceUrl: "https://example.org/event", sources: [], fetchedAt: "2026-11-04T22:00:00Z", status: "scheduled" };
}

const cases = [
  { name: "all-day inclusive end", event: event("2026-11-20T00:00:00-08:00", "2026-11-22T23:59:59-08:00", true), included: ["2026-11-20", "2026-11-21", "2026-11-22"], excluded: ["2026-11-23"] },
  { name: "timed midnight exclusive", event: event("2026-11-20T22:00:00-08:00", "2026-11-21T00:00:00-08:00"), included: ["2026-11-20"], excluded: ["2026-11-21"] },
  { name: "timed one millisecond after midnight", event: event("2026-11-20T22:00:00-08:00", "2026-11-21T00:00:00.001-08:00"), included: ["2026-11-20", "2026-11-21"], excluded: ["2026-11-22"] },
  { name: "UTC midnight equivalent", event: event("2026-11-20T23:00:00-08:00", "2026-11-21T08:00:00Z"), included: ["2026-11-20"], excluded: ["2026-11-21"] },
  { name: "UTC overnight", event: event("2026-11-20T23:00:00-08:00", "2026-11-21T09:00:00Z"), included: ["2026-11-20", "2026-11-21"], excluded: ["2026-11-22"] },
  { name: "missing end", event: event("2026-11-20T12:00:00-08:00"), included: ["2026-11-20"], excluded: ["2026-11-21"] },
  { name: "invalid end", event: event("2026-11-20T12:00:00-08:00", "not-a-date"), included: ["2026-11-20"], excluded: ["2026-11-21"] },
  { name: "invalid calendar end", event: event("2026-11-20T12:00:00-08:00", "2026-11-31T12:00:00-08:00"), included: ["2026-11-20"], excluded: ["2026-11-21"] },
  { name: "zero length", event: event("2026-11-20T12:00:00-08:00", "2026-11-20T12:00:00-08:00"), included: ["2026-11-20"], excluded: ["2026-11-21"] },
  { name: "reverse end", event: event("2026-11-20T12:00:00-08:00", "2026-11-19T12:00:00-08:00"), included: ["2026-11-20"], excluded: ["2026-11-21"] },
  { name: "single all-day", event: event("2026-11-21T00:00:00-08:00", "2026-11-21T23:59:59-08:00", true), included: ["2026-11-21"], excluded: ["2026-11-22"] },
  { name: "DST fall back", event: event("2026-10-31T23:00:00-07:00", "2026-11-01T01:30:00-08:00"), included: ["2026-10-31", "2026-11-01"], excluded: ["2026-11-02"] },
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
  expect(visible([later, multiDay], "2026-11-21", "")).toEqual(["interval", "later"]);
  expect(visible([multiDay], "", "2026-11-19")).toEqual([]);
  expect(visible([multiDay], "", "2026-11-21")).toEqual(["interval"]);
  expect(visible([multiDay], "2026-11-23", "")).toEqual([]);
  expect(JSON.stringify([later, multiDay])).toBe(before);
});
