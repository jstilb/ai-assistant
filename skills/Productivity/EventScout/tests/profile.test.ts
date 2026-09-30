#!/usr/bin/env bun
/**
 * profile.test.ts — TDD tests for InterestProfile.ts (no network).
 *
 * Slice 4 (2026-07): InterestProfile slims to {homeLocation, defaultRadiusMiles}
 * only. The former hand-seeded taste fields and the gated feedback-learning
 * section were deleted — Ranker.ts never read them (ranking is pure LLM
 * scoring against the raw query text) and the module that wrote the learning
 * section had zero consumers of its output. See SKILL.md's "Editing
 * InterestProfile.json".
 *
 * Tests:
 *   1. loadProfile() reads and validates the seed InterestProfile.json.
 *   2. loadProfile() rejects a malformed JSON file (missing required fields).
 *   3. EVENTSCOUT_PROFILE_PATH env override is honoured.
 *   4. homeLocation is valid lat/lng for San Diego.
 *   5. defaultRadiusMiles is a positive number.
 *
 * Env isolation: InterestProfile.ts value-imports InterestProfileSchema from
 * Tools/types.ts, which computes DEFAULT_CACHE_PATH from KAYA_HOME/KAYA_DIR
 * at import time (falling back to `${HOME}/.claude` — the LIVE main tree —
 * when unset). InterestProfile.ts itself never reads that constant (its own
 * default profile path is resolved relative to its own file location, not
 * KAYA_HOME), but per the hazard class documented in
 * project_eventscout_gotchas, KAYA_HOME/KAYA_DIR are still pinned to a
 * mkdtempSync dir BEFORE InterestProfile.ts is ever imported (via dynamic
 * import), and restored in afterAll for the shared bun:test process.
 *
 * Run:
 *   bun test ~/.claude/.claude/worktrees/arch-debt-d2-eventscout-buntest/skills/Productivity/EventScout/tests/profile.test.ts
 */

import { test, afterAll } from "bun:test";
import { writeFileSync, mkdirSync, existsSync, mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// ============================================================================
// Env isolation — pin KAYA_HOME/KAYA_DIR before importing Tools code.
// ============================================================================

const ORIGINAL_KAYA_HOME = process.env["KAYA_HOME"];
const ORIGINAL_KAYA_DIR = process.env["KAYA_DIR"];

const TEST_KAYA_HOME = mkdtempSync(join(tmpdir(), "eventscout-profile-test-"));
process.env["KAYA_HOME"] = TEST_KAYA_HOME;
process.env["KAYA_DIR"] = TEST_KAYA_HOME;

const { loadProfile } = await import("../Tools/InterestProfile.ts");

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
      `Assertion failed: ${message}\n    expected: ${JSON.stringify(expected)}\n    actual:   ${JSON.stringify(actual)}`
    );
  }
}

// ============================================================================
// Helpers
// ============================================================================

const TMP_DIR = join(TEST_KAYA_HOME, "es-profile-test");
if (!existsSync(TMP_DIR)) mkdirSync(TMP_DIR, { recursive: true });

function writeTmpProfile(name: string, content: unknown): string {
  const path = join(TMP_DIR, `${name}.json`);
  writeFileSync(path, JSON.stringify(content, null, 2));
  return path;
}

function withProfileEnv(path: string, fn: () => unknown): unknown {
  const prev = process.env["EVENTSCOUT_PROFILE_PATH"];
  process.env["EVENTSCOUT_PROFILE_PATH"] = path;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env["EVENTSCOUT_PROFILE_PATH"];
    else process.env["EVENTSCOUT_PROFILE_PATH"] = prev;
  }
}

// ============================================================================
// Tests
// ============================================================================

test("1. loadProfile() reads and validates the seed InterestProfile.json", async () => {
  // Load the actual seed (no env override)
  const prev = process.env["EVENTSCOUT_PROFILE_PATH"];
  delete process.env["EVENTSCOUT_PROFILE_PATH"];
  try {
    const profile = await loadProfile();
    assert(profile !== undefined, "profile is defined");
    assert(typeof profile.homeLocation === "object", "homeLocation is an object");
    assert(typeof profile.homeLocation.lat === "number", "homeLocation.lat is a number");
    assert(typeof profile.homeLocation.lng === "number", "homeLocation.lng is a number");
    assert(typeof profile.defaultRadiusMiles === "number", "defaultRadiusMiles is a number");
  } finally {
    if (prev === undefined) delete process.env["EVENTSCOUT_PROFILE_PATH"];
    else process.env["EVENTSCOUT_PROFILE_PATH"] = prev;
  }
});

test("2. loadProfile() rejects a malformed JSON file (missing required fields)", async () => {
  const badPath = writeTmpProfile("bad-profile", {
    // Missing all required fields
    notAProfile: true,
  });
  let threw = false;
  try {
    const result = await (withProfileEnv(badPath, () => loadProfile()) as ReturnType<typeof loadProfile>);
    void result; // Should not reach here
  } catch {
    threw = true;
  }
  assert(threw, "loadProfile() throws on malformed profile");
});

test("3. EVENTSCOUT_PROFILE_PATH env override is honoured", async () => {
  const customProfile = {
    homeLocation: { lat: 33.0, lng: -117.5, label: "Custom Location" },
    defaultRadiusMiles: 20,
  };
  const customPath = writeTmpProfile("custom-profile", customProfile);
  process.env["EVENTSCOUT_PROFILE_PATH"] = customPath;
  try {
    const profile = await loadProfile();
    assert(profile.homeLocation.label === "Custom Location", "loads from custom path");
    assertEq(profile.defaultRadiusMiles, 20, "custom radius is 20");
  } finally {
    delete process.env["EVENTSCOUT_PROFILE_PATH"];
  }
});

test("4. homeLocation is valid lat/lng for San Diego", async () => {
  const prev = process.env["EVENTSCOUT_PROFILE_PATH"];
  delete process.env["EVENTSCOUT_PROFILE_PATH"];
  try {
    const profile = await loadProfile();
    // San Diego lat roughly 32.7, lng roughly -117.2
    assert(profile.homeLocation.lat > 32 && profile.homeLocation.lat < 33.5, "lat is in San Diego range");
    assert(profile.homeLocation.lng < -117 && profile.homeLocation.lng > -118, "lng is in San Diego range");
    assert(profile.homeLocation.label.length > 0, "label is non-empty");
  } finally {
    if (prev === undefined) delete process.env["EVENTSCOUT_PROFILE_PATH"];
    else process.env["EVENTSCOUT_PROFILE_PATH"] = prev;
  }
});

test("5. defaultRadiusMiles is a positive number", async () => {
  const prev = process.env["EVENTSCOUT_PROFILE_PATH"];
  delete process.env["EVENTSCOUT_PROFILE_PATH"];
  try {
    const profile = await loadProfile();
    assert(
      typeof profile.defaultRadiusMiles === "number" && profile.defaultRadiusMiles > 0,
      "defaultRadiusMiles is a positive number",
    );
  } finally {
    if (prev === undefined) delete process.env["EVENTSCOUT_PROFILE_PATH"];
    else process.env["EVENTSCOUT_PROFILE_PATH"] = prev;
  }
});
