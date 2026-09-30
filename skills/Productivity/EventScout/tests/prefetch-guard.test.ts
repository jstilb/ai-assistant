#!/usr/bin/env bun
/**
 * prefetch-guard.test.ts — Unit tests for PrefetchGuard.ts
 *
 * Run:
 *   bun test ~/.claude/.claude/worktrees/arch-debt-d2-eventscout-buntest/skills/Productivity/EventScout/tests/prefetch-guard.test.ts
 *
 * Tests the three liveness conditions:
 *   1. Missing cache → unhealthy
 *   2. Stale cache (mtime outside freshness window) → unhealthy
 *   3. Fresh cache with 0 events → unhealthy
 *   4. Fresh cache with events → healthy
 *   5. Corrupt JSON → unhealthy
 *
 * Env isolation: PrefetchGuard.ts takes an explicit cachePath argument and
 * has no import from Tools/types.ts at all (not even type-only) — it has no
 * KAYA_HOME coupling and every fixture path below is scoped under a unique
 * os.tmpdir() subdirectory per test. KAYA_HOME/KAYA_DIR are still pinned to
 * a mkdtempSync dir before the dynamic import, as defense-in-depth for the
 * shared bun:test process (project_eventscout_gotchas hazard class), and
 * restored in afterAll.
 */

