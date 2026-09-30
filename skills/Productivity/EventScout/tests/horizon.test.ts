#!/usr/bin/env bun
/**
 * horizon.test.ts — Slice 5 TDD tests for Tools/Horizon.ts.
 *
 * Covers:
 *   - withinHorizon: filters events whose startDatetime is AFTER now+days.
 *     Keeps past events (not horizon's job). Keeps unparseable startDatetime.
 *   - horizonDays: reads EVENTSCOUT_HORIZON_DAYS, defaults to 120.
 *     NaN / 0 / negative all fall back to 120.
 *   - Integration: via ingestAllWithAdapters, far-future events are NOT
 *     returned/written after the horizon filter is applied in ingestSource.
 *
 * Run:
 *   bun test ~/.claude/.claude/worktrees/arch-debt-d2-eventscout-buntest/skills/Productivity/EventScout/tests/horizon.test.ts
 */

import { test } from "bun:test";
import { withinHorizon, horizonDays } from "../Tools/Horizon.ts";
import { ingestAllWithAdapters } from "../Tools/Ingest.ts";
import type { EventItem, EventSource } from "../Tools/types.ts";

// ============================================================================
// Test harness
// ============================================================================

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}

function assertEq<T>(actual: T, expected: T, message: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `Assertion failed: ${message} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`
    );
  }
}

// ============================================================================
// Fixtures
// ============================================================================

const NOW = new Date("2026-06-07T12:00:00-07:00");

/** ISO 8601 string for NOW + offsetDays. Negative = past. */
function isoOffset(days: number): string {
  const d = new Date(NOW.getTime() + days * 24 * 60 * 60 * 1000);
  return d.toISOString().replace("Z", "-07:00");
}

/**
 * ISO 8601 string for REAL now + offsetDays. Section 3 (integration through
 * ingestAllWithAdapters) MUST use this: Ingest.ts calls
 * `withinHorizon(events, new Date(), days)` with the real clock, so fixtures
 * anchored to the fixed NOW rot as calendar time advances past it (this
 * exact failure happened: NOW+50d slid inside the real 30-day horizon on
 * 2026-06-27 and test 3.4 started failing). Sections 1–2 keep the fixed NOW
 * because they pass it to withinHorizon explicitly.
 */
function isoOffsetReal(days: number): string {
  const d = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
  return d.toISOString().replace("Z", "-07:00");
}

let eventCounter = 0;
function makeEvent(startDatetime: string, overrides: Partial<EventItem> = {}): EventItem {
  const n = ++eventCounter;
  return {
    id: `horizon-test-event-${n}`,
    title: `Horizon Test Event ${n}`,
    startDatetime,
    allDay: false,
    category: "community",
    tags: [],
    isFree: false,
    sourceUrl: `https://example.com/horizon-${n}`,
    sources: [{ sourceId: "test-source", url: `https://example.com/horizon-${n}` }],
    fetchedAt: NOW.toISOString(),
    status: "scheduled",
    ...overrides,
  };
}

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

// ============================================================================
// Section 1: withinHorizon — pure filter
// ============================================================================

test("1.1: event at now+200d dropped (default 120d horizon)", () => {
  const events = [makeEvent(isoOffset(200))];
  const result = withinHorizon(events, NOW);
  assertEq(result.length, 0, "now+200d: dropped (1 event → 0 after filter)");
});

test("1.2: event at now+100d kept (default 120d horizon)", () => {
  const events = [makeEvent(isoOffset(100))];
  const result = withinHorizon(events, NOW);
  assertEq(result.length, 1, "now+100d: kept");
});

test("1.3: boundary — now+119d kept, now+121d dropped (default 120d)", () => {
  const e119 = makeEvent(isoOffset(119));
  const e121 = makeEvent(isoOffset(121));
  const result = withinHorizon([e119, e121], NOW);
  assertEq(result.length, 1, "exactly 1 event survives (119d kept, 121d dropped)");
  assert(result[0]?.id === e119.id, "surviving event is the 119d one");
});

test("1.4: past event (now-5d) kept — horizon is a future cap only", () => {
  const events = [makeEvent(isoOffset(-5))];
  const result = withinHorizon(events, NOW);
  assertEq(result.length, 1, "now-5d: kept (not dropped by horizon)");
});

