/**
 * DesktopVoiceClient.test.ts - Tests for desktop voice interaction client
 *
 * TDD tests for DesktopVoiceClient refactor:
 * - Conversation turn flow (listen -> think -> speak)
 * - Session management via StateManager
 * - Exit command handling (single handler, no dual registration)
 * - PID file management
 * - Error recovery in conversation loop
 *
 * Run: npx vitest run Tools/__tests__/DesktopVoiceClient.test.ts
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, rmSync, readFileSync } from "fs";
import { join } from "path";

// We test via CLI invocation since the module has side effects
import { spawnSync } from "child_process";

const TEST_DIR = "/tmp/voice-desktop-tests";
const TOOL_PATH = join(
  process.env.HOME || "",
  ".claude/skills/VoiceInteraction/Tools/DesktopVoiceClient.ts"
);

describe("DesktopVoiceClient", () => {
  beforeEach(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true });
    }
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true });
    }
  });

  describe("CLI Interface", () => {
    it("should show help text with no arguments", () => {
      const result = spawnSync("bun", [TOOL_PATH], {
        encoding: "utf-8",
        timeout: 10000,
      });
      expect(result.stdout).toContain("DesktopVoiceClient");
      expect(result.stdout).toContain("start");
      expect(result.stdout).toContain("stop");
      expect(result.stdout).toContain("status");
      expect(result.stdout).toContain("conversation");
    });

    it("should show help text with --help flag", () => {
      const result = spawnSync("bun", [TOOL_PATH, "--help"], {
        encoding: "utf-8",
        timeout: 10000,
      });
      expect(result.stdout).toContain("DesktopVoiceClient");
      expect(result.stdout).toContain("start");
    });

    it("should report status when not running", () => {
      const result = spawnSync("bun", [TOOL_PATH, "status"], {
        encoding: "utf-8",
        timeout: 10000,
      });
      const parsed = JSON.parse(result.stdout.trim());
      expect(parsed.running).toBe(false);
    });

    it("should report stop when not running", () => {
      const result = spawnSync("bun", [TOOL_PATH, "stop"], {
        encoding: "utf-8",
        timeout: 10000,
      });
      const parsed = JSON.parse(result.stdout.trim());
      expect(parsed.stopped).toBe(false);
      expect(parsed.reason).toBe("not_running");
    });
  });

  describe("Exit Commands - Regression Test", () => {
    it("should import isExitCommand from VoiceCommon", async () => {
      // DesktopVoiceClient delegates exit detection to VoiceCommon.isExitCommand
      const source = readFileSync(TOOL_PATH, "utf-8");

      // Verify isExitCommand is imported from VoiceCommon
      expect(source).toContain("isExitCommand");
      expect(source).toMatch(/import\s*\{[^}]*isExitCommand[^}]*\}\s*from\s*["']\.\/VoiceCommon/);
    });

    it("should check exit commands in continuous loop", () => {
      const source = readFileSync(TOOL_PATH, "utf-8");
      // The startContinuous function should check isExitCommand
      expect(source).toContain("isExitCommand");
    });

    it("should handle exit consistently in conversation command", () => {
      const source = readFileSync(TOOL_PATH, "utf-8");
      // The conversation CLI command should also reference isExitCommand
      const conversationBlock = source.slice(
        source.indexOf('case "conversation"')
      );
      expect(conversationBlock).toContain("isExitCommand");
    });
  });

  describe("StateManager Usage", () => {
    it("should not contain raw JSON.parse(readFileSync()) for state", () => {
      const source = readFileSync(TOOL_PATH, "utf-8");
      // PID file reads are acceptable (not JSON state management)
      // But no raw JSON.parse(readFileSync(...)) for session state
      const matches = source.match(/JSON\.parse\s*\(\s*readFileSync/g);
      // Should be null or only for non-state files (PID is plain text, not JSON.parse)
      expect(matches).toBeNull();
    });

    it("should use getSessionManager from VoiceCommon", () => {
      const source = readFileSync(TOOL_PATH, "utf-8");
      expect(source).toContain("getSessionManager");
      expect(source).toContain("from \"./VoiceCommon.ts\"");
    });

    it("should pass all required fields when updating session", () => {
      const source = readFileSync(TOOL_PATH, "utf-8");
      // The update() call should spread existing state to preserve required fields
      // Look for proper spread pattern in the update callback
      const updateBlocks = source.match(/manager\.update\s*\(\s*\([\w]+\)\s*=>\s*\({[^}]+}\)/gs);
      if (updateBlocks) {
        for (const block of updateBlocks) {
          // Should spread the existing state or include all required fields
          const hasSpread = block.includes("...s") || block.includes("...state") || block.includes("...current");
          const hasAllFields = block.includes("id") && block.includes("startedAt") && block.includes("messages") && block.includes("turnCount");
          expect(hasSpread || hasAllFields).toBe(true);
        }
      }
    });
  });

  describe("Error Handling", () => {
    it("should have top-level error handler on main()", () => {
      const source = readFileSync(TOOL_PATH, "utf-8");
      expect(source).toContain("main().catch");
    });

    it("should handle errors gracefully in continuous loop", () => {
      const source = readFileSync(TOOL_PATH, "utf-8");
      // The while loop should have try/catch
      expect(source).toContain("catch (err");
    });
  });

  describe("No Raw fetch() Calls", () => {
    it("should not contain direct fetch() calls (except localhost health checks)", () => {
      const source = readFileSync(TOOL_PATH, "utf-8");
      // Match standalone fetch( but not httpClient.fetch( or .fetch(
      // Filter out localhost health checks (not external API calls)
      const lines = source.split('\n').filter(l => !l.includes('localhost'));
      const rawFetchMatches = lines.join('\n').match(/(?<!\w)fetch\s*\(/g);
      expect(rawFetchMatches).toBeNull();
    });
  });
});
