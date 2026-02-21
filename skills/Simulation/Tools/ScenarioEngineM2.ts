#!/usr/bin/env bun
/**
 * ScenarioEngineM2.ts - Multi-agent scenario extensions for ScenarioEngine
 *
 * Extends the M1 ScenarioEngine with:
 * - Multi-agent scenario validation
 * - Config extraction for MultiAgentRunner
 * - Per-agent fault config support
 * - Inter-agent dependencies
 * - Shared state definitions
 *
 * Usage:
 *   import { validateMultiAgentScenario, extractMultiAgentConfig } from "./ScenarioEngineM2.ts";
 *   const result = validateMultiAgentScenario(config);
 *   const multiConfig = extractMultiAgentConfig(config);
 */

import type { MultiAgentConfig, AgentConfig, FaultConfigRef } from "./MultiAgentRunner.ts";

// ============================================
// TYPES
// ============================================

export interface MultiAgentScenarioAgent {
  agent_id: string;
  name: string;
  workload: string;
  fault_config: FaultConfigRef;
  timeout_ms?: number;
  depends_on?: string[];
}

export interface MultiAgentScenarioConfig {
  scenario: {
    id: string;
    name: string;
    description: string;
    type: "multi_agent";
    target: {
      type: "agent" | "workflow" | "skill" | "hook" | "prompt";
      skill?: string;
      workflow?: string;
      prompt?: string;
    };
    environment: {
      sandbox: boolean;
      copy_skills?: string[];
      mock_files?: Array<{ path: string; content: string }>;
    };
    agents: MultiAgentScenarioAgent[];
    coordination?: {
      max_parallel: number;
      start_order?: "parallel" | "sequential" | "staggered";
      stagger_delay_ms?: number;
    };
    shared_state?: Record<string, unknown>;
    faults?: Array<Record<string, unknown>>;
    invariants?: Array<{ name: string; assert: string; params?: Record<string, unknown> }>;
    execution: {
      runs: number;
      timeout_ms: number;
      parallel?: number;
      seed?: number;
    };
  };
}

interface ValidationResult {
  valid: boolean;
  errors: string[];
}

// ============================================
// VALID VALUES
// ============================================

const VALID_FAULT_MODES = ["network_timeout", "malformed_response", "rate_limit", "tool_unavailable"];
const VALID_TRIGGERS = ["call_count", "random_probability", "time_window"];
const VALID_START_ORDERS = ["parallel", "sequential", "staggered"];

// ============================================
// VALIDATION
// ============================================

export function validateMultiAgentScenario(config: MultiAgentScenarioConfig): ValidationResult {
  const errors: string[] = [];
  const s = config?.scenario;

  if (!s) {
    errors.push("Missing scenario object");
    return { valid: false, errors };
  }

  // Must be multi_agent type
  if (s.type !== "multi_agent") {
    errors.push(`scenario.type must be "multi_agent", got "${s.type}"`);
  }

  if (!s.id || s.id.trim() === "") {
    errors.push("scenario.id must be a non-empty string");
  }

  if (!s.name) errors.push("scenario.name is required");
  if (!s.target?.type) errors.push("scenario.target.type is required");

  // Agents array validation
  if (!s.agents || !Array.isArray(s.agents) || s.agents.length === 0) {
    errors.push("scenario.agents must be a non-empty array");
    return { valid: false, errors };
  }

  const agentIds = new Set<string>();

  for (let i = 0; i < s.agents.length; i++) {
    const agent = s.agents[i];

    if (!agent.agent_id) errors.push(`agents[${i}]: missing agent_id`);
    if (!agent.name) errors.push(`agents[${i}]: missing name`);
    if (!agent.workload) errors.push(`agents[${i}]: missing workload`);

    if (agent.agent_id) {
      if (agentIds.has(agent.agent_id)) {
        errors.push(`agents[${i}]: duplicate agent_id "${agent.agent_id}"`);
      }
      agentIds.add(agent.agent_id);
    }

    // Validate per-agent fault config
    if (agent.fault_config) {
      if (agent.fault_config.mode && !VALID_FAULT_MODES.includes(agent.fault_config.mode)) {
        errors.push(`agents[${i}]: invalid fault mode "${agent.fault_config.mode}"`);
      }
      if (agent.fault_config.trigger && !VALID_TRIGGERS.includes(agent.fault_config.trigger)) {
        errors.push(`agents[${i}]: invalid trigger "${agent.fault_config.trigger}"`);
      }
    } else {
      errors.push(`agents[${i}]: missing fault_config`);
    }

    // Validate depends_on references
    if (agent.depends_on) {
      for (const dep of agent.depends_on) {
        if (!s.agents.some(a => a.agent_id === dep)) {
          errors.push(`agents[${i}]: depends_on references nonexistent agent "${dep}"`);
        }
      }
    }
  }

  // Validate coordination
  if (s.coordination) {
    if (s.coordination.start_order && !VALID_START_ORDERS.includes(s.coordination.start_order)) {
      errors.push(`invalid start_order: "${s.coordination.start_order}"`);
    }
    if (s.coordination.max_parallel !== undefined && s.coordination.max_parallel < 1) {
      errors.push("max_parallel must be >= 1");
    }
  }

  // Execution config
  if (!s.execution) {
    errors.push("scenario.execution is required");
  } else {
    if (!s.execution.runs || s.execution.runs < 1) errors.push("execution.runs must be >= 1");
    if (!s.execution.timeout_ms || s.execution.timeout_ms < 1) errors.push("execution.timeout_ms must be >= 1");
  }

  return { valid: errors.length === 0, errors };
}

