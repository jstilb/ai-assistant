#!/usr/bin/env bun
/**
 * ProjectScaffold.test.ts - Tests for the orchestrator tool
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, rmSync, readFileSync, readdirSync } from "fs";
import { join } from "path";

import {
  parseScaffoldArgs,
  buildScaffoldPlan,
  type ScaffoldConfig,
  type ScaffoldPlan,
} from "./ProjectScaffold";

const TEST_DIR = "/tmp/scaffold-test";

describe("ProjectScaffold", () => {
  beforeEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  describe("parseScaffoldArgs", () => {
    test("parses all required arguments", () => {
      const config = parseScaffoldArgs([
        "--name", "my-agent",
        "--description", "A test agent",
      ]);
      expect(config.name).toBe("my-agent");
      expect(config.description).toBe("A test agent");
    });

    test("applies comprehensive defaults", () => {
      const config = parseScaffoldArgs([
        "--name", "my-agent",
        "--description", "test",
      ]);
      expect(config.language).toBe("typescript");
      expect(config.framework).toBe("langgraph");
      expect(config.environments).toContain("development");
      expect(config.testLevels).toContain("unit");
      expect(config.ciWorkflows).toContain("ci");
    });

    test("accepts --skip-repo flag", () => {
      const config = parseScaffoldArgs([
        "--name", "my-agent",
        "--description", "test",
        "--skip-repo",
      ]);
      expect(config.skipRepo).toBe(true);
    });

    test("accepts --skip-ci flag", () => {
      const config = parseScaffoldArgs([
        "--name", "my-agent",
        "--description", "test",
        "--skip-ci",
      ]);
      expect(config.skipCI).toBe(true);
    });

    test("accepts custom environments", () => {
      const config = parseScaffoldArgs([
        "--name", "my-agent",
        "--description", "test",
        "--environments", "development,staging,production",
      ]);
      expect(config.environments).toEqual(["development", "staging", "production"]);
    });

    test("throws on missing name", () => {
      expect(() => parseScaffoldArgs(["--description", "test"])).toThrow();
    });

    test("throws on missing description", () => {
      expect(() => parseScaffoldArgs(["--name", "test"])).toThrow();
    });
  });

  describe("buildScaffoldPlan", () => {
    test("includes all phases by default", () => {
      const config: ScaffoldConfig = {
        name: "my-agent",
        description: "test",
        language: "typescript",
        framework: "langgraph",
        environments: ["development"],
        testLevels: ["unit", "integration"],
        ciWorkflows: ["ci"],
        skipRepo: false,
        skipCI: false,
      };

      const plan = buildScaffoldPlan(config);
      expect(plan.phases.length).toBe(4); // repo, sandbox, tests, ci
      expect(plan.phases.map(p => p.name)).toContain("Repository Setup");
      expect(plan.phases.map(p => p.name)).toContain("Sandbox Setup");
      expect(plan.phases.map(p => p.name)).toContain("Test Infrastructure");
      expect(plan.phases.map(p => p.name)).toContain("CI/CD Setup");
    });

    test("skips repo phase when skipRepo is true", () => {
      const config: ScaffoldConfig = {
        name: "my-agent",
        description: "test",
        language: "typescript",
        framework: "langgraph",
        environments: ["development"],
        testLevels: ["unit"],
        ciWorkflows: ["ci"],
        skipRepo: true,
        skipCI: false,
      };

      const plan = buildScaffoldPlan(config);
      expect(plan.phases.map(p => p.name)).not.toContain("Repository Setup");
    });

    test("skips CI phase when skipCI is true", () => {
      const config: ScaffoldConfig = {
        name: "my-agent",
        description: "test",
        language: "typescript",
        framework: "langgraph",
        environments: ["development"],
        testLevels: ["unit"],
        ciWorkflows: ["ci"],
        skipRepo: false,
        skipCI: true,
      };

      const plan = buildScaffoldPlan(config);
      expect(plan.phases.map(p => p.name)).not.toContain("CI/CD Setup");
    });

    test("includes estimated file count", () => {
      const config: ScaffoldConfig = {
        name: "my-agent",
        description: "test",
        language: "typescript",
        framework: "langgraph",
        environments: ["development", "staging"],
        testLevels: ["unit", "integration", "evals"],
        ciWorkflows: ["ci", "staging", "production"],
        skipRepo: false,
        skipCI: false,
      };

      const plan = buildScaffoldPlan(config);
      expect(plan.estimatedFiles).toBeGreaterThan(10);
    });
  });
});
