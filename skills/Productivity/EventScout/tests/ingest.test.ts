#!/usr/bin/env bun
/**
 * ingest.test.ts — Slice 9 TDD unit tests for Tools/Ingest.ts resilience.
 *
 * Key invariant verified: ingestAll() is best-effort — one source failing
 * (throw, timeout, 0 events) MUST NOT abort the whole run. Every source
 * must appear in the per-source report, whether as a count or a failure reason.
 *
 * Tests use stub adapters injected via `ingestAll(sources, { adapterFor })`
 * (no network, deterministic) — every call below passes
 * `skipCacheWrite: true`, so the real sources.json and cache are never
 * touched and nothing here reaches the KAYA_HOME-derived cache path in
 * Tools/Cache.ts. No live-service gate is needed in this file.
 *
 * Scenarios:
 *   1. All-success: 3 sources all yield events → perSource has all 3 counts.
 *   2. One throws synchronously → other 2 still succeed; failed source appears
 *      with count 0 and failureReason set.
 *   3. One times out (promise never resolves within per-source timeout) → same
 *      — other 2 succeed; timed-out source appears with count 0 and
 *      failureReason containing "timeout".
 *   4. One yields 0 events (returns []) → appears as count 0, no failureReason
 *      (0 events is not an error — source may just have no upcoming events).
 *   5. No-cap: ALL sources appear in perSource, even on failure (no silent drop).
 *   6. FailureReasons map: failed sources have a failureReason string; succeeded
 *      sources have no failureReason (or undefined).
 *   7. Written count = sum of successful-source event counts minus dedup merges.
 *   8. Disabled source is skipped and does NOT appear in perSource at all.
 *   9. Concurrency cap respected AND concurrency actually runs in parallel.
 *   10. Failure isolation — one adapter throws, rest succeed, run completes.
 *   11. Each adapter called exactly once — no double-fetch regression.
 *   12. Timeout isolation under concurrency — one hangs, rest complete.
 *
 * bun:test module.
 * Run:
 *   bun test skills/Productivity/EventScout/tests/ingest.test.ts
 */

import { test, describe, beforeEach, afterEach } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { adapterFor, ingestAll, ingestSource } from "../Tools/Ingest.ts";
import { EventSourceSchema } from "../Tools/types.ts";
import type { AdapterResolver, EventSource, EventItem, SourceAdapter } from "../Tools/types.ts";
import { fetchRSSEvents } from "../Tools/adapters/RSSAdapter.ts";
import { fetchSPAEvents } from "../Tools/adapters/SPAAdapter.ts";
import { fetchSitemapLlmEvents } from "../Tools/adapters/SitemapLlmAdapter.ts";
import { fetchRaCoEvents, SOURCE_ID as RACO_ID } from "../Tools/adapters/RaCoAdapter.ts";
import { fetchEdmtrainEvents, SOURCE_ID as EDMTRAIN_ID } from "../Tools/adapters/EdmtrainAdapter.ts";
import { SOURCE_ID as PADRES_ID } from "../Tools/adapters/PadresAdapter.ts";

// ============================================================================
// Assertion helpers — throw on failure so bun:test reports real pass/fail
// ============================================================================

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

function assertEq<T>(actual: T, expected: T, message: string): void {
  assert(
    JSON.stringify(actual) === JSON.stringify(expected),
    `${message}\n    expected: ${JSON.stringify(expected)}\n    actual:   ${JSON.stringify(actual)}`,
  );
}

// ============================================================================
// Fixtures
// ============================================================================

function makeSource(id: string, overrides: Partial<EventSource> = {}): EventSource {
  return {
    id,
    url: `https://example.com/${id}`,
    name: `Test Source ${id}`,
    fetchTier: "html-llm",
    pollInterval: 720,
    enabled: true,
    ...overrides,
  };
}

/**
 * Make a stub EventItem with a unique title per source+n combination.
 * Titles are deliberately distinct to avoid dedup collisions (dedup uses
 * title + venue; no-venue branch uses stricter threshold 0.8, but short
 * numeric-suffix titles still share most tokens). We use full unique names.
 */
