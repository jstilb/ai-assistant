#!/usr/bin/env bun
/**
 * ReportGenerator - Generates MD + JSON reports from evaluation results
 *
 * Creates human-readable markdown reports and structured JSON reports
 * for each workflow evaluation.
 *
 * Usage:
 *   import { generateReport } from './ReportGenerator.ts';
 *   const { markdown, json } = generateReport(pipelineResult);
 */

import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import type { PipelineResult } from './EvaluatorPipeline.ts';
import type { Finding } from './evaluators/ResourceEfficiencyEvaluator.ts';
import { auditLog } from './AuditLogger.ts';

// ============================================================================
// Constants
// ============================================================================

const KAYA_HOME: string = join(homedir(), '.claude');
const REPORTS_DIR: string = join(KAYA_HOME, 'MEMORY', 'MONITORING', 'reports');

// ============================================================================
// Helpers
// ============================================================================

function getScoreEmoji(score: number): string {
  if (score >= 80) return 'PASS';
  if (score >= 50) return 'WARN';
  return 'FAIL';
}

function getSeverityIcon(severity: Finding['severity']): string {
  switch (severity) {
    case 'critical': return '[CRITICAL]';
    case 'warning': return '[WARNING]';
    case 'info': return '[INFO]';
  }
}

function formatTimestamp(ts: number): string {
  return new Date(ts).toISOString().replace('T', ' ').replace(/\.\d+Z/, ' UTC');
}

// ============================================================================
// Core Functions
// ============================================================================

function generateMarkdownReport(result: PipelineResult): string {
  const lines: string[] = [];

  // Header
  lines.push(`# Agent Monitor Report: ${result.workflowId}`);
  lines.push('');
  lines.push(`**Generated:** ${formatTimestamp(result.timestamp)}`);
  lines.push(`**Traces Analyzed:** ${result.traceCount}`);
  lines.push(`**Overall Score:** ${result.overallScore}/100 ${getScoreEmoji(result.overallScore)}`);
  lines.push(`**Status:** ${result.overallPassed ? 'PASSED' : 'FAILED'}`);
  lines.push('');

  // Score breakdown table
  lines.push('## Score Breakdown');
  lines.push('');
  lines.push('| Evaluator | Score | Weight | Weighted | Status |');
  lines.push('|-----------|-------|--------|----------|--------|');
  for (const evalResult of result.evaluatorResults) {
    lines.push(
      `| ${evalResult.name} | ${evalResult.score}/100 | ${(evalResult.weight * 100).toFixed(0)}% | ${evalResult.weightedScore.toFixed(1)} | ${getScoreEmoji(evalResult.score)} |`
    );
  }
  lines.push('');

  // Critical findings
  const criticalFindings = result.allFindings.filter(f => f.severity === 'critical');
  if (criticalFindings.length > 0) {
    lines.push('## Critical Findings');
    lines.push('');
    for (const finding of criticalFindings) {
      lines.push(`- ${getSeverityIcon(finding.severity)} **${finding.category}**: ${finding.message}`);
    }
    lines.push('');
  }

  // Warning findings
  const warningFindings = result.allFindings.filter(f => f.severity === 'warning');
  if (warningFindings.length > 0) {
    lines.push('## Warnings');
    lines.push('');
    for (const finding of warningFindings) {
      lines.push(`- ${getSeverityIcon(finding.severity)} **${finding.category}**: ${finding.message}`);
    }
    lines.push('');
  }

  // Per-evaluator details
  lines.push('## Evaluator Details');
  lines.push('');
  for (const evalResult of result.evaluatorResults) {
    lines.push(`### ${evalResult.name} (${evalResult.score}/100)`);
    lines.push('');

    // Non-info findings only in details
    const significantFindings = evalResult.findings.filter(f => f.severity !== 'info');
    if (significantFindings.length > 0) {
      lines.push('**Findings:**');
      for (const finding of significantFindings) {
        lines.push(`- ${getSeverityIcon(finding.severity)} ${finding.message}`);
      }
      lines.push('');
    }

    // Info findings as summary
    const infoFindings = evalResult.findings.filter(f => f.severity === 'info');
    if (infoFindings.length > 0) {
      lines.push('**Summary:**');
      for (const finding of infoFindings) {
        lines.push(`- ${finding.message}`);
      }
      lines.push('');
    }

    if (evalResult.recommendations.length > 0) {
      lines.push('**Recommendations:**');
      for (const rec of evalResult.recommendations) {
        lines.push(`- ${rec}`);
      }
      lines.push('');
    }
  }

  // Recommendations summary
  if (result.allRecommendations.length > 0) {
    lines.push('## All Recommendations');
    lines.push('');
    for (let i = 0; i < result.allRecommendations.length; i++) {
      lines.push(`${i + 1}. ${result.allRecommendations[i]}`);
    }
    lines.push('');
  }

  lines.push('---');
  lines.push(`*Report generated by AgentMonitor v1.0.0*`);

  return lines.join('\n');
}

function generateJsonReport(result: PipelineResult): string {
  return JSON.stringify({
    version: '1.0.0',
    workflowId: result.workflowId,
    timestamp: result.timestamp,
    overallScore: result.overallScore,
    overallPassed: result.overallPassed,
    traceCount: result.traceCount,
    evaluators: result.evaluatorResults.map(e => ({
      name: e.name,
      score: e.score,
      passed: e.passed,
      weight: e.weight,
      findingCounts: {
        critical: e.findings.filter(f => f.severity === 'critical').length,
        warning: e.findings.filter(f => f.severity === 'warning').length,
        info: e.findings.filter(f => f.severity === 'info').length,
      },
      recommendations: e.recommendations,
    })),
    criticalFindings: result.allFindings.filter(f => f.severity === 'critical'),
    recommendationCount: result.allRecommendations.length,
  }, null, 2);
}

export function saveReport(result: PipelineResult): { markdownPath: string; jsonPath: string } {
  const dateStr = new Date(result.timestamp).toISOString().split('T')[0];
  const dateDir = join(REPORTS_DIR, dateStr);

  if (!existsSync(dateDir)) {
    mkdirSync(dateDir, { recursive: true });
  }

  const markdownPath = join(dateDir, `${result.workflowId}-report.md`);
  const jsonPath = join(dateDir, `${result.workflowId}-report.json`);

  writeFileSync(markdownPath, generateMarkdownReport(result), 'utf-8');
  writeFileSync(jsonPath, generateJsonReport(result), 'utf-8');

  auditLog({
    action: 'generate_report',
    workflowId: result.workflowId,
    details: { markdownPath, jsonPath, overallScore: result.overallScore },
    success: true,
  });

  return { markdownPath, jsonPath };
}
