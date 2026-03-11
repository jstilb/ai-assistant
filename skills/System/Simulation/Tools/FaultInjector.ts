#!/usr/bin/env bun
/**
 * FaultInjector.ts - Fault injection engine with deterministic triggers
 *
 * Supports 4 fault types (network_timeout, malformed_response, rate_limit,
 * tool_unavailable) and 3 trigger conditions (call_count, random_probability,
 * time_window). All state persisted via StateManager.
 *
 * Usage:
 *   bun FaultInjector.ts configure --scenario=<path>
 *   bun FaultInjector.ts should-fault <tool-name> <step> [--seed=42]
 *   bun FaultInjector.ts inject <tool-name> --mode=<mode> [--seed=42]
 *   bun FaultInjector.ts stats
 *   bun FaultInjector.ts reset
 */

import { join } from "path";
import { z } from "zod";
import { createStateManager } from "../../../../lib/core/StateManager.ts";
import { generateFaultResponse as generateAdvancedFault, ADVANCED_FAULT_TYPES, type AdvancedFaultType } from "./AdvancedFaultTypes.ts";

const KAYA_HOME = process.env.HOME + "/.claude";
const STATE_PATH = join(KAYA_HOME, "skills/System/Simulation/state/fault-state.json");

// --- Types ---

type FaultMode =
  | "network_timeout" | "malformed_response" | "rate_limit" | "tool_unavailable"
  | "partial_response" | "delayed_response" | "intermittent_failure"
  | "data_corruption" | "resource_exhaustion";
type TriggerType = "call_count" | "random_probability" | "time_window";

interface FaultRule {
  tool: string;
  mode: FaultMode;
  trigger: TriggerType;
  /** For call_count: inject on/after this call number */
  call_count_threshold?: number;
  /** For random_probability: 0-1 probability */
  probability?: number;
  /** For time_window: inject only within this window (seconds from start) */
  time_window_start?: number;
  time_window_end?: number;
  /** Optional delay in ms for timeout faults */
  delay_ms?: number;
  /** Optional custom message */
  message?: string;
}

interface FaultLogEntry {
  tool: string;
  step: number;
  mode: FaultMode;
  trigger: TriggerType;
  timestamp: string;
  seed: number;
}

interface FaultState {
  rules: FaultRule[];
  callCounts: Record<string, number>;
  faultsInjected: number;
  faultLog: FaultLogEntry[];
  simulationStartedAt: string;
}

// --- Schema ---

const FaultRuleSchema = z.object({
  tool: z.string(),
  mode: z.enum([
    "network_timeout", "malformed_response", "rate_limit", "tool_unavailable",
    "partial_response", "delayed_response", "intermittent_failure",
    "data_corruption", "resource_exhaustion"
  ]),
  trigger: z.enum(["call_count", "random_probability", "time_window"]),
  call_count_threshold: z.number().int().min(1).optional(),
  probability: z.number().min(0).max(1).optional(),
  time_window_start: z.number().min(0).optional(),
  time_window_end: z.number().min(0).optional(),
  delay_ms: z.number().int().min(0).optional(),
  message: z.string().optional(),
});

const FaultStateSchema = z.object({
  rules: z.array(FaultRuleSchema),
  callCounts: z.record(z.string(), z.number()),
  faultsInjected: z.number(),
  faultLog: z.array(z.object({
    tool: z.string(),
    step: z.number(),
    mode: z.enum(["network_timeout", "malformed_response", "rate_limit", "tool_unavailable"]),
    trigger: z.enum(["call_count", "random_probability", "time_window"]),
    timestamp: z.string(),
    seed: z.number(),
  })),
  simulationStartedAt: z.string(),
});

const stateManager = createStateManager<FaultState>({
  path: STATE_PATH,
  schema: FaultStateSchema,
  defaults: {
    rules: [],
    callCounts: {},
    faultsInjected: 0,
    faultLog: [],
    simulationStartedAt: new Date().toISOString(),
  },
});

// --- Seeded random ---

function seededRandom(seed: number): number {
  const x = Math.sin(seed * 9301 + 49297) * 233280;
  return x - Math.floor(x);
}

