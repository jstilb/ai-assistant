#!/usr/bin/env bun
/**
 * BaselineManager - Reads persisted baseline metrics
 *
 * evals-rebuild slice C2: the Phase-1 write path (updateBaseline/
 * updateAgentBaseline) is deleted along with the rest of the Phase-1
 * batch-evaluation pipeline (EvaluatorPipeline.ts, MonitorCore's
 * evaluate/evaluate-all commands) — those commands were the ONLY callers.
 * What remains is read-only: getBaselineSummary(), used by MonitorCore's
 * Phase-2 `status` command. baselines.json is no longer written by
 * anything; getBaselineSummary() gracefully reports "no baseline data"
 * once any pre-existing file ages out, which is the correct behavior for
 * a Phase-1 artifact with no live producer.
 *
 * Usage:
 *   import { getBaselineSummary } from './BaselineManager.ts';
 *   const summary = await getBaselineSummary();
 */

import { existsSync } from 'fs';
import { join } from 'path';
import { z } from 'zod';
import { getKayaHome } from '../../../../lib/core/KayaHome.ts';
import { createStateManager } from '../../../../lib/core/StateManager.ts';
import { type LatencyPercentiles } from './Percentiles.ts';

// ============================================================================
// Types
// ============================================================================

interface BaselineData {
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

// ============================================================================
// Schemas
// ============================================================================

const LatencyPercentilesSchema = z.object({
  p50: z.number(),
  p75: z.number(),
  p90: z.number(),
  p95: z.number(),
  p99: z.number(),
  max: z.number(),
});

const BaselineDataSchema = z.object({
  lastUpdated: z.number(),
  sampleCount: z.number(),
  latency: z.object({
    percentiles: LatencyPercentilesSchema,
    byTool: z.record(z.string(), LatencyPercentilesSchema),
  }),
  resources: z.object({
    avgTokensPerWorkflow: z.number(),
    avgToolCallsPerWorkflow: z.number(),
    avgErrorRate: z.number(),
  }),
  agents: z.record(z.string(), z.object({
    avgScore: z.number(),
    evaluationCount: z.number(),
    lastEvaluation: z.number(),
  })),
});

// ============================================================================
// Constants
// ============================================================================

const KAYA_HOME: string = getKayaHome();
const BASELINES_PATH: string = join(KAYA_HOME, 'MEMORY', 'MONITORING', 'baselines', 'baselines.json');

// ============================================================================
// State Manager
// ============================================================================

const baselineStateManager = createStateManager({
  path: BASELINES_PATH,
  schema: BaselineDataSchema,
  defaults: {
    lastUpdated: 0,
    sampleCount: 0,
    latency: {
      percentiles: { p50: 0, p75: 0, p90: 0, p95: 0, p99: 0, max: 0 },
      byTool: {},
    },
    resources: { avgTokensPerWorkflow: 0, avgToolCallsPerWorkflow: 0, avgErrorRate: 0 },
    agents: {},
  },
});

// ============================================================================
// Core Functions
// ============================================================================

async function getBaseline(): Promise<BaselineData | null> {
  if (!existsSync(BASELINES_PATH)) return null;
  try {
    return await baselineStateManager.load();
  } catch {
    return null;
  }
}

export async function getBaselineSummary(): Promise<string> {
  const baseline = await getBaseline();
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
