#!/usr/bin/env bun
/**
 * MultiAgentRunner.ts - Multi-agent orchestration engine
 *
 * Orchestrates multiple agents simultaneously with:
 * - Independent fault config per agent
 * - Shared transcript (thread-safe JSONL writing)
 * - Coordinated lifecycle (start all -> wait all -> collect results)
 * - Agent-to-agent interactions via shared state
 * - Configurable max-parallel agents
 * - Dependency resolution (topological sort)
 *
 * Usage:
 *   import { createMultiAgentConfig, MultiAgentOrchestrator } from "./MultiAgentRunner.ts";
 *   const config = createMultiAgentConfig({ ... });
 *   const orchestrator = new MultiAgentOrchestrator(config, "/tmp/work");
 *   const result = await orchestrator.runDryMode();
 */

import { spawn, type ChildProcess } from "child_process";
import { existsSync, mkdirSync, appendFileSync } from "fs";
import { join } from "path";

// ============================================
// TYPES
// ============================================

export interface FaultConfigRef {
  tool: string;
  mode: "network_timeout" | "malformed_response" | "rate_limit" | "tool_unavailable";
  trigger: "call_count" | "random_probability" | "time_window";
  call_count_threshold?: number;
  probability?: number;
  time_window_start?: number;
  time_window_end?: number;
  delay_ms?: number;
  message?: string;
}

export interface AgentConfig {
  agent_id: string;
  name: string;
  workload: string;
  fault_config: FaultConfigRef;
  timeout_ms?: number;
  depends_on?: string[];
}

export interface MultiAgentConfig {
  simulation_id: string;
  agents: AgentConfig[];
  shared_state?: Record<string, unknown>;
  coordination?: {
    max_parallel: number;
    start_order?: "parallel" | "sequential" | "staggered";
    stagger_delay_ms?: number;
  };
}

export interface AgentResult {
  agent_id: string;
  name: string;
  status: "pass" | "fail" | "error" | "timeout" | "dry_run";
  stdout: string;
  stderr: string;
  exit_code: number;
  timed_out: boolean;
  duration_ms: number;
  faults_configured: FaultConfigRef;
  started_at: string;
  completed_at: string;
}

export interface MultiAgentResult {
  simulation_id: string;
  agents: AgentResult[];
  status: "completed" | "partial" | "failed";
  total_duration_ms: number;
  started_at: string;
  completed_at: string;
  transcript_path?: string;
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
// CONFIG FACTORY
// ============================================

export function createMultiAgentConfig(input: MultiAgentConfig): MultiAgentConfig {
  return {
    simulation_id: input.simulation_id,
    agents: input.agents,
    shared_state: input.shared_state ?? {},
    coordination: {
      max_parallel: input.coordination?.max_parallel ?? 4,
      start_order: input.coordination?.start_order ?? "parallel",
      stagger_delay_ms: input.coordination?.stagger_delay_ms ?? 1000,
    },
  };
}

// ============================================
// VALIDATION
// ============================================

export function validateMultiAgentConfig(config: MultiAgentConfig): ValidationResult {
  const errors: string[] = [];

  if (!config.simulation_id || config.simulation_id.trim() === "") {
    errors.push("simulation_id must be a non-empty string");
  }

  if (!config.agents || config.agents.length === 0) {
    errors.push("agents array must contain at least one agent");
  }

  // Check duplicate agent IDs
  const ids = new Set<string>();
  for (const agent of config.agents) {
    if (ids.has(agent.agent_id)) {
      errors.push(`duplicate agent_id: "${agent.agent_id}"`);
    }
    ids.add(agent.agent_id);

    if (!agent.agent_id) errors.push("agent must have agent_id");
    if (!agent.name) errors.push(`agent "${agent.agent_id}": missing name`);
    if (!agent.workload) errors.push(`agent "${agent.agent_id}": missing workload`);

    // Validate fault config
    if (agent.fault_config) {
      if (!VALID_FAULT_MODES.includes(agent.fault_config.mode)) {
        errors.push(`agent "${agent.agent_id}": invalid fault mode "${agent.fault_config.mode}"`);
      }
      if (!VALID_TRIGGERS.includes(agent.fault_config.trigger)) {
        errors.push(`agent "${agent.agent_id}": invalid trigger "${agent.fault_config.trigger}"`);
      }
    }

    // Validate depends_on references
    if (agent.depends_on) {
      for (const dep of agent.depends_on) {
        if (!config.agents.some(a => a.agent_id === dep)) {
          errors.push(`agent "${agent.agent_id}": depends_on references nonexistent agent "${dep}"`);
        }
      }
    }
  }

  // Validate coordination
  if (config.coordination) {
    if (config.coordination.start_order && !VALID_START_ORDERS.includes(config.coordination.start_order)) {
      errors.push(`invalid start_order: "${config.coordination.start_order}". Valid: ${VALID_START_ORDERS.join(", ")}`);
    }
  }

  return { valid: errors.length === 0, errors };
}

// ============================================
// DEPENDENCY RESOLUTION (Topological Sort)
// ============================================

export function resolveAgentOrder(agents: AgentConfig[]): AgentConfig[] {
  const graph = new Map<string, string[]>();
  const inDegree = new Map<string, number>();
  const agentMap = new Map<string, AgentConfig>();

  for (const agent of agents) {
    agentMap.set(agent.agent_id, agent);
    graph.set(agent.agent_id, []);
    inDegree.set(agent.agent_id, 0);
  }

  for (const agent of agents) {
    if (agent.depends_on) {
      for (const dep of agent.depends_on) {
        if (!graph.has(dep)) continue;
        graph.get(dep)!.push(agent.agent_id);
        inDegree.set(agent.agent_id, (inDegree.get(agent.agent_id) ?? 0) + 1);
      }
    }
  }

  // Kahn's algorithm for topological sort
  const queue: string[] = [];
  for (const [id, degree] of inDegree) {
    if (degree === 0) queue.push(id);
  }

  const sorted: AgentConfig[] = [];

  while (queue.length > 0) {
    const current = queue.shift()!;
    sorted.push(agentMap.get(current)!);

    for (const neighbor of graph.get(current) ?? []) {
      const newDegree = (inDegree.get(neighbor) ?? 1) - 1;
      inDegree.set(neighbor, newDegree);
      if (newDegree === 0) queue.push(neighbor);
    }
  }

  if (sorted.length !== agents.length) {
    throw new Error("Circular dependency detected among agents");
  }

  return sorted;
}

// ============================================
// ORCHESTRATOR
// ============================================

export class MultiAgentOrchestrator {
  private config: MultiAgentConfig;
  private workDir: string;
  private sharedState: Record<string, unknown>;
  private transcriptPath: string;

