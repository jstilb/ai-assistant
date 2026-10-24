#!/usr/bin/env bun
/**
 * RateLimitGuard.ts - Rate limit awareness and model fallback
 *
 * Reads MEMORY/State/rate-limits.json (written by statusline-command.sh)
 * and determines whether a model should be swapped for a fallback.
 *
 * A missing or stale reading is UNKNOWN, not 0%: resolveModel() reports it in `reason`
 * and `known:false, peak:null`, and keeps the preferred model.
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

import { existsSync } from "node:fs";
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
  /** Highest fresh usage percentage; null when usage is unknown (no fresh statusline reading). */
  peak: number | null;
  /** false = usage unknown. Unknown is NOT 0%: it means "no evidence either way". */
  known: boolean;
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
 * Read the raw rate limit state from disk, with NO staleness filtering.
 * Returns null if the file is missing, unreadable, or fails validation.
 * Whether a reading is current is decided per window by assessUsage().
 */
function getRateLimitState(): RateLimitState | null {
  return MEMORY.state.rateLimits.read();
}

type WindowName = "fiveHour" | "sevenDay";

/** One window's last real reading, with how old it is and whether it still describes the present. */
interface WindowReading {
  window: WindowName;
  usedPercentage: number;
  resetsAt: string;
  /** ISO time the statusline saw this reading; null if the file does not say. */
  observedAt: string | null;
  /** null when observedAt is missing or unparseable. */
  ageMs: number | null;
  /** Fresh = observed within MAX_STALE_MS AND its window has not reset since. Only fresh readings feed the peak. */
  fresh: boolean;
  /** Plain-words reason a reading is not fresh; null when fresh. */
  staleWhy: string | null;
}

interface UsageAssessment {
  /** true when at least one window has a FRESH real reading. false = UNKNOWN (never 0%). */
  known: boolean;
  /** Highest usedPercentage among fresh readings; null when unknown. */
  peak: number | null;
  /** Every window that has any real reading, fresh or stale. */
  readings: WindowReading[];
  /** Newest observedAt across all readings (fresh or stale); null if no reading has ever been recorded. */
  lastObservedAt: string | null;
}

function humanAge(ms: number): string {
  const m = Math.round(ms / 60_000);
  if (m < 90) return `${m}m`;
  const h = ms / 3_600_000;
  return h < 48 ? `${h.toFixed(1)}h` : `${Math.round(h / 24)}d`;
}

/**
 * Turn the state file into per-window readings. A window's reading is the current render's value if it has one,
 * else the file's `lastReal` (a null render never erases it). A missing reading is UNKNOWN, never 0%.
 * An old-format file (no observedAt) borrows the file's updatedAt as the observation time.
 */
function assessUsage(state: RateLimitState | null, nowMs: number = Date.now()): UsageAssessment {
  const readings: WindowReading[] = [];
  if (state) {
    for (const window of ["fiveHour", "sevenDay"] as const) {
      const current = state[window];
      const w = current ?? state.lastReal?.[window] ?? null;
      if (!w) continue;
      const observedAt = w.observedAt ?? (current ? state.updatedAt ?? null : null);
      const obsMs = observedAt ? Date.parse(observedAt) : Number.NaN;
      const ageMs = Number.isNaN(obsMs) ? null : nowMs - obsMs;
      const resetMs = Date.parse(w.resetsAt);
      let staleWhy: string | null = null;
      if (ageMs === null) staleWhy = "no usable observation time";
      else if (ageMs > MAX_STALE_MS) staleWhy = `observed ${humanAge(ageMs)} ago`;
      else if (!Number.isNaN(resetMs) && resetMs <= nowMs) staleWhy = `its window reset at ${w.resetsAt}`;
      readings.push({ window, usedPercentage: w.usedPercentage, resetsAt: w.resetsAt, observedAt, ageMs, fresh: staleWhy === null, staleWhy });
    }
  }
  const fresh = readings.filter((r) => r.fresh);
  const times = readings.map((r) => (r.observedAt ? Date.parse(r.observedAt) : Number.NaN)).filter((t) => !Number.isNaN(t));
  return {
    known: fresh.length > 0,
    peak: fresh.length > 0 ? Math.max(...fresh.map((r) => r.usedPercentage)) : null,
    readings,
    lastObservedAt: times.length > 0 ? new Date(Math.max(...times)).toISOString() : null,
  };
}

