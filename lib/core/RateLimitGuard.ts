#!/usr/bin/env bun
/**
 * RateLimitGuard.ts - Rate limit awareness and model fallback
 *
 * Reads MEMORY/State/rate-limits.json (written by statusline-command.sh)
 * and determines whether a model should be swapped for a fallback.
 *
 * Two safety layers:
 *   1. Pre-spawn: resolveModel() checks state file before spawning
 *   2. Post-spawn: isRateLimitError() pattern-matches agent output
 *
 * Usage:
 *   # CLI
 *   bun lib/core/RateLimitGuard.ts --preferred sonnet
 *   bun lib/core/RateLimitGuard.ts --preferred sonnet --threshold 85
 *   bun lib/core/RateLimitGuard.ts --check "You've hit your limit · resets Apr 10"
 *
 *   # Programmatic
 *   import { resolveModel, isRateLimitError, getFallbackModel } from './RateLimitGuard.ts';
 */

import { parseArgs } from "util";
import { MEMORY, type RateLimits, type RateLimitWindow } from "./MemoryPaths.ts";

// ============================================================================
// Types
// ============================================================================

type ModelTier = "sonnet" | "opus" | "haiku" | "fable";

/** @deprecated Use `RateLimits` from lib/core/MemoryPaths.ts. Re-exported for back-compat. */
type RateLimitState = RateLimits;

interface ModelFallbackResult {
  model: ModelTier;
  wasFallback: boolean;
  reason: string;
}

// ============================================================================
// Constants
// ============================================================================

const DEFAULT_THRESHOLD = 90;

/** Max age in ms before state is considered stale and ignored */
const MAX_STALE_MS = 10 * 60 * 1000; // 10 minutes

/** Fallback chain: each model maps to its ordered fallback list */
const FALLBACK_CHAIN: Record<ModelTier, ModelTier[]> = {
  haiku: ["sonnet", "opus"],
  sonnet: ["opus"],
  opus: [],
  // Fable has its own pool (split from the shared limit 2026-07-20); when it
  // is the one exhausted, Sonnet's headless path still works — same fallback
  // the executor chose (executor.ts FALLBACK_MODEL).
  fable: ["sonnet"],
};

/**
 * Pattern to detect rate limit errors in agent output.
 *
 * Matches Claude Code's rate/usage/session limit notices, e.g.
 *   "You've hit your limit · resets 3pm"
 *   "You've hit your session limit · resets 11:50pm (America/Los_Angeles)"
 *   "You've hit your usage limit"
 *
 * The first branch keys on the "hit your <qualifier> limit" phrasing (the
 * qualifier — session/usage/weekly/5-hour — is optional); the second is a
 * fallback for "<...> limit <...> resets" wording. Deliberately tight so prose
 * that merely mentions "rate limit" does not false-positive.
 */
// "reached your <Model> limit" is the per-model-pool banner (2026-08-29:
// "You've reached your Fable 5 limit. Switch to another model, ...").
const RATE_LIMIT_PATTERN = /hit your (?:[a-z0-9-]+ )?limit|reached your (?:[a-z0-9.-]+ ){0,3}limit|limit\b[^.\n]{0,40}resets/i;

// ============================================================================
// Core Functions
// ============================================================================

/**
 * Read the current rate limit state from disk.
 * Returns null if the file is missing, unreadable, or stale.
 */
function getRateLimitState(): RateLimitState | null {
  const parsed = MEMORY.state.rateLimits.read();
  if (!parsed) return null;
  // Stale data is treated as missing — RateLimitGuard's contract is "no recent measurement".
  if (parsed.updatedAt) {
    const age = Date.now() - new Date(parsed.updatedAt).getTime();
    if (age > MAX_STALE_MS) return null;
  }
  return parsed;
}

/**
 * Get the peak usage percentage across both rate limit windows.
 * Returns 0 if no data is available.
 */
function getPeakUsage(state: RateLimitState | null): number {
  if (!state) return 0;

  const five = state.fiveHour?.usedPercentage ?? 0;
  const seven = state.sevenDay?.usedPercentage ?? 0;
  return Math.max(five, seven);
}

/**
 * Check if the current rate limit state exceeds a threshold.
 */
function isRateLimited(threshold: number = DEFAULT_THRESHOLD): boolean {
  return getPeakUsage(getRateLimitState()) >= threshold;
}

/**
 * Get the next available fallback model for a given model.
 * Returns null if no fallback is available.
 */
function getFallbackModel(current: ModelTier): ModelTier | null {
  const chain = FALLBACK_CHAIN[current];
  return chain.length > 0 ? chain[0] : null;
}