// --- Core functions ---

async function configure(rules: FaultRule[]): Promise<FaultState> {
  const state: FaultState = {
    rules,
    callCounts: {},
    faultsInjected: 0,
    faultLog: [],
    simulationStartedAt: new Date().toISOString(),
  };
  await stateManager.save(state);
  return state;
}

async function shouldInjectFault(
  tool: string,
  step: number,
  seed: number = Date.now()
): Promise<{ inject: boolean; rule?: FaultRule; trigger?: TriggerType }> {
  const state = await stateManager.load();
  const callCount = (state.callCounts[tool] || 0) + 1;
  const elapsedSec = (Date.now() - new Date(state.simulationStartedAt).getTime()) / 1000;

  for (const rule of state.rules) {
    if (rule.tool !== tool) continue;

    switch (rule.trigger) {
      case "call_count": {
        const threshold = rule.call_count_threshold ?? 1;
        if (callCount >= threshold) {
          return { inject: true, rule, trigger: "call_count" };
        }
        break;
      }

      case "random_probability": {
        const prob = rule.probability ?? 0.5;
        const random = seededRandom(seed + step + tool.charCodeAt(0));
        if (random < prob) {
          return { inject: true, rule, trigger: "random_probability" };
        }
        break;
      }

      case "time_window": {
        const windowStart = rule.time_window_start ?? 0;
        const windowEnd = rule.time_window_end ?? Infinity;
        if (elapsedSec >= windowStart && elapsedSec <= windowEnd) {
          return { inject: true, rule, trigger: "time_window" };
        }
        break;
      }
    }
  }

  return { inject: false };
}

async function injectFault(
  tool: string,
  mode: FaultMode,
  step: number,
  trigger: TriggerType,
  seed: number = Date.now()
): Promise<Record<string, unknown>> {
  await stateManager.update((s) => ({
    ...s,
    callCounts: { ...s.callCounts, [tool]: (s.callCounts[tool] || 0) + 1 },
    faultsInjected: s.faultsInjected + 1,
    faultLog: [
      ...s.faultLog,
      { tool, step, mode, trigger, timestamp: new Date().toISOString(), seed },
    ],
  }));

  switch (mode) {
    case "network_timeout":
      return {
        error: true,
        code: "ETIMEDOUT",
        message: `${tool} operation timed out after configured delay`,
        tool,
        mode,
        exitCode: 124,
      };
    case "malformed_response":
      return {
        error: false,
        data: { _malformed: true, partial: `{"incomplete": true, "tool": "${tool}"`, truncated: true },
        message: `${tool} returned malformed/incomplete JSON response`,
        tool,
        mode,
      };
    case "rate_limit":
      return {
        error: true,
        code: "RATE_LIMITED",
        message: `${tool} rate limited — retry after 30s`,
        retryAfter: 30,
        tool,
        mode,
      };
    case "tool_unavailable":
      return {
        error: true,
        code: "ENOENT",
        message: `${tool}: command not found`,
        tool,
        mode,
      };
    default: {
      // Delegate to advanced fault engine for extended types
      if (ADVANCED_FAULT_TYPES.includes(mode as AdvancedFaultType)) {
        const advancedFault = {
          type: mode as AdvancedFaultType,
          parameters: {},
        };
        const context = JSON.stringify({ tool, step });
        return generateAdvancedFault(advancedFault, context, { seed });
      }
      return { error: true, message: `Unknown fault mode: ${mode}` };
    }
  }
}

async function incrementCallCount(tool: string): Promise<void> {
  await stateManager.update((s) => ({
    ...s,
    callCounts: { ...s.callCounts, [tool]: (s.callCounts[tool] || 0) + 1 },
  }));
}

