#!/usr/bin/env bun
/**
 * report-builder.ts - Structured report generation for SkillAudit v2
 *
 * Generates markdown reports matching the Section 3.3 schema:
 * - Executive Summary
 * - Dimension Scores table
 * - Per-dimension detail sections
 * - Action Items table
 * - Metadata
 *
 * Also supports JSON output matching the AuditReport TypeScript interface.
 */

import { writeFileSync } from 'fs';
import { join } from 'path';
import {
  SKILL_AUDITS_DIR,
  DIMENSIONS,
  HEALTH_THRESHOLDS,
  type DimensionName,
  type HealthStatus,
  type Priority,
  type Effort,
  type ImpactLevel,
} from './constants';
import { ensureDirectory, getDateString, getTimestamp } from './utils';

// ============================================================================
// Types
// ============================================================================

export interface Finding {
  description: string;
  location?: string;  // file:line reference
  severity: 'HIGH' | 'MEDIUM' | 'LOW';
}

export interface Recommendation {
  action: string;
  priority: Priority;
  effort: Effort;
  impact: ImpactLevel;
  dimension: DimensionName;
}

export interface DimensionResult {
  score: number;
  health: HealthStatus;
  findings: Finding[];
  recommendations: Recommendation[];
  partial?: boolean;  // true if inferential was skipped
}

export interface ActionItem {
  priority: Priority;
  action: string;
  dimension: string;
  effort: Effort;
  impact: ImpactLevel;
}

export interface AuditMetadata {
  auditDuration: number;  // seconds
  deterministicChecks: { passed: number; failed: number };
  inferentialEvaluations: number;
  learningsWritten: number;
  priorAuditDate?: string;
  priorOverallScore?: number;
  priorOverallHealth?: HealthStatus;
}

export interface PriorLearningEntry {
  filename: string;
  date: string;
  skill: string;
  severity: string;
  findings: string[];
  recommendations: string[];
}

export interface PriorAuditActions {
  auditDate: string;
  unresolvedP1: string[];
  unresolvedP2: string[];
}

export interface AuditReport {
  skillName: string;
  auditedAt: string;
  overallHealth: HealthStatus;
  overallScore: number;
  dimensions: Record<DimensionName, DimensionResult>;
  actionItems: ActionItem[];
  metadata: AuditMetadata;
  priorContext?: {
    learnings: PriorLearningEntry[];
    auditActions: PriorAuditActions | null;
  };
}

// ============================================================================
// Scoring Functions
// ============================================================================

/**
 * Calculate health status for a single dimension score.
 */
export function dimensionHealth(score: number): HealthStatus {
  if (score < 3) return 'RED';
  if (score < 6) return 'YELLOW';
  return 'GREEN';
}

/**
 * Calculate overall health from all dimension scores.
 * RED: Any dimension <3 OR >=3 dimensions below 5
 * YELLOW: >=2 dimensions below 6
 * GREEN: Otherwise
 */
export function calculateOverallHealth(dimensions: Record<DimensionName, DimensionResult>): HealthStatus {
  const scores = Object.values(dimensions).map(d => d.score);
  const anyBelow3 = scores.some(s => s < HEALTH_THRESHOLDS.redAnyBelow);
  const countBelow5 = scores.filter(s => s < 5).length;
  const countBelow6 = scores.filter(s => s < 6).length;

  if (anyBelow3 || countBelow5 >= HEALTH_THRESHOLDS.redCountBelow5) return 'RED';
  if (countBelow6 >= HEALTH_THRESHOLDS.yellowCountBelow6) return 'YELLOW';
  return 'GREEN';
}

/**
 * Calculate weighted average overall score.
 */
export function calculateOverallScore(dimensions: Record<DimensionName, DimensionResult>): number {
  let weightedSum = 0;
  let totalWeight = 0;

  for (const [key, result] of Object.entries(dimensions)) {
    const dim = DIMENSIONS[key as DimensionName];
    if (dim) {
      weightedSum += result.score * dim.weight;
      totalWeight += dim.weight;
    }
  }

  const score = totalWeight > 0 ? weightedSum / totalWeight : 0;
  return Math.round(score * 10) / 10;
}

/**
 * Calculate priority score for action item ranking.
 * Formula: (10 - DimensionScore) * DimensionWeight * 100
 */
export function priorityScore(dimensionScore: number, dimensionKey: DimensionName): number {
  const dim = DIMENSIONS[dimensionKey];
  return Math.round((10 - dimensionScore) * dim.weight * 100);
}

// ============================================================================
// Report Generation
// ============================================================================

/**
 * Generate the full markdown report.
 */
