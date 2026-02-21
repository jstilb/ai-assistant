import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, existsSync, rmSync, readFileSync } from "fs";
import { join } from "path";

/**
 * MultiAgentRunner.test.ts - M2 Multi-Agent Orchestration Tests
 *
 * Tests for:
 * - Multi-agent config validation
 * - Parallel agent orchestration
 * - Sequential and staggered start orders
 * - Agent dependency resolution
 * - Shared state management
 * - Independent fault configs per agent
 * - Coordinated lifecycle (start all -> wait all -> collect)
 * - Transcript thread-safety (shared JSONL)
 */

import {
  createMultiAgentConfig,
  validateMultiAgentConfig,
  resolveAgentOrder,
  MultiAgentOrchestrator,
  type MultiAgentConfig,
  type AgentConfig,
  type MultiAgentResult,
} from "../MultiAgentRunner.ts";

const TEST_DIR = "/tmp/simulation-multi-agent-test";

describe("MultiAgentRunner", () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
  });

  // -- Config Validation --

  describe("Config Validation", () => {
    test("validates a minimal multi-agent config", () => {
      const config: MultiAgentConfig = {
        simulation_id: "multi-001",
        agents: [
          {
            agent_id: "agent-a",
            name: "Agent A",
            workload: "Run browser validation",
            fault_config: {
              tool: "Read",
              mode: "network_timeout",
              trigger: "call_count",
              call_count_threshold: 3,
            },
          },
        ],
      };

      const result = validateMultiAgentConfig(config);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    test("rejects config with no agents", () => {
      const config: MultiAgentConfig = {
        simulation_id: "multi-002",
        agents: [],
      };

      const result = validateMultiAgentConfig(config);
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors.some((e: string) => e.includes("agent"))).toBe(true);
    });

    test("rejects config with missing simulation_id", () => {
      const config = {
        simulation_id: "",
        agents: [
          {
            agent_id: "a",
            name: "A",
            workload: "test",
            fault_config: { tool: "Read", mode: "network_timeout", trigger: "call_count" },
          },
        ],
      } as MultiAgentConfig;

      const result = validateMultiAgentConfig(config);
      expect(result.valid).toBe(false);
    });

    test("rejects duplicate agent IDs", () => {
      const config: MultiAgentConfig = {
        simulation_id: "multi-003",
        agents: [
          { agent_id: "dup", name: "A", workload: "test", fault_config: { tool: "Read", mode: "network_timeout", trigger: "call_count" } },
          { agent_id: "dup", name: "B", workload: "test", fault_config: { tool: "Bash", mode: "rate_limit", trigger: "random_probability" } },
        ],
      };

      const result = validateMultiAgentConfig(config);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e: string) => e.includes("duplicate"))).toBe(true);
    });

    test("validates coordination settings", () => {
      const config: MultiAgentConfig = {
        simulation_id: "multi-004",
        agents: [
          { agent_id: "a", name: "A", workload: "test", fault_config: { tool: "Read", mode: "network_timeout", trigger: "call_count" } },
          { agent_id: "b", name: "B", workload: "test", fault_config: { tool: "Bash", mode: "rate_limit", trigger: "random_probability" } },
        ],
        coordination: {
          max_parallel: 2,
          start_order: "parallel",
        },
      };

      const result = validateMultiAgentConfig(config);
      expect(result.valid).toBe(true);
    });

    test("rejects invalid start_order", () => {
      const config = {
        simulation_id: "multi-005",
        agents: [
          { agent_id: "a", name: "A", workload: "test", fault_config: { tool: "Read", mode: "network_timeout", trigger: "call_count" } },
        ],
        coordination: {
          max_parallel: 1,
          start_order: "invalid_order",
        },
      };

      const result = validateMultiAgentConfig(config as any);
      expect(result.valid).toBe(false);
    });

    test("rejects dependency on non-existent agent", () => {
      const config: MultiAgentConfig = {
        simulation_id: "multi-006",
        agents: [
          {
            agent_id: "a",
            name: "A",
            workload: "test",
            fault_config: { tool: "Read", mode: "network_timeout", trigger: "call_count" },
            depends_on: ["nonexistent"],
          },
        ],
      };

      const result = validateMultiAgentConfig(config);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e: string) => e.includes("nonexistent"))).toBe(true);
    });
  });

  // -- Config Factory --

  describe("createMultiAgentConfig", () => {
    test("creates config with defaults", () => {
      const config = createMultiAgentConfig({
        simulation_id: "test-sim",
        agents: [
          { agent_id: "a", name: "A", workload: "test", fault_config: { tool: "Read", mode: "network_timeout", trigger: "call_count" } },
        ],
      });

      expect(config.simulation_id).toBe("test-sim");
      expect(config.coordination).toBeDefined();
      expect(config.coordination!.max_parallel).toBe(4);
      expect(config.coordination!.start_order).toBe("parallel");
    });

    test("preserves explicit coordination", () => {
      const config = createMultiAgentConfig({
        simulation_id: "test-sim",
        agents: [
          { agent_id: "a", name: "A", workload: "test", fault_config: { tool: "Read", mode: "network_timeout", trigger: "call_count" } },
        ],
        coordination: { max_parallel: 2, start_order: "sequential" },
      });

      expect(config.coordination!.max_parallel).toBe(2);
      expect(config.coordination!.start_order).toBe("sequential");
    });
  });

  // -- Dependency Resolution --

  describe("resolveAgentOrder", () => {
    test("returns agents in order when no dependencies", () => {
      const agents: AgentConfig[] = [
        { agent_id: "a", name: "A", workload: "test", fault_config: { tool: "Read", mode: "network_timeout", trigger: "call_count" } },
        { agent_id: "b", name: "B", workload: "test", fault_config: { tool: "Bash", mode: "rate_limit", trigger: "random_probability" } },
      ];

      const order = resolveAgentOrder(agents);
      expect(order).toHaveLength(2);
    });

    test("resolves linear dependency chain", () => {
      const agents: AgentConfig[] = [
        { agent_id: "c", name: "C", workload: "test", fault_config: { tool: "R", mode: "network_timeout", trigger: "call_count" }, depends_on: ["b"] },
        { agent_id: "a", name: "A", workload: "test", fault_config: { tool: "R", mode: "network_timeout", trigger: "call_count" } },
        { agent_id: "b", name: "B", workload: "test", fault_config: { tool: "R", mode: "network_timeout", trigger: "call_count" }, depends_on: ["a"] },
      ];

      const order = resolveAgentOrder(agents);
      const ids = order.map(a => a.agent_id);
      expect(ids.indexOf("a")).toBeLessThan(ids.indexOf("b"));
      expect(ids.indexOf("b")).toBeLessThan(ids.indexOf("c"));
    });

    test("detects circular dependencies", () => {
      const agents: AgentConfig[] = [
        { agent_id: "a", name: "A", workload: "test", fault_config: { tool: "R", mode: "network_timeout", trigger: "call_count" }, depends_on: ["b"] },
        { agent_id: "b", name: "B", workload: "test", fault_config: { tool: "R", mode: "network_timeout", trigger: "call_count" }, depends_on: ["a"] },
      ];

      expect(() => resolveAgentOrder(agents)).toThrow(/circular/i);
    });
  });

  // -- Orchestrator --

  describe("MultiAgentOrchestrator", () => {
    test("constructs with valid config", () => {
      const config = createMultiAgentConfig({
        simulation_id: "orch-001",
        agents: [
          { agent_id: "a", name: "A", workload: "test", fault_config: { tool: "Read", mode: "network_timeout", trigger: "call_count" } },
        ],
      });

      const orchestrator = new MultiAgentOrchestrator(config, TEST_DIR);
      expect(orchestrator).toBeDefined();
    });

    test("getAgentCount returns correct count", () => {
      const config = createMultiAgentConfig({
        simulation_id: "orch-002",
        agents: [
          { agent_id: "a", name: "A", workload: "test", fault_config: { tool: "Read", mode: "network_timeout", trigger: "call_count" } },
          { agent_id: "b", name: "B", workload: "test2", fault_config: { tool: "Bash", mode: "rate_limit", trigger: "random_probability" } },
          { agent_id: "c", name: "C", workload: "test3", fault_config: { tool: "Edit", mode: "tool_unavailable", trigger: "time_window" } },
        ],
      });

      const orchestrator = new MultiAgentOrchestrator(config, TEST_DIR);
      expect(orchestrator.getAgentCount()).toBe(3);
    });

    test("runDryMode returns structured results without spawning processes", async () => {
      const config = createMultiAgentConfig({
        simulation_id: "orch-003",
        agents: [
          { agent_id: "a", name: "A", workload: "Run test A", fault_config: { tool: "Read", mode: "network_timeout", trigger: "call_count" }, timeout_ms: 5000 },
          { agent_id: "b", name: "B", workload: "Run test B", fault_config: { tool: "Bash", mode: "rate_limit", trigger: "random_probability", probability: 0.5 }, timeout_ms: 5000 },
        ],
        coordination: { max_parallel: 2, start_order: "parallel" },
      });

      const orchestrator = new MultiAgentOrchestrator(config, TEST_DIR);
      const result = await orchestrator.runDryMode();

      expect(result.simulation_id).toBe("orch-003");
      expect(result.agents).toHaveLength(2);
      expect(result.status).toBe("completed");
      expect(result.total_duration_ms).toBeGreaterThanOrEqual(0);

      for (const agentResult of result.agents) {
        expect(agentResult.agent_id).toBeDefined();
        expect(agentResult.status).toBeDefined();
        expect(["pass", "fail", "error", "timeout", "dry_run"]).toContain(agentResult.status);
      }
    });

    test("runDryMode respects sequential ordering", async () => {
      const config = createMultiAgentConfig({
        simulation_id: "orch-004",
        agents: [
          { agent_id: "first", name: "First", workload: "Run first", fault_config: { tool: "Read", mode: "network_timeout", trigger: "call_count" } },
          { agent_id: "second", name: "Second", workload: "Run second", fault_config: { tool: "Bash", mode: "rate_limit", trigger: "random_probability" }, depends_on: ["first"] },
        ],
        coordination: { max_parallel: 1, start_order: "sequential" },
      });

      const orchestrator = new MultiAgentOrchestrator(config, TEST_DIR);
      const result = await orchestrator.runDryMode();

      expect(result.agents).toHaveLength(2);
      // First agent should start before second
      const firstIdx = result.agents.findIndex(a => a.agent_id === "first");
      const secondIdx = result.agents.findIndex(a => a.agent_id === "second");
      expect(firstIdx).toBeLessThan(secondIdx);
    });

    test("shared state is accessible to all agents", () => {
      const config = createMultiAgentConfig({
        simulation_id: "orch-005",
        agents: [
          { agent_id: "a", name: "A", workload: "test", fault_config: { tool: "Read", mode: "network_timeout", trigger: "call_count" } },
        ],
        shared_state: { test_key: "test_value", counter: 0 },
      });

      const orchestrator = new MultiAgentOrchestrator(config, TEST_DIR);
      expect(orchestrator.getSharedState("test_key")).toBe("test_value");
      expect(orchestrator.getSharedState("counter")).toBe(0);
    });

    test("shared state can be updated", () => {
      const config = createMultiAgentConfig({
        simulation_id: "orch-006",
        agents: [
          { agent_id: "a", name: "A", workload: "test", fault_config: { tool: "Read", mode: "network_timeout", trigger: "call_count" } },
        ],
        shared_state: { counter: 0 },
      });

      const orchestrator = new MultiAgentOrchestrator(config, TEST_DIR);
      orchestrator.updateSharedState("counter", 5);
      expect(orchestrator.getSharedState("counter")).toBe(5);
    });

    test("transcript path is created under test dir", () => {
      const config = createMultiAgentConfig({
        simulation_id: "orch-007",
        agents: [
          { agent_id: "a", name: "A", workload: "test", fault_config: { tool: "Read", mode: "network_timeout", trigger: "call_count" } },
        ],
      });

      const orchestrator = new MultiAgentOrchestrator(config, TEST_DIR);
      const transcriptPath = orchestrator.getTranscriptPath();
      expect(transcriptPath).toContain("orch-007");
      expect(transcriptPath).toContain(".jsonl");
    });
  });
});
