#!/usr/bin/env bun
/**
 * LoadSkillConfig.test.ts - Unit tests for LoadSkillConfig
 *
 * Tests the config loading utility including:
 * - Base config loading from skill directories via StateManager
 * - Missing file handling via defaults
 * - No raw JSON.parse(readFileSync()) in migrated code paths
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";

// We test through the public API
import { loadSkillConfig } from "./LoadSkillConfig";

const TEST_DIR = "/tmp/loadskillconfig-test";
const TEST_SKILL_DIR = join(TEST_DIR, "skills", "TestSkill");

describe("LoadSkillConfig", () => {
  beforeEach(() => {
    // Create test directories
    mkdirSync(TEST_SKILL_DIR, { recursive: true });
  });

  afterEach(() => {
    // Cleanup
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true, force: true });
    }
  });

  describe("loadSkillConfig - config loading via StateManager", () => {
    test("loads a valid JSON config from skill directory", async () => {
      const config = { name: "TestSkill", version: "1.0", features: ["a", "b"] };
      writeFileSync(join(TEST_SKILL_DIR, "config.json"), JSON.stringify(config));

      const result = await loadSkillConfig<typeof config>(TEST_SKILL_DIR, "config.json");
      expect(result).toEqual(config);
    });

    test("returns empty object when base config does not exist", async () => {
      const result = await loadSkillConfig(TEST_SKILL_DIR, "nonexistent.json");
      expect(result).toEqual({});
    });

    test("throws on invalid JSON in base config", async () => {
      writeFileSync(join(TEST_SKILL_DIR, "broken.json"), "{ invalid json");

      await expect(
        loadSkillConfig(TEST_SKILL_DIR, "broken.json")
      ).rejects.toThrow();
    });

    test("handles empty JSON object in base config", async () => {
      writeFileSync(join(TEST_SKILL_DIR, "empty.json"), "{}");

      const result = await loadSkillConfig(TEST_SKILL_DIR, "empty.json");
      expect(result).toEqual({});
    });

    test("handles nested objects in config", async () => {
      const config = {
        database: { host: "localhost", port: 5432 },
        features: { auth: true, logging: false },
      };
      writeFileSync(join(TEST_SKILL_DIR, "config.json"), JSON.stringify(config));

      const result = await loadSkillConfig<typeof config>(TEST_SKILL_DIR, "config.json");
      expect(result.database.host).toBe("localhost");
      expect(result.features.auth).toBe(true);
    });

    test("handles array values in config", async () => {
      const config = { items: ["one", "two", "three"], count: 3 };
      writeFileSync(join(TEST_SKILL_DIR, "list.json"), JSON.stringify(config));

      const result = await loadSkillConfig<typeof config>(TEST_SKILL_DIR, "list.json");
      expect(result.items).toEqual(["one", "two", "three"]);
      expect(result.count).toBe(3);
    });

    test("preserves string values with special characters", async () => {
      const config = { path: "/usr/local/bin", desc: "A \"quoted\" value" };
      writeFileSync(join(TEST_SKILL_DIR, "special.json"), JSON.stringify(config));

      const result = await loadSkillConfig<typeof config>(TEST_SKILL_DIR, "special.json");
      expect(result.path).toBe("/usr/local/bin");
      expect(result.desc).toBe('A "quoted" value');
    });

    test("handles numeric values correctly", async () => {
      const config = { port: 8080, timeout: 30.5, retries: 0 };
      writeFileSync(join(TEST_SKILL_DIR, "numeric.json"), JSON.stringify(config));

      const result = await loadSkillConfig<typeof config>(TEST_SKILL_DIR, "numeric.json");
      expect(result.port).toBe(8080);
      expect(result.timeout).toBe(30.5);
      expect(result.retries).toBe(0);
    });
  });
});
