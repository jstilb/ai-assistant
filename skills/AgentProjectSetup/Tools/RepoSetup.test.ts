#!/usr/bin/env bun
/**
 * RepoSetup.test.ts - Tests for GitHub repository creation tool
 *
 * Tests verify CLI argument parsing, directory structure generation,
 * and gh CLI command composition without actually calling GitHub.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, rmSync, readFileSync } from "fs";
import { join } from "path";

// Import after defining — tests run against the module's exported functions
import {
  parseRepoArgs,
  generateGitignore,
  generateReadme,
  generateAgentsMd,
  buildGhCommand,
  type RepoConfig,
} from "./RepoSetup";

const TEST_DIR = "/tmp/repo-setup-test";

describe("RepoSetup", () => {
  beforeEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  describe("parseRepoArgs", () => {
    test("parses required arguments", () => {
      const config = parseRepoArgs([
        "--name", "my-agent",
        "--description", "A test agent",
      ]);
      expect(config.name).toBe("my-agent");
      expect(config.description).toBe("A test agent");
    });

    test("applies sensible defaults", () => {
      const config = parseRepoArgs([
        "--name", "my-agent",
        "--description", "A test agent",
      ]);
      expect(config.language).toBe("typescript");
      expect(config.visibility).toBe("private");
      expect(config.framework).toBe("langgraph");
    });

    test("accepts --language flag", () => {
      const config = parseRepoArgs([
        "--name", "my-agent",
        "--description", "A test agent",
        "--language", "python",
      ]);
      expect(config.language).toBe("python");
    });

    test("accepts --org flag", () => {
      const config = parseRepoArgs([
        "--name", "my-agent",
        "--description", "A test agent",
        "--org", "my-org",
      ]);
      expect(config.org).toBe("my-org");
    });

    test("accepts --public flag", () => {
      const config = parseRepoArgs([
        "--name", "my-agent",
        "--description", "A test agent",
        "--public",
      ]);
      expect(config.visibility).toBe("public");
    });

    test("throws on missing name", () => {
      expect(() => parseRepoArgs(["--description", "test"])).toThrow();
    });

    test("throws on missing description", () => {
      expect(() => parseRepoArgs(["--name", "test"])).toThrow();
    });
  });

  describe("generateGitignore", () => {
    test("generates TypeScript gitignore", () => {
      const content = generateGitignore("typescript");
      expect(content).toContain("node_modules/");
      expect(content).toContain(".env");
      expect(content).toContain("dist/");
    });

    test("generates Python gitignore", () => {
      const content = generateGitignore("python");
      expect(content).toContain("__pycache__/");
      expect(content).toContain(".venv/");
      expect(content).toContain(".env");
    });

    test("both include common patterns", () => {
      const ts = generateGitignore("typescript");
      const py = generateGitignore("python");
      expect(ts).toContain(".DS_Store");
      expect(py).toContain(".DS_Store");
      expect(ts).toContain(".env.production");
      expect(py).toContain(".env.production");
    });
  });

  describe("generateReadme", () => {
    test("includes project name and description", () => {
      const readme = generateReadme({
        name: "test-agent",
        description: "A test agent project",
        language: "typescript",
        framework: "langgraph",
        visibility: "private",
      });
      expect(readme).toContain("test-agent");
      expect(readme).toContain("A test agent project");
    });

    test("includes language-appropriate commands", () => {
      const tsReadme = generateReadme({
        name: "test-agent",
        description: "test",
        language: "typescript",
        framework: "langgraph",
        visibility: "private",
      });
      expect(tsReadme).toContain("bun");

      const pyReadme = generateReadme({
        name: "test-agent",
        description: "test",
        language: "python",
        framework: "langgraph",
        visibility: "private",
      });
      expect(pyReadme).toContain("pytest");
    });
  });

  describe("generateAgentsMd", () => {
    test("includes project name", () => {
      const agentsMd = generateAgentsMd({
        name: "test-agent",
        description: "A test agent",
        language: "typescript",
        framework: "langgraph",
        visibility: "private",
      });
      expect(agentsMd).toContain("test-agent");
      expect(agentsMd).toContain("A test agent");
    });

    test("includes security boundaries", () => {
      const agentsMd = generateAgentsMd({
        name: "test-agent",
        description: "test",
        language: "typescript",
        framework: "langgraph",
        visibility: "private",
      });
      expect(agentsMd).toContain("NEVER commit credentials");
      expect(agentsMd).toContain("Boundaries");
    });
  });

  describe("buildGhCommand", () => {
    test("builds basic gh repo create command", () => {
      const cmd = buildGhCommand({
        name: "my-agent",
        description: "A test agent",
        language: "typescript",
        framework: "langgraph",
        visibility: "private",
      });
      expect(cmd).toContain("gh repo create");
      expect(cmd).toContain("my-agent");
      expect(cmd).toContain("--private");
      expect(cmd).toContain("--clone");
    });

    test("uses org prefix when provided", () => {
      const cmd = buildGhCommand({
        name: "my-agent",
        description: "A test agent",
        language: "typescript",
        framework: "langgraph",
        visibility: "private",
        org: "my-org",
      });
      expect(cmd).toContain("my-org/my-agent");
    });

    test("respects public visibility", () => {
      const cmd = buildGhCommand({
        name: "my-agent",
        description: "A test agent",
        language: "typescript",
        framework: "langgraph",
        visibility: "public",
      });
      expect(cmd).toContain("--public");
      expect(cmd).not.toContain("--private");
    });
  });
});
