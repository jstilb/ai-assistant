/**
 * ConfigLoader.test.ts - Tests for Designer config loading
 *
 * Tests:
 * - Load user style preferences from YAML
 * - Default fallbacks when USER files missing
 * - Schema validation of config
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { loadDesignerConfig, type DesignerConfig } from "../DesignerConfig.ts";
import { existsSync, mkdirSync, writeFileSync, rmSync } from "fs";

const TEST_DIR = "/tmp/designer-test-config";
const TEST_USER_DIR = `${TEST_DIR}/USER`;

describe("DesignerConfig", () => {
  describe("loadDesignerConfig", () => {
    it("returns default config when no USER files exist", () => {
      const config = loadDesignerConfig("/tmp/nonexistent-designer-dir");
      expect(config).toBeDefined();
      expect(config.aesthetic).toBeDefined();
      expect(config.aesthetic.primary).toBe("cozy");
      expect(config.budget).toBe("moderate");
    });

    it("loads style preferences from YAML when available", () => {
      // Use the real USER directory
      const config = loadDesignerConfig("~/.claude/skills/Designer");
      expect(config).toBeDefined();
      expect(config.aesthetic.primary).toBe("cozy");
      expect(config.budget).toBe("moderate");
    });

    it("returns avoid_styles list", () => {
      const config = loadDesignerConfig("~/.claude/skills/Designer");
      expect(config.avoidStyles).toBeDefined();
      expect(Array.isArray(config.avoidStyles)).toBe(true);
      expect(config.avoidStyles.length).toBeGreaterThan(0);
    });

    it("returns color preferences", () => {
      const config = loadDesignerConfig("~/.claude/skills/Designer");
      expect(config.colors).toBeDefined();
      expect(config.colors.love).toBeDefined();
      expect(Array.isArray(config.colors.love)).toBe(true);
      expect(config.colors.avoid).toBeDefined();
    });

    it("config is typed correctly", () => {
      const config: DesignerConfig = loadDesignerConfig("~/.claude/skills/Designer");
      // TypeScript compile-time check -- if DesignerConfig type is wrong, this fails
      const _aesthetic: string = config.aesthetic.primary;
      const _budget: string = config.budget;
      expect(_aesthetic).toBeTruthy();
      expect(_budget).toBeTruthy();
    });
  });
});
