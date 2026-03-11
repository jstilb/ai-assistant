#!/usr/bin/env bun
/**
 * TriggerAnalyzer - Analyze trigger overlap between skills
 *
 * Reads SKILL.md files directly and calculates overlap percentages
 * to identify consolidation candidates.
 *
 * Usage:
 *   bun run TriggerAnalyzer.ts [--threshold 60]
 *   bun run TriggerAnalyzer.ts --matrix
 */

import { join } from 'path';
import {
  TRIGGER_OVERLAP_THRESHOLD,
  MIN_TRIGGER_OVERLAP_DISPLAY,
  SCORING,
} from './constants';
import {
  getSkillDirectories,
  getSkillPath,
  safeReadFile,
  extractTriggers,
  ensureMemoryDirectories,
} from './utils';
import type { Finding, Recommendation, DimensionResult } from './report-builder';
import { buildDimensionResult } from './report-builder';

export interface OverlapResult {
  skillA: string;
  skillB: string;
  overlap: number;
  sharedTriggers: string[];
}

interface SkillData {
  name: string;
  triggers: string[];
}

/**
 * Build skill data by reading SKILL.md files directly
 */
function buildSkillData(): SkillData[] {
  const skillDirs = getSkillDirectories();
  const skills: SkillData[] = [];

  for (const skillName of skillDirs) {
    const skillMdPath = `${getSkillPath(skillName)}/SKILL.md`;
    const content = safeReadFile(skillMdPath);

    if (content) {
      const triggers = extractTriggers(content);
      if (triggers.length > 0) {
        skills.push({ name: skillName, triggers });
      }
    }
  }

  return skills;
}

function calculateOverlap(triggersA: string[], triggersB: string[]): { overlap: number; shared: string[] } {
  const setA = new Set(triggersA.map(t => t.toLowerCase()));
  const setB = new Set(triggersB.map(t => t.toLowerCase()));

  const shared: string[] = [];
  for (const trigger of setA) {
    if (setB.has(trigger)) {
      shared.push(trigger);
    }
  }

  // Jaccard similarity: intersection / union
  const union = new Set([...setA, ...setB]);
  const overlap = union.size > 0 ? (shared.length / union.size) * 100 : 0;

  return { overlap, shared };
}

function analyzeOverlaps(skills: SkillData[], threshold: number): OverlapResult[] {
  const results: OverlapResult[] = [];

  for (let i = 0; i < skills.length; i++) {
    for (let j = i + 1; j < skills.length; j++) {
      const skillA = skills[i];
      const skillB = skills[j];

      if (!skillA.triggers?.length || !skillB.triggers?.length) {
        continue;
      }

      const { overlap, shared } = calculateOverlap(skillA.triggers, skillB.triggers);

      if (overlap >= threshold) {
        results.push({
          skillA: skillA.name,
          skillB: skillB.name,
          overlap: Math.round(overlap * 10) / 10,
          sharedTriggers: shared,
        });
      }
    }
  }

  // Sort by overlap descending
  return results.sort((a, b) => b.overlap - a.overlap);
}