const EVENT_NAMES: Record<string, string[]> = {
  "source-a": ["Jazz Quartet Live", "Rock Concert Extravaganza", "Blues Festival Night"],
  "source-b": ["Standup Comedy Show", "Improv Night Special", "Open Mic Showcase"],
  "source-c": ["Ballet Performance Season", "Art Gallery Opening", "Film Screening Outdoor"],
  "ok-1": ["Classical Orchestra Concert"],
  "ok-2": ["Food Festival Downtown", "Beer Garden Social"],
  "fast-1": ["Marathon Running Event"],
  "fast-2": ["Farmers Market Sunday"],
  good: ["Symphony Hall Concert"],
  bad: ["Never Gets Created"],
  x: ["Theatre Production Opening", "Dance Recital Annual"],
  y: ["Sports Championship Final"],
  "empty-source": [],
  s1: ["Photography Exhibition Show"],
  s2: ["Blocked Event"],
  s3: [],
  s4: ["Craft Beer Festival", "Wine Tasting Event"],
  s5: ["Parse Failed Event"],
  active: ["Community Parade Annual"],
  disabled: ["Should Not Appear"],
};

function makeEvent(sourceId: string, n: number): EventItem {
  const names = EVENT_NAMES[sourceId];
  const title = names?.[n - 1] ?? `Unique Event ${sourceId} Number ${n} Special`;
  // Use a unique date per source to ensure different-day bucketing prevents any cross-source merges
  const dayOffset = Math.abs(sourceId.charCodeAt(0) - 97) + n;
  const startDatetime = `2026-07-${String(15 + dayOffset).padStart(2, "0")}T19:00:00-07:00`;
  return {
    id: `${sourceId}-event-${n}`,
    title,
    startDatetime,
    allDay: false,
    category: "community",
    tags: [],
    isFree: false,
    sourceUrl: `https://example.com/${sourceId}`,
    sources: [{ sourceId, url: `https://example.com/${sourceId}` }],
    fetchedAt: new Date().toISOString(),
    status: "scheduled",
  };
}

/** Fake AdapterResolver: the stub Source Adapter keyed by source id. */
function fakeResolver(map: Record<string, SourceAdapter>): AdapterResolver {
  return (source) => {
    const adapter = map[source.id];
    if (!adapter) throw new Error(`fakeResolver: no stub for "${source.id}"`);
    return adapter;
  };
}

// ============================================================================
// Test 1: All-success — all 3 sources yield events
// ============================================================================

test("Test 1: all-success — 3 sources all yield events", async () => {
  const sources = [makeSource("source-a"), makeSource("source-b"), makeSource("source-c")];

  const adapters: Record<string, () => Promise<EventItem[]>> = {
    "source-a": async () => [makeEvent("source-a", 1), makeEvent("source-a", 2)],
    "source-b": async () => [makeEvent("source-b", 1)],
    "source-c": async () => [makeEvent("source-c", 1), makeEvent("source-c", 2), makeEvent("source-c", 3)],
  };

  const result = await ingestAll(sources, { adapterFor: fakeResolver(adapters), skipCacheWrite: true });

  assertEq(result.perSource["source-a"], 2, "source-a: 2 events");
  assertEq(result.perSource["source-b"], 1, "source-b: 1 event");
  assertEq(result.perSource["source-c"], 3, "source-c: 3 events");
  assert(result.written >= 5, `written >= 5 (got ${result.written})`);
  assert(!result.failureReasons?.["source-a"], "source-a: no failure reason");
  assert(!result.failureReasons?.["source-b"], "source-b: no failure reason");
  assert(!result.failureReasons?.["source-c"], "source-c: no failure reason");
});

// ============================================================================
// Test 2: One throws — other 2 still succeed; failed source reported
// ============================================================================

test("Test 2: one source throws — others continue, failure recorded", async () => {
  const sources = [makeSource("ok-1"), makeSource("thrower"), makeSource("ok-2")];

  const adapters: Record<string, () => Promise<EventItem[]>> = {
    "ok-1": async () => [makeEvent("ok-1", 1)],
    thrower: async () => {
      throw new Error("HTTP 403 Forbidden");
    },
    "ok-2": async () => [makeEvent("ok-2", 1), makeEvent("ok-2", 2)],
  };

  const result = await ingestAll(sources, { adapterFor: fakeResolver(adapters), skipCacheWrite: true });

  assertEq(result.perSource["ok-1"], 1, "ok-1: 1 event despite thrower");
  assertEq(result.perSource["ok-2"], 2, "ok-2: 2 events despite thrower");
  assertEq(result.perSource["thrower"], 0, "thrower: 0 events (failed)");
  assert(
    typeof result.failureReasons?.["thrower"] === "string" && result.failureReasons["thrower"].length > 0,
    "thrower: failureReason is a non-empty string",
  );
  assert(result.failureReasons?.["thrower"]?.includes("403") ?? false, "thrower: failureReason contains '403'");
});

