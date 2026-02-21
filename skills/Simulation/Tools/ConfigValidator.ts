#!/usr/bin/env bun
/**
 * ConfigValidator.ts - JSON Schema validation for fault scenario configs
 *
 * Validates scenario configuration files against a strict schema with
 * actionable error messages. Supports all 4 fault types, 3 trigger
 * conditions, and full scenario structure.
 *
 * Usage:
 *   bun ConfigValidator.ts validate <config.json>
 *   bun ConfigValidator.ts schema
 */

import { z } from "zod";

// ============================================
// TYPES
// ============================================

export interface FaultConfig {
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

export interface InvariantConfig {
  name: string;
  assert: string;
  params?: Record<string, unknown>;
}

export interface ScenarioConfig {
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
    mocks?: Array<Record<string, unknown>>;
    invariants?: InvariantConfig[];
    execution: {
      runs: number;
      timeout_ms: number;
      parallel?: number;
      seed?: number;
    };
  };
}

export interface ValidationResult {
  success: boolean;
  errors?: string[];
  config?: ScenarioConfig;
}

// ============================================
// SCHEMA
// ============================================

const FaultModes = ["network_timeout", "malformed_response", "rate_limit", "tool_unavailable"] as const;
const TriggerTypes = ["call_count", "random_probability", "time_window"] as const;
const ScenarioTypes = ["chaos", "replay", "property", "stress", "regression", "multi_agent"] as const;
const TargetTypes = ["workflow", "skill", "hook", "prompt", "agent"] as const;

const FaultConfigSchema = z.object({
  tool: z.string().min(1, "fault.tool must be a non-empty string"),
  mode: z.enum(FaultModes, {
    errorMap: () => ({ message: `fault.mode must be one of: ${FaultModes.join(", ")}` }),
  }),
  trigger: z.enum(TriggerTypes, {
    errorMap: () => ({ message: `fault.trigger must be one of: ${TriggerTypes.join(", ")}` }),
  }),
  call_count_threshold: z.number().int().min(1, "call_count_threshold must be >= 1").optional(),
  probability: z.number().min(0, "probability must be >= 0").max(1, "probability must be <= 1").optional(),
  time_window_start: z.number().min(0).optional(),
  time_window_end: z.number().min(0).optional(),
  delay_ms: z.number().int().min(0).optional(),
  message: z.string().optional(),
}).superRefine((data, ctx) => {
  if (data.trigger === "time_window" &&
      data.time_window_start !== undefined &&
      data.time_window_end !== undefined &&
      data.time_window_end < data.time_window_start) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "time_window_end must be >= time_window_start",
      path: ["time_window_end"],
    });
  }
});

const InvariantConfigSchema = z.object({
  name: z.string().min(1),
  assert: z.string().min(1),
  params: z.record(z.unknown()).optional(),
});

export const scenarioConfigSchema = z.object({
  scenario: z.object({
    id: z.string().min(1, "scenario.id must be a non-empty string"),
    name: z.string().min(1, "scenario.name must be a non-empty string"),
    description: z.string(),
    type: z.enum(ScenarioTypes, {
      errorMap: () => ({ message: `scenario.type must be one of: ${ScenarioTypes.join(", ")}` }),
    }),
    target: z.object({
      type: z.enum(TargetTypes, {
        errorMap: () => ({ message: `target.type must be one of: ${TargetTypes.join(", ")}` }),
      }),
      skill: z.string().optional(),
      workflow: z.string().optional(),
      prompt: z.string().optional(),
    }),
    environment: z.object({
      sandbox: z.boolean(),
      copy_skills: z.array(z.string()).optional(),
      mock_files: z.array(z.object({
        path: z.string(),
        content: z.string(),
      })).optional(),
    }),
    faults: z.array(FaultConfigSchema).optional(),
    mocks: z.array(z.any()).optional(),
    invariants: z.array(InvariantConfigSchema).optional(),
    execution: z.object({
      runs: z.number().int().min(1, "execution.runs must be >= 1"),
      timeout_ms: z.number().int().min(1, "execution.timeout_ms must be >= 1"),
      parallel: z.number().int().min(1).optional(),
      seed: z.number().int().optional(),
    }),
  }),
});

// ============================================
// VALIDATION
// ============================================

export function validateScenarioConfig(config: unknown): ValidationResult {
  const result = scenarioConfigSchema.safeParse(config);

  if (result.success) {
    return { success: true, config: result.data as ScenarioConfig };
  }

  const errors = result.error.issues.map((issue) => {
    const path = issue.path.join(".");
    return `${path}: ${issue.message}`;
  });

  return { success: false, errors };
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
        console.error("Usage: validate <config.json>");
        process.exit(1);
      }

      const { readFileSync, existsSync } = await import("fs");
      if (!existsSync(filePath)) {
        console.error(`File not found: ${filePath}`);
        process.exit(1);
      }

      const content = readFileSync(filePath, "utf-8");
      let parsed: unknown;
      try {
        parsed = JSON.parse(content);
      } catch {
        // Try YAML
        const YAML = (await import("yaml")).default;
        parsed = YAML.parse(content);
      }

      const result = validateScenarioConfig(parsed);
      console.log(JSON.stringify(result, null, 2));
      process.exit(result.success ? 0 : 1);
      break;
    }

    case "schema": {
      // Output the schema description
      console.log(JSON.stringify({
        faultModes: [...FaultModes],
        triggerTypes: [...TriggerTypes],
        scenarioTypes: [...ScenarioTypes],
        targetTypes: [...TargetTypes],
      }, null, 2));
      break;
    }

    default:
      console.log(`ConfigValidator - Fault scenario config validation

Commands:
  validate <config.json|yaml>   Validate a scenario config file
  schema                        Show valid schema values`);
      break;
  }
}