function printMatrix(skills: SkillData[], minOverlap: number = MIN_TRIGGER_OVERLAP_DISPLAY): void {
  const skillsWithTriggers = skills.filter(s => s.triggers?.length > 0);
  const names = skillsWithTriggers.map(s => s.name);

  console.log('\n## Trigger Overlap Matrix\n');
  console.log('(Showing pairs with >' + minOverlap + '% overlap)\n');

  // Header
  const header = ['Skill', ...names.map(n => n.substring(0, 8))].join(' | ');
  console.log('| ' + header + ' |');
  console.log('|' + '-'.repeat(header.length + 2) + '|');

  // Rows
  for (let i = 0; i < skillsWithTriggers.length; i++) {
    const row = [skillsWithTriggers[i].name.substring(0, 12).padEnd(12)];
    for (let j = 0; j < skillsWithTriggers.length; j++) {
      if (i === j) {
        row.push('  -  ');
      } else {
        const { overlap } = calculateOverlap(skillsWithTriggers[i].triggers, skillsWithTriggers[j].triggers);
        if (overlap >= minOverlap) {
          row.push(`**${Math.round(overlap)}%**`);
        } else if (overlap > 0) {
          row.push(`${Math.round(overlap)}%`);
        } else {
          row.push('  0  ');
        }
      }
    }
    console.log('| ' + row.join(' | ') + ' |');
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const thresholdArg = args.indexOf('--threshold');
  const threshold = thresholdArg >= 0 ? parseInt(args[thresholdArg + 1], 10) : TRIGGER_OVERLAP_THRESHOLD;
  const showMatrix = args.includes('--matrix');

  // Ensure MEMORY directories exist
  ensureMemoryDirectories();

  console.log('# Trigger Overlap Analysis\n');
  console.log(`Generated: ${new Date().toISOString()}`);
  console.log(`Threshold: ${threshold}%\n`);

  const skills = buildSkillData();
  console.log(`Loaded ${skills.length} skills from SKILL.md files.\n`);

  if (showMatrix) {
    printMatrix(skills);
    console.log('\n');
  }

  const overlaps = analyzeOverlaps(skills, threshold);

  if (overlaps.length === 0) {
    console.log(`No skill pairs found with >=${threshold}% trigger overlap.`);
    return;
  }

  console.log(`## Consolidation Candidates (>=${threshold}% overlap)\n`);

  for (const result of overlaps) {
    console.log(`### ${result.skillA} + ${result.skillB}`);
    console.log(`**Overlap:** ${result.overlap}%`);
    console.log(`**Shared triggers:** ${result.sharedTriggers.slice(0, 10).join(', ')}${result.sharedTriggers.length > 10 ? '...' : ''}`);
    console.log('');
  }

  // Summary
  console.log('## Summary\n');
  console.log(`- **High overlap (>60%):** ${overlaps.filter(o => o.overlap > 60).length} pairs`);
  console.log(`- **Medium overlap (40-60%):** ${overlaps.filter(o => o.overlap >= 40 && o.overlap <= 60).length} pairs`);
  console.log(`- **Total candidates:** ${overlaps.length} pairs`);
}

// ============================================================================
// Scoring Function — Dimension 8: Context Routing
// ============================================================================

/**
 * Score Context Routing for a skill based on trigger overlap analysis.
 * Applies SCORING.contextRouting deductions.
 */
export async function scoreContextRouting(skillName: string): Promise<DimensionResult> {
  const findings: Finding[] = [];
  const recommendations: Recommendation[] = [];
  let score = 10;

  // Load skill data
  const skills = buildSkillData();

  // Find the target skill
  const targetSkill = skills.find(s => s.name === skillName);
  if (!targetSkill || targetSkill.triggers.length === 0) {
    findings.push({
      description: 'No triggers found for skill — cannot assess routing overlap',
      severity: 'MEDIUM',
    });
    return buildDimensionResult(score - 1, findings, recommendations);
  }

  // Check USE WHEN and description from SKILL.md
  const skillMdPath = join(getSkillPath(skillName), 'SKILL.md');
  const skillContent = safeReadFile(skillMdPath);

  if (skillContent) {
    // Check for missing USE WHEN
    const hasUseWhen = /USE WHEN/i.test(skillContent);
    if (!hasUseWhen) {
      score += SCORING.contextRouting.missingUseWhen; // -1
      findings.push({
        description: 'Missing USE WHEN in SKILL.md frontmatter',
        severity: 'MEDIUM',
      });
      recommendations.push({
        action: 'Add USE WHEN triggers to SKILL.md description for routing clarity',
        priority: 'P2',
        effort: 'S',
        impact: 'MEDIUM',
        dimension: 'contextRouting',
      });
    }

    // Check for long description (>200 chars)
    const descMatch = skillContent.match(/description:\s*(.+?)(?:\n|$)/i);
    if (descMatch && descMatch[1].trim().length > 200) {
      score += SCORING.contextRouting.longDescription; // -1
      findings.push({
        description: `Description is ${descMatch[1].trim().length} chars (>200) — may cause false-positive routing`,
        severity: 'LOW',
      });
      recommendations.push({
        action: 'Shorten SKILL.md description to under 200 characters for precise routing',
        priority: 'P3',
        effort: 'S',
        impact: 'LOW',
        dimension: 'contextRouting',
      });
    }
  }

  // Compute overlaps vs all other skills
  const otherSkills = skills.filter(s => s.name !== skillName && s.triggers.length > 0);

  for (const other of otherSkills) {
    const { overlap } = calculateOverlap(targetSkill.triggers, other.triggers);

    if (overlap > 60) {
      score += SCORING.contextRouting.highOverlap; // -2
      findings.push({
        description: `High overlap (${Math.round(overlap)}%) with ${other.name}`,
        severity: 'HIGH',
      });
      recommendations.push({
        action: `Differentiate triggers from ${other.name} or consider consolidating`,
        priority: 'P2',
        effort: 'M',
        impact: 'HIGH',
        dimension: 'contextRouting',
      });
    } else if (overlap > 40) {
      score += SCORING.contextRouting.mediumOverlap; // -1
      findings.push({
        description: `Medium overlap (${Math.round(overlap)}%) with ${other.name}`,
        severity: 'MEDIUM',
      });
    }
  }

  if (findings.length === 0) {
    findings.push({
      description: 'No significant trigger overlap detected — clean routing',
      severity: 'LOW',
    });
  }

  return buildDimensionResult(score, findings, recommendations);
}

if (import.meta.main) {
  main().catch(console.error);
}