/**
 * Resolve which model to use, considering rate limits.
 *
 * Pre-spawn heuristic: if rate limits are above threshold, walk the
 * fallback chain. Note that the state file tracks session-wide limits,
 * not per-model, so this is best-effort — the real safety net is
 * post-spawn detection via isRateLimitError().
 */
function resolveModel(
  preferred: ModelTier,
  threshold: number = DEFAULT_THRESHOLD,
): ModelFallbackResult {
  const state = getRateLimitState();
  const peak = getPeakUsage(state);

  if (peak < threshold) {
    return {
      model: preferred,
      wasFallback: false,
      reason: `${preferred} within limits (${peak}% used)`,
    };
  }

  // Walk the fallback chain
  const fallback = getFallbackModel(preferred);
  if (fallback) {
    return {
      model: fallback,
      wasFallback: true,
      reason: `${preferred} at ${peak}% usage (threshold ${threshold}%), fell back to ${fallback}`,
    };
  }

  // No fallback available (opus is already the top tier)
  return {
    model: preferred,
    wasFallback: false,
    reason: `${preferred} at ${peak}% usage but no fallback available — proceeding with ${preferred}`,
  };
}

/**
 * Check if a string (agent output) contains a rate limit error.
 * Use this for post-spawn detection.
 */
function isRateLimitError(output: string): boolean {
  return RATE_LIMIT_PATTERN.test(output);
}

/**
 * Extract rate limit reset info from an error message.
 * Returns null if the message doesn't match.
 */
function extractResetInfo(output: string): string | null {
  const match = output.match(/resets\s+(.+?)(?:\s*\(|$)/i);
  return match ? match[1].trim() : null;
}

// ============================================================================
// CLI Interface
// ============================================================================

async function main() {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      preferred: { type: "string", short: "p" },
      threshold: { type: "string", short: "t" },
      check: { type: "string", short: "c" },
      status: { type: "boolean", short: "s" },
      help: { type: "boolean", short: "h" },
    },
  });

  if (values.help) {
    console.log(`
RateLimitGuard — Rate limit awareness and model fallback

USAGE:
  bun RateLimitGuard.ts --preferred sonnet           Resolve model with fallback
  bun RateLimitGuard.ts --preferred sonnet -t 85     Custom threshold (default: 90)
  bun RateLimitGuard.ts --check "agent output..."    Check if output contains rate limit error
  bun RateLimitGuard.ts --status                     Show current rate limit state

OPTIONS:
  -p, --preferred <model>   Model to resolve (sonnet, opus, haiku, fable)
  -t, --threshold <pct>     Usage percentage threshold (default: 90)
  -c, --check <text>        Check text for rate limit error pattern
  -s, --status              Show current rate limit state
  -h, --help                Show this help
`);
    return;
  }

  if (values.status) {
    const state = getRateLimitState();
    if (!state) {
      console.log(JSON.stringify({ available: false, reason: "No rate limit data or data is stale" }));
    } else {
      console.log(JSON.stringify({
        available: true,
        peakUsage: getPeakUsage(state),
        isLimited: isRateLimited(),
        ...state,
      }, null, 2));
    }
    return;
  }

  if (values.check) {
    const limited = isRateLimitError(values.check);
    const reset = limited ? extractResetInfo(values.check) : null;
    console.log(JSON.stringify({ isRateLimitError: limited, resetInfo: reset }));
    return;
  }

  if (values.preferred) {
    const model = values.preferred as ModelTier;
    if (!["sonnet", "opus", "haiku", "fable"].includes(model)) {
      console.error(`Error: --preferred must be sonnet, opus, haiku, or fable (got "${model}")`);
      process.exit(1);
    }
    const threshold = values.threshold ? parseInt(values.threshold, 10) : DEFAULT_THRESHOLD;
    const result = resolveModel(model, threshold);
    console.log(JSON.stringify(result));
    return;
  }

  console.error("Error: --preferred, --check, or --status required. Use --help for usage.");
  process.exit(1);
}

if (import.meta.main) {
  main().catch(console.error);
}

// ============================================================================
// Exports
// ============================================================================

export {
  resolveModel,
  isRateLimited,
  isRateLimitError,
  getRateLimitState,
  getFallbackModel,
  getPeakUsage,
  extractResetInfo,
  RATE_LIMIT_PATTERN,
  FALLBACK_CHAIN,
  DEFAULT_THRESHOLD,
  type ModelTier,
  type RateLimitState,
  type RateLimitWindow,
  type ModelFallbackResult,
};