const WINDOW_LABEL: Record<WindowName, string> = { fiveHour: "5h", sevenDay: "7d" };

/** Plain-words account of why usage is unknown (or partly unknown), for `reason` fields and logs. */
function describeGaps(a: UsageAssessment): string {
  const stale = a.readings.filter((r) => !r.fresh);
  if (a.readings.length === 0) {
    // The accessor returns null for a missing file AND for a corrupt/invalid one; say which. Both stay "unknown" (fail-safe).
    const path = MEMORY.state.rateLimits.path();
    if (existsSync(path) && MEMORY.state.rateLimits.read() === null) return `rate-limits.json could not be read or parsed (${path})`;
    return "no statusline reading has ever been recorded";
  }
  const parts = stale.map((r) => `${WINDOW_LABEL[r.window]} ${r.usedPercentage}% is stale (${r.staleWhy})`);
  return `no statusline reading since ${a.lastObservedAt ?? "an unknown time"}${parts.length ? `; last readings: ${parts.join(", ")}` : ""}`;
}

/**
 * Get the peak usage percentage across both windows, counting only FRESH readings.
 * Returns 0 if usage is unknown. That 0 means UNKNOWN, not "0% used" — callers that must tell the two apart
 * use assessUsage().known / .peak. Kept for back-compat.
 */
function getPeakUsage(state: RateLimitState | null): number {
  return assessUsage(state).peak ?? 0;
}

/**
 * Check if the current rate limit state exceeds a threshold. Unknown usage is NOT limited:
 * there is no evidence of a limit, and callers (spawn gates, the executor) already treat "no data" as go.
 */
function isRateLimited(threshold: number = DEFAULT_THRESHOLD): boolean {
  const peak = assessUsage(getRateLimitState()).peak;
  return peak !== null && peak >= threshold;
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
  const usage = assessUsage(getRateLimitState());
  const peak = usage.peak;

  if (peak === null) {
    // Unknown usage keeps the preferred model. There is no evidence of a limit, and failing over on missing
    // data would change every caller's behaviour (the statusline only writes while an interactive session renders).
    return {
      model: preferred,
      wasFallback: false,
      reason: `${preferred} usage unknown: ${describeGaps(usage)}; keeping ${preferred}`,
      peak: null,
      known: false,
    };
  }

  if (peak < threshold) {
    const gaps = usage.readings.filter((r) => !r.fresh);
    return {
      model: preferred,
      wasFallback: false,
      reason: `${preferred} within limits (${peak}% used)${gaps.length ? `; ignored stale: ${gaps.map((r) => `${WINDOW_LABEL[r.window]} ${r.usedPercentage}% (${r.staleWhy})`).join(", ")}` : ""}`,
      peak,
      known: true,
    };
  }

  // Walk the fallback chain
  const fallback = getFallbackModel(preferred);
  if (fallback) {
    return {
      model: fallback,
      wasFallback: true,
      reason: `${preferred} at ${peak}% usage (threshold ${threshold}%), fell back to ${fallback}`,
      peak,
      known: true,
    };
  }

  // No fallback available (opus is already the top tier)
  return {
    model: preferred,
    wasFallback: false,
    reason: `${preferred} at ${peak}% usage but no fallback available — proceeding with ${preferred}`,
    peak,
    known: true,
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
      console.log(JSON.stringify({ available: false, reason: "No rate limit file, or it failed validation" }));
    } else {
      const usage = assessUsage(state);
      console.log(JSON.stringify({
        available: usage.known,
        known: usage.known,
        peakUsage: getPeakUsage(state),
        peak: usage.peak,
        isLimited: isRateLimited(),
        ...(usage.known ? {} : { reason: `usage unknown: ${describeGaps(usage)}` }),
        readings: usage.readings,
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
  assessUsage,
  describeGaps,
  extractResetInfo,
  MAX_STALE_MS,
  RATE_LIMIT_PATTERN,
  FALLBACK_CHAIN,
  DEFAULT_THRESHOLD,
  type ModelTier,
  type RateLimitState,
  type RateLimitWindow,
  type ModelFallbackResult,
  type UsageAssessment,
  type WindowReading,
  type WindowName,
};
