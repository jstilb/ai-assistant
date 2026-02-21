#!/usr/bin/env bun
/**
 * TestInfraSetup.test.ts - Tests for test infrastructure generation tool
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, rmSync, readFileSync } from "fs";
import { join } from "path";

import {
  parseTestInfraArgs,
  generateTestConfig,
  generateConftest,
  generateUnitTestTemplate,
  generateIntegrationTestTemplate,
  generateEvalTestTemplate,
  generateTestFixtures,
  scaffoldTestInfra,
  type TestInfraConfig,
} from "./TestInfraSetup";

const TEST_DIR = "/tmp/testinfra-setup-test";

describe("TestInfraSetup", () => {
  beforeEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  describe("parseTestInfraArgs", () => {
    test("parses required project-dir", () => {
      const config = parseTestInfraArgs(["--project-dir", TEST_DIR]);
      expect(config.projectDir).toBe(TEST_DIR);
    });

    test("defaults to all test levels", () => {
      const config = parseTestInfraArgs(["--project-dir", TEST_DIR]);
      expect(config.levels).toContain("unit");
      expect(config.levels).toContain("integration");
      expect(config.levels).toContain("evals");
    });

    test("accepts custom test levels", () => {
      const config = parseTestInfraArgs([
        "--project-dir", TEST_DIR,
        "--levels", "unit,integration",
      ]);
      expect(config.levels).toEqual(["unit", "integration"]);
      expect(config.levels).not.toContain("evals");
    });

    test("throws on missing project-dir", () => {
      expect(() => parseTestInfraArgs([])).toThrow();
    });
  });

  describe("generateTestConfig", () => {
    test("generates bun test config for TypeScript", () => {
      const config = generateTestConfig("typescript");
      expect(config).toContain("bun");
      expect(config).toContain("tests");
    });

    test("generates pytest config for Python", () => {
      const config = generateTestConfig("python");
      expect(config).toContain("pytest");
      expect(config).toContain("asyncio_mode");
      expect(config).toContain("markers");
    });
  });

  describe("generateConftest", () => {
    test("generates TypeScript test helper", () => {
      const conftest = generateConftest("typescript");
      expect(conftest).toContain("mock");
      expect(conftest).toContain("export");
    });

    test("generates Python conftest", () => {
      const conftest = generateConftest("python");
      expect(conftest).toContain("@pytest.fixture");
      expect(conftest).toContain("mock_anthropic");
    });
  });

  describe("generateUnitTestTemplate", () => {
    test("generates TypeScript unit test", () => {
      const tmpl = generateUnitTestTemplate("typescript");
      expect(tmpl).toContain("describe");
      expect(tmpl).toContain("test");
      expect(tmpl).toContain("expect");
    });

    test("generates Python unit test", () => {
      const tmpl = generateUnitTestTemplate("python");
      expect(tmpl).toContain("class Test");
      expect(tmpl).toContain("pytest");
      expect(tmpl).toContain("async def test_");
    });
  });

  describe("generateIntegrationTestTemplate", () => {
    test("generates TypeScript integration test", () => {
      const tmpl = generateIntegrationTestTemplate("typescript");
      expect(tmpl).toContain("describe");
      expect(tmpl).toContain("Integration");
    });

    test("generates Python integration test", () => {
      const tmpl = generateIntegrationTestTemplate("python");
      expect(tmpl).toContain("Integration");
      expect(tmpl).toContain("class Test");
    });
  });

  describe("generateEvalTestTemplate", () => {
    test("generates TypeScript eval test", () => {
      const tmpl = generateEvalTestTemplate("typescript");
      expect(tmpl).toContain("Eval");
      expect(tmpl).toContain("Quality");
    });

    test("generates Python eval test", () => {
      const tmpl = generateEvalTestTemplate("python");
      expect(tmpl).toContain("evals");
      expect(tmpl).toContain("quality");
    });
  });

  describe("generateTestFixtures", () => {
    test("generates JSON test cases fixture", () => {
      const fixtures = generateTestFixtures();
      const parsed = JSON.parse(fixtures);
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed.length).toBeGreaterThan(0);
      expect(parsed[0]).toHaveProperty("input");
      expect(parsed[0]).toHaveProperty("expected_keywords");
    });
  });

  describe("scaffoldTestInfra", () => {
    test("creates test directories", () => {
      scaffoldTestInfra({
        projectDir: TEST_DIR,
        language: "typescript",
        levels: ["unit", "integration"],
      });

      expect(existsSync(join(TEST_DIR, "tests/unit"))).toBe(true);
      expect(existsSync(join(TEST_DIR, "tests/integration"))).toBe(true);
    });

    test("creates test config file", () => {
      scaffoldTestInfra({
        projectDir: TEST_DIR,
        language: "typescript",
        levels: ["unit"],
      });

      // For TS, we create a bunfig.toml or similar
      const configPath = join(TEST_DIR, "tests", "test-helpers.ts");
      expect(existsSync(configPath)).toBe(true);
    });

    test("creates unit test templates", () => {
      scaffoldTestInfra({
        projectDir: TEST_DIR,
        language: "typescript",
        levels: ["unit"],
      });

      expect(existsSync(join(TEST_DIR, "tests/unit/nodes.test.ts"))).toBe(true);
    });

    test("creates fixtures directory with test cases", () => {
      scaffoldTestInfra({
        projectDir: TEST_DIR,
        language: "typescript",
        levels: ["evals"],
      });

      expect(existsSync(join(TEST_DIR, "tests/evals/datasets/test_cases.json"))).toBe(true);
    });

    test("returns list of created files", () => {
      const result = scaffoldTestInfra({
        projectDir: TEST_DIR,
        language: "typescript",
        levels: ["unit", "integration", "evals"],
      });

      expect(result.filesCreated.length).toBeGreaterThan(0);
    });
  });
});
