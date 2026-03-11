#!/usr/bin/env bun
/**
 * LatencyEvaluator - P50/P95/P99 latency analysis
 *
 * Tracks percentile latencies, flags slow operations (>2 sigma from baseline),
 * and identifies blocking patterns.
 */

import type { AgentTrace } from '../TraceCollector.ts';
import type { EvaluationResult, Finding, Evaluator } from './ResourceEfficiencyEvaluator.ts';

// ============================================================================
// Types
// ============================================================================

interface LatencyConfig {
  maxToolCallLatencyMs: number;
  maxWorkflowLatencyMs: number;
  sigmaThreshold: number;
  blockingPatternWindowMs: number;
  blockingPatternMinCalls: number;
}

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
// Default Config
// ============================================================================

const DEFAULT_CONFIG: LatencyConfig = {
  maxToolCallLatencyMs: 30000,
  maxWorkflowLatencyMs: 600000,
  sigmaThreshold: 2.0,
  blockingPatternWindowMs: 5000,
  blockingPatternMinCalls: 3,
};

// ============================================================================
// Helpers
// ============================================================================

function computePercentiles(values: number[]): LatencyPercentiles {
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

// ============================================================================
// Evaluator
// ============================================================================

export function createLatencyEvaluator(config?: Partial<LatencyConfig>, baselinePercentiles?: LatencyPercentiles): Evaluator {
  const cfg = { ...DEFAULT_CONFIG, ...config };

  return {
    name: 'Latency',

    async evaluate(traces: AgentTrace[]): Promise<EvaluationResult> {
      const findings: Finding[] = [];
      const recommendations: string[] = [];
      let deductions = 0;

      // Extract latency values from tool calls
      const toolCalls = traces.filter(t => t.eventType === 'tool_call' && t.metadata.latencyMs != null);
      const latencies = toolCalls.map(t => t.metadata.latencyMs!);
      const percentiles = computePercentiles(latencies);

      // 1. Check overall workflow duration
      const timestamps = traces.map(t => t.timestamp).filter(t => t > 0);
      if (timestamps.length >= 2) {
        const workflowDuration = Math.max(...timestamps) - Math.min(...timestamps);
        if (workflowDuration > cfg.maxWorkflowLatencyMs) {
          findings.push({
            severity: 'critical',
            category: 'workflow_latency',
            message: `Workflow duration (${workflowDuration}ms) exceeds threshold (${cfg.maxWorkflowLatencyMs}ms)`,
            evidence: { workflowDuration, threshold: cfg.maxWorkflowLatencyMs },
          });
          deductions += 20;
          recommendations.push('Consider parallelizing independent operations');
        }
      }

      // 2. Check individual tool call latencies
      for (const tc of toolCalls) {
        const lat = tc.metadata.latencyMs!;
        if (lat > cfg.maxToolCallLatencyMs) {
          findings.push({
            severity: 'warning',
            category: 'tool_latency',
            message: `Tool "${tc.metadata.toolName}" took ${lat}ms (threshold: ${cfg.maxToolCallLatencyMs}ms)`,
            evidence: { toolName: tc.metadata.toolName, latencyMs: lat },
          });
          deductions += 5;
        }
      }

      // 3. Detect outliers using sigma threshold relative to baseline or current data
      const refMean = baselinePercentiles?.mean || percentiles.mean;
      const refStddev = baselinePercentiles?.stddev || percentiles.stddev;

      if (refStddev > 0) {
        for (const tc of toolCalls) {
          const lat = tc.metadata.latencyMs!;
          const zScore = (lat - refMean) / refStddev;
          if (zScore > cfg.sigmaThreshold) {
            findings.push({
              severity: 'warning',
              category: 'latency_outlier',
              message: `Tool "${tc.metadata.toolName}" latency (${lat}ms) is ${zScore.toFixed(1)} sigma above mean`,
              evidence: { toolName: tc.metadata.toolName, latencyMs: lat, zScore: zScore.toFixed(2), mean: refMean, stddev: refStddev },
            });
            deductions += 3;
          }
        }
      }

      // 4. Detect blocking patterns (many sequential calls with short gaps)
      const sortedToolCalls = toolCalls.sort((a, b) => a.timestamp - b.timestamp);
      for (let i = 0; i <= sortedToolCalls.length - cfg.blockingPatternMinCalls; i++) {
        const windowCalls = sortedToolCalls.slice(i, i + cfg.blockingPatternMinCalls);
        const totalGap = windowCalls[windowCalls.length - 1].timestamp - windowCalls[0].timestamp;
        const totalLatency = windowCalls.reduce((s, c) => s + (c.metadata.latencyMs || 0), 0);

        // If gap between calls is small and total latency is high, it is a blocking pattern
        if (totalGap < cfg.blockingPatternWindowMs && totalLatency > cfg.blockingPatternWindowMs) {
          findings.push({
            severity: 'info',
            category: 'blocking_pattern',
            message: `Sequential blocking pattern: ${cfg.blockingPatternMinCalls} calls in ${totalGap}ms with ${totalLatency}ms total latency`,
            evidence: {
              calls: windowCalls.map(c => ({ tool: c.metadata.toolName, latency: c.metadata.latencyMs })),
              totalGap,
              totalLatency,
            },
          });
          recommendations.push('Consider batching or parallelizing sequential tool calls');
          break;
        }
      }

      // 5. Info: latency summary
      findings.push({
        severity: 'info',
        category: 'latency_summary',
        message: `Latency percentiles: P50=${percentiles.p50}ms, P95=${percentiles.p95}ms, P99=${percentiles.p99}ms (${latencies.length} samples)`,
        evidence: percentiles,
      });

      const score = Math.max(0, Math.min(100, 100 - deductions));

      return {
        score,
        passed: score >= 50,
        findings,
        recommendations: [...new Set(recommendations)],
      };
    },
  };
}

export { computePercentiles };