import { test, afterAll } from "bun:test";
import { writeFileSync, utimesSync, mkdirSync, existsSync, mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// ============================================================================
// Env isolation — pin KAYA_HOME/KAYA_DIR before importing Tools code.
// ============================================================================

const ORIGINAL_KAYA_HOME = process.env["KAYA_HOME"];
const ORIGINAL_KAYA_DIR = process.env["KAYA_DIR"];

const TEST_KAYA_HOME = mkdtempSync(join(tmpdir(), "eventscout-prefetch-guard-test-"));
process.env["KAYA_HOME"] = TEST_KAYA_HOME;
process.env["KAYA_DIR"] = TEST_KAYA_HOME;

const { isPrefetchHealthy } = await import("../Tools/PrefetchGuard.ts");

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

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEqual<T>(actual: T, expected: T, label?: string): void {
  if (actual !== expected) {
    throw new Error(
      `${label ? label + ": " : ""}expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`
    );
  }
}

// ============================================================================
// Helpers
// ============================================================================

const TMP = tmpdir();

/** Write a minimal valid events-cache.json with `count` synthetic events */
function writeCache(dir: string, count: number): string {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const path = join(dir, "events-cache.json");
  const events = Array.from({ length: count }, (_, i) => ({
    id: `evt-${i}`,
    title: `Test Event ${i}`,
    startDatetime: "2099-01-01T00:00:00Z",
    venue: "Test Venue",
    category: "other",
    sources: ["test"],
    fetchedAt: new Date().toISOString(),
  }));
  writeFileSync(path, JSON.stringify({ events, lastUpdated: new Date().toISOString() }), "utf-8");
  return path;
}

/** Backdate a file's mtime by `deltaMs` milliseconds */
function backdateFile(path: string, deltaMs: number): void {
  const oldMs = Date.now() - deltaMs;
  const oldDate = new Date(oldMs);
  utimesSync(path, oldDate, oldDate);
}

// ============================================================================
// Tests
// ============================================================================

const WINDOW_MS = 10 * 60 * 1000; // 10 minute freshness window for tests
const NOW = Date.now();

// --- Case 1: Missing file ---
test("missing cache file → unhealthy", () => {
  const result = isPrefetchHealthy("/tmp/does-not-exist-xyz.json", WINDOW_MS, NOW);
  assertEqual(result.healthy, false, "healthy");
  assert(result.reason?.includes("not found") ?? false, `reason should mention 'not found', got: ${result.reason}`);
});

// --- Case 2: Stale file (mtime 30 min ago, window 10 min) ---
test("stale cache (30min old, 10min window) → unhealthy", () => {
  const dir = join(TMP, `es-guard-stale-${Date.now()}`);
  const path = writeCache(dir, 5);
  backdateFile(path, 30 * 60 * 1000); // 30 min ago
  const result = isPrefetchHealthy(path, WINDOW_MS, NOW);
  assertEqual(result.healthy, false, "healthy");
  assert(result.reason?.includes("stale") ?? false, `reason should mention 'stale', got: ${result.reason}`);
  assert((result.ageMs ?? 0) > 0, "ageMs should be positive");
});

// --- Case 3: Fresh file but 0 events ---
test("fresh cache with 0 events → unhealthy", () => {
  const dir = join(TMP, `es-guard-empty-${Date.now()}`);
  const path = writeCache(dir, 0);
  // mtime is fresh (just written)
  const result = isPrefetchHealthy(path, WINDOW_MS, NOW);
  assertEqual(result.healthy, false, "healthy");
  assertEqual(result.eventCount, 0, "eventCount");
  assert(result.reason?.includes("0 events") ?? false, `reason should mention '0 events', got: ${result.reason}`);
});

// --- Case 4: Fresh file with events → healthy ---
test("fresh cache with 10 events → healthy", () => {
  const dir = join(TMP, `es-guard-ok-${Date.now()}`);
  const path = writeCache(dir, 10);
  const result = isPrefetchHealthy(path, WINDOW_MS, NOW);
  assertEqual(result.healthy, true, "healthy");
  assertEqual(result.eventCount, 10, "eventCount");
  assert((result.ageMs ?? Infinity) < WINDOW_MS, "ageMs should be within freshness window");
});

// --- Case 5: Fresh file with 1 event → healthy (edge case boundary) ---
test("fresh cache with exactly 1 event → healthy", () => {
  const dir = join(TMP, `es-guard-one-${Date.now()}`);
  const path = writeCache(dir, 1);
  const result = isPrefetchHealthy(path, WINDOW_MS, NOW);
  assertEqual(result.healthy, true, "healthy");
  assertEqual(result.eventCount, 1, "eventCount");
});

// --- Case 6: Corrupt JSON ---
test("corrupt JSON cache → unhealthy", () => {
  const dir = join(TMP, `es-guard-corrupt-${Date.now()}`);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const path = join(dir, "events-cache.json");
  writeFileSync(path, "{ not valid json !! }}", "utf-8");
  const result = isPrefetchHealthy(path, WINDOW_MS, NOW);
  assertEqual(result.healthy, false, "healthy");
  assert(result.reason?.includes("parse") ?? false, `reason should mention parsing, got: ${result.reason}`);
});

// --- Case 7: Cache file missing "events" key (wrong shape) ---
test("cache file with no events array → 0 events → unhealthy", () => {
  const dir = join(TMP, `es-guard-noshape-${Date.now()}`);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const path = join(dir, "events-cache.json");
  writeFileSync(path, JSON.stringify({ wrongKey: [] }), "utf-8");
  const result = isPrefetchHealthy(path, WINDOW_MS, NOW);
  assertEqual(result.healthy, false, "healthy");
  assertEqual(result.eventCount, 0, "eventCount");
});

// --- Case 8: File just within the freshness window boundary ---
test("cache written exactly at window boundary → unhealthy (stale)", () => {
  const dir = join(TMP, `es-guard-boundary-${Date.now()}`);
  const path = writeCache(dir, 5);
  // Set mtime to exactly WINDOW_MS ago — that's NOT within the window (>)
  backdateFile(path, WINDOW_MS + 1000); // 1s past the boundary
  const result = isPrefetchHealthy(path, WINDOW_MS, NOW);
  assertEqual(result.healthy, false, "healthy");
});

// --- Case 9: Custom sinceMs respected ---
test("custom sinceMs=60s — file written 30s ago → healthy", () => {
  const dir = join(TMP, `es-guard-custom-${Date.now()}`);
  const path = writeCache(dir, 3);
  backdateFile(path, 30 * 1000); // 30s ago
  const result = isPrefetchHealthy(path, 60 * 1000, NOW); // 60s window
  assertEqual(result.healthy, true, "healthy");
  assertEqual(result.eventCount, 3, "eventCount");
});