  constructor(config: MultiAgentConfig, workDir: string) {
    this.config = config;
    this.workDir = workDir;
    this.sharedState = { ...(config.shared_state ?? {}) };

    // Set up transcript path
    const transcriptDir = join(workDir, "transcripts");
    if (!existsSync(transcriptDir)) mkdirSync(transcriptDir, { recursive: true });
    this.transcriptPath = join(transcriptDir, `${config.simulation_id}-${Date.now()}.jsonl`);
  }

  getAgentCount(): number {
    return this.config.agents.length;
  }

  getSharedState(key: string): unknown {
    return this.sharedState[key];
  }

  updateSharedState(key: string, value: unknown): void {
    this.sharedState[key] = value;
  }

  getTranscriptPath(): string {
    return this.transcriptPath;
  }

  /**
   * Dry run mode: validates config, resolves dependencies, returns
   * structured results WITHOUT spawning real agent processes.
   * Used for testing orchestration logic.
   */
  async runDryMode(): Promise<MultiAgentResult> {
    const startedAt = new Date().toISOString();
    const startTime = Date.now();

    // Resolve agent execution order
    const orderedAgents = resolveAgentOrder(this.config.agents);
    const maxParallel = this.config.coordination?.max_parallel ?? 4;
    const startOrder = this.config.coordination?.start_order ?? "parallel";

    const agentResults: AgentResult[] = [];

    if (startOrder === "sequential") {
      // Run agents one at a time in dependency order
      for (const agent of orderedAgents) {
        const result = this.createDryResult(agent);
        agentResults.push(result);
        this.logTranscriptEvent(agent.agent_id, "dry_run", "sequential_execution");
      }
    } else if (startOrder === "staggered") {
      // Run in batches with stagger delay
      const staggerDelay = this.config.coordination?.stagger_delay_ms ?? 1000;
      for (let i = 0; i < orderedAgents.length; i += maxParallel) {
        const batch = orderedAgents.slice(i, i + maxParallel);
        const batchResults = batch.map(agent => {
          this.logTranscriptEvent(agent.agent_id, "dry_run", "staggered_execution");
          return this.createDryResult(agent);
        });
        agentResults.push(...batchResults);
      }
    } else {
      // Parallel: run all at once (up to max_parallel)
      for (let i = 0; i < orderedAgents.length; i += maxParallel) {
        const batch = orderedAgents.slice(i, i + maxParallel);
        const batchResults = batch.map(agent => {
          this.logTranscriptEvent(agent.agent_id, "dry_run", "parallel_execution");
          return this.createDryResult(agent);
        });
        agentResults.push(...batchResults);
      }
    }

    const completedAt = new Date().toISOString();
    const totalDuration = Date.now() - startTime;

    return {
      simulation_id: this.config.simulation_id,
      agents: agentResults,
      status: "completed",
      total_duration_ms: totalDuration,
      started_at: startedAt,
      completed_at: completedAt,
      transcript_path: this.transcriptPath,
    };
  }

