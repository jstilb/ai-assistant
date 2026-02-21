#!/usr/bin/env bun
/**
 * BaselineManager - Computes and stores baseline metrics
 *
 * Maintains rolling baselines for agent performance metrics.
 * Used by evaluators to detect anomalies relative to historical performance.
 *
 * Usage:
 *   import { updateBaseline, getBaseline } from './BaselineManager.ts';
 *   updateBaseline(traces);
 *   const baseline = getBaseline();
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import type { AgentTrace } from './TraceCollector.ts';
import { computePercentiles, type LatencyPercentiles } from './evaluators/LatencyEvaluator.ts';
import { auditLog } from './AuditLogger.ts';

// ============================================================================
// Types
// ============================================================================

export interface BaselineData {
  lastUpdated: number;
  sampleCount: number;
  latency: {
    percentiles: LatencyPercentiles;
    byTool: Record<string, LatencyPercentiles>;
  };
  resources: {
    avgTokensPerWorkflow: number;
    avgToolCallsPerWorkflow: number;
    avgErrorRate: number;
  };
  agents: Record<string, {
    avgScore: number;
    evaluationCount: number;
    lastEvaluation: number;
  }>;
}

export interface BaselineConfig {
  minSamplesForBaseline: number;
  baselineWindowDays: number;
  autoUpdateBaselines: boolean;
}

// ============================================================================
// Constants
// ============================================================================

const KAYA_HOME: string = join(homedir(), '.claude');
const BASELINES_PATH: string = join(KAYA_HOME, 'MEMORY', 'MONITORING', 'baselines', 'baselines.json');
const EVALUATIONS_DIR: string = join(KAYA_HOME, 'MEMORY', 'MONITORING', 'evaluations');

const DEFAULT_BASELINE_CONFIG: BaselineConfig = {
  minSamplesForBaseline: 5,
  baselineWindowDays: 30,
  autoUpdateBaselines: true,
};

// ============================================================================
// Core Functions
// ============================================================================

export function getBaseline(): BaselineData | null {
  if (!existsSync(BASELINES_PATH)) return null;
  try {
    return JSON.parse(readFileSync(BASELINES_PATH, 'utf-8'));
  } catch {
    return null;
  }
}

function saveBaseline(baseline: BaselineData): void {
  const dir = dirname(BASELINES_PATH);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(BASELINES_PATH, JSON.stringify(baseline, null, 2), 'utf-8');
}

export function updateBaseline(traces: AgentTrace[], config?: Partial<BaselineConfig>): BaselineData {
  const cfg = { ...DEFAULT_BASELINE_CONFIG, ...config };
  const existing = getBaseline();

  // Extract latency values
  const toolCalls = traces.filter(t => t.eventType === 'tool_call' && t.metadata.latencyMs != null);
  const allLatencies = toolCalls.map(t => t.metadata.latencyMs!);

  // Per-tool latencies
  const toolLatencies = new Map<string, number[]>();
  for (const tc of toolCalls) {
    const name = tc.metadata.toolName || 'unknown';
    if (!toolLatencies.has(name)) toolLatencies.set(name, []);
    toolLatencies.get(name)!.push(tc.metadata.latencyMs!);
  }

  // Resource metrics
  const totalTokens = traces.reduce((s, t) => s + (t.metadata.tokensUsed || 0), 0);
  const totalToolCalls = traces.filter(t => t.eventType === 'tool_call').length;
  const errorCount = traces.filter(t => t.eventType === 'error').length;
  const errorRate = traces.length > 0 ? errorCount / traces.length : 0;

  const newSampleCount = (existing?.sampleCount || 0) + 1;

  // Compute new averages using exponential moving average
  const alpha = 1 / Math.min(newSampleCount, cfg.minSamplesForBaseline);

  const existingResources = existing?.resources || {
    avgTokensPerWorkflow: totalTokens,
    avgToolCallsPerWorkflow: totalToolCalls,
    avgErrorRate: errorRate,
  };

  const newBaseline: BaselineData = {
    lastUpdated: Date.now(),
    sampleCount: newSampleCount,
    latency: {
      percentiles: computePercentiles(allLatencies),
      byTool: Object.fromEntries(
        Array.from(toolLatencies.entries()).map(([name, lats]) => [name, computePercentiles(lats)])
      ),
    },
    resources: {
      avgTokensPerWorkflow: Math.round(
        existingResources.avgTokensPerWorkflow * (1 - alpha) + totalTokens * alpha
      ),
      avgToolCallsPerWorkflow: Math.round(
        existingResources.avgToolCallsPerWorkflow * (1 - alpha) + totalToolCalls * alpha
      ),
      avgErrorRate: parseFloat(
        (existingResources.avgErrorRate * (1 - alpha) + errorRate * alpha).toFixed(4)
      ),
    },
    agents: existing?.agents || {},
  };

  saveBaseline(newBaseline);

  auditLog({
    action: 'update_baseline',
    details: {
      sampleCount: newSampleCount,
      traceCount: traces.length,
      avgTokens: newBaseline.resources.avgTokensPerWorkflow,
      avgToolCalls: newBaseline.resources.avgToolCallsPerWorkflow,
    },
    success: true,
  });

  return newBaseline;
}

export function updateAgentBaseline(agentId: string, score: number): void {
  const baseline = getBaseline();
  if (!baseline) return;

  if (!baseline.agents[agentId]) {
    baseline.agents[agentId] = {
      avgScore: score,
      evaluationCount: 1,
      lastEvaluation: Date.now(),
    };
  } else {
    const agent = baseline.agents[agentId];
    const alpha = 1 / Math.min(agent.evaluationCount + 1, 10);
    agent.avgScore = Math.round(agent.avgScore * (1 - alpha) + score * alpha);
    agent.evaluationCount++;
    agent.lastEvaluation = Date.now();
  }

  saveBaseline(baseline);
}

export function getBaselineSummary(): string {
  const baseline = getBaseline();
  if (!baseline) return 'No baseline data available. Run evaluations to build baselines.';

  const lines: string[] = [];
  lines.push(`Baseline Summary (${baseline.sampleCount} samples)`);
  lines.push(`Last updated: ${new Date(baseline.lastUpdated).toISOString()}`);
  lines.push('');
  lines.push('Latency Percentiles:');
  lines.push(`  P50: ${baseline.latency.percentiles.p50}ms`);
  lines.push(`  P95: ${baseline.latency.percentiles.p95}ms`);
  lines.push(`  P99: ${baseline.latency.percentiles.p99}ms`);
  lines.push('');
  lines.push('Resource Averages:');
  lines.push(`  Tokens/workflow: ${baseline.resources.avgTokensPerWorkflow}`);
  lines.push(`  Tool calls/workflow: ${baseline.resources.avgToolCallsPerWorkflow}`);
  lines.push(`  Error rate: ${(baseline.resources.avgErrorRate * 100).toFixed(1)}%`);
  lines.push('');

  const agentEntries = Object.entries(baseline.agents);
  if (agentEntries.length > 0) {
    lines.push('Agent Baselines:');
    for (const [agentId, data] of agentEntries) {
      lines.push(`  ${agentId}: avg score ${data.avgScore}, ${data.evaluationCount} evals`);
    }
  }

  return lines.join('\n');
}
