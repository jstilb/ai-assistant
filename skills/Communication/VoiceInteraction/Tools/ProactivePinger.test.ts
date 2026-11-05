/**
 * ProactivePinger.test.ts - Tests for event-driven proactive voice outreach
 *
 * TDD tests for ProactivePinger refactor:
 * - Ping scheduling and cancellation via StateManager
 * - Channel routing (desktop vs telegram)
 * - Silent recovery on send failures
 * - CLI interface
 *
 * Run: bun test <abs path>/Tools/ProactivePinger.test.ts
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

// Structural check helper: collapse whitespace and unify quote style so a formatter
// (line wrapping, single vs double quotes) cannot break these source assertions.
const readSource = (path: string): string => readFileSync(path, "utf-8").replace(/\s+/g, " ").replace(/'/g, '"');

const TEST_DIR = "/tmp/voice-pinger-tests";
const TOOL_PATH = join(import.meta.dir, "ProactivePinger.ts");

describe("ProactivePinger", () => {
  const SHARED_STATE_DIR = "/tmp/voice-interaction";
  const PINGS_STATE_FILE = join(SHARED_STATE_DIR, "scheduled-pings.json");

  beforeEach(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true });
    }
    mkdirSync(TEST_DIR, { recursive: true });
    // Clean shared state to isolate tests
    if (existsSync(PINGS_STATE_FILE)) {
      rmSync(PINGS_STATE_FILE);
    }
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true });
    }
    // Clean shared state after tests
    if (existsSync(PINGS_STATE_FILE)) {
      rmSync(PINGS_STATE_FILE);
    }
  });

  describe("CLI Interface", () => {
    it("should show help text with no arguments", () => {
      const result = spawnSync("bun", [TOOL_PATH], {
        encoding: "utf-8",
        timeout: 10000,
      });
      expect(result.stdout).toContain("ProactivePinger");
      expect(result.stdout).toContain("send");
      expect(result.stdout).toContain("schedule");
      expect(result.stdout).toContain("list");
      expect(result.stdout).toContain("cancel");
    });

    it("should show help text with --help flag", () => {
      const result = spawnSync("bun", [TOOL_PATH, "--help"], {
        encoding: "utf-8",
        timeout: 10000,
      });
      expect(result.stdout).toContain("ProactivePinger");
    });

    it("should list scheduled pings (empty initially)", () => {
      const result = spawnSync("bun", [TOOL_PATH, "list"], {
        encoding: "utf-8",
        timeout: 10000,
      });
      const parsed = JSON.parse(result.stdout.trim());
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed.length).toBe(0);
    });

    it("should schedule a future ping", () => {
      const futureDate = new Date(Date.now() + 3600000).toISOString();
      const result = spawnSync("bun", [TOOL_PATH, "schedule", "--at", futureDate, "--message", "Test reminder"], {
        encoding: "utf-8",
        timeout: 10000,
      });
      const parsed = JSON.parse(result.stdout.trim());
      expect(parsed.id).toBeDefined();
      expect(parsed.message).toBe("Test reminder");
      expect(parsed.status).toBe("pending");
      expect(parsed.scheduledAt).toBe(futureDate);
    });

    it("should list scheduled pings after scheduling", () => {
      const futureDate = new Date(Date.now() + 3600000).toISOString();

      // Schedule a ping
      spawnSync("bun", [TOOL_PATH, "schedule", "--at", futureDate, "--message", "Listed reminder"], {
        encoding: "utf-8",
        timeout: 10000,
      });

      // List pings
      const result = spawnSync("bun", [TOOL_PATH, "list"], {
        encoding: "utf-8",
        timeout: 10000,
      });
      const parsed = JSON.parse(result.stdout.trim());
      expect(parsed.length).toBeGreaterThan(0);
      expect(parsed[0].message).toBe("Listed reminder");
    });

    it("should cancel a scheduled ping", () => {
      const futureDate = new Date(Date.now() + 3600000).toISOString();

      // Schedule first
      const schedResult = spawnSync("bun", [TOOL_PATH, "schedule", "--at", futureDate, "--message", "Cancel me"], {
        encoding: "utf-8",
        timeout: 10000,
      });
      const scheduled = JSON.parse(schedResult.stdout.trim());

      // Cancel it
      const cancelResult = spawnSync("bun", [TOOL_PATH, "cancel", scheduled.id], { encoding: "utf-8", timeout: 10000 });
      const parsed = JSON.parse(cancelResult.stdout.trim());
      expect(parsed.cancelled).toBe(true);
      expect(parsed.pingId).toBe(scheduled.id);
    });

    it("should handle cancel for non-existent ping", () => {
      const result = spawnSync("bun", [TOOL_PATH, "cancel", "nonexistent-ping-id"], {
        encoding: "utf-8",
        timeout: 10000,
      });
      const parsed = JSON.parse(result.stdout.trim());
      expect(parsed.cancelled).toBe(false);
    });
  });

  describe("StateManager Usage", () => {
    it("should use getPingsManager from VoiceCommon", () => {
      const source = readSource(TOOL_PATH);
      expect(source).toContain("getPingsManager");
      expect(source).toContain('from "./VoiceCommon.ts"');
    });

    it("should not contain raw JSON.parse(readFileSync()) for state", () => {
      const source = readSource(TOOL_PATH);
      const matches = source.match(/JSON\.parse\s*\(\s*readFileSync/g);
      expect(matches).toBeNull();
    });
  });

  describe("Error Handling", () => {
    it("should have top-level error handler on main()", () => {
      const source = readSource(TOOL_PATH);
      expect(source).toContain("main().catch");
    });

    it("should handle desktop playback failures with fallback", () => {
      const source = readSource(TOOL_PATH);
      // Desktop failure should fall back to telegram
      expect(source.includes("falling back to Telegram") || source.includes("fallback")).toBe(true);
    });

    it("should handle telegram voice generation failures with text fallback", () => {
      const source = readSource(TOOL_PATH);
      expect(source).toContain("text fallback");
    });
  });

  describe("No Raw fetch() Calls", () => {
    it("should not contain direct fetch() calls", () => {
      const source = readSource(TOOL_PATH);
      const rawFetchMatches = source.match(/(?<!\w)fetch\s*\(/g);
      expect(rawFetchMatches).toBeNull();
    });
  });

  describe("Silent Recovery Pattern", () => {
    it("should use try/catch for external tool invocations", () => {
      const source = readSource(TOOL_PATH);
      // spawnSync calls that could fail should have error handling
      expect(source.includes("status !== 0") || source.includes("result.status")).toBe(true);
    });

    it("should clean up temp files in finally or catch", () => {
      const source = readSource(TOOL_PATH);
      expect(source).toContain("unlinkSync");
      expect(source).toContain("ignore");
    });
  });
});