test("1.5: unparseable startDatetime kept (don't silently lose data)", () => {
  const events = [
    makeEvent("not-a-date"),
    makeEvent(""),
    makeEvent("2026-99-99T00:00:00"),
  ];
  const result = withinHorizon(events, NOW);
  assertEq(result.length, 3, "all 3 unparseable events kept");
});

test("1.6: custom days param overrides default", () => {
  const e50 = makeEvent(isoOffset(50));
  const e70 = makeEvent(isoOffset(70));
  // With days=60, e50 kept, e70 dropped
  const result = withinHorizon([e50, e70], NOW, 60);
  assertEq(result.length, 1, "days=60: now+50d kept, now+70d dropped");
  assert(result[0]?.id === e50.id, "surviving event is the 50d one");
});

test("1.7: mixed — past, in-horizon, and beyond-horizon", () => {
  const ePast = makeEvent(isoOffset(-10));
  const eIn = makeEvent(isoOffset(60));
  const eOut = makeEvent(isoOffset(150));
  const result = withinHorizon([ePast, eIn, eOut], NOW);
  assertEq(result.length, 2, "2 events survive (past + in-horizon)");
  const ids = result.map((e) => e.id);
  assert(ids.includes(ePast.id), "past event kept");
  assert(ids.includes(eIn.id), "in-horizon event kept");
  assert(!ids.includes(eOut.id), "beyond-horizon event dropped");
});

// ============================================================================
// Section 2: horizonDays — env-driven knob
// ============================================================================

test("2.1: default 120 when EVENTSCOUT_HORIZON_DAYS not set", () => {
  const prev = process.env["EVENTSCOUT_HORIZON_DAYS"];
  delete process.env["EVENTSCOUT_HORIZON_DAYS"];
  const result = horizonDays();
  if (prev !== undefined) process.env["EVENTSCOUT_HORIZON_DAYS"] = prev;
  assertEq(result, 120, "horizonDays() defaults to 120");
});

test("2.2: EVENTSCOUT_HORIZON_DAYS=60 → 60", () => {
  const prev = process.env["EVENTSCOUT_HORIZON_DAYS"];
  process.env["EVENTSCOUT_HORIZON_DAYS"] = "60";
  const result = horizonDays();
  process.env["EVENTSCOUT_HORIZON_DAYS"] = prev ?? "";
  if (prev === undefined) delete process.env["EVENTSCOUT_HORIZON_DAYS"];
  assertEq(result, 60, "horizonDays() returns 60 when env=60");
});

test("2.3: NaN env value → 120", () => {
  const prev = process.env["EVENTSCOUT_HORIZON_DAYS"];
  process.env["EVENTSCOUT_HORIZON_DAYS"] = "not-a-number";
  const result = horizonDays();
  process.env["EVENTSCOUT_HORIZON_DAYS"] = prev ?? "";
  if (prev === undefined) delete process.env["EVENTSCOUT_HORIZON_DAYS"];
  assertEq(result, 120, "horizonDays() falls back to 120 for NaN");
});

test("2.4: env=0 → 120", () => {
  const prev = process.env["EVENTSCOUT_HORIZON_DAYS"];
  process.env["EVENTSCOUT_HORIZON_DAYS"] = "0";
  const result = horizonDays();
  process.env["EVENTSCOUT_HORIZON_DAYS"] = prev ?? "";
  if (prev === undefined) delete process.env["EVENTSCOUT_HORIZON_DAYS"];
  assertEq(result, 120, "horizonDays() falls back to 120 for 0");
});

test("2.5: env=-30 → 120", () => {
  const prev = process.env["EVENTSCOUT_HORIZON_DAYS"];
  process.env["EVENTSCOUT_HORIZON_DAYS"] = "-30";
  const result = horizonDays();
  process.env["EVENTSCOUT_HORIZON_DAYS"] = prev ?? "";
  if (prev === undefined) delete process.env["EVENTSCOUT_HORIZON_DAYS"];
  assertEq(result, 120, "horizonDays() falls back to 120 for negative");
});

// ============================================================================
// Section 3: Integration — ingestAllWithAdapters applies horizon filter
// ============================================================================

