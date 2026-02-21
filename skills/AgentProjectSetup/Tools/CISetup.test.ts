#!/usr/bin/env bun
/**
 * CISetup.test.ts - Tests for CI/CD workflow generation tool
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, rmSync, readFileSync } from "fs";
import { join } from "path";

import {
  parseCIArgs,
  generateCIWorkflow,
  generateStagingWorkflow,
  generateProductionWorkflow,
  generateCodeowners,
  scaffoldCI,
  type CIConfig,
} from "./CISetup";

const TEST_DIR = "/tmp/ci-setup-test";

describe("CISetup", () => {
  beforeEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  describe("parseCIArgs", () => {
    test("parses required project-dir", () => {
      const config = parseCIArgs(["--project-dir", TEST_DIR]);
      expect(config.projectDir).toBe(TEST_DIR);
    });

    test("defaults to all workflows", () => {
      const config = parseCIArgs(["--project-dir", TEST_DIR]);
      expect(config.workflows).toContain("ci");
      expect(config.workflows).toContain("staging");
      expect(config.workflows).toContain("production");
    });

    test("accepts custom workflows", () => {
      const config = parseCIArgs([
        "--project-dir", TEST_DIR,
        "--workflows", "ci",
      ]);
      expect(config.workflows).toEqual(["ci"]);
    });

    test("throws on missing project-dir", () => {
      expect(() => parseCIArgs([])).toThrow();
    });
  });

  describe("generateCIWorkflow", () => {
    test("generates valid YAML structure for TypeScript", () => {
      const yaml = generateCIWorkflow("typescript");
      expect(yaml).toContain("name: CI");
      expect(yaml).toContain("on:");
      expect(yaml).toContain("jobs:");
      expect(yaml).toContain("bun");
    });

    test("generates valid YAML structure for Python", () => {
      const yaml = generateCIWorkflow("python");
      expect(yaml).toContain("name: CI");
      expect(yaml).toContain("python");
      expect(yaml).toContain("pytest");
      expect(yaml).toContain("ruff");
    });

    test("includes quality gates", () => {
      const yaml = generateCIWorkflow("typescript");
      expect(yaml).toContain("lint");
      expect(yaml).toContain("test");
    });

    test("includes concurrency controls", () => {
      const yaml = generateCIWorkflow("typescript");
      expect(yaml).toContain("concurrency:");
      expect(yaml).toContain("cancel-in-progress");
    });
  });

  describe("generateStagingWorkflow", () => {
    test("triggers on push to main", () => {
      const yaml = generateStagingWorkflow("typescript");
      expect(yaml).toContain("push:");
      expect(yaml).toContain("main");
    });

    test("includes Docker build step", () => {
      const yaml = generateStagingWorkflow("typescript");
      expect(yaml).toContain("docker");
    });

    test("includes deployment verification", () => {
      const yaml = generateStagingWorkflow("typescript");
      expect(yaml).toContain("Verify");
    });
  });

  describe("generateProductionWorkflow", () => {
    test("triggers on release", () => {
      const yaml = generateProductionWorkflow("typescript");
      expect(yaml).toContain("release:");
      expect(yaml).toContain("published");
    });

    test("includes pre-deployment checks", () => {
      const yaml = generateProductionWorkflow("typescript");
      expect(yaml).toContain("pre-deploy");
    });

    test("includes post-deployment verification", () => {
      const yaml = generateProductionWorkflow("typescript");
      expect(yaml).toContain("post-deploy");
    });
  });

  describe("generateCodeowners", () => {
    test("generates CODEOWNERS with default owner", () => {
      const codeowners = generateCodeowners("my-user");
      expect(codeowners).toContain("@my-user");
      expect(codeowners).toContain("*");
    });

    test("includes agent logic path", () => {
      const codeowners = generateCodeowners("my-user");
      expect(codeowners).toContain("src/agent/");
    });

    test("includes workflow path", () => {
      const codeowners = generateCodeowners("my-user");
      expect(codeowners).toContain(".github/workflows/");
    });
  });

  describe("scaffoldCI", () => {
    test("creates .github/workflows directory", () => {
      scaffoldCI({
        projectDir: TEST_DIR,
        language: "typescript",
        workflows: ["ci"],
        owner: "test-user",
      });

      expect(existsSync(join(TEST_DIR, ".github/workflows"))).toBe(true);
    });

    test("creates CI workflow file", () => {
      scaffoldCI({
        projectDir: TEST_DIR,
        language: "typescript",
        workflows: ["ci"],
        owner: "test-user",
      });

      const ciPath = join(TEST_DIR, ".github/workflows/ci.yml");
      expect(existsSync(ciPath)).toBe(true);
      const content = readFileSync(ciPath, "utf-8");
      expect(content).toContain("name: CI");
    });

    test("creates all workflow files when requested", () => {
      scaffoldCI({
        projectDir: TEST_DIR,
        language: "typescript",
        workflows: ["ci", "staging", "production"],
        owner: "test-user",
      });

      expect(existsSync(join(TEST_DIR, ".github/workflows/ci.yml"))).toBe(true);
      expect(existsSync(join(TEST_DIR, ".github/workflows/deploy-staging.yml"))).toBe(true);
      expect(existsSync(join(TEST_DIR, ".github/workflows/deploy-production.yml"))).toBe(true);
    });

    test("creates CODEOWNERS", () => {
      scaffoldCI({
        projectDir: TEST_DIR,
        language: "typescript",
        workflows: ["ci"],
        owner: "test-user",
      });

      expect(existsSync(join(TEST_DIR, ".github/CODEOWNERS"))).toBe(true);
    });

    test("returns list of created files", () => {
      const result = scaffoldCI({
        projectDir: TEST_DIR,
        language: "typescript",
        workflows: ["ci", "staging", "production"],
        owner: "test-user",
      });

      expect(result.filesCreated.length).toBeGreaterThan(0);
      expect(result.filesCreated).toContain(".github/workflows/ci.yml");
    });
  });
});