  /**
   * Real execution mode: spawns actual agent processes.
   * Each agent gets its own working directory, fault config, and env vars.
   */
  async run(): Promise<MultiAgentResult> {
    const startedAt = new Date().toISOString();
    const startTime = Date.now();

    const orderedAgents = resolveAgentOrder(this.config.agents);
    const maxParallel = this.config.coordination?.max_parallel ?? 4;
    const startOrder = this.config.coordination?.start_order ?? "parallel";

    const agentResults: AgentResult[] = [];

    if (startOrder === "sequential") {
      for (const agent of orderedAgents) {
        const result = await this.executeAgent(agent);
        agentResults.push(result);
      }
    } else if (startOrder === "staggered") {
      const staggerDelay = this.config.coordination?.stagger_delay_ms ?? 1000;
      for (let i = 0; i < orderedAgents.length; i += maxParallel) {
        const batch = orderedAgents.slice(i, i + maxParallel);
        const promises = batch.map((agent, idx) =>
          new Promise<AgentResult>(resolve => {
            setTimeout(async () => {
              const result = await this.executeAgent(agent);
              resolve(result);
            }, idx * staggerDelay);
          })
        );
        const batchResults = await Promise.all(promises);
        agentResults.push(...batchResults);
      }
    } else {
      // Parallel
      for (let i = 0; i < orderedAgents.length; i += maxParallel) {
        const batch = orderedAgents.slice(i, i + maxParallel);
        const promises = batch.map(agent => this.executeAgent(agent));
        const batchResults = await Promise.all(promises);
        agentResults.push(...batchResults);
      }
    }

    const completedAt = new Date().toISOString();
    const totalDuration = Date.now() - startTime;
    const allPassed = agentResults.every(r => r.status === "pass" || r.status === "dry_run");

    return {
      simulation_id: this.config.simulation_id,
      agents: agentResults,
      status: allPassed ? "completed" : agentResults.some(r => r.status === "pass") ? "partial" : "failed",
      total_duration_ms: totalDuration,
      started_at: startedAt,
      completed_at: completedAt,
      transcript_path: this.transcriptPath,
    };
  }

  // -- Internal helpers --

  private createDryResult(agent: AgentConfig): AgentResult {
    const now = new Date().toISOString();
    return {
      agent_id: agent.agent_id,
      name: agent.name,
      status: "dry_run",
      stdout: `[DRY RUN] ${agent.workload}`,
      stderr: "",
      exit_code: 0,
      timed_out: false,
      duration_ms: 0,
      faults_configured: agent.fault_config,
      started_at: now,
      completed_at: now,
    };
  }

