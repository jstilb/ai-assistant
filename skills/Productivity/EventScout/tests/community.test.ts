/**
 * community.test.ts — G2 community detection (Community.ts): series keys,
 * recurrence facts from the cache, the hold line, and the LLM classifier's
 * loud failures (with a fake inference function).
 */

import { test, expect } from "bun:test";
import type { InferenceResult } from "../../../../lib/core/Inference.ts";
import type { EventItem } from "../Tools/types.ts";
import { describeSeries, detectSeries, makeClassifier, seriesKey } from "../Tools/Community.ts";
import type { CommunityCandidate } from "../Tools/Community.ts";
import { defined } from "../../../../lib/test/defined.ts";

function item(id: string, title: string, start: string, extra: Partial<EventItem> = {}): EventItem {
  return {
    id,
    title,
    startDatetime: start,
    allDay: false,
    category: "community",
    tags: [],
    isFree: true,
    sourceUrl: "https://example.com/list",
    sources: [{ sourceId: "test", url: `https://example.com/e/${id}` }],
    fetchedAt: "2026-11-08T00:00:00Z",
    status: "scheduled",
    ...extra,
  };
}

// ============================================================================
// seriesKey
// ============================================================================

test("seriesKey drops dates and month names and keeps the venue name before the comma", () => {
  const a = seriesKey({ title: "Salsa Night - Nov 14", venue: "Tango Del Rey" });
  const b = seriesKey({ title: "Salsa Night – November 21st", venue: "Tango Del Rey, 3567 Del Rey St, San Diego" });
  const c = seriesKey({ title: "Salsa Night 11/28", venue: "tango del rey" });
  expect(a).toBe(b);
  expect(a).toBe(c);
  expect(seriesKey({ title: "Salsa Night", venue: "Other Club" })).not.toBe(a);
});

// ============================================================================
// detectSeries
// ============================================================================

test("a weekly group on one weekday is a series; its facts come from the cache dates", () => {
  const cache = [
    item("a1", "Open Mic", "2026-11-14T19:00:00-08:00", { venue: "Bar X" }),
    item("a2", "Open Mic", "2026-11-21T19:00:00-08:00", { venue: "Bar X" }),
    item("a3", "Open Mic", "2026-11-28T19:00:00-08:00", { venue: "Bar X" }),
  ];
  const s = defined(detectSeries(cache).get(defined(seriesKey(defined(cache[0])))));
  expect(s.dates).toEqual(["2026-11-14", "2026-11-21", "2026-11-28"]);
  expect(s.weekday).toBe("Saturday");
  expect(s.cadence).toBe("weekly");
  expect(s.fromRule).toBe(false);
  expect(describeSeries(s)).toBe("meets weekly on Saturdays (EventScout found it on 3 dates, Nov 14 – Nov 28)");
});

test("a show run on back-to-back days and a daily exhibit are not series", () => {
  const cache = [
    item("r1", "The Musical", "2026-11-13T19:30:00-08:00", { venue: "Theatre" }),
    item("r2", "The Musical", "2026-11-14T19:30:00-08:00", { venue: "Theatre" }),
    item("r3", "The Musical", "2026-11-15T14:00:00-08:00", { venue: "Theatre" }),
    item("x1", "Quilt Show", "2026-11-14T10:00:00-08:00", { venue: "Museum" }),
    item("x2", "Quilt Show", "2026-11-21T10:00:00-08:00", { venue: "Museum" }),
    item("x3", "Quilt Show", "2026-11-22T10:00:00-08:00", { venue: "Museum" }),
  ];
  expect(detectSeries(cache).size).toBe(0);
});

test("a single dated event is not a series unless a source gives a weekly or monthly rule", () => {
  const one = item("o1", "Concert", "2026-11-14T20:00:00-08:00", { venue: "Hall" });
  const ruled = item("w1", "Run Club", "2026-11-19T18:00:00-08:00", {
    venue: "Brewery",
    recurrenceRule: "RRULE:FREQ=WEEKLY;BYDAY=TH",
  });
  const daily = item("d1", "Yoga", "2026-11-14T08:00:00-08:00", { venue: "Park", recurrenceRule: "RRULE:FREQ=DAILY" });
  const series = detectSeries([one, ruled, daily]);
  expect(series.has(defined(seriesKey(one)))).toBe(false);
  expect(series.has(defined(seriesKey(daily)))).toBe(false);
  const s = defined(series.get(defined(seriesKey(ruled))));
  expect(s.fromRule).toBe(true);
  expect(s.weekday).toBe("Thursday");
  expect(describeSeries(s)).toBe("meets weekly on Thursdays (the source's calendar repeats it)");
});

test("cancelled dates never count toward a series", () => {
  const cache = [
    item("c1", "Trivia", "2026-11-17T19:00:00-08:00", { venue: "Pub" }),
    item("c2", "Trivia", "2026-11-24T19:00:00-08:00", { venue: "Pub", status: "cancelled" }),
  ];
  expect(detectSeries(cache).size).toBe(0);
});

test("a monthly group (gaps of 28–35 days) is a monthly series", () => {
  const cache = [
    item("m1", "Repair Cafe", "2026-11-15T13:00:00-08:00", { venue: "Hall" }),
    item("m2", "Repair Cafe", "2026-12-20T13:00:00-08:00", { venue: "Hall" }),
    item("m3", "Repair Cafe", "2027-01-17T13:00:00-08:00", { venue: "Hall" }),
  ];
  expect(defined(detectSeries(cache).get(defined(seriesKey(defined(cache[0]))))).cadence).toBe("monthly");
});

