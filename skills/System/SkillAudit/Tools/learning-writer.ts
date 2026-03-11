#!/usr/bin/env bun
/**
 * learning-writer.ts - Write audit findings to MEMORY/LEARNING/SYSTEM/
 *
 * Generates YAML-frontmatter markdown files for ContinualLearning synthesis.
 * Each audit produces at least one learning entry if it has HIGH-severity findings.
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'fs';
import { join, basename } from 'path';
import { LEARNING_SYSTEM_DIR, LEARNING_DIR, SKILL_AUDITS_DIR, type DimensionName, DIMENSIONS } from './constants';
import { ensureDirectory, getTimestamp, getDateString } from './utils';
import type { AuditReport, Finding, PriorLearningEntry, PriorAuditActions } from './report-builder';

// ============================================================================
// Types
// ============================================================================

export interface LearningEntry {
  title: string;
  category: 'skillaudit';
  skillName: string;
  dimensions: string[];
  severity: 'critical' | 'warning' | 'info';
  findings: string[];
  recommendations: string[];
}

// ============================================================================
// Core Functions
// ============================================================================

/**
 * Write audit learnings to MEMORY/LEARNING/SYSTEM/.
 * Returns the number of entries written.
 */
export function writeAuditLearnings(report: AuditReport): number {
  ensureDirectory(LEARNING_SYSTEM_DIR);

  const entries = extractLearnings(report);
  let written = 0;

  for (const entry of entries) {
    const filename = generateFilename(entry);
    const content = formatLearningEntry(entry);
    const filepath = join(LEARNING_SYSTEM_DIR, filename);

    try {
      writeFileSync(filepath, content, 'utf-8');
      written++;
    } catch {
      // Continue on write failure
    }
  }

  return written;
}

/**
 * Extract learning entries from an audit report.
 * Produces entries for:
 * 1. Critical findings (any P1 / HIGH severity)
 * 2. Pattern summary (aggregate of all findings)
 */
export function extractLearnings(report: AuditReport): LearningEntry[] {
  const entries: LearningEntry[] = [];

  // Collect all HIGH findings across dimensions
  const criticalFindings: { dimension: DimensionName; finding: Finding }[] = [];
  const allFindings: { dimension: DimensionName; finding: Finding }[] = [];

  for (const [key, result] of Object.entries(report.dimensions)) {
    const dimKey = key as DimensionName;
    for (const finding of result.findings) {
      allFindings.push({ dimension: dimKey, finding });
      if (finding.severity === 'HIGH') {
        criticalFindings.push({ dimension: dimKey, finding });
      }
    }
  }

  // Entry 1: Aggregate audit summary (always written)
  const dimensionsWithIssues = [...new Set(allFindings.map(f => DIMENSIONS[f.dimension].name))];
  entries.push({
    title: `skillaudit-${report.skillName.toLowerCase()}-summary`,
    category: 'skillaudit',
    skillName: report.skillName,
    dimensions: dimensionsWithIssues,
    severity: report.overallHealth === 'RED' ? 'critical' : report.overallHealth === 'YELLOW' ? 'warning' : 'info',
    findings: allFindings.slice(0, 10).map(f =>
      `[${DIMENSIONS[f.dimension].name}] ${f.finding.description}`
    ),
    recommendations: report.actionItems.slice(0, 5).map(a =>
      `[${a.priority}] ${a.action}`
    ),
  });

  // Entry 2: Critical findings only (if any)
  if (criticalFindings.length > 0) {
    entries.push({
      title: `skillaudit-${report.skillName.toLowerCase()}-critical`,
      category: 'skillaudit',
      skillName: report.skillName,
      dimensions: [...new Set(criticalFindings.map(f => DIMENSIONS[f.dimension].name))],
      severity: 'critical',
      findings: criticalFindings.map(f =>
        `[${DIMENSIONS[f.dimension].name}] ${f.finding.description}${f.finding.location ? ` (${f.finding.location})` : ''}`
      ),
      recommendations: report.actionItems
        .filter(a => a.priority === 'P1')
        .slice(0, 5)
        .map(a => a.action),
    });
  }

  return entries;
}

// ============================================================================
// Formatting
// ============================================================================

