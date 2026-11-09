import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { renderTiered } from "../Tools/Render.ts";
import type { QueryCoverage } from "../Tools/types.ts";
import type { RankedEvent } from "../Tools/Ranker.ts";

const event: RankedEvent = {
  id: "cached", title: "Cached performance", startDatetime: "2026-11-05T19:00:00-08:00",
  endDatetime: "2026-11-05T21:00:00-08:00", allDay: false, venue: "Fixture venue",
  category: "community", tags: [], isFree: true, sourceUrl: "https://example.invalid/event",
  sources: [{ sourceId: "unavailable", url: "https://example.invalid" }],
  fetchedAt: "2026-10-01T00:00:00Z", status: "scheduled", score: 1, why: "Fixture reason",
};
const coverage: QueryCoverage = {
  mode: "refresh", attemptedSources: ["available", "unavailable"],
  refreshedSources: ["available"], failedSources: ["unavailable"], persistenceFailed: false,
};

test("partial source coverage preserves cached matches and exposes recovery", () => {
  const output = renderTiered([event], undefined, coverage);
  expect(output).toContain("1 of 2 selected sources refreshed");
  expect(output).toContain("Unavailable this attempt: unavailable");
  expect(output).toContain("cached events from these sources may remain");
  expect(output).toContain("Retry `--refresh` later");
  expect(output).toContain(event.title);
  expect(output).toContain("9:00 PM PST");
});

test("empty source failure cannot establish no matching events exist", () => {
  const output = renderTiered([], undefined, { ...coverage, refreshedSources: [], failedSources: coverage.attemptedSources });
  expect(output).toContain("0 of 2 selected sources refreshed");
  expect(output).toContain("No matching events are available in the cache");
  expect(output).toContain("does not establish that no events exist");
  expect(output).not.toContain("No events matched your criteria");
});

test("cache-only and no eligible sources describe distinct next actions", () => {
  const cache = renderTiered([], undefined, { ...coverage, mode: "cache", attemptedSources: [], refreshedSources: [], failedSources: [] });
  expect(cache).toContain("Cache only; no sources were refreshed");
  expect(cache).toContain("Use `--refresh`");
  expect(cache).not.toContain("Unavailable this attempt");
  const noEligible = renderTiered([], undefined, { ...coverage, attemptedSources: [], refreshedSources: [], failedSources: [] });
  expect(noEligible).toContain("No enabled sources matched the source selection");
  expect(noEligible).toContain("Check enabled sources and category filters");
});

test("persistence warning describes in-memory results and sanitizes source labels", () => {
  const output = renderTiered([event], undefined, { ...coverage, persistenceFailed: true, failedSources: ["bad\n> forged"] });
  expect(output).toContain("Cache update failed. Results include fetched events and the existing cache; saving these results could not be confirmed");
  expect(output).toContain("bad___forged");
  expect(output).not.toContain("\n> forged");
});


