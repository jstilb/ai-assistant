#!/usr/bin/env bun
/**
 * ErrorRateEvaluator - Failure rate and error clustering analysis
 *
 * Calculates failure rates by agent and task type, detects error clustering,
 * and categorizes error types.
 */

import type { AgentTrace } from '../TraceCollector.ts';
import type { EvaluationResult, Finding, Evaluator } from './ResourceEfficiencyEvaluator.ts';

// ============================================================================
// Types
// ============================================================================

export interface ErrorRateConfig {
  maxErrorRatePercent: number;
  errorClusterWindowMs: number;
  errorClusterMinCount: number;
  criticalErrorTypes: string[];
}

// ============================================================================
// Default Config
// ============================================================================

const DEFAULT_CONFIG: ErrorRateConfig = {
  maxErrorRatePercent: 15,
  errorClusterWindowMs: 60000,
  errorClusterMinCount: 3,
  criticalErrorTypes: ['ENOENT', 'PERMISSION_DENIED', 'TIMEOUT', 'CIRCUIT_OPEN'],
};

// ============================================================================
// Evaluator
// ============================================================================

export function createErrorRateEvaluator(config?: Partial<ErrorRateConfig>): Evaluator {
  const cfg = { ...DEFAULT_CONFIG, ...config };

  return {
    name: 'ErrorRate',

    async evaluate(traces: AgentTrace[]): Promise<EvaluationResult> {
      const findings: Finding[] = [];
      const recommendations: string[] = [];
      let deductions = 0;

      const errorTraces = traces.filter(t => t.eventType === 'error');
      const totalEvents = traces.length;
      const errorRate = totalEvents > 0 ? (errorTraces.length / totalEvents) * 100 : 0;

      // 1. Overall error rate
      if (errorRate > cfg.maxErrorRatePercent) {
        const severity = errorRate > cfg.maxErrorRatePercent * 2 ? 'critical' : 'warning';
        findings.push({
          severity,
          category: 'error_rate',
          message: `Error rate ${errorRate.toFixed(1)}% exceeds threshold ${cfg.maxErrorRatePercent}%`,
          evidence: { errorRate: errorRate.toFixed(1), errorCount: errorTraces.length, totalEvents, threshold: cfg.maxErrorRatePercent },
        });
        deductions += Math.min(30, (errorRate - cfg.maxErrorRatePercent) * 2);
        recommendations.push('Investigate root causes of high error rate');
      }

      // 2. Error rate by agent
      const agentErrors = new Map<string, { errors: number; total: number }>();
      for (const t of traces) {
        const entry = agentErrors.get(t.agentId) || { errors: 0, total: 0 };
        entry.total++;
        if (t.eventType === 'error') entry.errors++;
        agentErrors.set(t.agentId, entry);
      }

      for (const [agentId, stats] of agentErrors) {
        const rate = (stats.errors / stats.total) * 100;
        if (rate > cfg.maxErrorRatePercent && stats.errors > 1) {
          findings.push({
            severity: 'warning',
            category: 'agent_error_rate',
            message: `Agent "${agentId}" error rate ${rate.toFixed(1)}% (${stats.errors}/${stats.total} events)`,
            evidence: { agentId, errorRate: rate.toFixed(1), errors: stats.errors, total: stats.total },
          });
          deductions += 5;
        }
      }

      // 3. Detect error clustering (many errors in a short time window)
      const sortedErrors = errorTraces.sort((a, b) => a.timestamp - b.timestamp);
      for (let i = 0; i < sortedErrors.length; i++) {
        const windowEnd = sortedErrors[i].timestamp + cfg.errorClusterWindowMs;
        const cluster = sortedErrors.filter(e => e.timestamp >= sortedErrors[i].timestamp && e.timestamp <= windowEnd);
        if (cluster.length >= cfg.errorClusterMinCount) {
          findings.push({
            severity: 'critical',
            category: 'error_cluster',
            message: `Error cluster detected: ${cluster.length} errors within ${cfg.errorClusterWindowMs}ms`,
            evidence: {
              clusterSize: cluster.length,
              windowMs: cfg.errorClusterWindowMs,
              errors: cluster.map(e => ({
                agent: e.agentId,
                message: e.metadata.errorMessage,
                timestamp: e.timestamp,
              })),
            },
          });
          deductions += 15;
          recommendations.push('Error clustering suggests a systemic issue - check shared dependencies');
          break;
        }
      }

      // 4. Categorize error types
      const errorCategories = new Map<string, number>();
      for (const err of errorTraces) {
        const msg = err.metadata.errorMessage || 'unknown';
        // Extract error category from message
        let category = 'unknown';
        for (const critType of cfg.criticalErrorTypes) {
          if (msg.toUpperCase().includes(critType)) {
            category = critType;
            break;
          }
        }
        if (category === 'unknown') {
          // Try to extract from common patterns
          if (msg.includes('not found') || msg.includes('ENOENT')) category = 'NOT_FOUND';
          else if (msg.includes('permission') || msg.includes('EACCES')) category = 'PERMISSION';
          else if (msg.includes('timeout') || msg.includes('ETIMEDOUT')) category = 'TIMEOUT';
          else if (msg.includes('connection') || msg.includes('ECONNREFUSED')) category = 'CONNECTION';
          else category = 'OTHER';
        }
        errorCategories.set(category, (errorCategories.get(category) || 0) + 1);
      }

      if (errorCategories.size > 0) {
        // Check for critical error types
        for (const critType of cfg.criticalErrorTypes) {
          const count = errorCategories.get(critType) || 0;
          if (count > 0) {
            findings.push({
              severity: 'critical',
              category: 'critical_error_type',
              message: `Critical error type "${critType}" occurred ${count} time(s)`,
              evidence: { errorType: critType, count },
            });
            deductions += 10;
          }
        }

        findings.push({
          severity: 'info',
          category: 'error_categories',
          message: `Error categories: ${Array.from(errorCategories.entries()).map(([k, v]) => `${k}(${v})`).join(', ')}`,
          evidence: Object.fromEntries(errorCategories),
        });
      }

      // 5. Info: error summary
      findings.push({
        severity: 'info',
        category: 'error_summary',
        message: `Error summary: ${errorTraces.length} errors out of ${totalEvents} events (${errorRate.toFixed(1)}%)`,
        evidence: { errorCount: errorTraces.length, totalEvents, errorRate: errorRate.toFixed(1) },
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
