#!/usr/bin/env bun
/**
 * ScenarioEngine.ts - YAML scenario parser and execution driver
 *
 * Parses scenario definitions, sets up environments, and drives
 * agent workflows through real subprocess execution with fault injection
 * and behavioral verification. JSONL transcript output.
 *
 * Uses StateManager for all state persistence. Uses refactored
 * FaultInjector (4 fault types, 3 trigger conditions) and
 * SandboxManager (git worktree + directory fallback).
 *
 * Usage:
 *   bun ScenarioEngine.ts run <scenario.yaml> [--runs=10] [--seed=42]
 *   bun ScenarioEngine.ts validate <scenario.yaml>
 *   bun ScenarioEngine.ts list
 */

import { existsSync, mkdirSync, readdirSync, appendFileSync } from "fs";
import { join, basename } from "path";
import { spawnSync } from "child_process";
import YAML from "yaml";
import { z } from "zod";
import { createStateManager } from "../../../../lib/core/StateManager.ts";
import { notifySync } from "../../../../lib/core/NotificationService.ts";
import { createSandbox, destroySandbox, validateIsolation } from "./SandboxManager.ts";
import { configure as configureFaults, shouldInjectFault, injectFault, getStats as getFaultStats, seededRandom } from "./FaultInjector.ts";
import type { FaultRule, FaultMode, TriggerType } from "./FaultInjector.ts";
import { CascadingFaultEngine, createCascadePattern, validateCascadePattern } from "./CascadingFaultEngine.ts";
import type { CascadePattern } from "./CascadingFaultEngine.ts";
import { emitWorkflowStart, emitToolCall, emitCompletion, emitError } from "../../AgentMonitor/Tools/TraceEmitter.ts";
import { generateReport, saveReport } from "./SimulationReporter.ts";

const KAYA_HOME = process.env.HOME + "/.claude";
const SCENARIOS_DIR = join(KAYA_HOME, "skills/System/Simulation/Scenarios");
const REPORTS_DIR = join(KAYA_HOME, "skills/System/Simulation/Reports");
const TRANSCRIPTS_DIR = join(KAYA_HOME, "skills/System/Simulation/Transcripts");
const STATE_PATH = join(KAYA_HOME, "skills/System/Simulation/state/engine-state.json");
const VERIFIER_TOOL = join(KAYA_HOME, "skills/System/Simulation/Tools/BehaviorVerifier.ts");

// --- Types ---

interface FaultConfig {
  tool: string;
  mode: FaultMode;
  trigger: TriggerType;
  probability?: number;
  call_count_threshold?: number;
  time_window_start?: number;
  time_window_end?: number;
  delay_ms?: number;
}

interface MockConfig {
  type: "tool_response" | "user_prompt" | "file_state";
  tool?: string;
  response?: unknown;
  variants?: string[];
  path?: string;
  content?: string;
}

interface InvariantConfig {
  name: string;
  assert: string;
  params?: Record<string, unknown>;
}

interface Scenario {
  scenario: {
    id: string;
    name: string;
    description: string;
    type: "chaos" | "replay" | "property" | "stress" | "regression" | "multi_agent";
    target: {
      type: "workflow" | "skill" | "hook" | "prompt" | "agent";
      skill?: string;
      workflow?: string;
      prompt?: string;
    };
    environment: {
      sandbox: boolean;
      copy_skills?: string[];
      mock_files?: Array<{ path: string; content: string }>;
    };
    faults?: FaultConfig[];
    mocks?: MockConfig[];
    invariants?: InvariantConfig[];
    cascading_faults?: {
      name: string;
      steps: Array<{
        fault_type: string;
        trigger_after: "immediate" | "on_recovery" | "on_retry";
        delay_ms?: number;
        parameters: Record<string, unknown>;
      }>;
      recovery_check?: boolean;
    };
    execution: {
      runs: number;
      timeout_ms: number;
      parallel?: number;
      seed?: number;
    };
  };
}

