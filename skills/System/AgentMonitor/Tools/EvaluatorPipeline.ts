#!/usr/bin/env bun
/**
 * EvaluatorPipeline - Runs evaluator chain on collected traces
 *
 * Orchestrates all evaluators, computes weighted scores, and produces
 * a unified evaluation result for a workflow.
 *
 * Usage:
 *   import { runPipeline } from './EvaluatorPipeline.ts';
 *   const result = await runPipeline(traces, config);
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, appendFileSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { z } from 'zod';
import type { AgentTrace } from './TraceCollector.ts';
import type { EvaluationResult, Finding, Evaluator } from './evaluators/ResourceEfficiencyEvaluator.ts';
import { createResourceEfficiencyEvaluator } from './evaluators/ResourceEfficiencyEvaluator.ts';
import { createLatencyEvaluator, type LatencyPercentiles } from './evaluators/LatencyEvaluator.ts';
import { createErrorRateEvaluator } from './evaluators/ErrorRateEvaluator.ts';
import { createDecisionQualityEvaluator } from './evaluators/DecisionQualityEvaluator.ts';
import { createComplianceEvaluator } from './evaluators/ComplianceEvaluator.ts';
import { auditLog } from './AuditLogger.ts';
import { emitInsight, emitEvalSignal } from '../../../../lib/core/SkillIntegrationBridge';
import { auditTrace } from './TraceAuditor';

// ============================================================================
// Types
// ============================================================================

export interface MonitoringConfig {
  evaluators: {
    resourceEfficiency: { enabled: boolean; weight: number; thresholds: Record<string, unknown> };
    latency: { enabled: boolean; weight: number; thresholds: Record<string, unknown> };
    errorRate: { enabled: boolean; weight: number; thresholds: Record<string, unknown> };
    decisionQuality: { enabled: boolean; weight: number; thresholds: Record<string, unknown> };
    compliance: { enabled: boolean; weight: number; checks: Record<string, unknown> };
  };
  scoring: { passingScore: number; warningScore: number; criticalScore: number };
  alerts: { voiceNotifications: boolean; jsonlLogging: boolean; criticalThreshold: number; warningThreshold: number };
  baselines: { minSamplesForBaseline: number; baselineWindowDays: number; autoUpdateBaselines: boolean };
  storage: { traceRetentionDays: number; evaluationRetentionDays: number; reportRetentionDays: number };
}

export interface PipelineResult {
  workflowId: string;
  timestamp: number;
  overallScore: number;
  overallPassed: boolean;
  evaluatorResults: {
    name: string;
    score: number;
    passed: boolean;
    weight: number;
    weightedScore: number;
    findings: Finding[];
    recommendations: string[];
  }[];
  allFindings: Finding[];
  allRecommendations: string[];
  traceCount: number;
}

// ============================================================================
// Schemas
// ============================================================================

const EvaluatorConfigSchema = z.object({
  enabled: z.boolean(),
  weight: z.number(),
  thresholds: z.record(z.unknown()).optional(),
  checks: z.record(z.unknown()).optional(),
});

const MonitoringConfigSchema = z.object({
  evaluators: z.object({
    resourceEfficiency: EvaluatorConfigSchema,
    latency: EvaluatorConfigSchema,
    errorRate: EvaluatorConfigSchema,
    decisionQuality: EvaluatorConfigSchema,
    compliance: EvaluatorConfigSchema,
  }),
  scoring: z.object({
    passingScore: z.number(),
    warningScore: z.number(),
    criticalScore: z.number(),
  }),
  alerts: z.object({
    voiceNotifications: z.boolean(),
    jsonlLogging: z.boolean(),
    criticalThreshold: z.number(),
    warningThreshold: z.number(),
  }),
  baselines: z.object({
    minSamplesForBaseline: z.number(),
    baselineWindowDays: z.number(),
    autoUpdateBaselines: z.boolean(),
  }),
  storage: z.object({
    traceRetentionDays: z.number(),
    evaluationRetentionDays: z.number(),
    reportRetentionDays: z.number(),
  }),
});

// ============================================================================
// Constants
// ============================================================================

const KAYA_HOME: string = join(homedir(), '.claude');
const CONFIG_PATH: string = join(KAYA_HOME, 'MEMORY', 'MONITORING', 'config', 'monitoring-config.json');
const EVALUATIONS_DIR: string = join(KAYA_HOME, 'MEMORY', 'MONITORING', 'evaluations');
const BASELINES_PATH: string = join(KAYA_HOME, 'MEMORY', 'MONITORING', 'baselines', 'baselines.json');
const LEARNING_DIR: string = join(KAYA_HOME, 'MEMORY', 'LEARNING', 'ALGORITHM');

// ============================================================================
// Config Loading
// ============================================================================

export function loadConfig(): MonitoringConfig {
  if (!existsSync(CONFIG_PATH)) {
    throw new Error(`Monitoring config not found at ${CONFIG_PATH}`);
  }
  const raw = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'));
  return MonitoringConfigSchema.parse(raw);
}

function loadBaseline(): LatencyPercentiles | undefined {
  if (!existsSync(BASELINES_PATH)) return undefined;
  try {
    const baselines = JSON.parse(readFileSync(BASELINES_PATH, 'utf-8'));
    return baselines.latency?.percentiles;
  } catch {
    return undefined;
  }
}

// ============================================================================
// Pipeline
// ============================================================================

export async function runPipeline(
  workflowId: string,
  traces: AgentTrace[],
  config?: MonitoringConfig
): Promise<PipelineResult> {
  const startTime = Date.now();
  const cfg = config || loadConfig();
  const baselinePercentiles = loadBaseline();

  // Build evaluator list based on config
  const evaluatorEntries: { evaluator: Evaluator; weight: number }[] = [];

  if (cfg.evaluators.resourceEfficiency.enabled) {
    evaluatorEntries.push({
      evaluator: createResourceEfficiencyEvaluator(
        cfg.evaluators.resourceEfficiency.thresholds as Record<string, number>
      ),
      weight: cfg.evaluators.resourceEfficiency.weight,
    });
  }

  if (cfg.evaluators.latency.enabled) {
    evaluatorEntries.push({
      evaluator: createLatencyEvaluator(
        cfg.evaluators.latency.thresholds as Record<string, number>,
        baselinePercentiles
      ),
      weight: cfg.evaluators.latency.weight,
    });
  }

  if (cfg.evaluators.errorRate.enabled) {
    evaluatorEntries.push({
      evaluator: createErrorRateEvaluator(
        cfg.evaluators.errorRate.thresholds as Record<string, unknown> as Record<string, number>
      ),
      weight: cfg.evaluators.errorRate.weight,
    });
  }

  if (cfg.evaluators.decisionQuality.enabled) {
    evaluatorEntries.push({
      evaluator: createDecisionQualityEvaluator(
        cfg.evaluators.decisionQuality.thresholds as Record<string, unknown> as Record<string, number | boolean | string>
      ),
      weight: cfg.evaluators.decisionQuality.weight,
    });
  }

  if (cfg.evaluators.compliance.enabled) {
    evaluatorEntries.push({
      evaluator: createComplianceEvaluator(
        cfg.evaluators.compliance.checks as Record<string, boolean | string[]>
      ),
      weight: cfg.evaluators.compliance.weight,
    });
  }

  // Run all evaluators
  const evaluatorResults: PipelineResult['evaluatorResults'] = [];
  const allFindings: Finding[] = [];
  const allRecommendations: string[] = [];

  for (const { evaluator, weight } of evaluatorEntries) {
    try {
      const result = await evaluator.evaluate(traces);
      const weightedScore = result.score * weight;

      evaluatorResults.push({
        name: evaluator.name,
        score: result.score,
        passed: result.passed,
        weight,
        weightedScore,
        findings: result.findings,
        recommendations: result.recommendations,
      });

      allFindings.push(...result.findings);
      allRecommendations.push(...result.recommendations);
    } catch (error: unknown) {
      const errMsg = error instanceof Error ? error.message : String(error);
      evaluatorResults.push({
        name: evaluator.name,
        score: 0,
        passed: false,
        weight,
        weightedScore: 0,
        findings: [{
          severity: 'critical',
          category: 'evaluator_error',
          message: `Evaluator "${evaluator.name}" failed: ${errMsg}`,
          evidence: { error: errMsg },
        }],
        recommendations: [`Fix ${evaluator.name} evaluator error: ${errMsg}`],
      });
    }
  }

  // Compute weighted overall score
  const totalWeight = evaluatorEntries.reduce((s, e) => s + e.weight, 0);
  const overallScore = totalWeight > 0
    ? Math.round(evaluatorResults.reduce((s, r) => s + r.weightedScore, 0) / totalWeight)
    : 0;

  const pipelineResult: PipelineResult = {
    workflowId,
    timestamp: Date.now(),
    overallScore,
    overallPassed: overallScore >= cfg.scoring.passingScore,
    evaluatorResults,
    allFindings,
    allRecommendations: [...new Set(allRecommendations)],
    traceCount: traces.length,
  };

  // Save evaluation to disk
  saveEvaluation(workflowId, pipelineResult);

  const durationMs = Date.now() - startTime;
  auditLog({
    action: 'evaluate',
    workflowId,
    details: {
      overallScore,
      passed: pipelineResult.overallPassed,
      evaluatorCount: evaluatorEntries.length,
      traceCount: traces.length,
      findingCount: allFindings.length,
    },
    durationMs,
    success: true,
  });

  // Emit insight for evaluation results
  emitInsight({
    source: 'AgentMonitor',
    type: 'signal',
    category: 'evaluation',
    title: `Evaluation: ${workflowId}`,
    content: `Score: ${overallScore}/100, Passed: ${pipelineResult.overallPassed}, Findings: ${allFindings.length}`,
    tags: ['agent-monitor', 'evaluation', workflowId],
    tier: 'hot',
    ttl: 7 * 24 * 60 * 60, // 7 days
    metadata: {
      overallScore,
      passed: pipelineResult.overallPassed,
      findingCount: allFindings.length,
      traceCount: traces.length,
    },
  });

  // Emit eval signal for low compliance scores
  if (overallScore < cfg.scoring.warningScore) {
    emitEvalSignal({
      source: 'AgentMonitor',
      signalType: overallScore < cfg.scoring.criticalScore ? 'failure' : 'regression',
      description: `Workflow ${workflowId} scored ${overallScore}/100 (threshold: ${cfg.scoring.passingScore})`,
      category: 'compliance',
      severity: overallScore < cfg.scoring.criticalScore ? 'critical' : 'high',
      suite: 'EvaluatorPipeline',
      score: overallScore,
      rawData: { findings: allFindings.slice(0, 5) }, // Top 5 findings
    });
  }

  // Trigger LLM audit for failed workflows (score < passing threshold)
  if (!pipelineResult.overallPassed) {
    auditTrace(workflowId, pipelineResult).catch(err => {
      console.error(`[EvaluatorPipeline] TraceAuditor failed (non-fatal): ${err}`);
    });
  }

  return pipelineResult;
}

function saveEvaluation(workflowId: string, result: PipelineResult): void {
  if (!existsSync(EVALUATIONS_DIR)) {
    mkdirSync(EVALUATIONS_DIR, { recursive: true });
  }
  const filePath = join(EVALUATIONS_DIR, `${workflowId}-eval.json`);
  writeFileSync(filePath, JSON.stringify(result, null, 2), 'utf-8');

  // Write learning record (fail-open)
  try {
    writeLearningRecord(workflowId, result);
  } catch {
    // Never break evaluation on learning write failure
  }
}

function writeLearningRecord(workflowId: string, result: PipelineResult): void {
  const now = new Date();
  const monthDir = join(LEARNING_DIR, `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`);
  if (!existsSync(monthDir)) {
    mkdirSync(monthDir, { recursive: true });
  }

  const timestamp = now.toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const status = result.overallPassed ? 'passed' : 'failed';
  const slug = workflowId.replace(/[^a-zA-Z0-9-]/g, '-').slice(0, 40);
  const filename = `${timestamp}_LEARNING_eval-${status}-${slug}.md`;

  const topFindings = result.allFindings.slice(0, 5);
  const topRecommendations = result.allRecommendations.slice(0, 5);

  const evaluatorSummary = result.evaluatorResults
    .map(e => `| ${e.name} | ${e.score}/100 | ${e.passed ? 'PASS' : 'FAIL'} | ${e.weight} |`)
    .join('\n');

  const content = `# Evaluation: ${workflowId}

**Date:** ${now.toISOString()}
**Score:** ${result.overallScore}/100
**Status:** ${result.overallPassed ? 'PASSED' : 'FAILED'}
**Traces:** ${result.traceCount}

## Evaluator Breakdown

| Evaluator | Score | Status | Weight |
|-----------|-------|--------|--------|
${evaluatorSummary}

## Key Findings

${topFindings.length > 0 ? topFindings.map(f => `- **[${f.severity}]** ${f.category}: ${f.message}`).join('\n') : '- No findings'}

## Recommendations

${topRecommendations.length > 0 ? topRecommendations.map(r => `- ${r}`).join('\n') : '- No recommendations'}
`;

  writeFileSync(join(monthDir, filename), content, 'utf-8');
}

export function loadEvaluation(workflowId: string): PipelineResult | null {
  const filePath = join(EVALUATIONS_DIR, `${workflowId}-eval.json`);
  if (!existsSync(filePath)) return null;
  try {
    return JSON.parse(readFileSync(filePath, 'utf-8'));
  } catch {
    return null;
  }
}
