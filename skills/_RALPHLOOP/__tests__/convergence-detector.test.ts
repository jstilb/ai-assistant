/**
 * ConvergenceDetector.ts - Unit Tests
 *
 * Tests for the trajectory analysis system that monitors
 * Ralph loop iterations for convergence, divergence, and oscillation.
 *
 * Uses bun:test as per project standards.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "fs";
import { join } from "path";

const TEST_DIR = "/tmp/ralphloop-convergence-test";
const TOOL_PATH = join(process.env.HOME!, ".claude/skills/_RALPHLOOP/Tools/ConvergenceDetector.ts");

beforeEach(() => {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
});

describe("ConvergenceDetector", () => {
  describe("initialization", () => {
    test("--init creates tracking state file", () => {
      const result = Bun.spawnSync(["bun", TOOL_PATH, "--init"], {
        cwd: TEST_DIR,
      });

      const output = result.stdout.toString();
      expect(output).toContain("initialized");
      expect(result.exitCode).toBe(0);

      // State file should exist
      expect(existsSync(join(TEST_DIR, ".ralph-convergence.json"))).toBe(true);
    });
  });

  describe("metric recording", () => {
    test("records iteration metrics successfully", () => {
      // Init first
      Bun.spawnSync(["bun", TOOL_PATH, "--init"], { cwd: TEST_DIR });

      // Record metrics
      const metrics = JSON.stringify({
        testsPassed: 10,
        testsFailed: 2,
        testsTotal: 12,
        buildSuccess: true,
        errorCount: 0,
        typeErrors: 0,
      });

      const result = Bun.spawnSync(["bun", TOOL_PATH, "--record", metrics], {
        cwd: TEST_DIR,
      });

      const output = result.stdout.toString();
      expect(output).toContain("Trajectory:");
      expect(output).toContain("Action:");
      expect(result.exitCode).toBe(0);
    });

    test("detects converging trajectory with improving metrics", () => {
      Bun.spawnSync(["bun", TOOL_PATH, "--init"], { cwd: TEST_DIR });

      // Record progressively improving metrics
      const iterationData = [
        { testsPassed: 5, testsFailed: 5, testsTotal: 10, buildSuccess: true, errorCount: 3, typeErrors: 2 },
        { testsPassed: 7, testsFailed: 3, testsTotal: 10, buildSuccess: true, errorCount: 2, typeErrors: 1 },
        { testsPassed: 8, testsFailed: 2, testsTotal: 10, buildSuccess: true, errorCount: 1, typeErrors: 0 },
        { testsPassed: 9, testsFailed: 1, testsTotal: 10, buildSuccess: true, errorCount: 0, typeErrors: 0 },
        { testsPassed: 10, testsFailed: 0, testsTotal: 10, buildSuccess: true, errorCount: 0, typeErrors: 0 },
      ];

      let lastOutput = "";
      for (const data of iterationData) {
        const result = Bun.spawnSync(
          ["bun", TOOL_PATH, "--record", JSON.stringify(data)],
          { cwd: TEST_DIR }
        );
        lastOutput = result.stdout.toString();
      }

      // With improving metrics, should NOT be DIVERGING
      expect(lastOutput).not.toContain("DIVERGING");
      expect(lastOutput).toContain("Action: CONTINUE");
    });

    test("detects negative trajectory with worsening metrics", () => {
      Bun.spawnSync(["bun", TOOL_PATH, "--init"], { cwd: TEST_DIR });

      // Record progressively worsening metrics
      const iterationData = [
        { testsPassed: 10, testsFailed: 0, testsTotal: 10, buildSuccess: true, errorCount: 0, typeErrors: 0 },
        { testsPassed: 8, testsFailed: 2, testsTotal: 10, buildSuccess: true, errorCount: 1, typeErrors: 1 },
        { testsPassed: 5, testsFailed: 5, testsTotal: 10, buildSuccess: false, errorCount: 3, typeErrors: 2 },
        { testsPassed: 3, testsFailed: 7, testsTotal: 10, buildSuccess: false, errorCount: 5, typeErrors: 4 },
        { testsPassed: 1, testsFailed: 9, testsTotal: 10, buildSuccess: false, errorCount: 8, typeErrors: 6 },
      ];

      let lastOutput = "";
      for (const data of iterationData) {
        const result = Bun.spawnSync(
          ["bun", TOOL_PATH, "--record", JSON.stringify(data)],
          { cwd: TEST_DIR }
        );
        lastOutput = result.stdout.toString();
      }

      // With worsening metrics should NOT be CONVERGING
      expect(lastOutput).not.toContain("CONVERGING");
      expect(lastOutput).toContain("Action:");
    });
  });

  describe("should-continue check", () => {
    test("returns true when no state exists", () => {
      const result = Bun.spawnSync(["bun", TOOL_PATH, "--should-continue"], {
        cwd: TEST_DIR,
      });

      expect(result.exitCode).toBe(0); // Should continue
    });

    test("returns true for active state", () => {
      Bun.spawnSync(["bun", TOOL_PATH, "--init"], { cwd: TEST_DIR });

      const result = Bun.spawnSync(["bun", TOOL_PATH, "--should-continue"], {
        cwd: TEST_DIR,
      });

      expect(result.exitCode).toBe(0);
    });
  });

  describe("status display", () => {
    test("--status shows formatted status", () => {
      Bun.spawnSync(["bun", TOOL_PATH, "--init"], { cwd: TEST_DIR });

      // Record one iteration
      Bun.spawnSync(
        ["bun", TOOL_PATH, "--record", JSON.stringify({
          testsPassed: 8,
          testsFailed: 2,
          testsTotal: 10,
          buildSuccess: true,
          errorCount: 0,
          typeErrors: 0,
        })],
        { cwd: TEST_DIR }
      );

      const result = Bun.spawnSync(["bun", TOOL_PATH, "--status"], {
        cwd: TEST_DIR,
      });

      const output = result.stdout.toString();
      expect(output).toContain("CONVERGENCE STATUS");
      expect(output).toContain("Total Iterations");
      expect(output).toContain("Diverging");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("CLI interface", () => {
    test("--help shows usage", () => {
      const result = Bun.spawnSync(["bun", TOOL_PATH, "--help"]);

      const output = result.stdout.toString();
      expect(output).toContain("ConvergenceDetector");
      expect(output).toContain("--init");
      expect(output).toContain("--record");
      expect(output).toContain("--should-continue");
      expect(result.exitCode).toBe(0);
    });

    test("unknown command shows error", () => {
      const result = Bun.spawnSync(["bun", TOOL_PATH, "--unknown-cmd"]);
      expect(result.exitCode).not.toBe(0);
    });
  });
});
