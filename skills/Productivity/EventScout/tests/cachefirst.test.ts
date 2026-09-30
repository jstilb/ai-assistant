#!/usr/bin/env bun
/**
 * cachefirst.test.ts — Slice 1 TDD tests for cache-first refresh selection.
 *
 * Re-intake (2026-07): the old NL refresh-intent-sniffing section is
 * DELETED — refresh is now decided by the CLI's --refresh flag alone (see
 * cli.ts's buildQueryContext / queryflags.test.ts). The word-matcher and its
 * trigger-phrase table are deleted from RefreshIntent.ts in this same slice,
 * alongside ConstraintParser.ts. selectRefreshSources — the mechanism that
 * decides WHICH sources to live-refresh once a refresh has been requested —
 * is UNCHANGED and still fully covered below.
 *
 * Tests:
 *   selectRefreshSources({ refresh, sources, constraints }):
 *    1.  refresh=false → [] (nothing, even highValue stale)
 *    2.  refresh=true, no constraints → all enabled sources (regardless of staleness)
 *    3.  refresh=true, category music → comedy-hinted source excluded, no-hint included
 *    4.  refresh=true, highValue=true source → included (highValue has no EXTRA effect)
 *    5.  refresh=false, highValue=true source → NOT returned (refresh=false beats all)
 *    6.  disabled source never returned (refresh=true)
 *    7.  disabled source never returned (refresh=false)
 *    8.  fresh source with no highValue included on refresh=true (staleness ignored)
 *    9.  stale source with comedy hint excluded from music constraints on refresh=true
 *
 * Env isolation: RefreshIntent.ts only has a type-only import from
 * Tools/types.ts (no runtime module evaluation) and does zero file I/O — it
 * has no actual KAYA_HOME coupling. KAYA_HOME/KAYA_DIR are still pinned to a
 * mkdtempSync dir before the dynamic import below, as defense-in-depth for
 * the shared bun:test process (project_eventscout_gotchas hazard class),
 * and restored in afterAll.
 *
 * Run:
 *   bun test ~/.claude/.claude/worktrees/arch-debt-d2-eventscout-buntest/skills/Productivity/EventScout/tests/cachefirst.test.ts
 */

import { test, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { EventSource, ConstraintSet } from "../Tools/types.ts";

// ============================================================================
// Env isolation — pin KAYA_HOME/KAYA_DIR before importing Tools code.
// ============================================================================

const ORIGINAL_KAYA_HOME = process.env["KAYA_HOME"];
const ORIGINAL_KAYA_DIR = process.env["KAYA_DIR"];

const TEST_KAYA_HOME = mkdtempSync(join(tmpdir(), "eventscout-cachefirst-test-"));
process.env["KAYA_HOME"] = TEST_KAYA_HOME;
process.env["KAYA_DIR"] = TEST_KAYA_HOME;

const { selectRefreshSources } = await import("../Tools/RefreshIntent.ts");

afterAll(() => {
  if (ORIGINAL_KAYA_HOME === undefined) delete process.env["KAYA_HOME"];
  else process.env["KAYA_HOME"] = ORIGINAL_KAYA_HOME;
  if (ORIGINAL_KAYA_DIR === undefined) delete process.env["KAYA_DIR"];
  else process.env["KAYA_DIR"] = ORIGINAL_KAYA_DIR;
  rmSync(TEST_KAYA_HOME, { recursive: true, force: true });
});

// ============================================================================
// Test harness
// ============================================================================

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

function assertEq<T>(actual: T, expected: T, message: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `${message} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`
    );
  }
}

// ============================================================================
// Fixtures
// ============================================================================

const NOW = new Date("2026-06-01T12:00:00Z");
const POLL = 720;

function staleTs(): string {
  return new Date(NOW.getTime() - 13 * 60 * 60 * 1000).toISOString();
}

function freshTs(): string {
  return new Date(NOW.getTime() - 1 * 60 * 60 * 1000).toISOString();
}

function makeSource(overrides: Partial<EventSource>): EventSource {
  return {
    id: "test-source",
    url: "https://example.com",
    name: "Test Source",
    fetchTier: "html-llm",
    pollInterval: POLL,
    enabled: true,
    ...overrides,
  };
}

function noConstraints(): ConstraintSet {
  return { rawQuery: "anything" };
}

function musicConstraints(): ConstraintSet {
  return { rawQuery: "music shows", categories: ["music"] };
}

