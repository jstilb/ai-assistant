#!/usr/bin/env bun
/**
 * Percentiles - Shared P50/P95/P99 latency statistics helper
 *
 * evals-rebuild slice C2: extracted from evaluators/LatencyEvaluator.ts
 * (deleted in this slice along with the rest of the Phase-1 evaluator
 * chain). computePercentiles()/LatencyPercentiles are FUNCTIONALLY
 * consumed by two Phase-2 (live-monitoring) modules that must keep
 * working after the Phase-1 evaluators are gone: ReplayEngine.ts
 * (derives a hypothetical baseline from a replayed trace window) and
 * BaselineManager.ts (persists rolling latency baselines). Moved here —
 * an AgentMonitor-local util, not lib/core/ — to keep the blast radius
 * to this skill; nothing outside AgentMonitor imported the old export.
 */

// ============================================================================
// Types
// ============================================================================

export interface LatencyPercentiles {
  p50: number;
  p95: number;
  p99: number;
  mean: number;
  stddev: number;
  min: number;
  max: number;
}

// ============================================================================
// Core Function
// ============================================================================

export function computePercentiles(values: number[]): LatencyPercentiles {
  if (values.length === 0) {
    return { p50: 0, p95: 0, p99: 0, mean: 0, stddev: 0, min: 0, max: 0 };
  }

  const sorted = [...values].sort((a, b) => a - b);
  const mean = sorted.reduce((s, v) => s + v, 0) / sorted.length;
  const variance = sorted.reduce((s, v) => s + Math.pow(v - mean, 2), 0) / sorted.length;
  const stddev = Math.sqrt(variance);

  const percentile = (p: number): number => {
    const idx = Math.ceil((p / 100) * sorted.length) - 1;
    return sorted[Math.max(0, idx)];
  };

  return {
    p50: percentile(50),
    p95: percentile(95),
    p99: percentile(99),
    mean: Math.round(mean),
    stddev: Math.round(stddev),
    min: sorted[0],
    max: sorted[sorted.length - 1],
  };
}
