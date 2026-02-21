/**
 * ProactivePinger.test.ts - Tests for event-driven proactive voice outreach
 *
 * TDD tests for ProactivePinger refactor:
 * - Ping scheduling and cancellation via StateManager
 * - Channel routing (desktop vs telegram)
 * - Silent recovery on send failures
 * - CLI interface
 *
 * Run: npx vitest run Tools/__tests__/ProactivePinger.test.ts
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, rmSync, readFileSync } from "fs";
import { join } from "path";
import { spawnSync } from "child_process";

const TEST_DIR = "/tmp/voice-pinger-tests";
const TOOL_PATH = join(
  process.env.HOME || "",
  ".claude/skills/VoiceInteraction/Tools/ProactivePinger.ts"
);

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
      const futureDate = new Date(
        Date.now() + 3600000
      ).toISOString();
      const result = spawnSync(
        "bun",
        [
          TOOL_PATH,
          "schedule",
          "--at",
          futureDate,
          "--message",
          "Test reminder",
        ],
        {
          encoding: "utf-8",
          timeout: 10000,
        }
      );
      const parsed = JSON.parse(result.stdout.trim());
      expect(parsed.id).toBeDefined();
      expect(parsed.message).toBe("Test reminder");
      expect(parsed.status).toBe("pending");
      expect(parsed.scheduledAt).toBe(futureDate);
    });

    it("should list scheduled pings after scheduling", () => {
      const futureDate = new Date(
        Date.now() + 3600000
      ).toISOString();

      // Schedule a ping
      spawnSync(
        "bun",
        [
          TOOL_PATH,
          "schedule",
          "--at",
          futureDate,
          "--message",
          "Listed reminder",
        ],
        { encoding: "utf-8", timeout: 10000 }
      );

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
      const futureDate = new Date(
        Date.now() + 3600000
      ).toISOString();

      // Schedule first
      const schedResult = spawnSync(
        "bun",
        [
          TOOL_PATH,
          "schedule",
          "--at",
          futureDate,
          "--message",
          "Cancel me",
        ],
        { encoding: "utf-8", timeout: 10000 }
      );
      const scheduled = JSON.parse(schedResult.stdout.trim());

      // Cancel it
      const cancelResult = spawnSync(
        "bun",
        [TOOL_PATH, "cancel", scheduled.id],
        { encoding: "utf-8", timeout: 10000 }
      );
      const parsed = JSON.parse(cancelResult.stdout.trim());
      expect(parsed.cancelled).toBe(true);
      expect(parsed.pingId).toBe(scheduled.id);
    });

    it("should handle cancel for non-existent ping", () => {
      const result = spawnSync(
        "bun",
        [TOOL_PATH, "cancel", "nonexistent-ping-id"],
        { encoding: "utf-8", timeout: 10000 }
      );
      const parsed = JSON.parse(result.stdout.trim());
      expect(parsed.cancelled).toBe(false);
    });
  });

  describe("StateManager Usage", () => {
    it("should use getPingsManager from VoiceCommon", () => {
      const source = readFileSync(TOOL_PATH, "utf-8");
      expect(source).toContain("getPingsManager");
      expect(source).toContain("from \"./VoiceCommon.ts\"");
    });

    it("should not contain raw JSON.parse(readFileSync()) for state", () => {
      const source = readFileSync(TOOL_PATH, "utf-8");
      const matches = source.match(/JSON\.parse\s*\(\s*readFileSync/g);
      expect(matches).toBeNull();
    });
  });

  describe("Error Handling", () => {
    it("should have top-level error handler on main()", () => {
      const source = readFileSync(TOOL_PATH, "utf-8");
      expect(source).toContain("main().catch");
    });

    it("should handle desktop playback failures with fallback", () => {
      const source = readFileSync(TOOL_PATH, "utf-8");
      // Desktop failure should fall back to telegram
      expect(source).toContain("falling back to Telegram") ||
        expect(source).toContain("fallback");
    });

    it("should handle telegram voice generation failures with text fallback", () => {
      const source = readFileSync(TOOL_PATH, "utf-8");
      expect(source).toContain("text fallback");
    });
  });

  describe("No Raw fetch() Calls", () => {
    it("should not contain direct fetch() calls", () => {
      const source = readFileSync(TOOL_PATH, "utf-8");
      const rawFetchMatches = source.match(/(?<!\w)fetch\s*\(/g);
      expect(rawFetchMatches).toBeNull();
    });
  });

  describe("Silent Recovery Pattern", () => {
    it("should use try/catch for external tool invocations", () => {
      const source = readFileSync(TOOL_PATH, "utf-8");
      // spawnSync calls that could fail should have error handling
      expect(source).toContain("status !== 0") ||
        expect(source).toContain("result.status");
    });

    it("should clean up temp files in finally or catch", () => {
      const source = readFileSync(TOOL_PATH, "utf-8");
      expect(source).toContain("unlinkSync");
      expect(source).toContain("ignore");
    });
  });
});
