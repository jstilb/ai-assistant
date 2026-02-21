#!/usr/bin/env bun
/**
 * SandboxSetup.test.ts - Tests for sandbox environment setup tool
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, rmSync, readFileSync } from "fs";
import { join } from "path";

import {
  parseSandboxArgs,
  generateDockerfile,
  generateDockerCompose,
  generateEnvFile,
  scaffoldSandbox,
  type SandboxConfig,
} from "./SandboxSetup";

const TEST_DIR = "/tmp/sandbox-setup-test";

describe("SandboxSetup", () => {
  beforeEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  describe("parseSandboxArgs", () => {
    test("parses required project-dir argument", () => {
      const config = parseSandboxArgs(["--project-dir", TEST_DIR]);
      expect(config.projectDir).toBe(TEST_DIR);
    });

    test("applies defaults", () => {
      const config = parseSandboxArgs(["--project-dir", TEST_DIR]);
      expect(config.language).toBe("typescript");
      expect(config.environments).toContain("development");
    });

    test("parses multiple environments", () => {
      const config = parseSandboxArgs([
        "--project-dir", TEST_DIR,
        "--environments", "development,staging,production",
      ]);
      expect(config.environments).toEqual(["development", "staging", "production"]);
    });

    test("throws on missing project-dir", () => {
      expect(() => parseSandboxArgs([])).toThrow();
    });
  });

  describe("generateDockerfile", () => {
    test("generates TypeScript Dockerfile with bun", () => {
      const df = generateDockerfile("typescript");
      expect(df).toContain("oven/bun");
      expect(df).toContain("USER agent");
      expect(df).toContain("HEALTHCHECK");
    });

    test("generates Python Dockerfile", () => {
      const df = generateDockerfile("python");
      expect(df).toContain("python:3.11-slim");
      expect(df).toContain("USER agent");
      expect(df).toContain("HEALTHCHECK");
    });

    test("includes security features", () => {
      const df = generateDockerfile("typescript");
      expect(df).toContain("useradd");
      expect(df).toContain("chmod -R 555");
    });
  });

  describe("generateDockerCompose", () => {
    test("generates compose with security options", () => {
      const compose = generateDockerCompose("my-agent", "development");
      expect(compose).toContain("no-new-privileges");
      expect(compose).toContain("read_only: true");
      expect(compose).toContain("sandbox-net");
    });

    test("uses environment name in service name", () => {
      const compose = generateDockerCompose("my-agent", "staging");
      expect(compose).toContain("my-agent-staging");
    });

    test("includes resource limits", () => {
      const compose = generateDockerCompose("my-agent", "development");
      expect(compose).toContain("cpus:");
      expect(compose).toContain("memory:");
    });
  });

  describe("generateEnvFile", () => {
    test("generates development env with debug settings", () => {
      const env = generateEnvFile("my-agent", "development");
      expect(env).toContain("ENVIRONMENT=development");
      expect(env).toContain("LOG_LEVEL=DEBUG");
    });

    test("generates staging env with production-like settings", () => {
      const env = generateEnvFile("my-agent", "staging");
      expect(env).toContain("ENVIRONMENT=staging");
      expect(env).toContain("LOG_LEVEL=INFO");
    });

    test("generates production env example", () => {
      const env = generateEnvFile("my-agent", "production");
      expect(env).toContain("ENVIRONMENT=production");
      expect(env).toContain("LOG_LEVEL=WARNING");
    });

    test("generates sandbox env", () => {
      const env = generateEnvFile("my-agent", "sandbox");
      expect(env).toContain("ENVIRONMENT=sandbox");
      expect(env).toContain("MAX_ITERATIONS=5");
    });
  });

  describe("scaffoldSandbox", () => {
    test("creates directory structure", () => {
      scaffoldSandbox({
        projectDir: TEST_DIR,
        language: "typescript",
        environments: ["development"],
      });

      expect(existsSync(join(TEST_DIR, "docker"))).toBe(true);
      expect(existsSync(join(TEST_DIR, "envs"))).toBe(true);
    });

    test("creates Dockerfile", () => {
      scaffoldSandbox({
        projectDir: TEST_DIR,
        language: "typescript",
        environments: ["development"],
      });

      const dfPath = join(TEST_DIR, "docker", "Dockerfile.sandbox");
      expect(existsSync(dfPath)).toBe(true);
      const content = readFileSync(dfPath, "utf-8");
      expect(content).toContain("oven/bun");
    });

    test("creates env files for each environment", () => {
      scaffoldSandbox({
        projectDir: TEST_DIR,
        language: "typescript",
        environments: ["development", "staging"],
      });

      expect(existsSync(join(TEST_DIR, "envs", ".env.development"))).toBe(true);
      expect(existsSync(join(TEST_DIR, "envs", ".env.staging"))).toBe(true);
    });

    test("creates docker-compose files for each environment", () => {
      scaffoldSandbox({
        projectDir: TEST_DIR,
        language: "typescript",
        environments: ["development", "staging"],
      });

      expect(existsSync(join(TEST_DIR, "docker", "docker-compose.development.yml"))).toBe(true);
      expect(existsSync(join(TEST_DIR, "docker", "docker-compose.staging.yml"))).toBe(true);
    });

    test("returns list of created files", () => {
      const result = scaffoldSandbox({
        projectDir: TEST_DIR,
        language: "typescript",
        environments: ["development"],
      });

      expect(result.filesCreated.length).toBeGreaterThan(0);
      expect(result.filesCreated).toContain("docker/Dockerfile.sandbox");
    });
  });
});
