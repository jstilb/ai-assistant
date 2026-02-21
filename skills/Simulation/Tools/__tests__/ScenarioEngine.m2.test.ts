import { describe, test, expect } from "bun:test";

/**
 * ScenarioEngine.m2.test.ts - M2 Enhanced Scenario Engine Tests
 *
 * Tests for:
 * - Multi-agent scenario support
 * - Scenario-level coordination
 * - Agent dependency resolution within scenarios
 * - State passing between scenario steps
 * - Integration with MultiAgentRunner
 */

import {
  parseScenario,
  validateScenario,
  type Scenario,
} from "../ScenarioEngine.ts";

import {
  validateMultiAgentScenario,
  extractMultiAgentConfig,
  type MultiAgentScenarioConfig,
} from "../ScenarioEngineM2.ts";

describe("ScenarioEngine M2 - Multi-Agent Extensions", () => {
  // -- Multi-Agent Scenario Validation --

  describe("Multi-Agent Scenario Validation", () => {
    test("validates a multi-agent scenario config", () => {
      const config: MultiAgentScenarioConfig = {
        scenario: {
          id: "multi-scenario-001",
          name: "Multi-Agent Resilience Test",
          description: "Tests multiple agents under fault conditions",
          type: "multi_agent",
          target: { type: "agent" },
          environment: { sandbox: true },
          agents: [
            {
              agent_id: "reader",
              name: "Reader Agent",
              workload: "Read and validate files",
              fault_config: {
                tool: "Read",
                mode: "network_timeout",
                trigger: "call_count",
                call_count_threshold: 3,
              },
            },
            {
              agent_id: "writer",
              name: "Writer Agent",
              workload: "Write processed results",
              fault_config: {
                tool: "Edit",
                mode: "malformed_response",
                trigger: "random_probability",
                probability: 0.4,
              },
              depends_on: ["reader"],
            },
          ],
          coordination: {
            max_parallel: 2,
            start_order: "sequential",
          },
          execution: { runs: 1, timeout_ms: 60000 },
        },
      };

      const result = validateMultiAgentScenario(config);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    test("rejects multi-agent scenario without agents array", () => {
      const config = {
        scenario: {
          id: "bad-multi-001",
          name: "Bad Multi-Agent",
          description: "Missing agents",
          type: "multi_agent",
          target: { type: "agent" },
          environment: { sandbox: true },
          execution: { runs: 1, timeout_ms: 60000 },
        },
      };

      const result = validateMultiAgentScenario(config as any);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e: string) => e.includes("agents"))).toBe(true);
    });

    test("validates agent fault configs within scenario", () => {
      const config: MultiAgentScenarioConfig = {
        scenario: {
          id: "fault-check-001",
          name: "Fault Config Check",
          description: "Verifies per-agent fault configs",
          type: "multi_agent",
          target: { type: "agent" },
          environment: { sandbox: true },
          agents: [
            {
              agent_id: "a",
              name: "Agent A",
              workload: "test",
              fault_config: {
                tool: "Read",
                mode: "network_timeout",
                trigger: "call_count",
                call_count_threshold: 2,
              },
            },
          ],
          execution: { runs: 1, timeout_ms: 30000 },
        },
      };

      const result = validateMultiAgentScenario(config);
      expect(result.valid).toBe(true);
    });

    test("rejects agent with invalid fault mode", () => {
      const config = {
        scenario: {
          id: "bad-fault-001",
          name: "Bad Fault Mode",
          description: "Invalid fault mode",
          type: "multi_agent",
          target: { type: "agent" },
          environment: { sandbox: true },
          agents: [
            {
              agent_id: "a",
              name: "Agent A",
              workload: "test",
              fault_config: {
                tool: "Read",
                mode: "invalid_mode",
                trigger: "call_count",
              },
            },
          ],
          execution: { runs: 1, timeout_ms: 30000 },
        },
      };

      const result = validateMultiAgentScenario(config as any);
      expect(result.valid).toBe(false);
    });
  });

  // -- Config Extraction --

  describe("extractMultiAgentConfig", () => {
    test("extracts MultiAgentConfig from scenario", () => {
      const config: MultiAgentScenarioConfig = {
        scenario: {
          id: "extract-001",
          name: "Extract Test",
          description: "Test extraction",
          type: "multi_agent",
          target: { type: "agent" },
          environment: { sandbox: true },
          agents: [
            {
              agent_id: "a",
              name: "Agent A",
              workload: "test workload",
              fault_config: { tool: "Read", mode: "network_timeout", trigger: "call_count" },
              timeout_ms: 5000,
            },
            {
              agent_id: "b",
              name: "Agent B",
              workload: "test workload 2",
              fault_config: { tool: "Bash", mode: "rate_limit", trigger: "random_probability", probability: 0.3 },
              depends_on: ["a"],
            },
          ],
          coordination: { max_parallel: 1, start_order: "sequential" },
          shared_state: { key: "value" },
          execution: { runs: 1, timeout_ms: 60000 },
        },
      };

      const multiConfig = extractMultiAgentConfig(config);
      expect(multiConfig.simulation_id).toBe("extract-001");
      expect(multiConfig.agents).toHaveLength(2);
      expect(multiConfig.agents[0].agent_id).toBe("a");
      expect(multiConfig.agents[1].depends_on).toEqual(["a"]);
      expect(multiConfig.coordination!.max_parallel).toBe(1);
      expect(multiConfig.shared_state).toEqual({ key: "value" });
    });
  });

  // -- State Passing Between Steps --

  describe("State Passing", () => {
    test("scenario with shared_state key is valid", () => {
      const config: MultiAgentScenarioConfig = {
        scenario: {
          id: "state-001",
          name: "State Passing Test",
          description: "Tests shared state",
          type: "multi_agent",
          target: { type: "agent" },
          environment: { sandbox: true },
          agents: [
            {
              agent_id: "producer",
              name: "Producer",
              workload: "produce data",
              fault_config: { tool: "Read", mode: "network_timeout", trigger: "call_count" },
            },
            {
              agent_id: "consumer",
              name: "Consumer",
              workload: "consume data",
              fault_config: { tool: "Edit", mode: "malformed_response", trigger: "random_probability" },
              depends_on: ["producer"],
            },
          ],
          shared_state: { pipeline_data: null, status: "pending" },
          coordination: { max_parallel: 1, start_order: "sequential" },
          execution: { runs: 1, timeout_ms: 60000 },
        },
      };

      const result = validateMultiAgentScenario(config);
      expect(result.valid).toBe(true);

      const multiConfig = extractMultiAgentConfig(config);
      expect(multiConfig.shared_state!.status).toBe("pending");
    });
  });
});