  private async executeAgent(agent: AgentConfig): Promise<AgentResult> {
    const startedAt = new Date().toISOString();
    const startTime = Date.now();
    const timeoutMs = agent.timeout_ms ?? 60000;

    this.logTranscriptEvent(agent.agent_id, "agent_start", agent.workload);

    return new Promise<AgentResult>((resolve) => {
      const env: Record<string, string> = {
        ...Object.fromEntries(
          Object.entries(process.env).filter(([_, v]) => v !== undefined) as [string, string][]
        ),
        SIMULATION_MODE: "true",
        AGENT_ID: agent.agent_id,
        FAULT_TOOL: agent.fault_config.tool,
        FAULT_MODE: agent.fault_config.mode,
        FAULT_TRIGGER: agent.fault_config.trigger,
      };

      const child = spawn("claude", [
        "--print",
        "--dangerously-skip-permissions",
        agent.workload,
      ], {
        cwd: this.workDir,
        env,
        timeout: timeoutMs,
      });

      let stdout = "";
      let stderr = "";

      child.stdout?.on("data", (data: Buffer) => { stdout += data.toString(); });
      child.stderr?.on("data", (data: Buffer) => { stderr += data.toString(); });

      const timer = setTimeout(() => {
        child.kill("SIGTERM");
      }, timeoutMs);

      child.on("close", (code: number | null, signal: string | null) => {
        clearTimeout(timer);
        const duration_ms = Date.now() - startTime;
        const timedOut = signal === "SIGTERM";
        const completedAt = new Date().toISOString();

        this.logTranscriptEvent(
          agent.agent_id,
          timedOut ? "agent_timeout" : (code === 0 ? "agent_complete" : "agent_error"),
          `exit=${code} signal=${signal}`
        );

        resolve({
          agent_id: agent.agent_id,
          name: agent.name,
          status: timedOut ? "timeout" : (code === 0 ? "pass" : "fail"),
          stdout: stdout.slice(0, 5000),
          stderr: stderr.slice(0, 2000),
          exit_code: code ?? 1,
          timed_out: timedOut,
          duration_ms,
          faults_configured: agent.fault_config,
          started_at: startedAt,
          completed_at: completedAt,
        });
      });

      child.on("error", (err: Error) => {
        clearTimeout(timer);
        const duration_ms = Date.now() - startTime;
        const completedAt = new Date().toISOString();

        this.logTranscriptEvent(agent.agent_id, "agent_spawn_error", err.message);

        resolve({
          agent_id: agent.agent_id,
          name: agent.name,
          status: "error",
          stdout: "",
          stderr: err.message,
          exit_code: 1,
          timed_out: false,
          duration_ms,
          faults_configured: agent.fault_config,
          started_at: startedAt,
          completed_at: completedAt,
        });
      });
    });
  }

  private logTranscriptEvent(agentId: string, eventType: string, details: string): void {
    const event = {
      timestamp: new Date().toISOString(),
      agent_id: agentId,
      tool_name: "orchestrator",
      trigger_condition: eventType,
      fault_type: "none",
      fault_params: {},
      outcome: details,
    };

    try {
      appendFileSync(this.transcriptPath, JSON.stringify(event) + "\n");
    } catch {
      // Best effort logging - don't crash on transcript write failure
    }
  }
}

// ============================================
// CLI
// ============================================

if (import.meta.main) {
  const [command, ...args] = process.argv.slice(2);

  switch (command) {
    case "validate": {
      const configPath = args[0];
      if (!configPath) {
        console.error("Usage: validate <config.json>");
        process.exit(1);
      }
      const { readFileSync } = await import("fs");
      const config = JSON.parse(readFileSync(configPath, "utf-8")) as MultiAgentConfig;
      const result = validateMultiAgentConfig(config);
      console.log(JSON.stringify(result, null, 2));
      process.exit(result.valid ? 0 : 1);
      break;
    }

    case "dry-run": {
      const configPath = args[0];
      const workDir = args.find(a => a.startsWith("--workdir="))?.split("=")[1] ?? "/tmp/simulation-multi";
      if (!configPath) {
        console.error("Usage: dry-run <config.json> [--workdir=/tmp/simulation-multi]");
        process.exit(1);
      }
      const { readFileSync } = await import("fs");
      const config = createMultiAgentConfig(
        JSON.parse(readFileSync(configPath, "utf-8")) as MultiAgentConfig
      );
      const orchestrator = new MultiAgentOrchestrator(config, workDir);
      const result = await orchestrator.runDryMode();
      console.log(JSON.stringify(result, null, 2));
      break;
    }

    case "run": {
      const configPath = args[0];
      const workDir = args.find(a => a.startsWith("--workdir="))?.split("=")[1] ?? "/tmp/simulation-multi";
      if (!configPath) {
        console.error("Usage: run <config.json> [--workdir=/tmp/simulation-multi]");
        process.exit(1);
      }
      const { readFileSync } = await import("fs");
      const config = createMultiAgentConfig(
        JSON.parse(readFileSync(configPath, "utf-8")) as MultiAgentConfig
      );
      const orchestrator = new MultiAgentOrchestrator(config, workDir);
      const result = await orchestrator.run();
      console.log(JSON.stringify(result, null, 2));
      process.exit(result.status === "completed" ? 0 : 1);
      break;
    }

    default:
      console.log(`MultiAgentRunner - Multi-agent orchestration engine

Commands:
  validate <config.json>                     Validate multi-agent config
  dry-run <config.json> [--workdir=PATH]     Dry run (no real processes)
  run <config.json> [--workdir=PATH]         Run agents with real processes

Config format:
  { simulation_id, agents: [...], coordination: { max_parallel, start_order } }`);
      break;
  }
}