function formatLearningEntry(entry: LearningEntry): string {
  const now = getTimestamp();
  const lines: string[] = [];

  // YAML frontmatter
  lines.push('---');
  lines.push(`title: "${entry.title}"`);
  lines.push(`category: ${entry.category}`);
  lines.push(`skill: ${entry.skillName}`);
  lines.push(`severity: ${entry.severity}`);
  lines.push(`dimensions: [${entry.dimensions.map(d => `"${d}"`).join(', ')}]`);
  lines.push(`created: "${now}"`);
  lines.push('---');
  lines.push('');

  // Content
  lines.push(`# SkillAudit Learning: ${entry.skillName}`);
  lines.push('');
  lines.push(`**Severity:** ${entry.severity.toUpperCase()}`);
  lines.push(`**Date:** ${now.split('T')[0]}`);
  lines.push('');

  lines.push('## Findings');
  lines.push('');
  for (const finding of entry.findings) {
    lines.push(`- ${finding}`);
  }
  lines.push('');

  if (entry.recommendations.length > 0) {
    lines.push('## Recommendations');
    lines.push('');
    for (const rec of entry.recommendations) {
      lines.push(`- ${rec}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

function generateFilename(entry: LearningEntry): string {
  const dateStr = getDateString();
  const slug = `skillaudit-${entry.skillName.toLowerCase()}`;
  return `${dateStr}_LEARNING_${slug}.md`;
}

// ============================================================================
// Read-Back Functions
// ============================================================================

/**
 * Read prior learning entries for a specific skill from MEMORY/LEARNING/SYSTEM/.
 * Scans monthly subdirectories, filters by skill YAML frontmatter.
 * Returns newest-first, capped at 5 entries.
 */
export function readPriorLearnings(skillName: string): PriorLearningEntry[] {
  const entries: PriorLearningEntry[] = [];
  const systemDir = join(LEARNING_DIR, 'SYSTEM');

  if (!existsSync(systemDir)) return entries;

  // Scan monthly subdirectories (e.g., 2026-02/)
  let subdirs: string[];
  try {
    subdirs = readdirSync(systemDir, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name)
      .sort()
      .reverse(); // newest first
  } catch {
    return entries;
  }

  const today = getDateString();

  for (const subdir of subdirs) {
    const monthDir = join(systemDir, subdir);
    let files: string[];
    try {
      files = readdirSync(monthDir).filter(f => f.endsWith('.md'));
    } catch {
      continue;
    }

    for (const file of files) {
      if (entries.length >= 5) break;

      const filePath = join(monthDir, file);
      let content: string;
      try {
        content = readFileSync(filePath, 'utf-8');
      } catch {
        continue;
      }

      // Parse YAML frontmatter
      const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
      if (!fmMatch) continue;

      const frontmatter = fmMatch[1];

      // Check skill: field matches
      const skillMatch = frontmatter.match(/^skill:\s*(.+)$/m);
      if (!skillMatch) continue;
      const fileSkill = skillMatch[1].trim();
      if (fileSkill.toLowerCase() !== skillName.toLowerCase()) continue;

      // Skip entries from today (we're generating a new one)
      const dateMatch = frontmatter.match(/^created:\s*"?(\d{4}-\d{2}-\d{2})/m);
      const fileDate = dateMatch ? dateMatch[1] : file.slice(0, 10);
      if (fileDate === today) continue;

      // Extract severity
      const sevMatch = frontmatter.match(/^severity:\s*(.+)$/m);
      const severity = sevMatch ? sevMatch[1].trim() : 'info';

      // Extract ## Findings bullets
      const findings: string[] = [];
      const findingsSection = content.match(/## Findings\s*\n([\s\S]*?)(?=\n##|\n---|\n$)/);
      if (findingsSection) {
        const bullets = findingsSection[1].match(/^- .+$/gm);
        if (bullets) findings.push(...bullets.map(b => b.slice(2)));
      }

      // Extract ## Recommendations bullets
      const recommendations: string[] = [];
      const recsSection = content.match(/## Recommendations\s*\n([\s\S]*?)(?=\n##|\n---|\n$)/);
      if (recsSection) {
        const bullets = recsSection[1].match(/^- .+$/gm);
        if (bullets) recommendations.push(...bullets.map(b => b.slice(2)));
      }

      entries.push({
        filename: file,
        date: fileDate,
        skill: fileSkill,
        severity,
        findings,
        recommendations,
      });
    }

    if (entries.length >= 5) break;
  }

  return entries;
}

/**
 * Read action items from the most recent prior audit report for a skill.
 * Excludes today's audit. Parses the Action Items table for P1/P2 items.
 */
export function readPriorAuditActions(skillName: string): PriorAuditActions | null {
  if (!existsSync(SKILL_AUDITS_DIR)) return null;

  let files: string[];
  try {
    files = readdirSync(SKILL_AUDITS_DIR)
      .filter(f => f.startsWith(`${skillName}-`) && f.endsWith('.md'))
      .sort()
      .reverse(); // newest first
  } catch {
    return null;
  }

  const today = getDateString();

  // Find most recent audit that isn't today
  for (const file of files) {
    const dateMatch = file.match(/(\d{4}-\d{2}-\d{2})\.md$/);
    if (!dateMatch) continue;
    const auditDate = dateMatch[1];
    if (auditDate === today) continue;

    const filePath = join(SKILL_AUDITS_DIR, file);
    let content: string;
    try {
      content = readFileSync(filePath, 'utf-8');
    } catch {
      continue;
    }

    // Parse Action Items table
    const actionSection = content.match(/## Action Items\s*\n([\s\S]*?)(?=\n## |\n$)/);
    if (!actionSection) continue;

    const unresolvedP1: string[] = [];
    const unresolvedP2: string[] = [];

    // Match table rows: | P1 | action text | dimension | effort | impact |
    const rows = actionSection[1].match(/^\|[^|]+\|[^|]+\|[^|]+\|[^|]+\|[^|]+\|$/gm);
    if (rows) {
      for (const row of rows) {
        const cells = row.split('|').map(c => c.trim()).filter(Boolean);
        if (cells.length < 2) continue;
        const priority = cells[0];
        const action = cells[1];
        if (priority === 'P1') unresolvedP1.push(action);
        else if (priority === 'P2') unresolvedP2.push(action);
      }
    }

    if (unresolvedP1.length === 0 && unresolvedP2.length === 0) return null;

    return { auditDate, unresolvedP1, unresolvedP2 };
  }

  return null;
}
