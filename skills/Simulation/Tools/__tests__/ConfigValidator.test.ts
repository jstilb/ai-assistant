import { describe, test, expect } from "bun:test";
import {
  validateScenarioConfig,
  scenarioConfigSchema,
  type ScenarioConfig,
  type ValidationResult,
} from "../ConfigValidator.ts";

// ============================================
// ISC #1: Config Validator Tests
// 15+ invalid configs, 5+ valid configs
// ============================================

describe("ConfigValidator", () => {
  // --- Valid Configs ---

  test("accepts minimal valid config with call_count trigger", () => {
    const config: ScenarioConfig = {
      scenario: {
        id: "test-001",
        name: "Test Scenario",
        description: "A test scenario",
        type: "chaos",
        target: { type: "workflow", skill: "Browser" },
        environment: { sandbox: true },
        faults: [
          {
            tool: "Read",
            mode: "network_timeout",
            trigger: "call_count",
            call_count_threshold: 3,
          },
        ],
        execution: { runs: 5, timeout_ms: 30000 },
      },
    };
    const result = validateScenarioConfig(config);
    expect(result.success).toBe(true);
  });

  test("accepts config with random_probability trigger", () => {
    const config: ScenarioConfig = {
      scenario: {
        id: "test-002",
        name: "Probability Scenario",
        description: "Tests probability trigger",
        type: "stress",
        target: { type: "skill", skill: "CORE" },
        environment: { sandbox: true },
        faults: [
          {
            tool: "Bash",
            mode: "tool_unavailable",
            trigger: "random_probability",
            probability: 0.5,
          },
        ],
        execution: { runs: 10, timeout_ms: 60000, seed: 42 },
      },
    };
    const result = validateScenarioConfig(config);
    expect(result.success).toBe(true);
  });

  test("accepts config with time_window trigger", () => {
    const config: ScenarioConfig = {
      scenario: {
        id: "test-003",
        name: "Time Window Scenario",
        description: "Tests time window trigger",
        type: "regression",
        target: { type: "hook" },
        environment: { sandbox: true },
        faults: [
          {
            tool: "WebFetch",
            mode: "rate_limit",
            trigger: "time_window",
            time_window_start: 0,
            time_window_end: 30,
          },
        ],
        execution: { runs: 3, timeout_ms: 120000 },
      },
    };
    const result = validateScenarioConfig(config);
    expect(result.success).toBe(true);
  });

  test("accepts config with multiple faults and invariants", () => {
    const config: ScenarioConfig = {
      scenario: {
        id: "test-004",
        name: "Multi Fault Scenario",
        description: "Multiple faults and invariants",
        type: "chaos",
        target: { type: "workflow", skill: "Browser", workflow: "Validate" },
        environment: {
          sandbox: true,
          copy_skills: ["Browser", "CORE"],
          mock_files: [
            { path: "~/test.html", content: "<html></html>" },
          ],
        },
        faults: [
          { tool: "Read", mode: "network_timeout", trigger: "call_count", call_count_threshold: 2 },
          { tool: "Bash", mode: "tool_unavailable", trigger: "random_probability", probability: 0.3 },
          { tool: "WebFetch", mode: "malformed_response", trigger: "time_window", time_window_start: 5, time_window_end: 15 },
        ],
        invariants: [
          { name: "no_production_writes", assert: "no_writes_outside_sandbox" },
          { name: "graceful_errors", assert: "agent_reports_failure_not_hallucinate" },
        ],
        execution: { runs: 10, timeout_ms: 120000, parallel: 3, seed: 42 },
      },
    };
    const result = validateScenarioConfig(config);
    expect(result.success).toBe(true);
  });

  test("accepts config with all four fault modes", () => {
    const config: ScenarioConfig = {
      scenario: {
        id: "test-005",
        name: "All Modes",
        description: "One fault per mode",
        type: "property",
        target: { type: "agent" },
        environment: { sandbox: true },
        faults: [
          { tool: "Read", mode: "network_timeout", trigger: "call_count", call_count_threshold: 1 },
          { tool: "Bash", mode: "malformed_response", trigger: "random_probability", probability: 0.5 },
          { tool: "WebFetch", mode: "rate_limit", trigger: "time_window", time_window_start: 0, time_window_end: 60 },
          { tool: "Grep", mode: "tool_unavailable", trigger: "call_count", call_count_threshold: 2 },
        ],
        execution: { runs: 1, timeout_ms: 60000 },
      },
    };
    const result = validateScenarioConfig(config);
    expect(result.success).toBe(true);
  });

  // --- Invalid Configs (15+) ---

  test("rejects config missing scenario.id", () => {
    const config = {
      scenario: {
        name: "Missing ID",
        description: "No id field",
        type: "chaos",
        target: { type: "workflow" },
        environment: { sandbox: true },
        faults: [],
        execution: { runs: 1, timeout_ms: 30000 },
      },
    };
    const result = validateScenarioConfig(config as any);
    expect(result.success).toBe(false);
    expect(result.errors!.some((e: string) => e.includes("id"))).toBe(true);
  });

  test("rejects config missing scenario.name", () => {
    const config = {
      scenario: {
        id: "missing-name",
        description: "No name field",
        type: "chaos",
        target: { type: "workflow" },
        environment: { sandbox: true },
        faults: [],
        execution: { runs: 1, timeout_ms: 30000 },
      },
    };
    const result = validateScenarioConfig(config as any);
    expect(result.success).toBe(false);
    expect(result.errors!.some((e: string) => e.includes("name"))).toBe(true);
  });

  test("rejects config with invalid scenario type", () => {
    const config = {
      scenario: {
        id: "bad-type",
        name: "Bad Type",
        description: "Invalid type value",
        type: "explode",
        target: { type: "workflow" },
        environment: { sandbox: true },
        faults: [],
        execution: { runs: 1, timeout_ms: 30000 },
      },
    };
    const result = validateScenarioConfig(config as any);
    expect(result.success).toBe(false);
    expect(result.errors!.some((e: string) => e.includes("type"))).toBe(true);
  });

  test("rejects config with invalid fault mode", () => {
    const config = {
      scenario: {
        id: "bad-fault-mode",
        name: "Bad Fault Mode",
        description: "Invalid fault mode",
        type: "chaos",
        target: { type: "workflow" },
        environment: { sandbox: true },
        faults: [
          { tool: "Read", mode: "crash_and_burn", trigger: "call_count", call_count_threshold: 1 },
        ],
        execution: { runs: 1, timeout_ms: 30000 },
      },
    };
    const result = validateScenarioConfig(config as any);
    expect(result.success).toBe(false);
    expect(result.errors!.some((e: string) => e.includes("mode"))).toBe(true);
  });

  test("rejects config with invalid trigger type", () => {
    const config = {
      scenario: {
        id: "bad-trigger",
        name: "Bad Trigger",
        description: "Invalid trigger type",
        type: "chaos",
        target: { type: "workflow" },
        environment: { sandbox: true },
        faults: [
          { tool: "Read", mode: "network_timeout", trigger: "moon_phase" },
        ],
        execution: { runs: 1, timeout_ms: 30000 },
      },
    };
    const result = validateScenarioConfig(config as any);
    expect(result.success).toBe(false);
    expect(result.errors!.some((e: string) => e.includes("trigger"))).toBe(true);
  });

  test("rejects config with probability > 1", () => {
    const config = {
      scenario: {
        id: "bad-prob",
        name: "Bad Probability",
        description: "Probability over 1",
        type: "chaos",
        target: { type: "workflow" },
        environment: { sandbox: true },
        faults: [
          { tool: "Read", mode: "network_timeout", trigger: "random_probability", probability: 1.5 },
        ],
        execution: { runs: 1, timeout_ms: 30000 },
      },
    };
    const result = validateScenarioConfig(config as any);
    expect(result.success).toBe(false);
    expect(result.errors!.some((e: string) => e.includes("probability"))).toBe(true);
  });

  test("rejects config with negative probability", () => {
    const config = {
      scenario: {
        id: "neg-prob",
        name: "Negative Probability",
        description: "Probability below 0",
        type: "chaos",
        target: { type: "workflow" },
        environment: { sandbox: true },
        faults: [
          { tool: "Read", mode: "network_timeout", trigger: "random_probability", probability: -0.1 },
        ],
        execution: { runs: 1, timeout_ms: 30000 },
      },
    };
    const result = validateScenarioConfig(config as any);
    expect(result.success).toBe(false);
  });

  test("rejects config with zero runs", () => {
    const config = {
      scenario: {
        id: "zero-runs",
        name: "Zero Runs",
        description: "Zero runs",
        type: "chaos",
        target: { type: "workflow" },
        environment: { sandbox: true },
        faults: [],
        execution: { runs: 0, timeout_ms: 30000 },
      },
    };
    const result = validateScenarioConfig(config as any);
    expect(result.success).toBe(false);
    expect(result.errors!.some((e: string) => e.includes("runs"))).toBe(true);
  });

  test("rejects config with negative timeout", () => {
    const config = {
      scenario: {
        id: "neg-timeout",
        name: "Negative Timeout",
        description: "Negative timeout",
        type: "chaos",
        target: { type: "workflow" },
        environment: { sandbox: true },
        faults: [],
        execution: { runs: 1, timeout_ms: -1000 },
      },
    };
    const result = validateScenarioConfig(config as any);
    expect(result.success).toBe(false);
  });

  test("rejects config missing target.type", () => {
    const config = {
      scenario: {
        id: "no-target-type",
        name: "No Target Type",
        description: "Missing target type",
        type: "chaos",
        target: {},
        environment: { sandbox: true },
        faults: [],
        execution: { runs: 1, timeout_ms: 30000 },
      },
    };
    const result = validateScenarioConfig(config as any);
    expect(result.success).toBe(false);
  });

  test("rejects config missing execution block", () => {
    const config = {
      scenario: {
        id: "no-exec",
        name: "No Execution",
        description: "Missing execution",
        type: "chaos",
        target: { type: "workflow" },
        environment: { sandbox: true },
        faults: [],
      },
    };
    const result = validateScenarioConfig(config as any);
    expect(result.success).toBe(false);
  });

  test("rejects config missing environment block", () => {
    const config = {
      scenario: {
        id: "no-env",
        name: "No Environment",
        description: "Missing environment",
        type: "chaos",
        target: { type: "workflow" },
        faults: [],
        execution: { runs: 1, timeout_ms: 30000 },
      },
    };
    const result = validateScenarioConfig(config as any);
    expect(result.success).toBe(false);
  });

  test("rejects config with fault missing tool name", () => {
    const config = {
      scenario: {
        id: "no-tool",
        name: "No Tool",
        description: "Fault without tool name",
        type: "chaos",
        target: { type: "workflow" },
        environment: { sandbox: true },
        faults: [
          { mode: "network_timeout", trigger: "call_count", call_count_threshold: 1 },
        ],
        execution: { runs: 1, timeout_ms: 30000 },
      },
    };
    const result = validateScenarioConfig(config as any);
    expect(result.success).toBe(false);
  });

  test("rejects config with call_count threshold of 0", () => {
    const config = {
      scenario: {
        id: "zero-threshold",
        name: "Zero Threshold",
        description: "Call count threshold of 0",
        type: "chaos",
        target: { type: "workflow" },
        environment: { sandbox: true },
        faults: [
          { tool: "Read", mode: "network_timeout", trigger: "call_count", call_count_threshold: 0 },
        ],
        execution: { runs: 1, timeout_ms: 30000 },
      },
    };
    const result = validateScenarioConfig(config as any);
    expect(result.success).toBe(false);
  });

  test("rejects config with time_window end before start", () => {
    const config = {
      scenario: {
        id: "bad-window",
        name: "Bad Window",
        description: "Time window end before start",
        type: "chaos",
        target: { type: "workflow" },
        environment: { sandbox: true },
        faults: [
          { tool: "Read", mode: "network_timeout", trigger: "time_window", time_window_start: 30, time_window_end: 10 },
        ],
        execution: { runs: 1, timeout_ms: 30000 },
      },
    };
    const result = validateScenarioConfig(config as any);
    expect(result.success).toBe(false);
  });

  test("rejects config with empty string id", () => {
    const config = {
      scenario: {
        id: "",
        name: "Empty ID",
        description: "Empty string id",
        type: "chaos",
        target: { type: "workflow" },
        environment: { sandbox: true },
        faults: [],
        execution: { runs: 1, timeout_ms: 30000 },
      },
    };
    const result = validateScenarioConfig(config as any);
    expect(result.success).toBe(false);
  });

  test("rejects entirely empty object", () => {
    const result = validateScenarioConfig({} as any);
    expect(result.success).toBe(false);
  });

  // --- Error message quality ---

  test("provides actionable error messages", () => {
    const config = {
      scenario: {
        id: "error-messages",
        name: "Error Messages",
        description: "Test error messages",
        type: "invalid_type",
        target: { type: "workflow" },
        environment: { sandbox: true },
        faults: [
          { tool: "Read", mode: "explode", trigger: "call_count", call_count_threshold: 1 },
        ],
        execution: { runs: 0, timeout_ms: -1 },
      },
    };
    const result = validateScenarioConfig(config as any);
    expect(result.success).toBe(false);
    expect(result.errors!.length).toBeGreaterThan(0);
    // Each error should be a non-empty string
    for (const err of result.errors!) {
      expect(typeof err).toBe("string");
      expect(err.length).toBeGreaterThan(0);
    }
  });
});
