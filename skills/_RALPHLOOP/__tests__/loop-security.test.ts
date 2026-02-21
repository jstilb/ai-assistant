/**
 * loop.sh - Security and Functionality Tests
 *
 * Tests for the Ralph Loop Orchestrator shell script.
 * Validates security configuration and basic functionality.
 *
 * Uses bun:test as per project standards.
 */

import { describe, test, expect } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const LOOP_PATH = join(process.env.HOME!, ".claude/skills/_RALPHLOOP/Templates/loop.sh");
const loopContent = readFileSync(LOOP_PATH, "utf-8");
const loopLines = loopContent.split("\n");

describe("loop.sh", () => {
  describe("security", () => {
    test("does NOT contain --dangerously-skip-permissions in executable lines", () => {
      // Check non-comment lines only
      for (const line of loopLines) {
        const trimmed = line.trim();
        if (trimmed.startsWith("#")) continue; // Skip comments
        if (trimmed === "") continue; // Skip empty lines
        expect(trimmed).not.toContain("--dangerously-skip-permissions");
      }
    });

    test("does NOT contain sudo", () => {
      for (const line of loopLines) {
        const trimmed = line.trim();
        if (trimmed.startsWith("#")) continue;
        if (trimmed === "") continue;
        expect(trimmed).not.toContain("sudo");
      }
    });

    test("uses set -e for error exit", () => {
      expect(loopContent).toContain("set -e");
    });

    test("has SECURITY NOTICE comment block", () => {
      expect(loopContent).toContain("SECURITY NOTICE");
      expect(loopContent).toContain("Do NOT use --dangerously-skip-permissions");
    });

    test("mentions RALPH_EXTRA_FLAGS for override", () => {
      expect(loopContent).toContain("RALPH_EXTRA_FLAGS");
    });
  });

  describe("functionality", () => {
    test("supports plan mode", () => {
      expect(loopContent).toContain('"plan"');
      expect(loopContent).toContain("PROMPT_plan.md");
    });

    test("supports build mode", () => {
      expect(loopContent).toContain("build");
      expect(loopContent).toContain("PROMPT_build.md");
    });

    test("supports iteration limits", () => {
      expect(loopContent).toContain("MAX_ITERATIONS");
    });

    test("uses configurable model", () => {
      expect(loopContent).toContain("RALPH_MODEL");
    });

    test("logs iterations", () => {
      expect(loopContent).toContain("LOG_FILE");
      expect(loopContent).toContain("ralph.log");
    });

    test("tracks progress", () => {
      expect(loopContent).toContain("PROGRESS_FILE");
      expect(loopContent).toContain("progress.txt");
    });

    test("validates prompt file exists", () => {
      expect(loopContent).toContain("! -f");
      expect(loopContent).toContain("PROMPT_FILE");
    });

    test("uses claude CLI for execution", () => {
      expect(loopContent).toContain("claude -p");
    });

    test("pushes changes in build mode", () => {
      expect(loopContent).toContain("git push");
    });

    test("reports completion summary", () => {
      expect(loopContent).toContain("Ralph Loop Complete");
      expect(loopContent).toContain("Total iterations");
    });
  });
});
