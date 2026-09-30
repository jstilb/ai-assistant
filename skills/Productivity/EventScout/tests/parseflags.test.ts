#!/usr/bin/env bun
/**
 * parseflags.test.ts — Unit tests for parseFlags in cli.ts.
 *
 * Covers boolean flag handling: --refresh must not swallow the next positional
 * or value-bearing flag, regardless of position.
 *
 * Run:
 *   bun test skills/Productivity/EventScout/tests/parseflags.test.ts  (absolute path)
 */

import { test } from "bun:test";
import { parseFlags } from "../cli.ts";

// ============================================================================
// Test harness — assert THROWS on failure so bun:test marks the test failed.
// ============================================================================

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

// ============================================================================
// Tests
// ============================================================================

test("T1: --refresh before --limit 3 — boolean flag must not swallow value", () => {
  const args = ["query", "comedy", "--refresh", "--limit", "3"];
  const { flags, positional } = parseFlags(args);
  assert(
    positional.includes("comedy") && !positional.includes("3"),
    'T1: positional contains "comedy" and NOT "3" when --refresh precedes --limit'
  );
  assert(
    "refresh" in flags,
    "T1: flags has refresh key"
  );
  assert(
    flags["limit"] === "3",
    'T1: flags.limit === "3"'
  );
});

test("T2: --limit before --refresh — order independent", () => {
  const args = ["query", "comedy", "--limit", "3", "--refresh"];
  const { flags, positional } = parseFlags(args);
  assert(
    positional.includes("comedy") && !positional.includes("3"),
    'T2: positional contains "comedy" and NOT "3" when --limit precedes --refresh'
  );
  assert(
    "refresh" in flags,
    "T2: flags has refresh key"
  );
  assert(
    flags["limit"] === "3",
    'T2: flags.limit === "3"'
  );
});

test("T3: trailing boolean flag (no following token)", () => {
  const args = ["query", "comedy", "--refresh"];
  const { flags, positional } = parseFlags(args);
  assert(
    positional.length === 2 && positional[0] === "query" && positional[1] === "comedy",
    'T3: positional is ["query","comedy"] with trailing --refresh'
  );
  assert(
    "refresh" in flags,
    "T3: flags has refresh key"
  );
});

test("T4: value-bearing flag still works correctly", () => {
  const args = ["add-source", "https://example.com", "--tier", "html-llm"];
  const { flags, positional } = parseFlags(args);
  assert(
    flags["tier"] === "html-llm",
    "T4: --tier html-llm parses correctly"
  );
  assert(
    positional.includes("https://example.com"),
    "T4: URL stays in positional"
  );
});

test("T5: multiple value flags alongside a boolean flag", () => {
  const args = ["query", "concerts", "--refresh", "--limit", "5", "--category", "music"];
  const { flags, positional } = parseFlags(args);
  assert(
    positional.includes("concerts") && !positional.includes("5") && !positional.includes("music"),
    "T5: only non-flag tokens in positional"
  );
  assert("refresh" in flags, "T5: refresh key present");
  assert(flags["limit"] === "5", 'T5: limit === "5"');
  assert(flags["category"] === "music", 'T5: category === "music"');
});