test("failed cache persistence preserves merged fresh rows and permits same-process recovery", async () => {
  const script = `
import { mock } from "bun:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
const tools = process.env.SYNTHETIC_TOOLS!;
const home = { lat: 32.7157, lng: -117.1611 };
const fixture = (id, title, day = 5, source = "good") => ({
  id, title, startDatetime: \`2030-11-\${String(day).padStart(2, "0")}T19:00:00-08:00\`,
  endDatetime: \`2030-11-\${String(day).padStart(2, "0")}T21:00:00-08:00\`, allDay: false,
  venue: "Synthetic venue", ...home, category: "community", tags: [], isFree: false,
  sourceUrl: \`https://example.invalid/\${id}\`, sources: [{sourceId: source, url: \`https://example.invalid/\${id}\`}],
  fetchedAt: "2030-11-01T00:00:00Z", status: "scheduled",
});
const cached = Array.from({length: 11}, (_, i) => fixture(\`cached-\${i}\`, \`Cached performance \${i}\`, i+5, "cached"));
const fresh = [
  {...fixture("cached-0", "Updated source title", 5), priceMin: 25},
  {...fixture("twin", "Cached performance 1", 6), description: "Detailed synthetic source record"},
  fixture("fresh-a", "Fresh alpha", 20), fixture("fresh-b", "Fresh beta", 21),
  fixture("api-a", "Class Level One", 22, "api"), fixture("api-b", "Class Level Two", 22, "api"),
];
const sources = [{id:"good",name:"Good",url:"https://example.invalid/good",enabled:true,fetchTier:"api",pollInterval:60},
  {id:"failed",name:"Failed",url:"https://example.invalid/failed",enabled:true,fetchTier:"ics",pollInterval:60},
  {id:"empty",name:"Empty",url:"https://example.invalid/empty",enabled:true,fetchTier:"ics",pollInterval:60}];
let disk = structuredClone(cached), mode = "before", writes = 0, stateWrites = 0, reads = 0;
const calls = [];
const modulePath = name => resolve(tools, name + ".ts");
mock.module(modulePath("Cache"), () => ({
  readEvents: () => { reads++; return structuredClone(disk); },
  upsertEventsDeduped: incoming => {
    writes++;
    if (mode === "before") throw new Error("synthetic first-write failure");
    if (mode === "partial") { disk = structuredClone(incoming); throw new Error("synthetic second-write failure"); }
    const byId = new Map(disk.map(e => [e.id,e]));
    for (const e of incoming) byId.set(e.id,e);
    disk = dedupeAndMerge([...byId.values()], new Set(["api"]));
  },
}));
mock.module(modulePath("SourceManager"), () => ({
  loadSources: () => sources, loadApiTierSourceIds: () => new Set(["api"]),
  updateLastFetchedBatch: updates => { stateWrites++; assert.deepEqual(Object.keys(updates).sort(), ["empty","good"]); },
}));
mock.module(modulePath("Ingest"), () => ({ingestSource: async source => {
  calls.push(source.id); if (source.id === "failed") throw new Error("synthetic source failure");
  return source.id === "empty" ? [] : structuredClone(fresh);
}}));
mock.module(modulePath("Geocoder"), () => ({enrichWithGeo: async events => events}));
mock.module(modulePath("InterestProfile"), () => ({loadProfile: async () => ({homeLocation:{...home,label:"Synthetic"},defaultRadiusMiles:15})}));
mock.module(modulePath("Ranker"), () => ({rankEvents: async events => events.map(e => ({...e,score:1,why:\`Source reason for \${e.id}\`}))}));
globalThis.fetch = () => { throw new Error("OFFLINE_GUARD: fetch"); };
Bun.plugin({name:"synthetic-provider-guard",setup(build) {
  build.onResolve({filter: /(?:^|\\/)Inference\\.ts$/}, args => { throw new Error("OFFLINE_GUARD: provider import " + args.path); });
}});
const { dedupeAndMerge } = await import(modulePath("Dedup"));
const { queryHybrid } = await import(modulePath("Query"));
const context = {rawQuery:"synthetic coverage",window:{start:"2030-11-01T00:00:00-08:00",end:"2030-11-30T23:59:59-08:00"},home,radiusMiles:15};
function verify(result, count = 15) {
  assert.equal(result.events.length, count);
  assert.equal(result.rankedEvents.length, count);
  assert.equal(result.events.find(e => e.id === "cached-0").title, "Updated source title");
  assert.equal(result.events.find(e => e.id === "cached-0").priceMin, 25);
  assert(result.events.some(e => e.id === "api-a")); assert(result.events.some(e => e.id === "api-b"));
  for (const id of ["fresh-a","fresh-b"]) assert(result.events.some(e => e.id === id));
  const twin = result.events.find(e => e.title === "Cached performance 1");
  if (count === 15) { assert.deepEqual(twin.sources.map(s=>s.sourceId).sort(), ["cached","good"]); assert(result.events.some(e => e.id === "cached-10")); }
  if (count > 10) assert(result.markdown.includes("**Why:** Source reason for"));
  else assert(result.markdown.includes("> _Source reason for"));
}
for (const failure of ["before", "partial"]) {
  disk = structuredClone(cached); mode = failure;
  const result = await queryHybrid(context, Infinity, true);
  console.log("MARKDOWN_" + failure + "\\n" + result.markdown + "\\nEND_MARKDOWN");
  verify(result); assert.equal(result.coverage.persistenceFailed, true); assert.equal(stateWrites, 0);
  assert(result.markdown.includes("saving these results could not be confirmed"));
  assert.deepEqual(result.coverage.failedSources,["failed"]);
}
disk = structuredClone(cached); mode = "success";
const recovered = await queryHybrid(context, Infinity, true);
verify(recovered); assert.equal(recovered.coverage.persistenceFailed,false); assert.equal(stateWrites,1);
assert(!recovered.markdown.includes("Cache update failed"));
const readsBefore = reads, callsBefore = calls.length;
verify(await queryHybrid(context, Infinity, false));
assert.equal(reads, readsBefore+1); assert.equal(calls.length,callsBefore); assert.equal(stateWrites,1);
disk = []; mode = "before";
const empty = await queryHybrid(context, Infinity, true); verify(empty,6); assert.equal(stateWrites,1);
assert.equal(writes,4);
console.log("CACHE_PRESERVE_PASSED");
`;
  const child = Bun.spawn([process.execPath, "--eval", script], {
    env: { PATH: process.env.PATH, SYNTHETIC_TOOLS: resolve(import.meta.dir, "../Tools") },
    stdout: "pipe", stderr: "pipe", timeout: 10_000,
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: expect.any(String) });
  expect(stdout).toContain("CACHE_PRESERVE_PASSED");
}, 15_000);