test("3.1: far-future events from adapter dropped in result", async () => {
  // Fix horizon to 120 days so this test is deterministic regardless of env
  const prevEnv = process.env["EVENTSCOUT_HORIZON_DAYS"];
  delete process.env["EVENTSCOUT_HORIZON_DAYS"];

  const inHorizon = makeEvent(isoOffsetReal(30));
  const beyondHorizon = makeEvent(isoOffsetReal(200));

  const sources = [makeSource("test-horizon-src")];
  const adapters: Record<string, () => Promise<EventItem[]>> = {
    "test-horizon-src": async () => [inHorizon, beyondHorizon],
  };

  const result = await ingestAllWithAdapters(sources, adapters, {
    skipCacheWrite: true,
  });

  // perSource count reflects AFTER the horizon filter (what was kept)
  assertEq(
    result.perSource["test-horizon-src"],
    1,
    "perSource count = 1 (only in-horizon event counted)"
  );
  assertEq(result.written, 1, "written = 1 (far-future event not written)");

  if (prevEnv !== undefined) process.env["EVENTSCOUT_HORIZON_DAYS"] = prevEnv;
});

test("3.2: all in-horizon events returned (none dropped incorrectly)", async () => {
  const prevEnv = process.env["EVENTSCOUT_HORIZON_DAYS"];
  delete process.env["EVENTSCOUT_HORIZON_DAYS"];

  const e1 = makeEvent(isoOffsetReal(10));
  const e2 = makeEvent(isoOffsetReal(50));
  const e3 = makeEvent(isoOffsetReal(90));

  const sources = [makeSource("all-in-horizon")];
  const adapters: Record<string, () => Promise<EventItem[]>> = {
    "all-in-horizon": async () => [e1, e2, e3],
  };

  const result = await ingestAllWithAdapters(sources, adapters, {
    skipCacheWrite: true,
  });

  assertEq(result.perSource["all-in-horizon"], 3, "all 3 in-horizon events kept");
  assertEq(result.written, 3, "written = 3");

  if (prevEnv !== undefined) process.env["EVENTSCOUT_HORIZON_DAYS"] = prevEnv;
});

test("3.3: multi-source — horizon applied to each independently", async () => {
  const prevEnv = process.env["EVENTSCOUT_HORIZON_DAYS"];
  delete process.env["EVENTSCOUT_HORIZON_DAYS"];

  const srcA_in = makeEvent(isoOffsetReal(5));
  const srcA_out = makeEvent(isoOffsetReal(180));
  const srcB_in = makeEvent(isoOffsetReal(45));
  const srcB_out = makeEvent(isoOffsetReal(300));

  const sources = [makeSource("multi-src-a"), makeSource("multi-src-b")];
  const adapters: Record<string, () => Promise<EventItem[]>> = {
    "multi-src-a": async () => [srcA_in, srcA_out],
    "multi-src-b": async () => [srcB_in, srcB_out],
  };

  const result = await ingestAllWithAdapters(sources, adapters, {
    skipCacheWrite: true,
  });

  assertEq(result.perSource["multi-src-a"], 1, "src-a: 1 kept (1 dropped)");
  assertEq(result.perSource["multi-src-b"], 1, "src-b: 1 kept (1 dropped)");
  assertEq(result.written, 2, "written = 2 total across both sources");

  if (prevEnv !== undefined) process.env["EVENTSCOUT_HORIZON_DAYS"] = prevEnv;
});

test("3.4: EVENTSCOUT_HORIZON_DAYS=30 env knob respected in integration", async () => {
  const prevEnv = process.env["EVENTSCOUT_HORIZON_DAYS"];
  process.env["EVENTSCOUT_HORIZON_DAYS"] = "30";

  const eIn30 = makeEvent(isoOffsetReal(20));   // kept: 20 ≤ 30
  const eOut30 = makeEvent(isoOffsetReal(50));  // dropped: 50 > 30

  const sources = [makeSource("knob-test-src")];
  const adapters: Record<string, () => Promise<EventItem[]>> = {
    "knob-test-src": async () => [eIn30, eOut30],
  };

  const result = await ingestAllWithAdapters(sources, adapters, {
    skipCacheWrite: true,
  });

  assertEq(result.perSource["knob-test-src"], 1, "knob=30: only the 20d event kept");
  assertEq(result.written, 1, "written = 1 with 30d horizon");

  process.env["EVENTSCOUT_HORIZON_DAYS"] = prevEnv ?? "";
  if (prevEnv === undefined) delete process.env["EVENTSCOUT_HORIZON_DAYS"];
});
