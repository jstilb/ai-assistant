import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import { filterEvents } from "../Tools/Filter.ts";
import type { EventItem } from "../Tools/types.ts";
import { defined } from "../../../../lib/test/defined.ts";

const html = readFileSync(new URL("../ui/index.html", import.meta.url), "utf8");
const script = html.split("<script>")[1]?.split("</script>")[0]?.split("// ---- wire up ----")[0];
if (!script) throw new Error("EventScout UI script is missing");
const server = readFileSync(new URL("../Tools/UiServer.ts", import.meta.url), "utf8");
const dataFunction = server.slice(server.indexOf("async function buildData("), server.indexOf("// ----------------------------------------------------------------------------\n// Server"));
const compiled = new Bun.Transpiler({ loader: "ts" }).transformSync(dataFunction);

function event(id: string, location: Partial<EventItem> = {}): EventItem {
  return { id, title: id, startDatetime: "2026-11-05T21:00:00-08:00", allDay: false, category: "music", tags: [], isFree: false, sourceUrl: "https://example.org/event", sources: [], fetchedAt: "2026-11-04T22:00:00Z", status: "scheduled", ...location };
}
const events = [event("same", { lat: 0, lng: 0 }), event("near", { lat: 0, lng: 0.01 }), event("far", { lat: 0, lng: 1 }), event("unknown"), event("partial", { lat: 0 })];

function ui(lat = "0", lng = "0", radius = "") {
  const controls = Object.fromEntries(["q", "from", "to", "maxPrice", "originLat", "originLng", "radiusMiles", "freeOnly", "savedOnly"].map(id => ["#" + id, { value: "", checked: false }]));
  defined(controls["#originLat"]).value = lat;
  defined(controls["#originLng"]).value = lng;
  defined(controls["#radiusMiles"]).value = radius;
  const sandbox = { document: { querySelector: (selector: string) => controls[selector], querySelectorAll: () => [], createElement: () => ({ innerHTML: "", addEventListener() {}, querySelector: () => ({ addEventListener() {} }) }) }, events: structuredClone(events), result: [] as string[], labels: [] as string[], boundary: 0, invalid: false };
  const context = createContext(sandbox);
  runInContext(defined(script, "UI script"), context);
  runInContext("STATE.events = events; STATE.events.forEach(augment); result = currentFiltered().map(e => e.id); labels = STATE.events.map(distanceLabel); invalid = locationSettings().invalid; boundary = distanceMiles(events[2], {lat:0,lng:0});", context);
  return { sandbox, context, controls };
}

for (const radius of ["", "0", ".5", "1", "5", "100"]) {
  test(`actual UI radius ${JSON.stringify(radius)} matches Filter and retains unknown`, () => {
    const actual = ui("0", "0", radius).sandbox;
    const expected = filterEvents(events, { rawQuery: "events", window: { start: "2026-11-05T00:00:00-08:00", end: "2026-11-05T23:59:59-08:00" }, home: { lat: 0, lng: 0 }, radiusMiles: radius ? Number(radius) : Infinity }).map(e => e.id);
    expect(Array.from(actual.result)).toEqual(expected);
    expect(Array.from(actual.result)).toContain("unknown");
    expect(actual.labels[3]).toBe("Distance unknown (unverified)");
    expect(actual.labels[4]).toBe("Distance unknown (unverified)");
  });
}

test("actual UI uses exact inclusive radius and new local origin", () => {
  const boundary = ui().sandbox.boundary;
  expect(Array.from(ui("0", "0", String(boundary)).sandbox.result)).toContain("far");
  expect(Array.from(ui("0", "0", String(boundary - 0.000001)).sandbox.result)).not.toContain("far");
  expect(Array.from(ui("0", "1", "0").sandbox.result)).toEqual(["far", "unknown", "partial"]);
  expect(ui("0", "0", "0").sandbox.labels[0]).toBe("0.00 mi from origin (straight line)");
});

for (const [lat, lng, radius] of [["", "", "1"], ["91", "0", "1"], ["0", "-181", "1"], ["0", "", ""], ["0", "0", "-1"], ["0", "0", "abc"], ["1e2", "0", "1"], ["0", "Infinity", "1"]]) {
  test(`actual UI rejects invalid location ${lat}/${lng}/${radius}`, () => {
    const actual = ui(lat, lng, radius).sandbox;
    expect(actual.invalid).toBe(true);
    expect(Array.from(actual.result)).toEqual([]);
  });
}

test("no configured origin permits an unbounded view with unknown distance", () => {
  const actual = ui("", "", "").sandbox;
  expect(actual.invalid).toBe(false);
  expect(actual.result.length).toBe(events.length);
  expect(Array.from(actual.labels).every(label => label === "Distance unknown (unverified)")).toBe(true);
});

test("restoreOrigin restores configured coordinates without hardcoded UI defaults", () => {
  const actual = ui("1", "2", "3");
  runInContext("configuredLocation = {home:{lat:0,lng:0,label:'Test home'},radiusMiles:5}; restoreOrigin();", actual.context);
  expect(defined(actual.controls["#originLat"]).value).toBe("0");
  expect(defined(actual.controls["#originLng"]).value).toBe("0");
  expect(defined(actual.controls["#radiusMiles"]).value).toBe("3");
});

async function api(profile: unknown, rejected = false) {
  const build = new Function("readEvents", "loadSources", "readSaved", "loadProfile", compiled + "\nreturn buildData();");
  const payload: string = await build(() => events, () => [], () => [], async () => { if (rejected) throw new Error("private/path/secret"); return profile; });
  return JSON.parse(payload);
}

test("bounded actual API function exposes valid defaults and preserves payload", async () => {
  const result = await api({ homeLocation: { lat: 0, lng: 0, label: "Test home" }, defaultRadiusMiles: 0 });
  expect(result.locationDefaults).toEqual({ home: { lat: 0, lng: 0, label: "Test home" }, radiusMiles: 0 });
  expect(result.locationError).toBeNull();
  expect(result.events).toEqual(events);
});

for (const profile of [undefined, { homeLocation: { lat: 91, lng: 0 }, defaultRadiusMiles: 25 }, { homeLocation: { lat: 0, lng: 181 }, defaultRadiusMiles: 25 }, { homeLocation: { lat: 0, lng: 0 }, defaultRadiusMiles: -1 }, { homeLocation: { lat: NaN, lng: 0 }, defaultRadiusMiles: Infinity }]) {
  test("bounded actual API function rejects invalid defaults without dropping events", async () => {
    const result = await api(profile);
    expect(result.locationDefaults).toBeNull();
    expect(result.locationError).toContain("Configured home and radius are unavailable");
    expect(result.events).toEqual(events);
  });
}

test("bounded API profile failure omits raw error details", async () => {
  const result = await api(null, true);
  expect(result.locationDefaults).toBeNull();
  expect(JSON.stringify(result)).not.toContain("private/path/secret");
  expect(result.events).toEqual(events);
});