async function getStats(): Promise<{
  totalFaults: number;
  faultsByTool: Record<string, number>;
  faultsByMode: Record<string, number>;
  faultsByTrigger: Record<string, number>;
  callCounts: Record<string, number>;
}> {
  const state = await stateManager.load();
  const faultsByTool: Record<string, number> = {};
  const faultsByMode: Record<string, number> = {};
  const faultsByTrigger: Record<string, number> = {};

  for (const entry of state.faultLog) {
    faultsByTool[entry.tool] = (faultsByTool[entry.tool] || 0) + 1;
    faultsByMode[entry.mode] = (faultsByMode[entry.mode] || 0) + 1;
    faultsByTrigger[entry.trigger] = (faultsByTrigger[entry.trigger] || 0) + 1;
  }

  return {
    totalFaults: state.faultsInjected,
    faultsByTool,
    faultsByMode,
    faultsByTrigger,
    callCounts: state.callCounts,
  };
}

async function reset(): Promise<void> {
  await stateManager.save({
    rules: [],
    callCounts: {},
    faultsInjected: 0,
    faultLog: [],
    simulationStartedAt: new Date().toISOString(),
  });
}

// --- CLI ---

async function main() {
  const [command, ...args] = process.argv.slice(2);

  switch (command) {
    case "configure": {
      const scenarioArg = args.find((a) => a.startsWith("--scenario="));
      if (scenarioArg) {
        const YAML = (await import("yaml")).default;
        const { readFileSync } = await import("fs");
        const scenarioPath = scenarioArg.split("=")[1];
        const yamlContent = readFileSync(scenarioPath, "utf-8");
        const scenario = YAML.parse(yamlContent);
        const faultRules = scenario?.scenario?.faults || [];
        const state = await configure(faultRules);
        console.log(JSON.stringify(state, null, 2));
      } else {
        const { readFileSync } = await import("fs");
        const input = readFileSync("/dev/stdin", "utf-8").trim();
        const rules = JSON.parse(input) as FaultRule[];
        const state = await configure(rules);
        console.log(JSON.stringify(state, null, 2));
      }
      break;
    }

    case "should-fault": {
      const tool = args[0];
      const step = parseInt(args[1] || "0");
      const seedArg = args.find((a) => a.startsWith("--seed="));
      const seed = seedArg ? parseInt(seedArg.split("=")[1]) : Date.now();
      if (!tool) {
        console.error("Usage: should-fault <tool-name> <step> [--seed=42]");
        process.exit(1);
      }
      const result = await shouldInjectFault(tool, step, seed);
      console.log(JSON.stringify(result, null, 2));
      break;
    }

    case "inject": {
      const tool = args[0];
      const modeArg = args.find((a) => a.startsWith("--mode="));
      const triggerArg = args.find((a) => a.startsWith("--trigger="));
      const seedArg = args.find((a) => a.startsWith("--seed="));
      const stepArg = args.find((a) => a.startsWith("--step="));
      const mode = (modeArg?.split("=")[1] || "network_timeout") as FaultMode;
      const trigger = (triggerArg?.split("=")[1] || "random_probability") as TriggerType;
      const seed = seedArg ? parseInt(seedArg.split("=")[1]) : Date.now();
      const step = stepArg ? parseInt(stepArg.split("=")[1]) : 0;
      if (!tool) {
        console.error("Usage: inject <tool-name> --mode=<mode> [--trigger=<trigger>] [--seed=42] [--step=0]");
        process.exit(1);
      }
      const result = await injectFault(tool, mode, step, trigger, seed);
      console.log(JSON.stringify(result, null, 2));
      break;
    }

    case "stats": {
      const stats = await getStats();
      console.log(JSON.stringify(stats, null, 2));
      break;
    }

    case "reset": {
      await reset();
      console.log(JSON.stringify({ reset: true }));
      break;
    }

    default:
      console.log(`FaultInjector - Deterministic fault injection engine

Commands:
  configure [--scenario=path]              Configure fault rules
  should-fault <tool> <step> [--seed]      Check if fault should inject
  inject <tool> --mode=<mode> [--seed]     Generate fault response
  stats                                     Show injection statistics
  reset                                     Reset fault state

Fault modes: network_timeout, malformed_response, rate_limit, tool_unavailable
Trigger types: call_count, random_probability, time_window`);
      break;
  }
}

main().catch((err) => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});

export {
  configure,
  shouldInjectFault,
  injectFault,
  incrementCallCount,
  getStats,
  reset,
  seededRandom,
};
export type { FaultRule, FaultState, FaultMode, TriggerType, FaultLogEntry };
