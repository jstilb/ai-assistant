#!/usr/bin/env bun
/**
 * DecisionQualityEvaluator - Hybrid rules + LLM-as-judge evaluation
 *
 * Primary: Rule-based checks (ISC completion rate, tool call efficiency, error recovery)
 * Secondary: LLM-as-judge via Inference.ts for nuanced decision quality assessment
 */

import { join } from 'path';
import { homedir } from 'os';
import type { AgentTrace } from '../TraceCollector.ts';
import type { EvaluationResult, Finding, Evaluator } from './ResourceEfficiencyEvaluator.ts';

// ============================================================================
// Types
// ============================================================================

export interface DecisionQualityConfig {
  minIscCompletionRate: number;
  minToolCallEfficiency: number;
  maxUnnecessaryToolCalls: number;
  errorRecoveryTimeoutMs: number;
  useLlmJudge: boolean;
  llmJudgeLevel: 'fast' | 'standard' | 'smart';
}

// ============================================================================
// Default Config
// ============================================================================

const DEFAULT_CONFIG: DecisionQualityConfig = {
  minIscCompletionRate: 0.7,
  minToolCallEfficiency: 0.5,
  maxUnnecessaryToolCalls: 10,
  errorRecoveryTimeoutMs: 60000,
  useLlmJudge: true,
  llmJudgeLevel: 'fast',
};

const KAYA_HOME: string = join(homedir(), '.claude');

// ============================================================================
// LLM Judge
// ============================================================================

async function runLlmJudge(traces: AgentTrace[], level: string): Promise<{ score: number; reasoning: string } | null> {
  try {
    const tracesSummary = summarizeTracesForLlm(traces);
    const prompt = `You are an AI agent quality evaluator. Analyze this workflow execution trace and provide a quality score.

## Trace Summary
${tracesSummary}

## Evaluation Criteria
1. Did the agent make efficient decisions?
2. Did it recover from errors appropriately?
3. Were tool calls necessary and well-ordered?
4. Was the overall approach sound?

## Required Output Format
Respond with ONLY a JSON object (no markdown, no code blocks):
{"score": <0-100>, "reasoning": "<brief explanation>"}`;

    const inferenceToolPath = join(KAYA_HOME, 'lib', 'core', 'Inference.ts');
    const proc = Bun.spawn(['bun', inferenceToolPath, level], {
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    });

    proc.stdin.write(prompt);
    proc.stdin.end();

    const result = await new Response(proc.stdout).text();

    // Parse the JSON response - handle potential markdown wrapping
    let cleanResult = result.trim();
    // Strip markdown code block if present
    if (cleanResult.startsWith('```')) {
      cleanResult = cleanResult.replace(/```(?:json)?\s*/g, '').replace(/```\s*$/g, '').trim();
    }

    const parsed = JSON.parse(cleanResult);
    return {
      score: Math.max(0, Math.min(100, parsed.score || 50)),
      reasoning: parsed.reasoning || 'No reasoning provided',
    };
  } catch (error: unknown) {
    const errMsg = error instanceof Error ? error.message : String(error);
    // LLM judge is supplementary, failure should not crash the evaluator
    // Log to stderr for audit trail
    console.error('[DecisionQuality] LLM judge unavailable, using rules-only scoring:', errMsg);
    return null;
  }
}

function summarizeTracesForLlm(traces: AgentTrace[]): string {
  const lines: string[] = [];
  const eventCounts: Record<string, number> = {};

  for (const t of traces) {
    eventCounts[t.eventType] = (eventCounts[t.eventType] || 0) + 1;
  }

  lines.push(`Total events: ${traces.length}`);
  lines.push(`Event breakdown: ${Object.entries(eventCounts).map(([k, v]) => `${k}=${v}`).join(', ')}`);

  const toolCalls = traces.filter(t => t.eventType === 'tool_call');
  if (toolCalls.length > 0) {
    const toolNames = toolCalls.map(t => t.metadata.toolName || 'unknown');
    lines.push(`Tool calls (${toolCalls.length}): ${toolNames.join(' -> ')}`);
  }

  const errors = traces.filter(t => t.eventType === 'error');
  if (errors.length > 0) {
    lines.push(`Errors (${errors.length}):`);
    for (const err of errors.slice(0, 5)) {
      lines.push(`  - ${err.metadata.errorMessage || 'unknown error'}`);
    }
  }

  const decisions = traces.filter(t => t.eventType === 'decision');
  if (decisions.length > 0) {
    const avgIsc = decisions
      .filter(d => d.metadata.iscCompletionRate != null)
      .reduce((s, d) => s + d.metadata.iscCompletionRate!, 0) / decisions.length;
    lines.push(`Decision points: ${decisions.length}, Avg ISC rate: ${(avgIsc * 100).toFixed(0)}%`);
  }

  // Duration
  const timestamps = traces.map(t => t.timestamp);
  if (timestamps.length >= 2) {
    const duration = Math.max(...timestamps) - Math.min(...timestamps);
    lines.push(`Workflow duration: ${(duration / 1000).toFixed(1)}s`);
  }

  return lines.join('\n');
}

// ============================================================================
// Evaluator
// ============================================================================