// ============================================================================
// Test 3: One times out — other 2 succeed; timeout recorded
// ============================================================================

test("Test 3: one source times out — others continue, timeout recorded", async () => {
  const sources = [makeSource("fast-1"), makeSource("slow-hang"), makeSource("fast-2")];

  // The slow source never resolves within the 100ms test timeout
  const neverResolves = new Promise<EventItem[]>(() => {
    // Intentionally never resolves — tests the per-source timeout
  });

  const adapters: Record<string, () => Promise<EventItem[]>> = {
    "fast-1": async () => [makeEvent("fast-1", 1)],
    "slow-hang": () => neverResolves,
    "fast-2": async () => [makeEvent("fast-2", 1)],
  };

  // Use a very short per-source timeout (200ms) to make the test fast
  const result = await ingestAll(sources, {
    adapterFor: fakeResolver(adapters),
    skipCacheWrite: true,
    perSourceTimeoutMs: 200,
  });

  assertEq(result.perSource["fast-1"], 1, "fast-1: 1 event despite hang");
  assertEq(result.perSource["fast-2"], 1, "fast-2: 1 event despite hang");
  assertEq(result.perSource["slow-hang"], 0, "slow-hang: 0 events (timed out)");
  assert(typeof result.failureReasons?.["slow-hang"] === "string", "slow-hang: failureReason is a string");
  assert(
    result.failureReasons?.["slow-hang"]?.toLowerCase().includes("timeout") ?? false,
    "slow-hang: failureReason contains 'timeout'",
  );
});

// ============================================================================
// Test 4: Zero events is not a failure
// ============================================================================

test("Test 4: source returns 0 events — not a failure, count = 0", async () => {
  const sources = [makeSource("empty-source")];

  const adapters: Record<string, () => Promise<EventItem[]>> = {
    "empty-source": async () => [],
  };

  const result = await ingestAll(sources, { adapterFor: fakeResolver(adapters), skipCacheWrite: true });

  assertEq(result.perSource["empty-source"], 0, "empty-source: count = 0");
  assert(!result.failureReasons?.["empty-source"], "empty-source: no failure reason (0 events is OK)");
});

// ============================================================================
// Test 5: No silent drop — ALL enabled sources appear in perSource
// ============================================================================

test("Test 5: no silent drop — all enabled sources appear in perSource", async () => {
  const sources = [makeSource("s1"), makeSource("s2"), makeSource("s3"), makeSource("s4"), makeSource("s5")];

  const adapters: Record<string, () => Promise<EventItem[]>> = {
    s1: async () => [makeEvent("s1", 1)],
    s2: async () => {
      throw new Error("network error");
    },
    s3: async () => [],
    s4: async () => [makeEvent("s4", 1), makeEvent("s4", 2)],
    s5: async () => {
      throw new Error("parse error");
    },
  };

  const result = await ingestAll(sources, { adapterFor: fakeResolver(adapters), skipCacheWrite: true });

  const reportedIds = Object.keys(result.perSource);
  for (const source of sources) {
    assert(reportedIds.includes(source.id), `${source.id} appears in perSource (no silent drop)`);
  }
  assert(reportedIds.length === 5, `perSource has exactly 5 entries (got ${reportedIds.length})`);
});

// ============================================================================
// Test 6: failureReasons only for actually-failed sources
// ============================================================================

test("Test 6: failureReasons only set for failed sources, not succeeded ones", async () => {
  const sources = [makeSource("good"), makeSource("bad")];

  const adapters: Record<string, () => Promise<EventItem[]>> = {
    good: async () => [makeEvent("good", 1)],
    bad: async () => {
      throw new Error("connection refused");
    },
  };

  const result = await ingestAll(sources, { adapterFor: fakeResolver(adapters), skipCacheWrite: true });

  assert(!result.failureReasons?.["good"], "good: no failure reason (succeeded)");
  assert(typeof result.failureReasons?.["bad"] === "string", "bad: failureReason is a string");
});

