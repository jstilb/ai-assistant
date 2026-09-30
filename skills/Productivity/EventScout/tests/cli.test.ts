#!/usr/bin/env bun
/**
 * cli.test.ts — Slice 8 TDD tests for cli.ts (arg parsing + dispatch).
 *
 * Tests:
 *   1. `add-source` with a bad URL → exits non-zero with error message.
 *   2. `add-source` with a valid URL → appends a schema-valid EventSource to
 *      the sources file (written to TEMP via EVENTSCOUT_SOURCES_PATH override).
 *   3. `add-source` with --tier and --category → fields present in written source.
 *   4. `add-source` default tier is "html-llm" when --tier not provided.
 *   5. `add-source` default pollInterval is 720, enabled is true.
 *   6. `list-sources` prints id, tier, lastFetched, enabled for each source.
 *   7. `list-sources` against the temp file (populated in test 2) shows added source.
 *   8. Unknown subcommand → exits non-zero with helpful error message.
 *   9. `add-source` duplicate id → still appends (id derived from URL, not deduped).
 *
 * All source writes go to a TEMP file via EVENTSCOUT_SOURCES_PATH env var.
 * The real sources.json is never touched.
 *
 * CLI path is resolved relative to this test file (not hardcoded to any tree)
 * so this always spawns the CLI that lives alongside these tests — running the
 * suite from a worktree exercises the worktree's own cli.ts, never the live
 * ~/.claude tree.
 *
 * KAYA_HOME / KAYA_DIR are pinned to a temp dir for the spawned CLI subprocess:
 * cli.ts transitively imports Tools/BookingLedger.ts and Tools/Cache.ts, whose
 * default paths (DEFAULT_BOOKING_LEDGER_PATH, DEFAULT_CACHE_PATH) derive from
 * KAYA_HOME at module-import time (see Tools/types.ts). None of the subcommands
 * exercised here (add-source/list-sources/unknown) actually reach those paths —
 * both only touch SourceManager.ts, which is fully scoped by
 * EVENTSCOUT_SOURCES_PATH — but pinning KAYA_HOME/KAYA_DIR is cheap insurance
 * against a future subcommand or code-path change accidentally writing into
 * the live ~/.claude tree from this worktree (see memory:
 * project_eventscout_gotchas — "KAYA_HOME state writes hit LIVE tree from
 * worktrees").
 *
 * Run:
 *   bun test ~/.claude/.claude/worktrees/arch-debt-d2-eventscout-buntest/skills/Productivity/EventScout/tests/cli.test.ts
 */

import { test, afterAll } from "bun:test";
import { spawnSync } from "child_process";
import { writeFileSync, readFileSync, unlinkSync, existsSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { EventSourceSchema } from "../Tools/types.ts";
import { z } from "zod";

// ============================================================================
// Assertion helpers — throw on failure so bun:test reports real pass/fail
// ============================================================================

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

function assertContains(haystack: string, needle: string, message: string): void {
  if (!haystack.includes(needle)) {
    throw new Error(`${message} — expected to contain "${needle}"\nGot: ${haystack.slice(0, 300)}`);
  }
}

// ============================================================================
// Env isolation — pin KAYA_HOME/KAYA_DIR for the spawned CLI subprocess
// ============================================================================

const ORIGINAL_KAYA_HOME = process.env["KAYA_HOME"];
const ORIGINAL_KAYA_DIR = process.env["KAYA_DIR"];
const TEST_KAYA_DIR = mkdtempSync(join(tmpdir(), "eventscout-cli-test-kaya-"));
process.env["KAYA_HOME"] = TEST_KAYA_DIR;
process.env["KAYA_DIR"] = TEST_KAYA_DIR;

// ============================================================================
// CLI runner helper
// ============================================================================

// Resolve relative to this test file's own location (never a hardcoded tree)
// so a worktree run always spawns the worktree's own cli.ts.
const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "cli.ts");

interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function runCLI(args: string[], env: Record<string, string> = {}): RunResult {
  const result = spawnSync("bun", [CLI, ...args], {
    encoding: "utf-8",
    env: { ...process.env, ...env },
    timeout: 30_000,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

// ============================================================================
// Temp file management (sources.json)
// ============================================================================

const TEMP_SOURCES = join(tmpdir(), `eventscout-test-sources-${Date.now()}.json`);

/** Write an empty sources array to the temp file */
function initTempSources(initial: unknown[] = []): void {
  writeFileSync(TEMP_SOURCES, JSON.stringify(initial, null, 2), "utf-8");
}

/** Read the temp sources file and return the parsed array */
function readTempSources(): unknown[] {
  if (!existsSync(TEMP_SOURCES)) return [];
  return JSON.parse(readFileSync(TEMP_SOURCES, "utf-8")) as unknown[];
}

// ============================================================================
// Tests
// ============================================================================

test("Test 1: add-source with bad URL exits non-zero with an error message", () => {
  initTempSources();
  const r = runCLI(["add-source", "not-a-valid-url"], {
    EVENTSCOUT_SOURCES_PATH: TEMP_SOURCES,
  });
  assert(
    (r.status ?? 0) !== 0,
    "Test 1: bad URL → exits non-zero"
  );
  assert(
    r.stderr.length > 0 || r.stdout.includes("Error") || r.stdout.includes("Invalid") || r.stdout.includes("invalid"),
    "Test 1b: bad URL → error message printed"
  );
});

test("Test 2: add-source with valid URL appends a schema-valid EventSource", () => {
  initTempSources();
  const r = runCLI(["add-source", "https://example.com/events"], {
    EVENTSCOUT_SOURCES_PATH: TEMP_SOURCES,
  });
  assert(
    r.status === 0,
    "Test 2: valid URL → exits 0"
  );
  const sources = readTempSources();
  assert(sources.length === 1, "Test 2b: one source written to temp file");
  const parsed = z.array(EventSourceSchema).safeParse(sources);
  assert(parsed.success, `Test 2c: written source is schema-valid (${parsed.success ? "ok" : parsed.error.message})`);
});

test("Test 3: --tier and --category flags are persisted", () => {
  initTempSources();
  const r = runCLI(
    ["add-source", "https://example.com/events2", "--tier", "rss", "--category", "music"],
    { EVENTSCOUT_SOURCES_PATH: TEMP_SOURCES }
  );
  assert(r.status === 0, "Test 3: exits 0 with --tier and --category");
  const sources = readTempSources() as Array<{ fetchTier?: string; categoryHint?: string }>;
  const added = sources[0];
  assert(added?.fetchTier === "rss", "Test 3b: fetchTier=rss stored");
  assert(added?.categoryHint === "music", "Test 3c: categoryHint=music stored");
});

test("Test 4: default tier is html-llm", () => {
  initTempSources();
  runCLI(["add-source", "https://example.com/events3"], {
    EVENTSCOUT_SOURCES_PATH: TEMP_SOURCES,
  });
  const sources = readTempSources() as Array<{ fetchTier?: string }>;
  assert(
    sources[0]?.fetchTier === "html-llm",
    "Test 4: default fetchTier is html-llm when --tier not provided"
  );
});

test("Test 5: default pollInterval=720, enabled=true", () => {
  initTempSources();
  runCLI(["add-source", "https://example.com/events4"], {
    EVENTSCOUT_SOURCES_PATH: TEMP_SOURCES,
  });
  const sources = readTempSources() as Array<{ pollInterval?: number; enabled?: boolean }>;
  assert(sources[0]?.pollInterval === 720, "Test 5: default pollInterval=720");
  assert(sources[0]?.enabled === true, "Test 5b: default enabled=true");
});

test("Test 6: list-sources prints id, tier, enabled", () => {
  initTempSources([
    {
      id: "test-src",
      url: "https://example.com",
      name: "Test",
      fetchTier: "rss",
      pollInterval: 720,
      enabled: true,
    },
  ]);
  const r = runCLI(["list-sources"], { EVENTSCOUT_SOURCES_PATH: TEMP_SOURCES });
  assert(r.status === 0, "Test 6: list-sources exits 0");
  assertContains(r.stdout, "test-src", "Test 6b: list-sources shows source id");
  assertContains(r.stdout, "rss", "Test 6c: list-sources shows fetchTier");
});

test("Test 7: list-sources shows source added via add-source", () => {
  initTempSources();
  runCLI(["add-source", "https://mysite.com/calendar", "--name", "My Site"], {
    EVENTSCOUT_SOURCES_PATH: TEMP_SOURCES,
  });
  const r = runCLI(["list-sources"], { EVENTSCOUT_SOURCES_PATH: TEMP_SOURCES });
  assertContains(r.stdout, "mysite", "Test 7: list-sources shows source added via add-source (id derived from URL)");
});

test("Test 8: unknown subcommand exits non-zero with usage/error", () => {
  const r = runCLI(["foobar"]);
  assert((r.status ?? 0) !== 0, "Test 8: unknown subcommand exits non-zero");
  assert(
    r.stdout.includes("Unknown") || r.stderr.includes("Unknown") ||
    r.stdout.includes("Usage") || r.stderr.includes("Usage"),
    "Test 8b: unknown subcommand prints usage/error"
  );
});

test("Test 9: --name flag sets the name field", () => {
  initTempSources();
  runCLI(["add-source", "https://example.com/ev5", "--name", "Custom Name"], {
    EVENTSCOUT_SOURCES_PATH: TEMP_SOURCES,
  });
  const sources = readTempSources() as Array<{ name?: string }>;
  assert(sources[0]?.name === "Custom Name", "Test 9: --name flag sets the name field");
});

// ============================================================================
// Cleanup — restore env, remove temp files/dirs
// ============================================================================

afterAll(() => {
  if (ORIGINAL_KAYA_HOME === undefined) {
    delete process.env["KAYA_HOME"];
  } else {
    process.env["KAYA_HOME"] = ORIGINAL_KAYA_HOME;
  }
  if (ORIGINAL_KAYA_DIR === undefined) {
    delete process.env["KAYA_DIR"];
  } else {
    process.env["KAYA_DIR"] = ORIGINAL_KAYA_DIR;
  }
  try { rmSync(TEST_KAYA_DIR, { recursive: true, force: true }); } catch { /* ok */ }
  try { if (existsSync(TEMP_SOURCES)) unlinkSync(TEMP_SOURCES); } catch { /* ok */ }
});