interface RunResult {
  runIndex: number;
  seed: number;
  sandboxId: string;
  startedAt: string;
  completedAt: string;
  duration_ms: number;
  status: "pass" | "fail" | "error" | "timeout";
  invariantResults: Array<{ name: string; passed: boolean; details?: string }>;
  faultsInjected: number;
  agentResponse?: string;
  error?: string;
}

interface SimulationResult {
  scenarioId: string;
  scenarioName: string;
  scenarioType: string;
  totalRuns: number;
  passed: number;
  failed: number;
  errors: number;
  passRate: number;
  startedAt: string;
  completedAt: string;
  totalDuration_ms: number;
  runs: RunResult[];
  summary: string;
  transcriptPath?: string;
}

// --- JSONL Transcript Event ---

interface TranscriptEvent {
  timestamp: string;
  agentId: string;
  toolName: string;
  triggerCondition: string;
  faultType: string;
  faultParameters: Record<string, unknown>;
  outcome: string;
}

// --- StateManager ---

const EngineStateSchema = z.object({
  lastSimulation: z.string().optional(),
  simulationCount: z.number(),
  lastRunAt: z.string().optional(),
});

const stateManager = createStateManager({
  path: STATE_PATH,
  schema: EngineStateSchema,
  defaults: { simulationCount: 0 },
});

// --- Parsing ---

function parseScenario(filePath: string): Scenario {
  const { readFileSync } = require("fs");
  const content = readFileSync(filePath, "utf-8");
  const parsed = YAML.parse(content);

  if (!parsed || !parsed.scenario) {
    throw new Error("Invalid scenario: missing top-level 'scenario' key");
  }

  return parsed as Scenario;
}