// ============================================================================
// Test 7: Written count reflects deduplicated events
// ============================================================================

test("Test 7: written count = total events (no dedup in stub scenario)", async () => {
  const sources = [makeSource("x"), makeSource("y")];

  const adapters: Record<string, () => Promise<EventItem[]>> = {
    x: async () => [makeEvent("x", 1), makeEvent("x", 2)],
    y: async () => [makeEvent("y", 1)],
  };

  const result = await ingestAll(sources, { adapterFor: fakeResolver(adapters), skipCacheWrite: true });

  // 3 total events, distinct ids → 0 merges → written = 3
  assert(result.written >= 3, `written >= 3 (got ${result.written})`);
  assertEq(result.merges, 0, "0 merges (all distinct events)");
});

// ============================================================================
// Test 8: Disabled source is skipped (not in perSource)
// ============================================================================

test("Test 8: disabled source is skipped — not in perSource", async () => {
  const sources = [makeSource("active"), makeSource("disabled", { enabled: false })];

  const adapters: Record<string, () => Promise<EventItem[]>> = {
    active: async () => [makeEvent("active", 1)],
    disabled: async () => [makeEvent("disabled", 1)], // would work but should be skipped
  };

  const result = await ingestAll(sources, { adapterFor: fakeResolver(adapters), skipCacheWrite: true });

  assert("active" in result.perSource, "active source appears in perSource");
  assert(!("disabled" in result.perSource), "disabled source NOT in perSource (skipped)");
});

// ============================================================================
// Slice 8 Tests — Concurrency pool, failure isolation, single-fetch guarantee
// ============================================================================

// ============================================================================
// Test 9: Concurrency cap respected AND concurrency actually runs in parallel
// ============================================================================

test("Test 9 (Slice 8): concurrency cap respected — max in-flight bounded AND > 1", async () => {
  let maxInFlight = 0;
  let currentInFlight = 0;

  function makeTrackedAdapter(id: string): () => Promise<EventItem[]> {
    return async () => {
      currentInFlight++;
      if (currentInFlight > maxInFlight) maxInFlight = currentInFlight;
      // Yield long enough for all cap-slots to fill before anyone finishes.
      // With concurrency=3 and 6 sources: first 3 start, all await this tick,
      // so currentInFlight reaches 3 before any decrement.
      await new Promise<void>((resolve) => setTimeout(resolve, 30));
      currentInFlight--;
      return [makeEvent(id, 1)];
    };
  }

  // 6 sources, concurrency cap = 3 → must reach exactly 3 in-flight (not 1)
  const cap = 3;
  const sourceIds = ["c1", "c2", "c3", "c4", "c5", "c6"];
  const sources = sourceIds.map((id) => makeSource(id));
  const adapters: Record<string, () => Promise<EventItem[]>> = {};
  for (const id of sourceIds) {
    adapters[id] = makeTrackedAdapter(id);
  }

  const result = await ingestAll(sources, {
    adapterFor: fakeResolver(adapters),
    skipCacheWrite: true,
    concurrency: cap,
  });

  assert(maxInFlight <= cap, `maxInFlight (${maxInFlight}) never exceeded cap (${cap})`);
  // The key assertion: actual parallelism observed — sequential execution gives maxInFlight=1
  assert(maxInFlight > 1, `actual concurrency observed: maxInFlight (${maxInFlight}) > 1`);
  // All 6 sources must have been attempted
  assert(
    sourceIds.every((id) => id in result.perSource),
    "all 6 sources appear in perSource",
  );
});

// ============================================================================
// Test 10: Failure isolation — one adapter throws, rest succeed, run completes
// ============================================================================

