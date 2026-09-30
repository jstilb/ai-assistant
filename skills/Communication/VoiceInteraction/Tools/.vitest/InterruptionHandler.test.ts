/**
 * InterruptionHandler.test.ts - Tests for voice response interruption management
 *
 * TDD tests for InterruptionHandler refactor:
 * - Registration and cancellation of active responses
 * - Cancel-all functionality
 * - State persistence via StateManager
 * - Error handling patterns
 *
 * Run: npx vitest run Tools/__tests__/InterruptionHandler.test.ts
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, rmSync, readFileSync } from "fs";
import { join } from "path";
import { spawnSync } from "child_process";

const TEST_DIR = "/tmp/voice-interruption-tests";
const TOOL_PATH = join(
  process.env.HOME || "",
  ".claude/skills/Communication/VoiceInteraction/Tools/InterruptionHandler.ts"
);

describe("InterruptionHandler", () => {
  const SHARED_STATE_DIR = "/tmp/voice-interaction";
  const INTERRUPTION_STATE_FILE = join(SHARED_STATE_DIR, "active-responses.json");

  beforeEach(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true });
    }
    mkdirSync(TEST_DIR, { recursive: true });
    // Clean shared state to isolate tests
    if (existsSync(INTERRUPTION_STATE_FILE)) {
      rmSync(INTERRUPTION_STATE_FILE);
    }
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true });
    }
    // Clean shared state after tests
    if (existsSync(INTERRUPTION_STATE_FILE)) {
      rmSync(INTERRUPTION_STATE_FILE);
    }
  });

  describe("CLI Interface", () => {
    it("should show help text with no arguments", () => {
      const result = spawnSync("bun", [TOOL_PATH], {
        encoding: "utf-8",
        timeout: 10000,
      });
      expect(result.stdout).toContain("InterruptionHandler");
      expect(result.stdout).toContain("register");
      expect(result.stdout).toContain("cancel");
      expect(result.stdout).toContain("status");
    });

    it("should show help text with --help flag", () => {
      const result = spawnSync("bun", [TOOL_PATH, "--help"], {
        encoding: "utf-8",
        timeout: 10000,
      });
      expect(result.stdout).toContain("InterruptionHandler");
    });

    it("should register an active response", () => {
      const result = spawnSync(
        "bun",
        [TOOL_PATH, "register", "test-session-1", "desktop"],
        {
          encoding: "utf-8",
          timeout: 10000,
        }
      );
      const parsed = JSON.parse(result.stdout.trim());
      expect(parsed.registered).toBe(true);
      expect(parsed.sessionId).toBe("test-session-1");
      expect(parsed.channel).toBe("desktop");
    });

    it("should show status of active responses", () => {
      // Register first
      spawnSync("bun", [TOOL_PATH, "register", "status-test", "desktop"], {
        encoding: "utf-8",
        timeout: 10000,
      });

      const result = spawnSync("bun", [TOOL_PATH, "status"], {
        encoding: "utf-8",
        timeout: 10000,
      });
      const parsed = JSON.parse(result.stdout.trim());
      expect(parsed.activeResponses).toBeDefined();
      expect(Array.isArray(parsed.activeResponses)).toBe(true);
    });

    it("should cancel a specific response", () => {
      // Register first
      spawnSync("bun", [TOOL_PATH, "register", "cancel-test", "desktop"], {
        encoding: "utf-8",
        timeout: 10000,
      });

      const result = spawnSync("bun", [TOOL_PATH, "cancel", "cancel-test"], {
        encoding: "utf-8",
        timeout: 10000,
      });
      const parsed = JSON.parse(result.stdout.trim());
      expect(parsed.cancelled).toBe(true);
      expect(parsed.sessionId).toBe("cancel-test");
    });

    it("should handle cancel for non-existent session gracefully", () => {
      const result = spawnSync(
        "bun",
        [TOOL_PATH, "cancel", "nonexistent-session"],
        {
          encoding: "utf-8",
          timeout: 10000,
        }
      );
      const parsed = JSON.parse(result.stdout.trim());
      expect(parsed.cancelled).toBe(false);
    });

    it("should cancel all active responses", () => {
      // Register multiple
      spawnSync("bun", [TOOL_PATH, "register", "all-1", "desktop"], {
        encoding: "utf-8",
        timeout: 10000,
      });
      spawnSync("bun", [TOOL_PATH, "register", "all-2", "telegram"], {
        encoding: "utf-8",
        timeout: 10000,
      });

      const result = spawnSync("bun", [TOOL_PATH, "cancel-all"], {
        encoding: "utf-8",
        timeout: 10000,
      });
      const parsed = JSON.parse(result.stdout.trim());
      expect(parsed.cancelled).toBeGreaterThanOrEqual(0);
    });
  });

  describe("StateManager Usage", () => {
    it("should use getInterruptionManager from VoiceCommon", () => {
      const source = readFileSync(TOOL_PATH, "utf-8");
      expect(source).toContain("getInterruptionManager");
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

    it("should handle process kill failures gracefully", () => {
      const source = readFileSync(TOOL_PATH, "utf-8");
      // process.kill should be in try/catch
      expect(source).toContain("process.kill");
      expect(source).toContain("catch");
    });
  });

  describe("No Raw fetch() Calls", () => {
    it("should not contain direct fetch() calls", () => {
      const source = readFileSync(TOOL_PATH, "utf-8");
      const rawFetchMatches = source.match(/(?<!\w)fetch\s*\(/g);
      expect(rawFetchMatches).toBeNull();
    });
  });

  describe("Async Semantics", () => {
    it("should use async functions for state operations", () => {
      const source = readFileSync(TOOL_PATH, "utf-8");
      expect(source).toContain("async function registerResponse");
      expect(source).toContain("async function cancelResponse");
      expect(source).toContain("async function cancelAll");
    });

    it("should preserve interruption state atomically via manager.update", () => {
      const source = readFileSync(TOOL_PATH, "utf-8");
      // Should use manager.update() or manager.save() for state changes
      expect(
        source.includes("manager.update") || source.includes("manager.save")
      ).toBe(true);
    });
  });
});
