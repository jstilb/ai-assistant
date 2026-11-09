import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import { mapRowToItem, projectNineteenHzOccurrences } from "../Tools/adapters/NineteenHzAdapter.ts";
import { buildDefaultWindow, parseIsoDateStrict } from "../Tools/Window.ts";
import { laDateIso } from "../Tools/lib/tz.ts";
import { defined } from "../../../../lib/test/defined.ts";

const server = readFileSync(new URL("../Tools/UiServer.ts", import.meta.url), "utf8");
const fn = server.slice(server.indexOf("async function buildData("), server.indexOf("// ----------------------------------------------------------------------------\n// Server"));
const compiled = new Bun.Transpiler({ loader: "ts" }).transformSync(fn);
const build = new Function("readEvents", "loadSources", "readSaved", "loadProfile", "projectNineteenHzOccurrences", "buildDefaultWindow", "parseIsoDateStrict", "laDateIso", "params", "now", compiled + "\nreturn buildData(params, now);");
const seed = mapRowToItem({ dayTime: "Wednesdays (9pm-2am)", eventHtml: "<a href='https://example.org/weekly'>Weekly</a> @ Test venue (San Diego)", genres: "house", priceAge: "Free w/RSVP b4 10 / $5 | 21+", organizer: "Test", linksHtml: "", date: null }, "19hz-socal", "https://example.org/listing", "2026-11-04T22:00:00Z", "2026-11-04");
if (!seed) throw new Error("Test seed missing");
const cached = [seed, { ...seed, id: "dated-tail", title: "Explicit tail", startDatetime: "2030-01-01T21:00:00-08:00", endDatetime: undefined, recurrenceRule: undefined }];
const now = new Date("2026-11-04T23:00:00Z");

async function api(from = "", to = "") {
  const text: string = await build(() => cached, () => [], () => [], async () => ({ homeLocation: { lat: 0, lng: 0, label: "Test home" }, defaultRadiusMiles: 25 }), projectNineteenHzOccurrences, buildDefaultWindow, parseIsoDateStrict, laDateIso, new URLSearchParams({ from, to }), now);
  return JSON.parse(text);
}

test("actual API shares projector and keeps cached tails and source facts", async () => {
  const before = JSON.stringify(cached);
  const data = await api("2026-11-11", "2026-11-12");
  expect(data.events).toEqual(projectNineteenHzOccurrences(cached, { start: "2026-11-11T00:00:00-08:00", end: "2026-11-12T23:59:59-08:00" }));
  const projected = data.events.find((event: { startDatetime: string }) => event.startDatetime === "2026-11-11T21:00:00-08:00");
  expect(projected.endDatetime).toBe("2026-11-12T02:00:00-08:00");
  expect(projected.admissionNote).toBe(seed.admissionNote);
  expect(projected.isFree).toBe(false);
  expect(projected.priceMin).toBe(5);
  expect(data.cachedEventIds).toEqual(cached.map(event => event.id));
  expect(data.events.some((event: { id: string }) => event.id === "dated-tail")).toBe(true);
  expect(JSON.stringify(cached)).toBe(before);
});

test("actual API uses exact open-end horizon and explicit start anchor", async () => {
  expect((await api()).recurrenceProjection).toEqual({ from: "2026-11-04", to: "2026-11-18", openEnd: true, added: 2 });
  expect((await api("2026-11-11")).recurrenceProjection).toEqual({ from: "2026-11-11", to: "2026-11-25", openEnd: true, added: 3 });
  expect((await api("", "2026-11-18")).recurrenceProjection).toEqual({ from: "2026-11-04", to: "2026-11-18", openEnd: false, added: 2 });
});

test("actual API preserves explicit valid ranges longer than 180 days", async () => {
  const data = await api("2026-11-04", "2027-05-05");
  expect(data.recurrenceError).toBeNull();
  expect(data.recurrenceProjection.to).toBe("2027-05-05");
  expect(data.events.some((event: { startDatetime: string }) => event.startDatetime === "2027-05-05T21:00:00-07:00")).toBe(true);
});