test("Test 10 (Slice 8): failure isolation — one throws, others succeed, run completes", async () => {
  const sources = [makeSource("fi-good-1"), makeSource("fi-bad"), makeSource("fi-good-2"), makeSource("fi-good-3")];

  const adapters: Record<string, () => Promise<EventItem[]>> = {
    "fi-good-1": async () => [makeEvent("fi-good-1", 1)],
    "fi-bad": async () => {
      throw new Error("simulated failure");
    },
    "fi-good-2": async () => [makeEvent("fi-good-2", 1)],
    "fi-good-3": async () => [makeEvent("fi-good-3", 1)],
  };

  const result = await ingestAll(sources, {
    adapterFor: fakeResolver(adapters),
    skipCacheWrite: true,
    concurrency: 3,
  });

  assertEq(result.perSource["fi-good-1"], 1, "fi-good-1: 1 event despite fi-bad failing");
  assertEq(result.perSource["fi-good-2"], 1, "fi-good-2: 1 event despite fi-bad failing");
  assertEq(result.perSource["fi-good-3"], 1, "fi-good-3: 1 event despite fi-bad failing");
  assertEq(result.perSource["fi-bad"], 0, "fi-bad: 0 events (threw)");
  assert(
    typeof result.failureReasons?.["fi-bad"] === "string" && result.failureReasons["fi-bad"].includes("simulated"),
    "fi-bad: failureReason records the error",
  );
  assert(!result.failureReasons?.["fi-good-1"], "fi-good-1: no failureReason");
});

// ============================================================================
// Test 11: All sources fetched exactly once — guards against double-fetch regression
// ============================================================================

test("Test 11 (Slice 8): each adapter called exactly once — no double-fetch", async () => {
  const callCounts: Record<string, number> = {};

  function makeOnceAdapter(id: string): () => Promise<EventItem[]> {
    callCounts[id] = 0;
    return async () => {
      callCounts[id]!++;
      return [makeEvent(id, 1)];
    };
  }

  const onceIds = ["once-a", "once-b", "once-c", "once-d"];
  const sources = onceIds.map((id) => makeSource(id));
  const adapters: Record<string, () => Promise<EventItem[]>> = {};
  for (const id of onceIds) {
    adapters[id] = makeOnceAdapter(id);
  }

  await ingestAll(sources, {
    adapterFor: fakeResolver(adapters),
    skipCacheWrite: true,
    concurrency: 4,
  });

  for (const id of onceIds) {
    assertEq(callCounts[id], 1, `${id}: called exactly once (got ${callCounts[id]})`);
  }
});

// ============================================================================
// Test 12: Timeout isolation under concurrency — one hangs, rest succeed
// ============================================================================

test("Test 12 (Slice 8): timeout isolation — one hangs, others complete under concurrency", async () => {
  const sources = [makeSource("ti-fast-1"), makeSource("ti-hang"), makeSource("ti-fast-2")];

  const neverResolves = new Promise<EventItem[]>(() => {
    /* never */
  });

  const adapters: Record<string, () => Promise<EventItem[]>> = {
    "ti-fast-1": async () => [makeEvent("ti-fast-1", 1)],
    "ti-hang": () => neverResolves,
    "ti-fast-2": async () => [makeEvent("ti-fast-2", 1)],
  };

  const result = await ingestAll(sources, {
    adapterFor: fakeResolver(adapters),
    skipCacheWrite: true,
    concurrency: 3,
    perSourceTimeoutMs: 150,
  });

  assertEq(result.perSource["ti-fast-1"], 1, "ti-fast-1: succeeded despite hang");
  assertEq(result.perSource["ti-fast-2"], 1, "ti-fast-2: succeeded despite hang");
  assertEq(result.perSource["ti-hang"], 0, "ti-hang: 0 events (timed out)");
  assert(
    result.failureReasons?.["ti-hang"]?.toLowerCase().includes("timeout") ?? false,
    "ti-hang: failureReason contains 'timeout'",
  );
});

// ============================================================================
// Source Adapter seam (P05 S1) — adapterFor / ingestSource / ingestAll only.
// Resolve-only for production adapters: no adapter is ever called here.
// ============================================================================

