import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import { filterEvents } from "../Tools/Filter.ts";
import type { EventItem } from "../Tools/types.ts";
import { defined } from "../../../../lib/test/defined.ts";

const html = readFileSync(new URL("../ui/index.html", import.meta.url), "utf8");
const script = html.split("<script>")[1]?.split("</script>")[0]?.split("// ---- wire up ----")[0];
if (!script) throw new Error("EventScout UI script is missing");

function event(id: string, price: Partial<EventItem> = {}): EventItem {
  return { id, title: id, startDatetime: "2026-11-05T21:00:00-08:00", allDay: false, category: "music", tags: [], isFree: false, sourceUrl: "https://example.org/event", sources: [], fetchedAt: "2026-11-04T22:00:00Z", status: "scheduled", ...price };
}
const events = [event("unknown"), event("free", { isFree: true }), event("zero", { priceMin: 0 }), event("range", { priceMin: 5, priceMax: 30 }), event("conditional", { priceMin: 6.5, admissionNote: "Free w/RSVP b4 9 / $6.50" }), event("max-only", { priceMax: 10 })];

function ui(value: string, freeOnly = false) {
  const controls = Object.fromEntries(["q", "from", "to", "maxPrice", "originLat", "originLng", "radiusMiles", "freeOnly", "savedOnly"].map(id => ["#" + id, { value: "", checked: false }]));
  defined(controls["#maxPrice"]).value = value;
  defined(controls["#freeOnly"]).checked = freeOnly;
  const sandbox = {
    document: { querySelector: (selector: string) => controls[selector], querySelectorAll: () => [], createElement: () => ({ innerHTML: "", addEventListener() {}, appendChild() {}, querySelector: () => ({ addEventListener() {} }) }) },
    events: structuredClone(events), result: [] as string[], labels: [] as string[], detail: "", row: "", parsed: undefined as number | undefined,
  };
  const context = createContext(sandbox);
  runInContext(defined(script, "UI script"), context);
  runInContext("STATE.events = events; STATE.events.forEach(augment); result = currentFiltered().map(e => e.id); labels = STATE.events.map(e => e._price); parsed = maximumPrice(); row = rowFor(STATE.events[4]).innerHTML;", context);
  return sandbox;
}

for (const value of ["", "0", "5", "6.50", "15", ".5", " 6.50 "]) {
  test(`actual UI maximum ${JSON.stringify(value)} agrees with Filter`, () => {
    const before = JSON.stringify(events);
    const actual = ui(value);
    const expected = filterEvents(events, { rawQuery: "events", window: { start: "2026-11-05T00:00:00-08:00", end: "2026-11-05T23:59:59-08:00" }, home: { lat: 0, lng: 0 }, radiusMiles: Infinity, maxPrice: value.trim() ? Number(value) : undefined }).map(e => e.id);
    expect(Array.from(actual.result)).toEqual(expected);
    expect(JSON.stringify(events)).toBe(before);
  });
}

for (const value of ["-1", "abc", "6.50xyz", "Infinity", "1e3", "6,50", ".", "9".repeat(400)]) {
  test(`actual UI rejects invalid maximum ${value.slice(0, 20)}`, () => {
    expect(ui(value).result).toEqual([]);
    expect(Number.isNaN(ui(value).parsed)).toBe(true);
  });
}

test("actual UI preserves ranges, exact conditions and free intersection", () => {
  expect(Array.from(ui("6.50", true).result)).toEqual(["free"]);
  expect(ui("6.50").labels[3]).toBe("$5–30");
  expect(ui("6.50").row).toContain("Free w/RSVP b4 9 / $6.50");
  expect(ui("6.50").row).not.toContain("9pm");
  expect(Array.from(ui("").result)).toContain("unknown");
  expect(Array.from(ui("15").result)).not.toContain("unknown");
});