export function generateMarkdownReport(report: AuditReport): string {
  const lines: string[] = [];

  // Header
  lines.push(`# ${report.skillName} Audit Report — ${report.auditedAt.split('T')[0]}`);
  lines.push('');

  // Executive Summary
  lines.push('## Executive Summary');
  lines.push(`- Overall Health: ${healthEmoji(report.overallHealth)} **${report.overallHealth}**`);
  lines.push(`- Overall Score: **${report.overallScore} / 10.0**`);
  const criticalFindings = Object.values(report.dimensions)
    .flatMap(d => d.findings)
    .filter(f => f.severity === 'HIGH').length;
  lines.push(`- Critical Findings: ${criticalFindings}`);
  const p1Count = report.actionItems.filter(a => a.priority === 'P1').length;
  const p2Count = report.actionItems.filter(a => a.priority === 'P2').length;
  const p3Count = report.actionItems.filter(a => a.priority === 'P3').length;
  lines.push(`- Action Items: ${report.actionItems.length} (P1: ${p1Count}, P2: ${p2Count}, P3: ${p3Count})`);
  lines.push('');

  // Dimension Scores Table
  lines.push('## Dimension Scores');
  lines.push('| # | Dimension | Score | Health | Key Finding |');
  lines.push('|---|-----------|-------|--------|-------------|');

  const sortedDimensions = Object.entries(DIMENSIONS)
    .sort(([, a], [, b]) => a.number - b.number);

  for (const [key, dim] of sortedDimensions) {
    const result = report.dimensions[key as DimensionName];
    if (!result) continue;
    const topFinding = result.findings[0]?.description || 'No issues found';
    const partialTag = result.partial ? ' (partial)' : '';
    lines.push(`| ${dim.number} | ${dim.name} | ${result.score}${partialTag} | ${healthEmoji(result.health)} ${result.health} | ${truncate(topFinding, 60)} |`);
  }
  lines.push('');

  // Per-Dimension Detail Sections
  for (const [key, dim] of sortedDimensions) {
    const result = report.dimensions[key as DimensionName];
    if (!result) continue;

    lines.push(`### Dimension ${dim.number}: ${dim.name}`);
    lines.push(`**Score:** ${result.score} / 10 | **Health:** ${healthEmoji(result.health)} ${result.health}${result.partial ? ' (partial — inferential skipped)' : ''}`);
    lines.push('');

    lines.push('**Findings:**');
    if (result.findings.length === 0) {
      lines.push('1. No issues found');
    } else {
      for (let i = 0; i < result.findings.length; i++) {
        const f = result.findings[i];
        const loc = f.location ? ` (${f.location})` : '';
        lines.push(`${i + 1}. [${f.severity}] ${f.description}${loc}`);
      }
    }
    lines.push('');

    if (result.recommendations.length > 0) {
      lines.push('**Recommendations:**');
      for (let i = 0; i < result.recommendations.length; i++) {
        const r = result.recommendations[i];
        lines.push(`${i + 1}. [${r.priority}] ${r.action}`);
      }
      lines.push('');
    }
  }

  // Action Items Table
  lines.push('## Action Items');
  lines.push('| Priority | Action | Dimension | Effort | Impact |');
  lines.push('|----------|--------|-----------|--------|--------|');
  for (const item of report.actionItems) {
    lines.push(`| ${item.priority} | ${truncate(item.action, 60)} | ${item.dimension} | ${item.effort} | ${item.impact} |`);
  }
  lines.push('');

  // Prior Audit Follow-Up (informational only — does not influence scores)
  if (report.priorContext) {
    const { learnings, auditActions } = report.priorContext;
    const hasContent = learnings.length > 0 || (auditActions && (auditActions.unresolvedP1.length > 0 || auditActions.unresolvedP2.length > 0));

    if (hasContent) {
      lines.push('## Prior Audit Follow-Up');
      lines.push('');
      lines.push('> This section is **informational only**. It does not influence any dimension score.');
      lines.push('');

      if (auditActions && (auditActions.unresolvedP1.length > 0 || auditActions.unresolvedP2.length > 0)) {
        lines.push(`### Unresolved Items from Prior Audit (${auditActions.auditDate})`);
        if (auditActions.unresolvedP1.length > 0) {
          lines.push('**P1 Items (unresolved):**');
          for (const item of auditActions.unresolvedP1) {
            lines.push(`- ${item}`);
          }
        }
        if (auditActions.unresolvedP2.length > 0) {
          lines.push('**P2 Items (unresolved):**');
          for (const item of auditActions.unresolvedP2) {
            lines.push(`- ${item}`);
          }
        }
        lines.push('');
      }

      if (learnings.length > 0) {
        lines.push('### Prior Learning Entries');
        for (const entry of learnings) {
          lines.push(`**${entry.date} — ${entry.severity.toUpperCase()}**`);
          if (entry.findings.length > 0) {
            lines.push('Findings:');
            for (const f of entry.findings) {
              lines.push(`- ${f}`);
            }
          }
          if (entry.recommendations.length > 0) {
            lines.push('Recommendations:');
            for (const r of entry.recommendations) {
              lines.push(`- ${r}`);
            }
          }
          lines.push('');
        }
      }
    }
  }

  // Metadata
  lines.push('## Metadata');
  lines.push(`- Audit Duration: ${report.metadata.auditDuration}s`);
  lines.push(`- Deterministic Checks: ${report.metadata.deterministicChecks.passed} passed, ${report.metadata.deterministicChecks.failed} failed`);
  lines.push(`- Inferential Evaluations: ${report.metadata.inferentialEvaluations} completed`);
  lines.push(`- Learnings Written: ${report.metadata.learningsWritten} entries`);
  if (report.metadata.priorAuditDate) {
    lines.push(`- Prior Audit: ${report.metadata.priorAuditDate}`);
    if (report.metadata.priorOverallScore !== undefined) {
      const delta = report.overallScore - report.metadata.priorOverallScore;
      const sign = delta >= 0 ? '+' : '';
      lines.push(`- Score Trend: ${report.metadata.priorOverallScore} → ${report.overallScore} (${sign}${delta.toFixed(1)})`);
    }
    if (report.metadata.priorOverallHealth) {
      lines.push(`- Health Trend: ${report.metadata.priorOverallHealth} → ${report.overallHealth}`);
    }
  }
  lines.push('');

  return lines.join('\n');
}