// ============================================================================
// selectRefreshSources tests
// ============================================================================

test("Test 1: refresh=false → [] (nothing returned, even highValue stale)", () => {
  const hvStale = makeSource({ id: "hv-stale", highValue: true, lastFetched: staleTs() });
  const stale = makeSource({ id: "stale", lastFetched: staleTs() });
  const result = selectRefreshSources({
    refresh: false,
    sources: [hvStale, stale],
    constraints: noConstraints(),
  });
  assertEq(result.length, 0, "Test 1: refresh=false → [] (nothing returned, even highValue stale)");
});

test("Test 2: refresh=true + no constraints → all 3 enabled sources", () => {
  const fresh = makeSource({ id: "fresh", lastFetched: freshTs() });
  const stale = makeSource({ id: "stale2", lastFetched: staleTs() });
  const neverFetched = makeSource({ id: "never" });
  const result = selectRefreshSources({
    refresh: true,
    sources: [fresh, stale, neverFetched],
    constraints: noConstraints(),
  });
  assertEq(result.length, 3, "Test 2: refresh=true + no constraints → all 3 enabled sources");
});

test("Test 3: refresh=true + music constraints → comedy excluded, no-hint included", () => {
  const comedy = makeSource({ id: "comedy", categoryHint: "comedy", lastFetched: freshTs() });
  const music = makeSource({ id: "music", categoryHint: "music", lastFetched: freshTs() });
  const noHint = makeSource({ id: "nohint", lastFetched: freshTs() });
  const result = selectRefreshSources({
    refresh: true,
    sources: [comedy, music, noHint],
    constraints: musicConstraints(),
  });
  assert(!result.some((s) => s.id === "comedy"), "Test 3a: comedy source excluded from music query");
  assert(result.some((s) => s.id === "music"), "Test 3b: music source included in music query");
  assert(result.some((s) => s.id === "nohint"), "Test 3c: no-hint source included in music query");
});

test("Test 4: refresh=true, highValue=true source is included (same as any enabled source)", () => {
  const hv = makeSource({ id: "hv", highValue: true, lastFetched: freshTs() });
  const result = selectRefreshSources({
    refresh: true,
    sources: [hv],
    constraints: noConstraints(),
  });
  assert(result.some((s) => s.id === "hv"), "Test 4: highValue=true included on refresh=true (no special exclusion)");
});

test("Test 5: refresh=false, highValue=true source → NOT returned", () => {
  const hv = makeSource({ id: "hv2", highValue: true, lastFetched: staleTs() });
  const result = selectRefreshSources({
    refresh: false,
    sources: [hv],
    constraints: noConstraints(),
  });
  assert(!result.some((s) => s.id === "hv2"), "Test 5: refresh=false beats highValue=true → not returned");
});

test("Test 6: disabled source never returned when refresh=true", () => {
  const disabled = makeSource({ id: "dis1", enabled: false, lastFetched: staleTs() });
  const result = selectRefreshSources({
    refresh: true,
    sources: [disabled],
    constraints: noConstraints(),
  });
  assert(!result.some((s) => s.id === "dis1"), "Test 6: disabled source not returned (refresh=true)");
});

test("Test 7: disabled source never returned when refresh=false", () => {
  const disabled = makeSource({ id: "dis2", enabled: false, lastFetched: staleTs() });
  const result = selectRefreshSources({
    refresh: false,
    sources: [disabled],
    constraints: noConstraints(),
  });
  assert(!result.some((s) => s.id === "dis2"), "Test 7: disabled source not returned (refresh=false)");
});

test("Test 8: fresh source (no highValue) included on refresh=true (staleness ignored)", () => {
  const fresh = makeSource({ id: "fresh2", lastFetched: freshTs(), highValue: false });
  const result = selectRefreshSources({
    refresh: true,
    sources: [fresh],
    constraints: noConstraints(),
  });
  assert(result.some((s) => s.id === "fresh2"), "Test 8: fresh source (no highValue) included on refresh=true");
});

test("Test 9: stale comedy source excluded from music constraints on refresh=true", () => {
  const comedy = makeSource({ id: "comedy2", categoryHint: "comedy", lastFetched: staleTs() });
  const result = selectRefreshSources({
    refresh: true,
    sources: [comedy],
    constraints: musicConstraints(),
  });
  assert(!result.some((s) => s.id === "comedy2"), "Test 9: stale comedy source excluded from music query on refresh=true");
});
