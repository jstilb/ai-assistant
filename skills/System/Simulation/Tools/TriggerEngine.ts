#!/usr/bin/env bun
/**
 * TriggerEngine.ts - Deterministic per-call fault trigger decision engine
 *
 * Implements 3 trigger conditions:
 *   - call_count: fault after N calls to a specific tool
 *   - random_probability: fault with probability P (deterministic with seed)
 *   - time_window: fault only during a time window from simulation start
 *
 * All decisions are deterministic given the same seed.
 *
 * Usage:
 *   import { createTriggerEngine } from "./TriggerEngine.ts";
 *   const engine = createTriggerEngine({ seed: 42 });
 *   const decision = engine.shouldTrigger("Read", { type: "call_count", call_count_threshold: 3 });
 */

// ============================================
// TYPES
// ============================================

export type TriggerType = "call_count" | "random_probability" | "time_window";

export interface TriggerCondition {
  type: TriggerType;
  call_count_threshold?: number;
  probability?: number;
  time_window_start?: number;
  time_window_end?: number;
}

export interface TriggerDecision {
  triggered: boolean;
  toolName: string;
  triggerType: TriggerType;
  callNumber: number;
  reason: string;
}

export interface TriggerStats {
  totalChecks: number;
  totalTriggered: number;
  callCounts: Record<string, number>;
}

export interface TriggerEngineOptions {
  seed: number;
  startTime?: number;
}

export interface TriggerEngine {
  shouldTrigger(toolName: string, condition: TriggerCondition): TriggerDecision;
  getCallCount(toolName: string): number;
  getStats(): TriggerStats;
  reset(): void;
}

// ============================================
// SEEDED RANDOM
// ============================================

/**
 * Deterministic pseudo-random number generator using a linear congruential approach.
 * Returns a value in [0, 1).
 */
function seededRandom(seed: number): number {
  const x = Math.sin(seed * 9301 + 49297) * 233280;
  return x - Math.floor(x);
}

// ============================================
// IMPLEMENTATION
// ============================================

class TriggerEngineImpl implements TriggerEngine {
  private seed: number;
  private startTime: number;
  private callCounts: Record<string, number> = {};
  private totalChecks = 0;
  private totalTriggered = 0;
  private randomCounter = 0;

  constructor(options: TriggerEngineOptions) {
    this.seed = options.seed;
    this.startTime = options.startTime ?? Date.now();
  }

  shouldTrigger(toolName: string, condition: TriggerCondition): TriggerDecision {
    this.totalChecks++;

    // Increment call count for this tool
    this.callCounts[toolName] = (this.callCounts[toolName] ?? 0) + 1;
    const callNumber = this.callCounts[toolName];

    let triggered = false;
    let reason = "";

    switch (condition.type) {
      case "call_count": {
        const threshold = condition.call_count_threshold ?? 1;
        triggered = callNumber >= threshold;
        reason = triggered
          ? `Call count ${callNumber} >= threshold ${threshold}`
          : `Call count ${callNumber} < threshold ${threshold}`;
        break;
      }

      case "random_probability": {
        const prob = condition.probability ?? 0.5;
        if (prob <= 0) {
          triggered = false;
          reason = "Probability is 0, never triggers";
        } else if (prob >= 1) {
          triggered = true;
          reason = "Probability is 1, always triggers";
        } else {
          // Use seed + counter for deterministic sequence
          const randomValue = seededRandom(this.seed + this.randomCounter);
          this.randomCounter++;
          triggered = randomValue < prob;
          reason = `Random value ${randomValue.toFixed(4)} ${triggered ? "<" : ">="} probability ${prob}`;
        }
        break;
      }

      case "time_window": {
        const elapsedSec = (Date.now() - this.startTime) / 1000;
        const windowStart = condition.time_window_start ?? 0;
        const windowEnd = condition.time_window_end ?? Infinity;
        triggered = elapsedSec >= windowStart && elapsedSec <= windowEnd;
        reason = triggered
          ? `Elapsed ${elapsedSec.toFixed(1)}s within window [${windowStart}, ${windowEnd}]`
          : `Elapsed ${elapsedSec.toFixed(1)}s outside window [${windowStart}, ${windowEnd}]`;
        break;
      }
    }

    if (triggered) {
      this.totalTriggered++;
    }

    return {
      triggered,
      toolName,
      triggerType: condition.type,
      callNumber,
      reason,
    };
  }

  getCallCount(toolName: string): number {
    return this.callCounts[toolName] ?? 0;
  }

  getStats(): TriggerStats {
    return {
      totalChecks: this.totalChecks,
      totalTriggered: this.totalTriggered,
      callCounts: { ...this.callCounts },
    };
  }

  reset(): void {
    this.callCounts = {};
    this.totalChecks = 0;
    this.totalTriggered = 0;
    this.randomCounter = 0;
  }
}

// ============================================
// FACTORY
// ============================================

export function createTriggerEngine(options: TriggerEngineOptions): TriggerEngine {
  return new TriggerEngineImpl(options);
}

// ============================================
// CLI
// ============================================

if (import.meta.main) {
  const [command, ...args] = process.argv.slice(2);

  switch (command) {
    case "check": {
      const toolName = args[0];
      const typeArg = args.find(a => a.startsWith("--type="))?.split("=")[1] as TriggerType;
      const seedArg = args.find(a => a.startsWith("--seed="))?.split("=")[1];
      const thresholdArg = args.find(a => a.startsWith("--threshold="))?.split("=")[1];
      const probArg = args.find(a => a.startsWith("--probability="))?.split("=")[1];

      if (!toolName || !typeArg) {
        console.error("Usage: check <tool> --type=<trigger_type> [--seed=42] [--threshold=3] [--probability=0.5]");
        process.exit(1);
      }

      const engine = createTriggerEngine({ seed: parseInt(seedArg ?? "42") });
      const condition: TriggerCondition = {
        type: typeArg,
        call_count_threshold: thresholdArg ? parseInt(thresholdArg) : undefined,
        probability: probArg ? parseFloat(probArg) : undefined,
      };

      const decision = engine.shouldTrigger(toolName, condition);
      console.log(JSON.stringify(decision, null, 2));
      break;
    }

    default:
      console.log(`TriggerEngine - Deterministic fault trigger decisions

Commands:
  check <tool> --type=<type> [options]   Check trigger decision

Trigger types: call_count, random_probability, time_window`);
      break;
  }
}