/**
 * Generate action items from all dimension results, sorted by priority score.
 */
export function generateActionItems(dimensions: Record<DimensionName, DimensionResult>): ActionItem[] {
  const items: ActionItem[] = [];

  for (const [key, result] of Object.entries(dimensions)) {
    const dimKey = key as DimensionName;
    const dim = DIMENSIONS[dimKey];
    if (!dim) continue;

    for (const rec of result.recommendations) {
      items.push({
        priority: rec.priority,
        action: rec.action,
        dimension: dim.name,
        effort: rec.effort,
        impact: rec.impact,
      });
    }
  }

  // Sort: P1 first, then by impact (H > M > L)
  const priorityOrder: Record<Priority, number> = { P1: 0, P2: 1, P3: 2 };
  const impactOrder: Record<ImpactLevel, number> = { HIGH: 0, MEDIUM: 1, LOW: 2 };

  items.sort((a, b) => {
    const pDiff = priorityOrder[a.priority] - priorityOrder[b.priority];
    if (pDiff !== 0) return pDiff;
    return impactOrder[a.impact] - impactOrder[b.impact];
  });

  return items;
}

/**
 * Generate the full JSON report.
 */
export function generateJsonReport(report: AuditReport): string {
  return JSON.stringify(report, null, 2);
}

/**
 * Save audit report to MEMORY/SkillAudits/.
 */
export function saveReport(report: AuditReport): string {
  ensureDirectory(SKILL_AUDITS_DIR);
  const filename = `${report.skillName}-${getDateString()}.md`;
  const filepath = join(SKILL_AUDITS_DIR, filename);
  const markdown = generateMarkdownReport(report);
  writeFileSync(filepath, markdown, 'utf-8');
  return filepath;
}

/**
 * Save ecosystem report to MEMORY/SkillAudits/.
 */
export function saveEcosystemReport(content: string): string {
  ensureDirectory(SKILL_AUDITS_DIR);
  const filename = `ecosystem-${getDateString()}.md`;
  const filepath = join(SKILL_AUDITS_DIR, filename);
  writeFileSync(filepath, content, 'utf-8');
  return filepath;
}

/**
 * Create an empty dimension result with default values.
 */
export function emptyDimensionResult(score: number = 5): DimensionResult {
  return {
    score: Math.max(1, Math.min(10, score)),
    health: dimensionHealth(score),
    findings: [],
    recommendations: [],
  };
}

/**
 * Create a DimensionResult from a score and findings.
 */
export function buildDimensionResult(
  score: number,
  findings: Finding[],
  recommendations: Recommendation[],
  partial: boolean = false
): DimensionResult {
  const clampedScore = Math.max(1, Math.min(10, Math.round(score * 10) / 10));
  return {
    score: clampedScore,
    health: dimensionHealth(clampedScore),
    findings,
    recommendations,
    partial,
  };
}

// ============================================================================
// Helpers
// ============================================================================

function healthEmoji(health: HealthStatus): string {
  switch (health) {
    case 'GREEN': return '🟢';
    case 'YELLOW': return '🟡';
    case 'RED': return '🔴';
  }
}

function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen - 3) + '...';
}