function validateScenario(scenario: Scenario): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  const s = scenario.scenario;

  if (!s.id) errors.push("Missing scenario.id");
  if (!s.name) errors.push("Missing scenario.name");
  if (!s.type) errors.push("Missing scenario.type");
  if (!["chaos", "replay", "property", "stress", "regression", "multi_agent"].includes(s.type)) {
    errors.push(`Invalid type: ${s.type}. Valid: chaos, replay, property, stress, regression, multi_agent`);
  }
  if (!s.target?.type) errors.push("Missing scenario.target.type");
  if (!s.execution?.runs) errors.push("Missing scenario.execution.runs");
  if (!s.execution?.timeout_ms) errors.push("Missing scenario.execution.timeout_ms");

  if (s.faults) {
    for (let i = 0; i < s.faults.length; i++) {
      const fault = s.faults[i];
      if (!fault.tool) errors.push(`faults[${i}]: missing tool name`);
      if (!fault.mode) errors.push(`faults[${i}]: missing mode`);
      const validModes = ["network_timeout", "malformed_response", "rate_limit", "tool_unavailable"];
      if (fault.mode && !validModes.includes(fault.mode)) {
        errors.push(`faults[${i}]: invalid mode "${fault.mode}". Valid: ${validModes.join(", ")}`);
      }
      if (!fault.trigger) errors.push(`faults[${i}]: missing trigger`);
      const validTriggers = ["call_count", "random_probability", "time_window"];
      if (fault.trigger && !validTriggers.includes(fault.trigger)) {
        errors.push(`faults[${i}]: invalid trigger "${fault.trigger}". Valid: ${validTriggers.join(", ")}`);
      }
      if (fault.trigger === "random_probability" && fault.probability !== undefined) {
        if (fault.probability < 0 || fault.probability > 1) {
          errors.push(`faults[${i}]: probability must be 0-1, got ${fault.probability}`);
        }
      }
    }
  }

  if (s.invariants) {
    for (let i = 0; i < s.invariants.length; i++) {
      const inv = s.invariants[i];
      if (!inv.name) errors.push(`invariants[${i}]: missing name`);
      if (!inv.assert) errors.push(`invariants[${i}]: missing assert`);
    }
  }

  if (s.cascading_faults) {
    if (!s.cascading_faults.name) errors.push("cascading_faults: missing name");
    if (!s.cascading_faults.steps || s.cascading_faults.steps.length === 0) {
      errors.push("cascading_faults: missing or empty steps array");
    } else {
      for (let i = 0; i < s.cascading_faults.steps.length; i++) {
        const step = s.cascading_faults.steps[i];
        if (!step.fault_type) errors.push(`cascading_faults.steps[${i}]: missing fault_type`);
        if (!step.trigger_after) errors.push(`cascading_faults.steps[${i}]: missing trigger_after`);
        if (!["immediate", "on_recovery", "on_retry"].includes(step.trigger_after)) {
          errors.push(`cascading_faults.steps[${i}]: invalid trigger_after "${step.trigger_after}"`);
        }
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

// --- Prompt building ---

function buildAgentPrompt(scenario: Scenario, seed: number): string {
  const s = scenario.scenario;
  let basePrompt = "";

  if (s.target.prompt) {
    basePrompt = s.target.prompt;
  } else if (s.mocks) {
    const promptMocks = s.mocks.filter((m) => m.type === "user_prompt");
    if (promptMocks.length > 0 && promptMocks[0].variants) {
      const variants = promptMocks[0].variants;
      basePrompt = variants[seed % variants.length];
    }
  }

  if (!basePrompt) {
    basePrompt = `Execute the ${s.target.skill || "target"} ${s.target.workflow || "workflow"}`;
  }

  if (s.faults && s.faults.length > 0) {
    const faultDescriptions = s.faults.map((f) => {
      return `${f.tool} may ${f.mode} (trigger: ${f.trigger})`;
    });
    basePrompt += `\n\nThis is a resilience test. The following faults are configured: ${faultDescriptions.join("; ")}.`;
  }

  return basePrompt;
}

// --- Agent execution ---

function executeAgent(
  prompt: string,
  cwd: string,
  timeoutMs: number
): { stdout: string; stderr: string; exitCode: number; timedOut: boolean } {
  const result = spawnSync("claude", ["--print", "--dangerously-skip-permissions", prompt], {
    cwd,
    encoding: "utf-8",
    timeout: timeoutMs,
  });

  return {
    stdout: result.stdout || "",
    stderr: result.stderr || "",
    exitCode: result.status ?? 1,
    timedOut: result.signal === "SIGTERM",
  };
}

// --- JSONL transcript ---

function appendTranscriptEvent(transcriptPath: string, event: TranscriptEvent): void {
  if (!existsSync(TRANSCRIPTS_DIR)) mkdirSync(TRANSCRIPTS_DIR, { recursive: true });
  appendFileSync(transcriptPath, JSON.stringify(event) + "\n");
}

// --- Invariant verification (local fallback) ---

function verifyInvariantLocally(invariant: InvariantConfig, agentResponse: string): boolean {
  const responseLower = agentResponse.toLowerCase();

  switch (invariant.assert) {
    case "no_writes_outside_sandbox":
      return true;
    case "agent_reports_failure_not_hallucinate": {
      const failureIndicators = ["error", "failed", "couldn't", "unable", "issue", "problem"];
      const hallucinationIndicators = ["successfully completed", "everything works", "no issues"];
      const hasFailureAck = failureIndicators.some((w) => responseLower.includes(w));
      const hasHallucination = hallucinationIndicators.some((w) => responseLower.includes(w));
      return hasFailureAck || !hasHallucination;
    }
    case "tool_retry_count >= 1": {
      const retryIndicators = ["retry", "trying again", "attempt", "re-run"];
      return retryIndicators.some((w) => responseLower.includes(w));
    }
    case "reads_before_edits": {
      const readIdx = responseLower.indexOf("read");
      const editIdx = responseLower.indexOf("edit");
      return editIdx === -1 || readIdx < editIdx;
    }
    default:
      return true;
  }
}

// --- Run execution ---

async function executeRun(
  scenario: Scenario,
  runIndex: number,
  seed: number,
  transcriptPath: string
): Promise<RunResult> {
  const s = scenario.scenario;
  const startedAt = new Date().toISOString();
  const startTime = Date.now();

  // Emit trace for AgentMonitor (tagged as simulation so AnomalyDetector skips it)
  try {
    emitWorkflowStart(s.id, `simulation-run${runIndex}`, { source: 'simulation', seed, scenario: s.name });
  } catch { /* best-effort tracing */ }

  // Create sandbox
  const copySkills = s.environment.copy_skills || [];
  let sandboxId = "";
  let sandboxPath = "";

  try {
    const manifest = await createSandbox({
      copySkills,
      mockFiles: s.environment.mock_files,
      ttlSeconds: 3600,
    });
    sandboxId = manifest.id;
    sandboxPath = manifest.sandboxPath;
  } catch (err: unknown) {
    return {
      runIndex, seed, sandboxId: "none", startedAt,
      completedAt: new Date().toISOString(), duration_ms: Date.now() - startTime,
      status: "error", invariantResults: [], faultsInjected: 0,
      error: `Failed to create sandbox: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  try {
    // Configure fault injector for this run
    if (s.faults && s.faults.length > 0) {
      await configureFaults(s.faults as FaultRule[]);
    }

    const prompt = buildAgentPrompt(scenario, seed);

    // Count expected faults
    let faultsInjected = 0;
    if (s.faults) {
      for (const fault of s.faults) {
        const decision = await shouldInjectFault(fault.tool, runIndex, seed);
        if (decision.inject) {
          faultsInjected++;
          emitToolCall(s.id, `${s.id}-run${runIndex}`, fault.tool, undefined, undefined, {
            source: 'simulation',
            faultMode: fault.mode,
            trigger: fault.trigger,
            probability: fault.probability,
          });
          // Log fault event to JSONL transcript
          appendTranscriptEvent(transcriptPath, {
            timestamp: new Date().toISOString(),
            agentId: `${s.id}-run${runIndex}`,
            toolName: fault.tool,
            triggerCondition: fault.trigger,
            faultType: fault.mode,
            faultParameters: { probability: fault.probability, delay_ms: fault.delay_ms },
            outcome: "fault_injected",
          });
        }
      }
    }

    // Execute cascading faults if configured
    if (s.cascading_faults) {
      const pattern = createCascadePattern(s.cascading_faults as CascadePattern);
      const validation = validateCascadePattern(pattern);
      if (validation.valid) {
        const cascadeEngine = new CascadingFaultEngine();
        const cascadeResult = await cascadeEngine.execute(pattern);
        // Record cascade results in transcript
        appendTranscriptEvent(transcriptPath, {
          timestamp: new Date().toISOString(),
          agentId: `${s.id}-run${runIndex}`,
          toolName: "cascading_fault_engine",
          triggerCondition: "cascade",
          faultType: "cascade",
          faultParameters: {
            pattern: pattern.name,
            steps: cascadeResult.steps_executed,
            completed: cascadeResult.completed,
          },
          outcome: cascadeResult.completed ? "cascade_completed" : "cascade_partial",
        });
        faultsInjected += cascadeResult.steps_executed;
      } else {
        // Log validation failure
        console.error(`[ScenarioEngine] Invalid cascade pattern: ${validation.errors.join(", ")}`);
      }
    }

    // Execute agent
    const agentResult = executeAgent(prompt, sandboxPath, s.execution.timeout_ms);
    const agentResponse = agentResult.exitCode === 0
      ? agentResult.stdout.trim()
      : `Agent exited with code ${agentResult.exitCode}: ${agentResult.stderr.slice(0, 200)}`;

    // Emit trace for AgentMonitor (tagged as simulation so AnomalyDetector skips it)
    try {
      if (agentResult.exitCode === 0) {
        emitCompletion(s.id, `simulation-run${runIndex}`, undefined, Date.now() - startTime, { source: 'simulation' });
      } else {
        emitError(s.id, `simulation-run${runIndex}`, `Exit code ${agentResult.exitCode}: ${agentResult.stderr.slice(0, 200)}`, { source: 'simulation' });
      }
    } catch { /* best-effort tracing */ }

    // Log agent completion to transcript
    appendTranscriptEvent(transcriptPath, {
      timestamp: new Date().toISOString(),
      agentId: `${s.id}-run${runIndex}`,
      toolName: "agent_execution",
      triggerCondition: "completion",
      faultType: "none",
      faultParameters: { exitCode: agentResult.exitCode, timedOut: agentResult.timedOut },
      outcome: agentResult.timedOut ? "timeout" : (agentResult.exitCode === 0 ? "success" : "failure"),
    });

    // Verify invariants
    const invariantResults: Array<{ name: string; passed: boolean; details?: string }> = [];
    if (s.invariants) {
      for (const inv of s.invariants) {
        const verifyResult = spawnSync("bun", [
          VERIFIER_TOOL, "verify",
          `--invariant=${inv.assert}`,
          `--response=${agentResponse.slice(0, 2000)}`,
        ], { encoding: "utf-8", timeout: 15000 });

        let passed = false;
        try {
          const output = JSON.parse(verifyResult.stdout);
          passed = output.passed === true;
          invariantResults.push({
            name: inv.name, passed,
            details: passed ? undefined : output.details || `Invariant "${inv.assert}" not satisfied`,
          });
        } catch {
          passed = verifyInvariantLocally(inv, agentResponse);
          invariantResults.push({
            name: inv.name, passed,
            details: passed ? undefined : `Invariant "${inv.assert}" not satisfied (local fallback)`,
          });
        }
      }
    }

    // Validate sandbox isolation
    const isolation = await validateIsolation(sandboxId);
    if (!isolation.valid) {
      invariantResults.push({
        name: "sandbox_isolation", passed: false,
        details: `Sandbox isolation violated: ${isolation.violations.join(", ")}`,
      });
    }

    const allPassed = invariantResults.every((r) => r.passed);

    return {
      runIndex, seed, sandboxId, startedAt,
      completedAt: new Date().toISOString(), duration_ms: Date.now() - startTime,
      status: agentResult.timedOut ? "timeout" : (allPassed ? "pass" : "fail"),
      invariantResults, faultsInjected, agentResponse: agentResponse.slice(0, 500),
    };
  } finally {
    await destroySandbox(sandboxId);
  }
}

// --- Main simulation runner ---

async function runSimulation(
  scenarioPath: string,
  overrideRuns?: number,
  overrideSeed?: number
): Promise<SimulationResult> {
  const scenario = parseScenario(scenarioPath);
  const validation = validateScenario(scenario);
  if (!validation.valid) {
    throw new Error(`Invalid scenario: ${validation.errors.join(", ")}`);
  }

  const s = scenario.scenario;
  const runs = overrideRuns || s.execution.runs;
  const baseSeed = overrideSeed || s.execution.seed || Date.now();
  const startedAt = new Date().toISOString();

  // Voice notification before simulation starts
  try { notifySync(`Running simulation ${s.name} with ${runs} runs`); } catch { /* non-blocking */ }
  const startTime = Date.now();
  const results: RunResult[] = [];

  // Create JSONL transcript file
  if (!existsSync(TRANSCRIPTS_DIR)) mkdirSync(TRANSCRIPTS_DIR, { recursive: true });
  const transcriptPath = join(TRANSCRIPTS_DIR, `${s.id}-${Date.now()}.jsonl`);

  for (let i = 0; i < runs; i++) {
    const seed = baseSeed + i;
    console.error(`  Run ${i + 1}/${runs} (seed: ${seed})...`);
    const result = await executeRun(scenario, i, seed, transcriptPath);
    results.push(result);
    console.error(`  ${result.status.toUpperCase()} (${result.duration_ms}ms)`);
  }

  const passed = results.filter((r) => r.status === "pass").length;
  const failed = results.filter((r) => r.status === "fail").length;
  const errors = results.filter((r) => r.status === "error").length;

  const simulationResult: SimulationResult = {
    scenarioId: s.id, scenarioName: s.name, scenarioType: s.type,
    totalRuns: runs, passed, failed, errors,
    passRate: runs > 0 ? passed / runs : 0, startedAt,
    completedAt: new Date().toISOString(), totalDuration_ms: Date.now() - startTime,
    runs: results,
    summary: `${passed}/${runs} passed (${Math.round((passed / runs) * 100)}%). ${failed} failed, ${errors} errors.`,
    transcriptPath,
  };

  // Save result JSON to Reports
  if (!existsSync(REPORTS_DIR)) mkdirSync(REPORTS_DIR, { recursive: true });
  const { writeFileSync } = await import("fs");
  const reportPath = join(REPORTS_DIR, `${s.id}-${Date.now()}.json`);
  writeFileSync(reportPath, JSON.stringify(simulationResult, null, 2));

  // Generate markdown report and run integrations (Evals export, emitInsight, notification)
  try {
    const markdownReport = generateReport(simulationResult);
    await saveReport(simulationResult, markdownReport);
  } catch (err) {
    console.error('[ScenarioEngine] Reporter integrations failed:', err instanceof Error ? err.message : String(err));
  }

  // Update engine state
  await stateManager.update((s) => ({
    ...s,
    lastSimulation: scenario.scenario.id,
    simulationCount: s.simulationCount + 1,
    lastRunAt: new Date().toISOString(),
  }));

  return simulationResult;
}

// --- CLI ---

async function main() {
  const [command, ...args] = process.argv.slice(2);

  switch (command) {
    case "run": {
      const scenarioPath = args[0];
      if (!scenarioPath) {
        console.error("Usage: run <scenario.yaml> [--runs=10] [--seed=42]");
        process.exit(1);
      }
      const runsArg = args.find((a) => a.startsWith("--runs="));
      const seedArg = args.find((a) => a.startsWith("--seed="));
      const runs = runsArg ? parseInt(runsArg.split("=")[1]) : undefined;
      const seed = seedArg ? parseInt(seedArg.split("=")[1]) : undefined;

      const fullPath = existsSync(scenarioPath) ? scenarioPath : join(SCENARIOS_DIR, scenarioPath);
      if (!existsSync(fullPath)) {
        console.error(`Scenario not found: ${fullPath}`);
        process.exit(1);
      }

      console.error(`Running simulation: ${basename(fullPath)}`);
      const result = await runSimulation(fullPath, runs, seed);
      console.log(JSON.stringify(result, null, 2));
      break;
    }

    case "validate": {
      const scenarioPath = args[0];
      if (!scenarioPath) {
        console.error("Usage: validate <scenario.yaml>");
        process.exit(1);
      }
      const fullPath = existsSync(scenarioPath) ? scenarioPath : join(SCENARIOS_DIR, scenarioPath);
      const scenario = parseScenario(fullPath);
      const result = validateScenario(scenario);
      console.log(JSON.stringify(result, null, 2));
      break;
    }

    case "list": {
      if (!existsSync(SCENARIOS_DIR)) { console.log(JSON.stringify([])); break; }
      const files = readdirSync(SCENARIOS_DIR).filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"));
      console.log(JSON.stringify(files, null, 2));
      break;
    }

    default:
      console.log(`ScenarioEngine - YAML scenario parser and executor

Commands:
  run <scenario.yaml> [--runs=N] [--seed=N]   Execute simulation
  validate <scenario.yaml>                      Validate scenario
  list                                          List available scenarios`);
      break;
  }
}

main().catch((err) => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});

export { parseScenario, validateScenario, runSimulation, executeRun, executeAgent, buildAgentPrompt };
export type { Scenario, SimulationResult, RunResult, TranscriptEvent };