describe("Source Adapter seam", () => {
  const prevHorizon = process.env["EVENTSCOUT_HORIZON_DAYS"];
  beforeEach(() => {
    delete process.env["EVENTSCOUT_HORIZON_DAYS"];
  });
  afterEach(() => {
    if (prevHorizon === undefined) delete process.env["EVENTSCOUT_HORIZON_DAYS"];
    else process.env["EVENTSCOUT_HORIZON_DAYS"] = prevHorizon;
  });

  /** An event `days` from the real now, stamped by `sourceId`. */
  function eventInDays(sourceId: string, days: number, title: string): EventItem {
    const start = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
    return { ...makeEvent(sourceId, 1), id: `${sourceId}-${title}`, title, startDatetime: start };
  }

  test("dispatch by tier: adapterFor picks the tier's adapter", () => {
    assert(adapterFor(makeSource("t-rss", { fetchTier: "rss" })) === fetchRSSEvents, "rss → fetchRSSEvents");
    assert(adapterFor(makeSource("t-spa", { fetchTier: "spa" })) === fetchSPAEvents, "spa → fetchSPAEvents");
    assert(adapterFor(makeSource("t-html", { fetchTier: "html-llm" })) === fetchSPAEvents, "html-llm → fetchSPAEvents");
    assert(
      adapterFor(makeSource("t-sitemap", { fetchTier: "sitemap-llm" })) === fetchSitemapLlmEvents,
      "sitemap-llm → fetchSitemapLlmEvents",
    );
  });

  test("dispatch by id for api: adapterFor picks the adapter keyed by its SOURCE_ID", () => {
    assert(adapterFor(makeSource(RACO_ID, { fetchTier: "api" })) === fetchRaCoEvents, `${RACO_ID} → fetchRaCoEvents`);
    assert(
      adapterFor(makeSource(EDMTRAIN_ID, { fetchTier: "api" })) === fetchEdmtrainEvents,
      `${EDMTRAIN_ID} → fetchEdmtrainEvents`,
    );
    const padres = adapterFor(makeSource(PADRES_ID, { fetchTier: "api" }));
    assert(padres !== fetchRaCoEvents && padres !== fetchEdmtrainEvents, "padres-mlb resolves to its own adapter");
  });

  test("unknown api id: failureReasons names it, other sources still run", async () => {
    const stubs = fakeResolver({ "ok-1": async () => [makeEvent("ok-1", 1)] });
    const resolve: AdapterResolver = (s) => (s.id === "no-such-api" ? adapterFor(s) : stubs(s));
    const sources = [makeSource("no-such-api", { fetchTier: "api" }), makeSource("ok-1")];

    const result = await ingestAll(sources, { adapterFor: resolve, skipCacheWrite: true });

    assertEq(result.perSource["ok-1"], 1, "ok-1 still ran");
    assertEq(result.perSource["no-such-api"], 0, "unknown api source reports 0");
    assertEq(
      result.failureReasons?.["no-such-api"],
      '[Ingest] no Source Adapter for api source "no-such-api"',
      "failureReasons carries the adapterFor error",
    );
  });

  test("foreign sourceId: that source fails with both ids, even beyond the horizon", async () => {
    const sources = [makeSource("drifter"), makeSource("ok-2")];
    const result = await ingestAll(sources, {
      adapterFor: fakeResolver({
        // Beyond the 120-day horizon: the identity check must run first.
        drifter: async () => [eventInDays("renamed-id", 400, "Drifted Event")],
        "ok-2": async () => [makeEvent("ok-2", 1)],
      }),
      skipCacheWrite: true,
    });

    const reason = result.failureReasons?.["drifter"] ?? "";
    assert(reason.includes('"renamed-id"') && reason.includes('"drifter"'), `reason names both ids: ${reason}`);
    assertEq(
      reason,
      '[Ingest] Source Adapter for "html-llm" stamped sourceId "renamed-id" on source "drifter"',
      "exact identity error text",
    );
    assertEq(result.perSource["ok-2"], 1, "ok-2 unaffected");
  });

  test("horizon applied once, via ingestSource", async () => {
    const stub = fakeResolver({
      "hz-src": async () => [eventInDays("hz-src", 10, "Near Event"), eventInDays("hz-src", 200, "Far Event")],
    });

    const direct = await ingestSource(makeSource("hz-src"), stub);
    assertEq(
      direct.map((e) => e.title),
      ["Near Event"],
      "ingestSource drops the far event",
    );

    const logged: string[] = [];
    const realLog = console.log;
    console.log = (...args: unknown[]) => {
      logged.push(args.map(String).join(" "));
    };
    try {
      const result = await ingestAll([makeSource("hz-src")], { adapterFor: stub, skipCacheWrite: true });
      assertEq(result.perSource["hz-src"], 1, "ingestAll keeps 1");
    } finally {
      console.log = realLog;
    }
    const drops = logged.filter((l) => l.includes("hz-src") && l.includes("horizon"));
    assertEq(drops.length, 1, "the horizon drop is logged once per source (one pass)");
  });

  test("registry: every enabled source in sources.json resolves via adapterFor", () => {
    const raw = JSON.parse(readFileSync(join(import.meta.dir, "../Tools/sources.json"), "utf-8")) as unknown;
    const enabled = z
      .array(EventSourceSchema)
      .parse(raw)
      .filter((s) => s.enabled);
    assert(enabled.length > 0, "sources.json has enabled sources");
    for (const source of enabled) {
      assert(typeof adapterFor(source) === "function", `${source.id} (${source.fetchTier}) resolves`);
    }
  });

  // --------------------------------------------------------------------------
  // Error mode (P05 S4): the Source Adapter contract (CONTEXT.md) — a failed
  // primary fetch throws, never a silent []. One real sources.json entry per
  // fetch-based adapter, resolved through the production adapterFor, with
  // globalThis.fetch stubbed. Excluded (plan §6 S4): SPA (BrightData +
  // Playwright transport, not fetch) and Edmtrain (key gate reads secrets.json
  // before any fetch). The message match stops a pre-fetch error from passing.
  // --------------------------------------------------------------------------
  describe("error mode", () => {
    const registry = z
      .array(EventSourceSchema)
      .parse(JSON.parse(readFileSync(join(import.meta.dir, "../Tools/sources.json"), "utf-8")) as unknown);
    function registryEntry(id: string): EventSource {
      const entry = registry.find((s) => s.id === id);
      if (!entry) throw new Error(`sources.json has no entry "${id}"`);
      return entry;
    }

    // [adapter, sources.json id] — ICS uses an entry without `unblock`.
    const ADAPTER_SOURCES: ReadonlyArray<readonly [string, string]> = [
      ["ActiveNet", "sdparkandrec-activenet"],
      ["Ctycms", "liberty-station"],
      ["DanceStudioPro", "thedancehouse-schedule"],
      ["Evvnt", "inewsource-events"],
      ["ICS", "daylight-sd"],
      ["MemberLife", "majestyinmotion-classes"],
      ["NineteenHz", "19hz-socal"],
      ["Padres", "padres-mlb"],
      ["Pike13", "cultureshock-sd"],
      ["RaCo", "ra-co-sandiego"],
      ["RSS", "sd-press-club"],
      ["Sdfc", "sandiego-fc"],
      ["SitemapLlm", "sdwritersink-classes"],
      ["WordPressTec", "balboa-park"],
    ];
    const FAILURES = [
      {
        failure: "HTTP 500",
        stub: async (): Promise<Response> => new Response("", { status: 500 }),
        // The status, not a URL value such as Pike13's `per_page=500`.
        expected: /(?<![=\d])500(?!\d)/,
      },
      {
        failure: "network throw",
        stub: async (): Promise<Response> => {
          throw new TypeError("p05 network down");
        },
        expected: /p05 network down/,
      },
    ];
    const CASES = ADAPTER_SOURCES.flatMap(([adapter, id]) =>
      FAILURES.map(({ failure, stub, expected }) => ({ adapter, id, failure, stub, expected })),
    );

    const realFetch = globalThis.fetch;
    afterEach(() => {
      globalThis.fetch = realFetch;
    });

    test.each(CASES)(
      "error mode: $adapter $failure",
      async ({ id, stub, expected }) => {
        const source = registryEntry(id);
        assert(source.unblock !== true, `${id}: test entry must not use the unblocker`);
        globalThis.fetch = Object.assign(stub, { preconnect: realFetch.preconnect });
        let caught: unknown;
        try {
          await ingestSource(source);
        } catch (err) {
          caught = err;
        }
        assert(caught !== undefined, `${id}: adapter resolved instead of rejecting`);
        const message = caught instanceof Error ? caught.message : String(caught);
        assert(expected.test(message), `${id}: reject "${message}" does not match ${expected}`);
      },
      // ICS retries 3 times with real sleeps (~750 + 1500 ms) before it throws.
      15_000,
    );
  });
});
