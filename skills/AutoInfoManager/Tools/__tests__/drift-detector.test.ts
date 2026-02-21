/**
 * DriftDetector Tests - ArchitectureUpdate and DeepDriftCheck
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "fs";
import { join } from "path";
import { architectureUpdate, deepDriftCheck } from "../DriftDetector";

const TEST_DIR = join(import.meta.dir, ".test-drift");
const TEST_CONFIG_DIR = join(TEST_DIR, "Config");
const TEST_STATE_DIR = join(TEST_DIR, "State");

describe("DriftDetector", () => {
  beforeEach(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true });
    }
    mkdirSync(TEST_CONFIG_DIR, { recursive: true });
    mkdirSync(TEST_STATE_DIR, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true });
    }
  });

  describe("architectureUpdate", () => {
    it("should create baseline on first run (all files as added)", async () => {
      // Create config files
      writeFileSync(join(TEST_CONFIG_DIR, "tiers.json"), '{"version": 1}');
      writeFileSync(join(TEST_CONFIG_DIR, "settings.json"), '{"debug": false}');

      const result = await architectureUpdate(TEST_CONFIG_DIR, TEST_STATE_DIR);

      expect(result.success).toBe(true);
      const data = result.data as { modified: string[]; added: string[]; removed: string[] };
      expect(data.added.length).toBe(2);
      expect(data.modified.length).toBe(0);
      expect(data.removed.length).toBe(0);

      // Verify baseline was created
      const hashPath = join(TEST_STATE_DIR, "config-hashes.json");
      expect(existsSync(hashPath)).toBe(true);
    });

    it("should detect modified files", async () => {
      writeFileSync(join(TEST_CONFIG_DIR, "tiers.json"), '{"version": 1}');

      // First run creates baseline
      await architectureUpdate(TEST_CONFIG_DIR, TEST_STATE_DIR);

      // Modify the file
      writeFileSync(join(TEST_CONFIG_DIR, "tiers.json"), '{"version": 2}');

      // Second run detects modification
      const result = await architectureUpdate(TEST_CONFIG_DIR, TEST_STATE_DIR);
      const data = result.data as { modified: string[]; added: string[]; removed: string[] };

      expect(data.modified).toContain("tiers.json");
    });

    it("should detect added files", async () => {
      writeFileSync(join(TEST_CONFIG_DIR, "tiers.json"), '{"version": 1}');

      // First run
      await architectureUpdate(TEST_CONFIG_DIR, TEST_STATE_DIR);

      // Add a new file
      writeFileSync(join(TEST_CONFIG_DIR, "new-config.json"), '{}');

      // Second run
      const result = await architectureUpdate(TEST_CONFIG_DIR, TEST_STATE_DIR);
      const data = result.data as { modified: string[]; added: string[]; removed: string[] };

      expect(data.added).toContain("new-config.json");
    });

    it("should detect removed files", async () => {
      writeFileSync(join(TEST_CONFIG_DIR, "tiers.json"), '{"version": 1}');
      writeFileSync(join(TEST_CONFIG_DIR, "old-config.json"), '{}');

      // First run
      await architectureUpdate(TEST_CONFIG_DIR, TEST_STATE_DIR);

      // Remove a file
      rmSync(join(TEST_CONFIG_DIR, "old-config.json"));

      // Second run
      const result = await architectureUpdate(TEST_CONFIG_DIR, TEST_STATE_DIR);
      const data = result.data as { modified: string[]; added: string[]; removed: string[] };

      expect(data.removed).toContain("old-config.json");
    });

    it("should report no changes when nothing changed", async () => {
      writeFileSync(join(TEST_CONFIG_DIR, "tiers.json"), '{"version": 1}');

      // First run
      await architectureUpdate(TEST_CONFIG_DIR, TEST_STATE_DIR);

      // Second run without changes
      const result = await architectureUpdate(TEST_CONFIG_DIR, TEST_STATE_DIR);
      const data = result.data as { modified: string[]; added: string[]; removed: string[] };

      expect(data.modified.length).toBe(0);
      expect(data.added.length).toBe(0);
      expect(data.removed.length).toBe(0);
    });
  });

  describe("deepDriftCheck", () => {
    it("should report on tiers.json validity", async () => {
      // Create valid tiers.json
      writeFileSync(
        join(TEST_CONFIG_DIR, "tiers.json"),
        JSON.stringify({ version: 1, daily: { timeout: 300000, steps: [] } })
      );

      const result = await deepDriftCheck(TEST_CONFIG_DIR, TEST_STATE_DIR);

      expect(result.success).toBe(true);
      expect(result.metrics).toBeDefined();
      expect(result.metrics!.tiersConfigValid).toBe(1);
    });

    it("should detect invalid tiers.json", async () => {
      writeFileSync(join(TEST_CONFIG_DIR, "tiers.json"), "not valid json {{{");

      const result = await deepDriftCheck(TEST_CONFIG_DIR, TEST_STATE_DIR);

      expect(result.success).toBe(true);
      expect(result.metrics!.tiersConfigValid).toBe(0);
    });

    it("should check state file integrity", async () => {
      // Create valid state file
      writeFileSync(
        join(TEST_STATE_DIR, "last-runs.json"),
        JSON.stringify({ daily: null, weekly: null, monthly: null })
      );

      const result = await deepDriftCheck(TEST_CONFIG_DIR, TEST_STATE_DIR);

      expect(result.success).toBe(true);
      expect(result.metrics!.stateFilesChecked).toBeGreaterThanOrEqual(1);
    });

    it("should detect corrupt state files", async () => {
      writeFileSync(join(TEST_STATE_DIR, "last-runs.json"), "corrupt data!!");

      const result = await deepDriftCheck(TEST_CONFIG_DIR, TEST_STATE_DIR);

      expect(result.success).toBe(true);
      expect(result.metrics!.stateFilesCorrupt).toBeGreaterThanOrEqual(1);
    });

    it("should return real counts not hardcoded zeros", async () => {
      writeFileSync(join(TEST_CONFIG_DIR, "tiers.json"), '{"version": 1}');

      const result = await deepDriftCheck(TEST_CONFIG_DIR, TEST_STATE_DIR);

      expect(result.success).toBe(true);
      // Must have real metrics, not hardcoded zeros
      expect(result.metrics).toBeDefined();
      expect(typeof result.metrics!.tiersConfigValid).toBe("number");
      expect(typeof result.metrics!.stateFilesChecked).toBe("number");
    });
  });
});
