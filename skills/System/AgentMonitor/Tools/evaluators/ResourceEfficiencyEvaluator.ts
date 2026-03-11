#!/usr/bin/env bun
/**
 * ResourceEfficiencyEvaluator - Token usage and redundant tool call detection
 *
 * Flags excessive token usage (configurable thresholds), identifies redundant
 * tool calls, and detects retry storms.
 */

import type { AgentTrace } from '../TraceCollector.ts';

// ============================================================================
// Types
// ============================================================================

export interface EvaluationResult {
  score: number;
  passed: boolean;
  findings: Finding[];
  recommendations: string[];
}

export interface Finding {
  severity: 'info' | 'warning' | 'critical';
  category: string;
  message: string;
  evidence: unknown;
}

export interface Evaluator {
  name: string;
  evaluate(traces: AgentTrace[]): Promise<EvaluationResult>;
}

interface ResourceEfficiencyConfig {
  maxTokensPerWorkflow: number;
  maxTokensPerToolCall: number;
  redundantToolCallWindow: number;
  redundantToolCallThreshold: number;
  retryStormThreshold: number;
  retryStormWindowMs: number;
}

// ============================================================================
// Default Config
// ============================================================================

const DEFAULT_CONFIG: ResourceEfficiencyConfig = {
  maxTokensPerWorkflow: 500000,
  maxTokensPerToolCall: 50000,
  redundantToolCallWindow: 5,
  redundantToolCallThreshold: 3,
  retryStormThreshold: 5,
  retryStormWindowMs: 30000,
};

// ============================================================================
// Evaluator
// ============================================================================

export function createResourceEfficiencyEvaluator(config?: Partial<ResourceEfficiencyConfig>): Evaluator {
  const cfg = { ...DEFAULT_CONFIG, ...config };

  return {
    name: 'ResourceEfficiency',

    async evaluate(traces: AgentTrace[]): Promise<EvaluationResult> {
      const findings: Finding[] = [];
      const recommendations: string[] = [];
      let deductions = 0;

      // 1. Check total token usage
      const totalTokens = traces.reduce((sum, t) => sum + (t.metadata.tokensUsed || 0), 0);
      if (totalTokens > cfg.maxTokensPerWorkflow) {
        const overagePercent = Math.round(((totalTokens - cfg.maxTokensPerWorkflow) / cfg.maxTokensPerWorkflow) * 100);
        findings.push({
          severity: overagePercent > 100 ? 'critical' : 'warning',
          category: 'token_usage',
          message: `Total token usage (${totalTokens}) exceeds threshold (${cfg.maxTokensPerWorkflow}) by ${overagePercent}%`,
          evidence: { totalTokens, threshold: cfg.maxTokensPerWorkflow, overagePercent },
        });
        deductions += Math.min(30, overagePercent / 3);
        recommendations.push('Consider breaking the workflow into smaller sub-tasks to reduce token consumption');
      }

      // 2. Check per-tool-call token usage
      const toolCalls = traces.filter(t => t.eventType === 'tool_call');
      for (const tc of toolCalls) {
        if (tc.metadata.tokensUsed && tc.metadata.tokensUsed > cfg.maxTokensPerToolCall) {
          findings.push({
            severity: 'warning',
            category: 'tool_token_usage',
            message: `Tool call "${tc.metadata.toolName}" used ${tc.metadata.tokensUsed} tokens (threshold: ${cfg.maxTokensPerToolCall})`,
            evidence: { toolName: tc.metadata.toolName, tokensUsed: tc.metadata.tokensUsed },
          });
          deductions += 5;
        }
      }

      // 3. Detect redundant tool calls (same tool called multiple times in a sliding window)
      const toolCallSequence = toolCalls.map(t => t.metadata.toolName || 'unknown');
      for (let i = 0; i <= toolCallSequence.length - cfg.redundantToolCallWindow; i++) {
        const window = toolCallSequence.slice(i, i + cfg.redundantToolCallWindow);
        const counts = new Map<string, number>();
        for (const name of window) {
          counts.set(name, (counts.get(name) || 0) + 1);
        }
        for (const [toolName, count] of counts) {
          if (count >= cfg.redundantToolCallThreshold) {
            findings.push({
              severity: 'warning',
              category: 'redundant_calls',
              message: `Tool "${toolName}" called ${count} times within ${cfg.redundantToolCallWindow}-call window (starting at index ${i})`,
              evidence: { toolName, count, windowStart: i, windowSize: cfg.redundantToolCallWindow },
            });
            deductions += 5;
            recommendations.push(`Consider caching or batching "${toolName}" calls`);
            break; // Avoid duplicate findings for overlapping windows
          }
        }
      }

      // 4. Detect retry storms (many error events in a short window)
      const errorTraces = traces.filter(t => t.eventType === 'error').sort((a, b) => a.timestamp - b.timestamp);
      for (let i = 0; i < errorTraces.length; i++) {
        const windowEnd = errorTraces[i].timestamp + cfg.retryStormWindowMs;
        const errorsInWindow = errorTraces.filter(e => e.timestamp >= errorTraces[i].timestamp && e.timestamp <= windowEnd);
        if (errorsInWindow.length >= cfg.retryStormThreshold) {
          findings.push({
            severity: 'critical',
            category: 'retry_storm',
            message: `Retry storm detected: ${errorsInWindow.length} errors within ${cfg.retryStormWindowMs}ms window`,
            evidence: {
              errorCount: errorsInWindow.length,
              windowMs: cfg.retryStormWindowMs,
              firstError: errorTraces[i].timestamp,
              errors: errorsInWindow.map(e => e.metadata.errorMessage),
            },
          });
          deductions += 20;
          recommendations.push('Implement exponential backoff or circuit breaker pattern');
          break;
        }
      }

      // 5. Info: resource summary
      findings.push({
        severity: 'info',
        category: 'resource_summary',
        message: `Resource summary: ${totalTokens} tokens, ${toolCalls.length} tool calls, ${errorTraces.length} errors`,
        evidence: { totalTokens, toolCallCount: toolCalls.length, errorCount: errorTraces.length },
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
