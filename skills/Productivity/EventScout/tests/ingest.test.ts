#!/usr/bin/env bun
/**
 * ingest.test.ts — Slice 9 TDD unit tests for Tools/Ingest.ts resilience.
 *
 * Key invariant verified: ingestAll() is best-effort — one source failing
 * (throw, timeout, 0 events) MUST NOT abort the whole run. Every source
 * must appear in the per-source report, whether as a count or a failure reason.
 *
 * Tests use stub adapters injected via the exported `ingestAllWithAdapters`
 * function (no network, deterministic) — every call below passes
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
 *   bun test ~/.claude/.claude/worktrees/arch-debt-d2-eventscout-buntest/skills/Productivity/EventScout/tests/ingest.test.ts
 */

import { test, describe, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { ingestAllWithAdapters } from "../Tools/Ingest.ts";
import type { EventSource, EventItem } from "../Tools/types.ts";

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
    `${message}\n    expected: ${JSON.stringify(expected)}\n    actual:   ${JSON.stringify(actual)}`
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
  "good": ["Symphony Hall Concert"],
  "bad": ["Never Gets Created"],
  "x": ["Theatre Production Opening", "Dance Recital Annual"],
  "y": ["Sports Championship Final"],
  "empty-source": [],
  "s1": ["Photography Exhibition Show"],
  "s2": ["Blocked Event"],
  "s3": [],
  "s4": ["Craft Beer Festival", "Wine Tasting Event"],
  "s5": ["Parse Failed Event"],
  "active": ["Community Parade Annual"],
  "disabled": ["Should Not Appear"],
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

// ============================================================================
// Test 1: All-success — all 3 sources yield events
// ============================================================================

test("Test 1: all-success — 3 sources all yield events", async () => {
  const sources = [
    makeSource("source-a"),
    makeSource("source-b"),
    makeSource("source-c"),
  ];

  const adapters: Record<string, () => Promise<EventItem[]>> = {
    "source-a": async () => [makeEvent("source-a", 1), makeEvent("source-a", 2)],
    "source-b": async () => [makeEvent("source-b", 1)],
    "source-c": async () => [makeEvent("source-c", 1), makeEvent("source-c", 2), makeEvent("source-c", 3)],
  };

  const result = await ingestAllWithAdapters(sources, adapters, { skipCacheWrite: true });

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
  const sources = [
    makeSource("ok-1"),
    makeSource("thrower"),
    makeSource("ok-2"),
  ];

  const adapters: Record<string, () => Promise<EventItem[]>> = {
    "ok-1": async () => [makeEvent("ok-1", 1)],
    "thrower": async () => { throw new Error("HTTP 403 Forbidden"); },
    "ok-2": async () => [makeEvent("ok-2", 1), makeEvent("ok-2", 2)],
  };

  const result = await ingestAllWithAdapters(sources, adapters, { skipCacheWrite: true });

  assertEq(result.perSource["ok-1"], 1, "ok-1: 1 event despite thrower");
  assertEq(result.perSource["ok-2"], 2, "ok-2: 2 events despite thrower");
  assertEq(result.perSource["thrower"], 0, "thrower: 0 events (failed)");
  assert(
    typeof result.failureReasons?.["thrower"] === "string" && result.failureReasons["thrower"].length > 0,
    "thrower: failureReason is a non-empty string"
  );
  assert(
    result.failureReasons?.["thrower"]?.includes("403") ?? false,
    "thrower: failureReason contains '403'"
  );
});

// ============================================================================
// Test 3: One times out — other 2 succeed; timeout recorded
// ============================================================================

test("Test 3: one source times out — others continue, timeout recorded", async () => {
  const sources = [
    makeSource("fast-1"),
    makeSource("slow-hang"),
    makeSource("fast-2"),
  ];

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
  const result = await ingestAllWithAdapters(sources, adapters, {
    skipCacheWrite: true,
    perSourceTimeoutMs: 200,
  });

  assertEq(result.perSource["fast-1"], 1, "fast-1: 1 event despite hang");
  assertEq(result.perSource["fast-2"], 1, "fast-2: 1 event despite hang");
  assertEq(result.perSource["slow-hang"], 0, "slow-hang: 0 events (timed out)");
  assert(
    typeof result.failureReasons?.["slow-hang"] === "string",
    "slow-hang: failureReason is a string"
  );
  assert(
    result.failureReasons?.["slow-hang"]?.toLowerCase().includes("timeout") ?? false,
    "slow-hang: failureReason contains 'timeout'"
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

  const result = await ingestAllWithAdapters(sources, adapters, { skipCacheWrite: true });

  assertEq(result.perSource["empty-source"], 0, "empty-source: count = 0");
  assert(!result.failureReasons?.["empty-source"], "empty-source: no failure reason (0 events is OK)");
});

// ============================================================================
// Test 5: No silent drop — ALL enabled sources appear in perSource
// ============================================================================

test("Test 5: no silent drop — all enabled sources appear in perSource", async () => {
  const sources = [
    makeSource("s1"),
    makeSource("s2"),
    makeSource("s3"),
    makeSource("s4"),
    makeSource("s5"),
  ];

  const adapters: Record<string, () => Promise<EventItem[]>> = {
    "s1": async () => [makeEvent("s1", 1)],
    "s2": async () => { throw new Error("network error"); },
    "s3": async () => [],
    "s4": async () => [makeEvent("s4", 1), makeEvent("s4", 2)],
    "s5": async () => { throw new Error("parse error"); },
  };

  const result = await ingestAllWithAdapters(sources, adapters, { skipCacheWrite: true });

  const reportedIds = Object.keys(result.perSource);
  for (const source of sources) {
    assert(
      reportedIds.includes(source.id),
      `${source.id} appears in perSource (no silent drop)`
    );
  }
  assert(reportedIds.length === 5, `perSource has exactly 5 entries (got ${reportedIds.length})`);
});

// ============================================================================
// Test 6: failureReasons only for actually-failed sources
// ============================================================================

test("Test 6: failureReasons only set for failed sources, not succeeded ones", async () => {
  const sources = [
    makeSource("good"),
    makeSource("bad"),
  ];

  const adapters: Record<string, () => Promise<EventItem[]>> = {
    "good": async () => [makeEvent("good", 1)],
    "bad": async () => { throw new Error("connection refused"); },
  };

  const result = await ingestAllWithAdapters(sources, adapters, { skipCacheWrite: true });

  assert(!result.failureReasons?.["good"], "good: no failure reason (succeeded)");
  assert(
    typeof result.failureReasons?.["bad"] === "string",
    "bad: failureReason is a string"
  );
});

// ============================================================================
// Test 7: Written count reflects deduplicated events
// ============================================================================

test("Test 7: written count = total events (no dedup in stub scenario)", async () => {
  const sources = [
    makeSource("x"),
    makeSource("y"),
  ];

  const adapters: Record<string, () => Promise<EventItem[]>> = {
    "x": async () => [makeEvent("x", 1), makeEvent("x", 2)],
    "y": async () => [makeEvent("y", 1)],
  };

  const result = await ingestAllWithAdapters(sources, adapters, { skipCacheWrite: true });

  // 3 total events, distinct ids → 0 merges → written = 3
  assert(result.written >= 3, `written >= 3 (got ${result.written})`);
  assertEq(result.merges, 0, "0 merges (all distinct events)");
});

// ============================================================================
// Test 8: Disabled source is skipped (not in perSource)
// ============================================================================

test("Test 8: disabled source is skipped — not in perSource", async () => {
  const sources = [
    makeSource("active"),
    makeSource("disabled", { enabled: false }),
  ];

  const adapters: Record<string, () => Promise<EventItem[]>> = {
    "active": async () => [makeEvent("active", 1)],
    "disabled": async () => [makeEvent("disabled", 1)], // would work but should be skipped
  };

  const result = await ingestAllWithAdapters(sources, adapters, { skipCacheWrite: true });

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

  const result = await ingestAllWithAdapters(sources, adapters, {
    skipCacheWrite: true,
    concurrency: cap,
  });

  assert(maxInFlight <= cap, `maxInFlight (${maxInFlight}) never exceeded cap (${cap})`);
  // The key assertion: actual parallelism observed — sequential execution gives maxInFlight=1
  assert(maxInFlight > 1, `actual concurrency observed: maxInFlight (${maxInFlight}) > 1`);
  // All 6 sources must have been attempted
  assert(
    sourceIds.every((id) => id in result.perSource),
    "all 6 sources appear in perSource"
  );
});

// ============================================================================
// Test 10: Failure isolation — one adapter throws, rest succeed, run completes
// ============================================================================

test("Test 10 (Slice 8): failure isolation — one throws, others succeed, run completes", async () => {
  const sources = [
    makeSource("fi-good-1"),
    makeSource("fi-bad"),
    makeSource("fi-good-2"),
    makeSource("fi-good-3"),
  ];

  const adapters: Record<string, () => Promise<EventItem[]>> = {
    "fi-good-1": async () => [makeEvent("fi-good-1", 1)],
    "fi-bad":    async () => { throw new Error("simulated failure"); },
    "fi-good-2": async () => [makeEvent("fi-good-2", 1)],
    "fi-good-3": async () => [makeEvent("fi-good-3", 1)],
  };

  const result = await ingestAllWithAdapters(sources, adapters, {
    skipCacheWrite: true,
    concurrency: 3,
  });

  assertEq(result.perSource["fi-good-1"], 1, "fi-good-1: 1 event despite fi-bad failing");
  assertEq(result.perSource["fi-good-2"], 1, "fi-good-2: 1 event despite fi-bad failing");
  assertEq(result.perSource["fi-good-3"], 1, "fi-good-3: 1 event despite fi-bad failing");
  assertEq(result.perSource["fi-bad"], 0, "fi-bad: 0 events (threw)");
  assert(
    typeof result.failureReasons?.["fi-bad"] === "string" &&
    result.failureReasons["fi-bad"].includes("simulated"),
    "fi-bad: failureReason records the error"
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

  await ingestAllWithAdapters(sources, adapters, {
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
  const sources = [
    makeSource("ti-fast-1"),
    makeSource("ti-hang"),
    makeSource("ti-fast-2"),
  ];

  const neverResolves = new Promise<EventItem[]>(() => { /* never */ });

  const adapters: Record<string, () => Promise<EventItem[]>> = {
    "ti-fast-1": async () => [makeEvent("ti-fast-1", 1)],
    "ti-hang":   () => neverResolves,
    "ti-fast-2": async () => [makeEvent("ti-fast-2", 1)],
  };

  const result = await ingestAllWithAdapters(sources, adapters, {
    skipCacheWrite: true,
    concurrency: 3,
    perSourceTimeoutMs: 150,
  });

  assertEq(result.perSource["ti-fast-1"], 1, "ti-fast-1: succeeded despite hang");
  assertEq(result.perSource["ti-fast-2"], 1, "ti-fast-2: succeeded despite hang");
  assertEq(result.perSource["ti-hang"], 0, "ti-hang: 0 events (timed out)");
  assert(
    result.failureReasons?.["ti-hang"]?.toLowerCase().includes("timeout") ?? false,
    "ti-hang: failureReason contains 'timeout'"
  );
});

// ============================================================================
// T2-09 — apify-tier per-source health streaks wired into ingestAllCore().
// The streak/tier DECISION logic itself is unit-tested in isolation in
// ApifyHealth.test.ts (with an injected sendAlertFn spy); these tests prove
// only the WIRING — that ingestAllCore() actually calls trackApifySourceHealth()
// for fetchTier "apify" sources on both the success and catch branches, and
// leaves every other tier (this file's 12 tests above, all "html-llm") alone.
// KAYA_HOME is pinned to a mkdtemp sandbox (never the live tree) and
// KAYA_ALERT_DRY_RUN=1 is set so recordFailure()'s AlertGate bridge never
// reaches the network — scoped to this describe block only via local
// beforeEach/afterEach so the 12 tests above are unaffected.
// ============================================================================

describe("T2-09: apify-tier health streaks wired into ingestAllCore()", () => {
  const tmpHome = join(tmpdir(), `eventscout-ingest-apify-test-${Date.now()}`);
  const failureLogPath = join(tmpHome, "MEMORY/MONITORING/failure-log.jsonl");

  function readFailureLogLines(): Array<Record<string, unknown>> {
    if (!existsSync(failureLogPath)) return [];
    return readFileSync(failureLogPath, "utf-8")
      .trim()
      .split("\n")
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  }

  beforeEach(() => {
    process.env.KAYA_HOME = tmpHome;
    process.env.KAYA_ALERT_DRY_RUN = "1";
    mkdirSync(tmpHome, { recursive: true });
  });

  afterEach(() => {
    delete process.env.KAYA_HOME;
    delete process.env.KAYA_ALERT_DRY_RUN;
    if (existsSync(tmpHome)) rmSync(tmpHome, { recursive: true, force: true });
  });

  test("3 consecutive hard-fails on an apify source, across 3 separate ingestAllWithAdapters() calls, reach the page threshold", async () => {
    const apifySource = makeSource("apify-dead", { fetchTier: "apify" });
    const adapters: Record<string, () => Promise<EventItem[]>> = {
      "apify-dead": async () => {
        throw new Error("status=TIMED-OUT");
      },
    };

    for (let i = 0; i < 3; i++) {
      const result = await ingestAllWithAdapters([apifySource], adapters, { skipCacheWrite: true });
      assertEq(result.perSource["apify-dead"], 0, `run ${i + 1}: apify-dead still reports 0 events`);
      assert(
        (result.failureReasons?.["apify-dead"] ?? "").includes("TIMED-OUT"),
        `run ${i + 1}: apify-dead failureReason still populated (unchanged existing behavior)`
      );
    }

    const lines = readFailureLogLines().filter(
      (l) =>
        l["source"] === "EventScout:ApifyIngest" &&
        (l["context"] as Record<string, unknown>)["sourceId"] === "apify-dead" &&
        (l["context"] as Record<string, unknown>)["channel"] === "hard-fail"
    );
    assertEq(lines.length, 3, "3 hard-fail forensic entries recorded, one per run");
    const streaks = lines.map((l) => (l["context"] as Record<string, unknown>)["streak"]);
    assertEq(streaks, [1, 2, 3], "streak climbs 1 -> 2 -> 3 across the 3 runs");
  });

  test("a real fetch success (events.length > 0) does not trigger any apify-health forensic entry", async () => {
    const apifySource = makeSource("apify-healthy", { fetchTier: "apify" });
    const adapters: Record<string, () => Promise<EventItem[]>> = {
      "apify-healthy": async () => [makeEvent("s4", 1)],
    };

    const result = await ingestAllWithAdapters([apifySource], adapters, { skipCacheWrite: true });
    assertEq(result.perSource["apify-healthy"], 1, "apify-healthy: 1 event, unchanged existing behavior");

    const lines = readFailureLogLines().filter(
      (l) => (l["context"] as Record<string, unknown>)?.["sourceId"] === "apify-healthy"
    );
    assertEq(lines.length, 0, "a clean success writes no failure-log entry at all");
  });

  test("3 consecutive zero-result runs on an apify source reach digest tier without ever paging", async () => {
    const apifySource = makeSource("apify-quiet", { fetchTier: "apify" });
    const adapters: Record<string, () => Promise<EventItem[]>> = {
      "apify-quiet": async () => [],
    };

    for (let i = 0; i < 3; i++) {
      const result = await ingestAllWithAdapters([apifySource], adapters, { skipCacheWrite: true });
      assertEq(result.perSource["apify-quiet"], 0, `run ${i + 1}: 0 events`);
      assert(
        result.failureReasons?.["apify-quiet"] === undefined,
        `run ${i + 1}: 0 events with no exception is NOT a failureReason (existing scenario-4 invariant, unchanged)`
      );
    }

    const lines = readFailureLogLines().filter(
      (l) =>
        l["source"] === "EventScout:ApifyIngest" &&
        (l["context"] as Record<string, unknown>)["sourceId"] === "apify-quiet" &&
        (l["context"] as Record<string, unknown>)["channel"] === "zero-result"
    );
    assertEq(lines.length, 3, "3 zero-result forensic entries recorded, one per run");
    assertEq(lines[0]!["tier"], undefined, "run 1: tier 'log' (field omitted)");
    assertEq(lines[1]!["tier"], undefined, "run 2: tier 'log' (field omitted)");
    assertEq(lines[2]!["tier"], "digest", "run 3: escalates to 'digest'");
  });

  test("non-apify sources (the other 35 tiers) are completely untouched by this wiring", async () => {
    const htmlLlmSource = makeSource("not-apify", { fetchTier: "html-llm" });
    const adapters: Record<string, () => Promise<EventItem[]>> = {
      "not-apify": async () => {
        throw new Error("some non-apify failure");
      },
    };

    await ingestAllWithAdapters([htmlLlmSource], adapters, { skipCacheWrite: true });

    const lines = readFailureLogLines().filter(
      (l) => (l["context"] as Record<string, unknown>)?.["sourceId"] === "not-apify"
    );
    assertEq(lines.length, 0, "a non-apify-tier failure never reaches FailureLog via this new wiring");
  });
});
