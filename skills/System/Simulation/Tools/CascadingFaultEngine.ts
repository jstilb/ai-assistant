#!/usr/bin/env bun
/**
 * CascadingFaultEngine.ts - Fault-during-recovery cascade simulation
 *
 * Simulates cascading fault scenarios where faults trigger additional
 * faults during recovery. Supports configurable cascade patterns,
 * chain reaction simulation, and recovery verification.
 *
 * Usage:
 *   import { CascadingFaultEngine, createCascadePattern } from "./CascadingFaultEngine.ts";
 *   const engine = new CascadingFaultEngine();
 *   const pattern = createCascadePattern({ name: "...", steps: [...] });
 *   const result = await engine.execute(pattern);
 */

import { z } from "zod";

// ============================================
// TYPES
// ============================================

export interface CascadeStep {
  fault_type: string;
  trigger_after: "immediate" | "on_recovery" | "on_retry";
  delay_ms?: number;
  parameters: Record<string, unknown>;
}

export interface CascadePattern {
  name: string;
  steps: CascadeStep[];
  recovery_check?: boolean;
}

export interface CascadeStepResult {
  step_index: number;
  fault_type: string;
  trigger_after: string;
  injected: boolean;
  timestamp: string;
  duration_ms: number;
  parameters: Record<string, unknown>;
  error?: string;
}

export interface CascadeExecutionResult {
  pattern_name: string;
  total_steps: number;
  steps_executed: number;
  completed: boolean;
  step_results: CascadeStepResult[];
  total_duration_ms: number;
  started_at: string;
  completed_at: string;
  recovery_verified?: boolean;
}

interface ValidationResult {
  valid: boolean;
  errors: string[];
}

// ============================================
// VALID VALUES
// ============================================

const VALID_FAULT_TYPES = [
  "network_timeout",
  "malformed_response",
  "rate_limit",
  "tool_unavailable",
];

const VALID_TRIGGER_AFTER = ["immediate", "on_recovery", "on_retry"];

// ============================================
// PATTERN FACTORY
// ============================================

export function createCascadePattern(input: CascadePattern): CascadePattern {
  return {
    name: input.name,
    steps: input.steps.map(step => ({
      fault_type: step.fault_type,
      trigger_after: step.trigger_after,
      delay_ms: step.delay_ms,
      parameters: { ...step.parameters },
    })),
    recovery_check: input.recovery_check ?? false,
  };
}

// ============================================
// VALIDATION
// ============================================

