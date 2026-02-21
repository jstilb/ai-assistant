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

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import type { AgentTrace } from './TraceCollector.ts';
import type { EvaluationResult, Finding, Evaluator } from './evaluators/ResourceEfficiencyEvaluator.ts';
import { createResourceEfficiencyEvaluator } from './evaluators/ResourceEfficiencyEvaluator.ts';
import { createLatencyEvaluator, type LatencyPercentiles } from './evaluators/LatencyEvaluator.ts';
import { createErrorRateEvaluator } from './evaluators/ErrorRateEvaluator.ts';
import { createDecisionQualityEvaluator } from './evaluators/DecisionQualityEvaluator.ts';
import { createComplianceEvaluator } from './evaluators/ComplianceEvaluator.ts';
import { auditLog } from './AuditLogger.ts';
import { emitInsight, emitEvalSignal } from '../../CORE/Tools/SkillIntegrationBridge';

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
// Constants
// ============================================================================

const KAYA_HOME: string = join(homedir(), '.claude');
const CONFIG_PATH: string = join(KAYA_HOME, 'MEMORY', 'MONITORING', 'config', 'monitoring-config.json');
const EVALUATIONS_DIR: string = join(KAYA_HOME, 'MEMORY', 'MONITORING', 'evaluations');
const BASELINES_PATH: string = join(KAYA_HOME, 'MEMORY', 'MONITORING', 'baselines', 'baselines.json');

// ============================================================================
// Config Loading
// ============================================================================

export function loadConfig(): MonitoringConfig {
  if (!existsSync(CONFIG_PATH)) {
    throw new Error(`Monitoring config not found at ${CONFIG_PATH}`);
  }
  return JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'));
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

  return pipelineResult;
}

function saveEvaluation(workflowId: string, result: PipelineResult): void {
  if (!existsSync(EVALUATIONS_DIR)) {
    mkdirSync(EVALUATIONS_DIR, { recursive: true });
  }
  const filePath = join(EVALUATIONS_DIR, `${workflowId}-eval.json`);
  writeFileSync(filePath, JSON.stringify(result, null, 2), 'utf-8');
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