export function createDecisionQualityEvaluator(config?: Partial<DecisionQualityConfig>): Evaluator {
  const cfg = { ...DEFAULT_CONFIG, ...config };

  return {
    name: 'DecisionQuality',

    async evaluate(traces: AgentTrace[]): Promise<EvaluationResult> {
      const findings: Finding[] = [];
      const recommendations: string[] = [];
      let ruleScore = 100;

      // === RULE-BASED EVALUATION ===

      // 1. ISC Completion Rate
      const decisions = traces.filter(t => t.eventType === 'decision');
      const iscRates = decisions
        .filter(d => d.metadata.iscCompletionRate != null)
        .map(d => d.metadata.iscCompletionRate!);

      if (iscRates.length > 0) {
        const avgIsc = iscRates.reduce((s, r) => s + r, 0) / iscRates.length;
        if (avgIsc < cfg.minIscCompletionRate) {
          findings.push({
            severity: avgIsc < cfg.minIscCompletionRate * 0.5 ? 'critical' : 'warning',
            category: 'isc_completion',
            message: `Average ISC completion rate ${(avgIsc * 100).toFixed(0)}% below threshold ${(cfg.minIscCompletionRate * 100).toFixed(0)}%`,
            evidence: { avgIscRate: avgIsc, threshold: cfg.minIscCompletionRate, sampleSize: iscRates.length },
          });
          ruleScore -= Math.min(25, (cfg.minIscCompletionRate - avgIsc) * 100);
          recommendations.push('Review ISC table for incomplete items and identify blockers');
        }
      }

      // 2. Tool call efficiency (ratio of unique tool types to total calls)
      const toolCalls = traces.filter(t => t.eventType === 'tool_call');
      if (toolCalls.length > 0) {
        const uniqueTools = new Set(toolCalls.map(t => t.metadata.toolName || 'unknown')).size;
        const efficiency = uniqueTools / toolCalls.length;

        if (efficiency < cfg.minToolCallEfficiency && toolCalls.length > 5) {
          findings.push({
            severity: 'warning',
            category: 'tool_efficiency',
            message: `Tool call efficiency ${(efficiency * 100).toFixed(0)}%: ${toolCalls.length} calls using only ${uniqueTools} unique tools`,
            evidence: { efficiency, totalCalls: toolCalls.length, uniqueTools },
          });
          ruleScore -= 10;
          recommendations.push('Reduce redundant tool calls by caching results or batching operations');
        }

        // Check for potentially unnecessary calls (> threshold)
        if (toolCalls.length > cfg.maxUnnecessaryToolCalls) {
          const toolFreq = new Map<string, number>();
          for (const tc of toolCalls) {
            const name = tc.metadata.toolName || 'unknown';
            toolFreq.set(name, (toolFreq.get(name) || 0) + 1);
          }
          const sorted = [...toolFreq.entries()].sort((a, b) => b[1] - a[1]);
          findings.push({
            severity: 'info',
            category: 'tool_frequency',
            message: `High tool call count (${toolCalls.length}). Top tools: ${sorted.slice(0, 5).map(([n, c]) => `${n}(${c})`).join(', ')}`,
            evidence: { totalCalls: toolCalls.length, topTools: Object.fromEntries(sorted.slice(0, 10)) },
          });
        }
      }

      // 3. Error recovery assessment
      const errors = traces.filter(t => t.eventType === 'error');
      if (errors.length > 0) {
        let recoveredCount = 0;
        let unrecoveredCount = 0;

        for (const err of errors) {
          // Check if there is a successful event after the error within the timeout
          const recovered = traces.some(
            t => t.timestamp > err.timestamp &&
              t.timestamp <= err.timestamp + cfg.errorRecoveryTimeoutMs &&
              t.agentId === err.agentId &&
              (t.eventType === 'tool_call' || t.eventType === 'completion')
          );

          if (recovered) {
            recoveredCount++;
          } else {
            unrecoveredCount++;
          }
        }

        const recoveryRate = errors.length > 0 ? recoveredCount / errors.length : 1;
        if (recoveryRate < 0.5 && errors.length > 1) {
          findings.push({
            severity: 'warning',
            category: 'error_recovery',
            message: `Low error recovery rate: ${(recoveryRate * 100).toFixed(0)}% (${recoveredCount}/${errors.length} errors recovered)`,
            evidence: { recoveryRate, recovered: recoveredCount, unrecovered: unrecoveredCount, total: errors.length },
          });
          ruleScore -= 15;
          recommendations.push('Improve error handling and retry logic');
        } else if (recoveryRate >= 0.8) {
          findings.push({
            severity: 'info',
            category: 'error_recovery',
            message: `Good error recovery: ${(recoveryRate * 100).toFixed(0)}% of errors recovered`,
            evidence: { recoveryRate, recovered: recoveredCount, total: errors.length },
          });
        }
      }

      // 4. Workflow completion check
      const hasStart = traces.some(t => t.eventType === 'start');
      const hasCompletion = traces.some(t => t.eventType === 'completion');
      if (hasStart && !hasCompletion) {
        findings.push({
          severity: 'warning',
          category: 'incomplete_workflow',
          message: 'Workflow started but no completion event recorded',
          evidence: { hasStart, hasCompletion },
        });
        ruleScore -= 10;
        recommendations.push('Ensure workflows emit completion events');
      }

      ruleScore = Math.max(0, Math.min(100, ruleScore));

      // === LLM-AS-JUDGE (supplementary) ===
      let llmScore: number | null = null;
      let llmReasoning: string | null = null;

      if (cfg.useLlmJudge && traces.length > 0) {
        const llmResult = await runLlmJudge(traces, cfg.llmJudgeLevel);
        if (llmResult) {
          llmScore = llmResult.score;
          llmReasoning = llmResult.reasoning;
          findings.push({
            severity: 'info',
            category: 'llm_judge',
            message: `LLM judge score: ${llmScore}/100 - ${llmReasoning}`,
            evidence: { llmScore, reasoning: llmReasoning },
          });
        }
      }

      // Combine scores: 70% rules, 30% LLM (if available)
      const finalScore = llmScore != null
        ? Math.round(ruleScore * 0.7 + llmScore * 0.3)
        : ruleScore;

      return {
        score: finalScore,
        passed: finalScore >= 50,
        findings,
        recommendations: [...new Set(recommendations)],
      };
    },
  };
}
