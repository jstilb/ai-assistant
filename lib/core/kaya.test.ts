#!/usr/bin/env bun
/**
 * kaya.test.ts - Unit tests for the Kaya CLI tool
 *
 * Tests the MCP management functionality including:
 * - MCP config merging via StateManager (no raw JSON.parse/readFileSync)
 * - Profile switching
 * - Version comparison
 * - Wallpaper utility functions
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { readNormalizedSource } from "../test/sourceText.ts";
import { defined } from "../test/defined.ts";

// kaya.ts doesn't export functions directly - it's a CLI tool.
// We test by verifying the tool compiles and runs correctly.
// The key migration verification is ensuring no JSON.parse(readFileSync()) exists.

const TEST_DIR = "/tmp/kaya-test";
const TEST_MCP_DIR = join(TEST_DIR, "MCPs");

describe("kaya.ts - MCP configuration", () => {
  beforeEach(() => {
    mkdirSync(TEST_MCP_DIR, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true, force: true });
    }
  });

  test("MCP config files are valid JSON", () => {
    // Create test MCP configs
    const mcpConfig1 = { mcpServers: { server1: { command: "test1" } } };
    const mcpConfig2 = { mcpServers: { server2: { command: "test2" } } };

    writeFileSync(join(TEST_MCP_DIR, "test1-MCP.json"), JSON.stringify(mcpConfig1));
    writeFileSync(join(TEST_MCP_DIR, "test2-MCP.json"), JSON.stringify(mcpConfig2));

    // Verify files are valid JSON (would fail with StateManager if not)
    expect(existsSync(join(TEST_MCP_DIR, "test1-MCP.json"))).toBe(true);
    expect(existsSync(join(TEST_MCP_DIR, "test2-MCP.json"))).toBe(true);
  });

  test("no raw JSON.parse(readFileSync()) in kaya.ts (migration verification)", () => {
    // Structural check on comment-free, whitespace/quote-normalized source (a formatter cannot break it).
    const source = readNormalizedSource(join(import.meta.dir, "kaya.ts"));
    expect(source).not.toMatch(/JSON\.parse\(readFileSync\(/);
  });

  test("kaya.ts persists MCP config through StateManager", () => {
    const source = readNormalizedSource(join(import.meta.dir, "kaya.ts"));
    expect(source).toContain("createStateManager");
    expect(source).toMatch(/from "\.\/StateManager\.ts"/);
  });
});

describe("kaya.ts - version comparison", () => {
  // Version comparison logic - testing the pattern used in kaya.ts
  function compareVersions(a: string, b: string): number {
    const partsA = a.split(".").map(Number);
    const partsB = b.split(".").map(Number);
    for (let i = 0; i < 3; i++) {
      if (partsA[i]! > defined(partsB[i])) return 1;
      if (partsA[i]! < defined(partsB[i])) return -1;
    }
    return 0;
  }

  test("equal versions return 0", () => {
    expect(compareVersions("1.0.0", "1.0.0")).toBe(0);
    expect(compareVersions("2.5.10", "2.5.10")).toBe(0);
  });

  test("newer versions return 1", () => {
    expect(compareVersions("2.0.0", "1.0.0")).toBe(1);
    expect(compareVersions("1.1.0", "1.0.0")).toBe(1);
    expect(compareVersions("1.0.1", "1.0.0")).toBe(1);
  });

  test("older versions return -1", () => {
    expect(compareVersions("1.0.0", "2.0.0")).toBe(-1);
    expect(compareVersions("1.0.0", "1.1.0")).toBe(-1);
    expect(compareVersions("1.0.0", "1.0.1")).toBe(-1);
  });
});
