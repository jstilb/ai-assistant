#!/usr/bin/env bun
/**
 * CostTracker.ts - Cumulative cost tracking with session cap
 *
 * Tracks per-API costs across a Designer session. Enforces a $5.00/session
 * hard cap. When cap is reached, callers should use cached/fallback results
 * instead of making new API calls.
 *
 * Per-API cost estimates:
 *   - Claude Vision: ~$0.015-0.03/call
 *   - Gemini Vision: ~$0.01/call
 *   - Shopping Skill: ~$0.005/call
 *
 * Usage:
 *   import { createCostTracker, DEFAULT_SESSION_CAP } from './CostTracker';
 *   const tracker = createCostTracker();
 *   const check = tracker.checkBudget('claude_vision', 0.025);
 *   if (check.allowed) tracker.recordCost('claude_vision', 0.025);
 *
 * @module CostTracker
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CostEntry {
  api_name: string;
  cost: number;
  timestamp: string;
  cumulative_total: number;
}

export interface BudgetCheck {
  allowed: boolean;
  warning?: string;
  remaining: number;
}

export interface CostTracker {
  recordCost(apiName: string, cost: number): void;
  getTotalCost(): number;
  getSessionCap(): number;
  isCapReached(): boolean;
  checkBudget(apiName: string, estimatedCost: number): BudgetCheck;
  getEntries(): CostEntry[];
  getCostsByApi(): Record<string, number>;
  reset(): void;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const DEFAULT_SESSION_CAP = 5.0;

const CAP_WARNING_THRESHOLD = 0.8; // Warn when 80% of cap used

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createCostTracker(sessionCap?: number): CostTracker {
  const cap = sessionCap ?? DEFAULT_SESSION_CAP;
  const entries: CostEntry[] = [];
  let totalCost = 0;

  return {
    recordCost(apiName: string, cost: number): void {
      totalCost += cost;

      entries.push({
        api_name: apiName,
        cost,
        timestamp: new Date().toISOString(),
        cumulative_total: totalCost,
      });
    },

    getTotalCost(): number {
      return totalCost;
    },

    getSessionCap(): number {
      return cap;
    },

    isCapReached(): boolean {
      return totalCost >= cap;
    },

    checkBudget(apiName: string, estimatedCost: number): BudgetCheck {
      const remaining = cap - totalCost;

      if (totalCost >= cap) {
        return {
          allowed: false,
          warning: `Session cost cap reached ($${totalCost.toFixed(2)}/$${cap.toFixed(2)}). Use cached/fallback results instead.`,
          remaining: 0,
        };
      }

      const afterCost = totalCost + estimatedCost;
      const usageRatio = totalCost / cap;

      if (usageRatio >= CAP_WARNING_THRESHOLD) {
        return {
          allowed: true,
          warning: `Approaching session cost cap: $${totalCost.toFixed(2)}/$${cap.toFixed(2)} (${(usageRatio * 100).toFixed(0)}% used). Remaining: $${remaining.toFixed(2)}.`,
          remaining,
        };
      }

      return {
        allowed: true,
        remaining,
      };
    },

    getEntries(): CostEntry[] {
      return entries.map(e => ({ ...e }));
    },

    getCostsByApi(): Record<string, number> {
      const byApi: Record<string, number> = {};
      for (const entry of entries) {
        byApi[entry.api_name] = (byApi[entry.api_name] || 0) + entry.cost;
      }
      return byApi;
    },

    reset(): void {
      entries.length = 0;
      totalCost = 0;
    },
  };
}

// ---------------------------------------------------------------------------
// CLI entrypoint
// ---------------------------------------------------------------------------

if (import.meta.main) {
  console.log(`CostTracker - Session cost cap: $${DEFAULT_SESSION_CAP.toFixed(2)}`);
  console.log("");
  console.log("Per-API cost estimates:");
  console.log("  Claude Vision: ~$0.015-0.03/call");
  console.log("  Gemini Vision: ~$0.01/call");
  console.log("  Shopping Skill: ~$0.005/call");
  console.log("");
  console.log("Usage (programmatic):");
  console.log("  import { createCostTracker } from './CostTracker';");
  console.log("  const tracker = createCostTracker();");
  console.log("  tracker.checkBudget('claude_vision', 0.025);");
}
