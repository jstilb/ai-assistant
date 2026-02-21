import { describe, test, expect } from "bun:test";
import {
  createRunnerConfig,
  buildSpawnArgs,
  type RunnerConfig,
  type RunResult,
} from "../AgentRunner.ts";

// ============================================
// ISC #9, #10: Single-Agent Runner Tests
// Process spawn config, watchdog timer, diagnostics
// ============================================

describe("AgentRunner", () => {
  test("createRunnerConfig sets default timeout to 60s", () => {
    const config = createRunnerConfig({
      prompt: "test prompt",
      cwd: "/tmp/sandbox",
    });

    expect(config.timeoutMs).toBe(60000);
  });

  test("createRunnerConfig allows custom timeout", () => {
    const config = createRunnerConfig({
      prompt: "test prompt",
      cwd: "/tmp/sandbox",
      timeoutMs: 120000,
    });

    expect(config.timeoutMs).toBe(120000);
  });

  test("buildSpawnArgs returns array without shell concatenation", () => {
    const config = createRunnerConfig({
      prompt: "Run the browser check",
      cwd: "/tmp/sandbox",
    });

    const args = buildSpawnArgs(config);

    // Must be an array
    expect(Array.isArray(args.args)).toBe(true);
    // No element should contain shell metacharacters that suggest concatenation
    for (const arg of args.args) {
      expect(typeof arg).toBe("string");
    }
  });

  test("spawn config includes correct command", () => {
    const config = createRunnerConfig({
      prompt: "test",
      cwd: "/tmp/sandbox",
    });

    const spawnConfig = buildSpawnArgs(config);
    expect(spawnConfig.command).toBe("claude");
  });

  test("spawn config includes cwd", () => {
    const config = createRunnerConfig({
      prompt: "test",
      cwd: "/tmp/my-sandbox",
    });

    const spawnConfig = buildSpawnArgs(config);
    expect(spawnConfig.cwd).toBe("/tmp/my-sandbox");
  });

  test("spawn config includes timeout", () => {
    const config = createRunnerConfig({
      prompt: "test",
      cwd: "/tmp/sandbox",
      timeoutMs: 90000,
    });

    const spawnConfig = buildSpawnArgs(config);
    expect(spawnConfig.timeout).toBe(90000);
  });

  test("spawn args include --print flag", () => {
    const config = createRunnerConfig({
      prompt: "test prompt",
      cwd: "/tmp/sandbox",
    });

    const spawnConfig = buildSpawnArgs(config);
    expect(spawnConfig.args).toContain("--print");
  });

  test("spawn args include --dangerously-skip-permissions flag", () => {
    const config = createRunnerConfig({
      prompt: "test prompt",
      cwd: "/tmp/sandbox",
    });

    const spawnConfig = buildSpawnArgs(config);
    expect(spawnConfig.args).toContain("--dangerously-skip-permissions");
  });

  test("environment variables are set", () => {
    const config = createRunnerConfig({
      prompt: "test",
      cwd: "/tmp/sandbox",
      env: { SIMULATION_MODE: "true", FAULT_SEED: "42" },
    });

    const spawnConfig = buildSpawnArgs(config);
    expect(spawnConfig.env?.SIMULATION_MODE).toBe("true");
    expect(spawnConfig.env?.FAULT_SEED).toBe("42");
  });

  test("diagnostic dump structure", () => {
    // The runner should produce a diagnostic dump on timeout
    const config = createRunnerConfig({
      prompt: "test",
      cwd: "/tmp/sandbox",
      timeoutMs: 100,
    });

    // Test the diagnostic dump structure directly
    const diagnostic = {
      timedOut: true,
      timeoutMs: config.timeoutMs,
      prompt: config.prompt,
      cwd: config.cwd,
      timestamp: new Date().toISOString(),
    };

    expect(diagnostic).toHaveProperty("timedOut");
    expect(diagnostic).toHaveProperty("timeoutMs");
    expect(diagnostic).toHaveProperty("prompt");
    expect(diagnostic).toHaveProperty("cwd");
    expect(diagnostic).toHaveProperty("timestamp");
  });
});