test("actual API projects valid dates beyond two years without invented expiry", async () => {
  const data = await api("2029-11-01", "2029-11-30");
  expect(data.recurrenceError).toBeNull();
  expect(data.recurrenceProjection).toEqual({ from: "2029-11-01", to: "2029-11-30", openEnd: false, added: 5 });
  expect(data.events.some((event: { startDatetime: string }) => event.startDatetime === "2029-11-07T21:00:00-08:00")).toBe(true);
});

for (const [from, to] of [["2026-11-12", "2026-11-11"], ["2026-02-30", "2026-11-11"], ["2026-11-11", "2026-11-31"]]) {
  test(`actual API discloses cached-only fallback ${from}/${to}`, async () => {
    const data = await api(from, to);
    expect(data.events).toEqual(cached);
    expect(data.recurrenceProjection).toBeNull();
    expect(data.recurrenceError).toContain("cached dates only");
  });
}

const html = readFileSync(new URL("../ui/index.html", import.meta.url), "utf8");
const script = html.split("<script>")[1]?.split("</script>")[0]?.split("// ---- wire up ----")[0];
if (!script) throw new Error("EventScout UI script missing");

function loader(fetch: (url: string) => Promise<unknown>) {
  const controls = Object.fromEntries(["q", "from", "to", "maxPrice", "originLat", "originLng", "radiusMiles", "freeOnly", "savedOnly", "freshness"].map(id => ["#" + id, { value: "", checked: false, textContent: "" }]));
  defined(controls["#from"]).value = "2026-11-11";
  defined(controls["#to"]).value = "2026-11-12";
  const sandbox = { document: { querySelector: (selector: string) => controls[selector], querySelectorAll: () => [] }, fetch, URLSearchParams, result: [] as string[], pending: false, failure: "" };
  const context = createContext(sandbox);
  runInContext(defined(script, "UI script"), context);
  runInContext("apply=()=>{}; refreshSavedIndex=()=>{}; buildSourceRefreshDropdown=()=>{}; buildCategoryFilter=()=>{}; buildSourceFilter=()=>{}; updateCatLabel=()=>{}; updateSrcLabel=()=>{};", context);
  return { sandbox, context, controls };
}

const payload = (id: string) => ({ events: [{ ...seed, id }], sources: [], saved: [], cachedEventIds: [id], locationDefaults: null });

test("actual UI date reload rejects stale responses", async () => {
  const resolvers: Array<(value: unknown) => void> = [];
  const urls: string[] = [];
  const ui = loader(url => { urls.push(url); return new Promise(resolve => resolvers.push(resolve)); });
  const first = runInContext("loadData()", ui.context);
  defined(ui.controls["#from"]).value = "2026-11-18";
  const second = runInContext("loadData()", ui.context);
  defined(resolvers[1])({ ok: true, json: async () => payload("latest") });
  await second;
  defined(resolvers[0])({ ok: true, json: async () => payload("stale") });
  await first;
  runInContext("result=STATE.events.map(e=>e.id); pending=recurrencePending;", ui.context);
  expect(Array.from(ui.sandbox.result)).toEqual(["latest"]);
  expect(ui.sandbox.pending).toBe(false);
  expect(urls[1]).toContain("from=2026-11-18");
});

test("actual UI fetch failure removes stale projections and exposes cached-only state", async () => {
  const ui = loader(async () => { throw new Error("Network unavailable"); });
  runInContext("STATE={events:[{id:'cached'},{id:'old-projection'}],sources:[],saved:[],cachedEventIds:['cached']};", ui.context);
  await runInContext("loadData()", ui.context);
  runInContext("result=STATE.events.map(e=>e.id); failure=recurrenceFetchError; pending=recurrencePending;", ui.context);
  expect(Array.from(ui.sandbox.result)).toEqual(["cached"]);
  expect(ui.sandbox.failure).toContain("cached dates only");
  expect(ui.sandbox.pending).toBe(false);
});