// ============================================
// CONFIG EXTRACTION
// ============================================

/**
 * Extract a MultiAgentConfig from a multi-agent scenario config.
 * This bridges the scenario schema with the MultiAgentRunner interface.
 */
export function extractMultiAgentConfig(config: MultiAgentScenarioConfig): MultiAgentConfig {
  const s = config.scenario;

  const agents: AgentConfig[] = s.agents.map(agent => ({
    agent_id: agent.agent_id,
    name: agent.name,
    workload: agent.workload,
    fault_config: agent.fault_config,
    timeout_ms: agent.timeout_ms,
    depends_on: agent.depends_on,
  }));

  return {
    simulation_id: s.id,
    agents,
    shared_state: s.shared_state,
    coordination: s.coordination ? {
      max_parallel: s.coordination.max_parallel,
      start_order: s.coordination.start_order,
      stagger_delay_ms: s.coordination.stagger_delay_ms,
    } : undefined,
  };
}

// ============================================
// CLI
// ============================================

if (import.meta.main) {
  const [command, ...args] = process.argv.slice(2);

  switch (command) {
    case "validate": {
      const filePath = args[0];
      if (!filePath) {
        console.error("Usage: validate <multi-agent-scenario.json>");
        process.exit(1);
      }
      const { readFileSync, existsSync } = await import("fs");
      if (!existsSync(filePath)) {
        console.error(`File not found: ${filePath}`);
        process.exit(1);
      }

      let parsed: unknown;
      const content = readFileSync(filePath, "utf-8");
      try {
        parsed = JSON.parse(content);
      } catch {
        const YAML = (await import("yaml")).default;
        parsed = YAML.parse(content);
      }

      const result = validateMultiAgentScenario(parsed as MultiAgentScenarioConfig);
      console.log(JSON.stringify(result, null, 2));
      process.exit(result.valid ? 0 : 1);
      break;
    }

    case "extract": {
      const filePath = args[0];
      if (!filePath) {
        console.error("Usage: extract <multi-agent-scenario.json>");
        process.exit(1);
      }
      const { readFileSync, existsSync } = await import("fs");
      if (!existsSync(filePath)) {
        console.error(`File not found: ${filePath}`);
        process.exit(1);
      }

      const content = readFileSync(filePath, "utf-8");
      const config = JSON.parse(content) as MultiAgentScenarioConfig;
      const multiConfig = extractMultiAgentConfig(config);
      console.log(JSON.stringify(multiConfig, null, 2));
      break;
    }

    default:
      console.log(`ScenarioEngineM2 - Multi-agent scenario extensions

Commands:
  validate <scenario.json>   Validate multi-agent scenario
  extract <scenario.json>    Extract MultiAgentConfig from scenario`);
      break;
  }
}