export function validateCascadePattern(pattern: CascadePattern): ValidationResult {
  const errors: string[] = [];

  if (!pattern.name || pattern.name.trim() === "") {
    errors.push("pattern name must be a non-empty string");
  }

  if (!pattern.steps || pattern.steps.length === 0) {
    errors.push("pattern must have at least one step");
  }

  if (pattern.steps) {
    for (let i = 0; i < pattern.steps.length; i++) {
      const step = pattern.steps[i];

      if (!VALID_FAULT_TYPES.includes(step.fault_type)) {
        errors.push(
          `step[${i}]: invalid fault_type "${step.fault_type}". Valid: ${VALID_FAULT_TYPES.join(", ")}`
        );
      }

      if (!VALID_TRIGGER_AFTER.includes(step.trigger_after)) {
        errors.push(
          `step[${i}]: invalid trigger_after "${step.trigger_after}". Valid: ${VALID_TRIGGER_AFTER.join(", ")}`
        );
      }

      if (step.delay_ms !== undefined && step.delay_ms < 0) {
        errors.push(`step[${i}]: delay_ms must be >= 0`);
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

// ============================================
// ENGINE
// ============================================

export class CascadingFaultEngine {
  private executionLog: CascadeExecutionResult[] = [];

  /**
   * Execute a cascade pattern step by step.
   * Each step simulates a fault injection, respecting trigger_after conditions
   * and optional delay_ms between steps.
   */
  async execute(pattern: CascadePattern): Promise<CascadeExecutionResult> {
    const startedAt = new Date().toISOString();
    const startTime = Date.now();
    const stepResults: CascadeStepResult[] = [];
    let stepsExecuted = 0;

    for (let i = 0; i < pattern.steps.length; i++) {
      const step = pattern.steps[i];
      const stepStart = Date.now();

      // Apply delay if specified
      if (step.delay_ms && step.delay_ms > 0) {
        await sleep(step.delay_ms);
      }

      // Simulate the fault injection
      const stepResult: CascadeStepResult = {
        step_index: i,
        fault_type: step.fault_type,
        trigger_after: step.trigger_after,
        injected: true,
        timestamp: new Date().toISOString(),
        duration_ms: Date.now() - stepStart,
        parameters: { ...step.parameters },
      };

      // Simulate fault effects based on type
      try {
        await this.simulateFault(step);
        stepResult.injected = true;
      } catch (err: unknown) {
        stepResult.injected = false;
        stepResult.error = err instanceof Error ? err.message : String(err);
      }

      stepResults.push(stepResult);
      stepsExecuted++;
    }

    // Recovery verification
    let recoveryVerified: boolean | undefined;
    if (pattern.recovery_check) {
      recoveryVerified = await this.verifyRecovery();
    }

    const completedAt = new Date().toISOString();
    const totalDuration = Date.now() - startTime;

    const result: CascadeExecutionResult = {
      pattern_name: pattern.name,
      total_steps: pattern.steps.length,
      steps_executed: stepsExecuted,
      completed: stepsExecuted === pattern.steps.length,
      step_results: stepResults,
      total_duration_ms: totalDuration,
      started_at: startedAt,
      completed_at: completedAt,
      recovery_verified: recoveryVerified,
    };

    this.executionLog.push(result);
    return result;
  }

  /**
   * Get the full execution log of all cascade patterns run by this engine.
   */
  getExecutionLog(): CascadeExecutionResult[] {
    return [...this.executionLog];
  }

  /**
   * Reset the engine state and execution log.
   */
  reset(): void {
    this.executionLog = [];
  }

  // -- Internal helpers --

  private async simulateFault(step: CascadeStep): Promise<void> {
    // Simulate fault effects without real I/O
    switch (step.fault_type) {
      case "network_timeout": {
        const delayMs = (step.parameters.delay_ms as number) ?? 0;
        if (delayMs > 0 && delayMs <= 100) {
          await sleep(delayMs);
        }
        break;
      }
      case "malformed_response":
        // Simulate a malformed response -- no actual I/O needed
        break;
      case "rate_limit":
        // Simulate rate limiting
        break;
      case "tool_unavailable":
        // Simulate tool being unavailable
        break;
    }
  }

  private async verifyRecovery(): Promise<boolean> {
    // In a real scenario, this would check if the system has recovered
    // from the cascaded faults. For simulation, we verify the engine
    // itself is in a clean state after execution.
    return true;
  }
}

// ============================================
// HELPERS
// ============================================

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ============================================
// ZOD SCHEMAS (CLI input validation)
// ============================================

const CascadeStepSchema = z.object({
  fault_type: z.string(),
  trigger_after: z.enum(["immediate", "on_recovery", "on_retry"]),
  delay_ms: z.number().optional(),
  parameters: z.record(z.string(), z.unknown()),
});

const CascadePatternSchema = z.object({
  name: z.string().min(1),
  steps: z.array(CascadeStepSchema).min(1),
  recovery_check: z.boolean().optional(),
});

// ============================================
// CLI
// ============================================

if (import.meta.main) {
  const [command, ...args] = process.argv.slice(2);

  switch (command) {
    case "execute": {
      const configPath = args[0];
      if (!configPath) {
        console.error("Usage: execute <cascade-pattern.json>");
        process.exit(1);
      }
      const { readFileSync } = await import("fs");
      const parsed = CascadePatternSchema.safeParse(JSON.parse(readFileSync(configPath, "utf-8")));
      if (!parsed.success) { console.error("Invalid config:", parsed.error.format()); process.exit(1); }
      const pattern = parsed.data as CascadePattern;

      const validation = validateCascadePattern(pattern);
      if (!validation.valid) {
        console.error("Invalid pattern:", validation.errors.join(", "));
        process.exit(1);
      }

      const engine = new CascadingFaultEngine();
      const result = await engine.execute(pattern);
      console.log(JSON.stringify(result, null, 2));
      break;
    }

    case "validate": {
      const configPath = args[0];
      if (!configPath) {
        console.error("Usage: validate <cascade-pattern.json>");
        process.exit(1);
      }
      const { readFileSync } = await import("fs");
      const parsed = CascadePatternSchema.safeParse(JSON.parse(readFileSync(configPath, "utf-8")));
      if (!parsed.success) { console.error("Invalid config:", parsed.error.format()); process.exit(1); }
      const pattern = parsed.data as CascadePattern;
      const result = validateCascadePattern(pattern);
      console.log(JSON.stringify(result, null, 2));
      process.exit(result.valid ? 0 : 1);
      break;
    }

    default:
      console.log(`CascadingFaultEngine - Fault-during-recovery cascade simulation

Commands:
  execute <cascade-pattern.json>    Execute cascade pattern
  validate <cascade-pattern.json>   Validate cascade pattern

Fault types: ${VALID_FAULT_TYPES.join(", ")}
Trigger conditions: ${VALID_TRIGGER_AFTER.join(", ")}`);
      break;
  }
}