test("two dates show a repeat but no cadence word: the line lists the dates", () => {
  const cache = [
    item("p1", "Craft Night", "2026-11-14T16:00:00-08:00", { venue: "Studio" }),
    item("p2", "Craft Night", "2026-11-28T16:00:00-08:00", { venue: "Studio" }),
  ];
  const s = defined(detectSeries(cache).get(defined(seriesKey(defined(cache[0])))));
  expect(describeSeries(s)).toBe("the sources list it on 2 Saturdays: Nov 14, Nov 28");
});

test("irregular gaps never claim a cadence: the line lists the dates", () => {
  const cache = [
    item("g1", "Book Club", "2026-11-07T18:00:00-08:00", { venue: "Cafe" }),
    item("g2", "Book Club", "2026-11-14T18:00:00-08:00", { venue: "Cafe" }),
    item("g3", "Book Club", "2026-12-12T18:00:00-08:00", { venue: "Cafe" }),
  ];
  const s = defined(detectSeries(cache).get(defined(seriesKey(defined(cache[0])))));
  expect(s.cadence).toBe("repeating");
  expect(describeSeries(s)).toBe("the sources list it on 3 Saturdays: Nov 7, Nov 14, Dec 12");
});

test("a rule with several weekdays or no BYDAY never names a wrong weekday", () => {
  const twoDays = item("t1", "Run Club", "2026-11-16T18:00:00-08:00", {
    venue: "Track",
    recurrenceRule: "RRULE:FREQ=WEEKLY;BYDAY=MO,WE",
  });
  const monthDay = item("t2", "Board Games", "2026-11-14T18:00:00-08:00", {
    venue: "Shop",
    recurrenceRule: "RRULE:FREQ=MONTHLY;BYMONTHDAY=14",
  });
  const weeklyNoDay = item("t3", "Pickup Soccer", "2026-11-15T09:00:00-08:00", { venue: "Field", recurrenceRule: "RRULE:FREQ=WEEKLY" });
  const series = detectSeries([twoDays, monthDay, weeklyNoDay]);
  expect(describeSeries(defined(series.get(defined(seriesKey(twoDays)))))).toBe("meets weekly (the source's calendar repeats it)");
  expect(describeSeries(defined(series.get(defined(seriesKey(monthDay)))))).toBe("meets monthly (the source's calendar repeats it)");
  expect(describeSeries(defined(series.get(defined(seriesKey(weeklyNoDay)))))).toBe(
    "meets weekly on Sundays (the source's calendar repeats it)",
  );
});

test("an event with no venue has no series key, so two 'Open Mic' listings never merge", () => {
  expect(seriesKey({ title: "Open Mic", venue: "" })).toBeNull();
  expect(seriesKey({ title: "Open Mic" })).toBeNull();
  const cache = [item("n1", "Open Mic", "2026-11-14T19:00:00-08:00"), item("n2", "Open Mic", "2026-11-21T19:00:00-08:00")];
  expect(detectSeries(cache).size).toBe(0);
});

// ============================================================================
// makeClassifier
// ============================================================================

const CANDIDATES: CommunityCandidate[] = [
  { key: "salsa|tango", title: "Salsa Social", category: "music", tags: [], cadence: "weekly on Saturdays" },
  { key: "improv|club", title: "Improv Show", category: "comedy", tags: [], cadence: "weekly on Saturdays" },
];

function fakeResult(parsed: unknown, success = true): InferenceResult {
  return {
    success,
    output: "",
    parsed,
    ...(success ? {} : { error: "timeout" }),
    latencyMs: 1,
    level: "standard",
    estimatedTokens: { input: 0, output: 0, total: 0 },
    estimatedCostUSD: 0,
  };
}

test("the classifier maps verdicts back to series keys, one Sonnet call with a schema", async () => {
  const calls: Array<{ level: string; schema: unknown }> = [];
  const classify = makeClassifier(async (opts) => {
    calls.push({ level: opts.level, schema: opts.schema });
    expect(opts.userPrompt).toContain('"id":"s1"');
    expect(opts.userPrompt).toContain("Salsa Social");
    return fakeResult({
      verdicts: [
        { id: "s1", community: true, kind: "dance social" },
        { id: "s2", community: false, kind: "watch-only show" },
      ],
    });
  });
  const out = await classify(CANDIDATES);
  expect(calls).toHaveLength(1);
  expect(defined(calls[0]).level).toBe("standard");
  expect(defined(calls[0]).schema).toBeDefined();
  expect(out.get("salsa|tango")).toEqual({ community: true, kind: "dance social" });
  expect(out.get("improv|club")).toEqual({ community: false, kind: "watch-only show" });
});

test("no candidates = no LLM call", async () => {
  let called = false;
  const classify = makeClassifier(async () => {
    called = true;
    return fakeResult({ verdicts: [] });
  });
  expect((await classify([])).size).toBe(0);
  expect(called).toBe(false);
});

test("the classifier fails loudly on a failed call, a bad shape, or a missing verdict", async () => {
  await expect(makeClassifier(async () => fakeResult(undefined, false))(CANDIDATES)).rejects.toThrow(/LLM call failed/);
  await expect(makeClassifier(async () => fakeResult({ nope: 1 }))(CANDIDATES)).rejects.toThrow(/bad shape/);
  await expect(
    makeClassifier(async () => fakeResult({ verdicts: [{ id: "s1", community: true, kind: "dance social" }] }))(CANDIDATES),
  ).rejects.toThrow(/answered 1 of 2/);
});
