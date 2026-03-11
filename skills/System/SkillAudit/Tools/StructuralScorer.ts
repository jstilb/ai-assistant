#!/usr/bin/env bun
/**
 * StructuralScorer - Score Dimension 2: Implementation Quality
 *
 * Performs deterministic CreateSkill compliance checks and produces a
 * DimensionResult for the v2 audit report. Pure deterministic — no LLM.
 *
 * Usage:
 *   bun run StructuralScorer.ts <skill-name>
 *   bun run StructuralScorer.ts Browser
 *   bun run StructuralScorer.ts Browser --json
 *   bun run StructuralScorer.ts --all
 */

import { existsSync, readdirSync } from 'fs';
import { join, basename } from 'path';
import { SKILLS_DIR, SCORING } from './constants';
import {
  getSkillPath,
  getSkillFiles,
  safeReadFile,
  isTitleCase,
  countLines,
  countWords,
  extractTriggers,
  skillExists,
  getSkillDirectories,
} from './utils';
import type { Finding, Recommendation, DimensionResult } from './report-builder';
import { buildDimensionResult } from './report-builder';

// ============================================================================
// Types
// ============================================================================

export interface StructuralResult {
  skillName: string;
  score: number;
  dimensionResult: DimensionResult;
  structure: {
    hasTitleCase: boolean;
    hasSkillMd: boolean;
    hasFrontmatter: boolean;
    hasDescription: boolean;
    hasUseWhenTriggers: boolean;
    hasCustomization: boolean;
    hasVoiceNotification: boolean;
    hasWorkflowTable: boolean;
    hasExamples: boolean;
    exampleCount: number;
    isFlatStructure: boolean;
    depth: number;
    workflowCount: number;
    toolCount: number;
  };
}

// ============================================================================
// Structure Helpers
// ============================================================================

function measureFolderDepth(skillPath: string): number {
  let maxDepth = 0;

  function walk(dir: string, currentDepth: number): void {
    if (currentDepth > maxDepth) maxDepth = currentDepth;
    if (currentDepth > 3) return; // Guard against runaway traversal

    try {
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory() && !entry.name.startsWith('.')) {
          walk(join(dir, entry.name), currentDepth + 1);
        }
      }
    } catch {
      // Ignore permission/IO errors
    }
  }

  walk(skillPath, 0);
  return maxDepth;
}

// ============================================================================
// Core Scoring Logic
// ============================================================================

/**
 * Score a skill's structural and content compliance against CreateSkill spec.
 * Returns null if the skill directory does not exist.
 */
export function scoreStructure(skillName: string): StructuralResult | null {
  if (!skillExists(skillName)) {
    return null;
  }

  const skillPath = getSkillPath(skillName);
  const skillMdPath = join(skillPath, 'SKILL.md');
  const hasSkillMd = existsSync(skillMdPath);

  // Read SKILL.md content once
  const skillMdContent = hasSkillMd ? (safeReadFile(skillMdPath) ?? '') : '';

  // ---- Structural properties ----
  const hasFrontmatter = skillMdContent.startsWith('---');
  const hasDescription = skillMdContent.includes('description:');
  const hasUseWhenTriggers = skillMdContent.toLowerCase().includes('use when');
  const hasCustomization = skillMdContent.includes('## Customization');
  const hasVoiceNotification =
    skillMdContent.includes('Voice Notification') ||
    /curl.*localhost:8888/.test(skillMdContent);
  const hasWorkflowTable =
    skillMdContent.includes('| Workflow') ||
    skillMdContent.includes('| Trigger');

  const exampleMatches = skillMdContent.match(/\*\*Example \d+/gi) ?? [];
  const exampleCount = exampleMatches.length;
  const hasExamples = exampleCount > 0 || skillMdContent.includes('## Examples');

  const depth = measureFolderDepth(skillPath);
  const isFlatStructure = depth <= 2;

  const files = getSkillFiles(skillName);
  const workflowCount = files.workflows.length;
  const toolCount = files.tools.length;
  const lineCount = skillMdContent ? countLines(skillMdContent) : 0;

  // ---- Build findings & recommendations ----
  const findings: Finding[] = [];
  const recommendations: Recommendation[] = [];
  let score = 10;

  // TitleCase naming
  if (!isTitleCase(skillName)) {
    score += SCORING.implementation.missingTitleCase; // -1
    findings.push({
      description: `Skill directory "${skillName}" is not TitleCase`,
      severity: 'MEDIUM',
    });
    recommendations.push({
      action: `Rename skill directory to TitleCase (e.g. "${skillName[0].toUpperCase()}${skillName.slice(1)}")`,
      priority: 'P2',
      effort: 'M',
      impact: 'LOW',
      dimension: 'implementationQuality',
    });
  }

  // SKILL.md presence — biggest single deduction
  if (!hasSkillMd) {
    score += SCORING.implementation.missingSkillMd; // -3
    findings.push({
      description: 'Missing SKILL.md — skill has no documentation entry point',
      severity: 'HIGH',
    });
    recommendations.push({
      action: 'Create SKILL.md with frontmatter, description, USE WHEN triggers, and examples',
      priority: 'P1',
      effort: 'M',
      impact: 'HIGH',
      dimension: 'implementationQuality',
    });
  }

  // Frontmatter
  if (!hasFrontmatter) {
    score += SCORING.implementation.missingFrontmatter; // -1
    findings.push({
      description: 'SKILL.md is missing YAML frontmatter (---)',
      location: 'SKILL.md:1',
      severity: 'MEDIUM',
    });
    recommendations.push({
      action: 'Add YAML frontmatter block at top of SKILL.md with name, description, and USE WHEN',
      priority: 'P2',
      effort: 'S',
      impact: 'MEDIUM',
      dimension: 'implementationQuality',
    });
  }

  // Description
  if (!hasDescription) {
    score += SCORING.implementation.missingDescription; // -1
    findings.push({
      description: 'SKILL.md frontmatter is missing "description:" field',
      location: 'SKILL.md',
      severity: 'MEDIUM',
    });
    recommendations.push({
      action: 'Add "description:" field to YAML frontmatter with a concise USE WHEN statement',
      priority: 'P2',
      effort: 'S',
      impact: 'MEDIUM',
      dimension: 'implementationQuality',
    });
  }

  // USE WHEN triggers
  if (!hasUseWhenTriggers) {
    score += SCORING.implementation.missingTriggers; // -1
    findings.push({
      description: 'SKILL.md lacks "USE WHEN" trigger section — AI cannot auto-route to this skill',
      location: 'SKILL.md',
      severity: 'HIGH',
    });
    recommendations.push({
      action: 'Add "USE WHEN" clause to description field with specific invocation triggers',
      priority: 'P1',
      effort: 'S',
      impact: 'HIGH',
      dimension: 'implementationQuality',
    });
  }

  // Customization section
  if (!hasCustomization) {
    score += SCORING.implementation.missingCustomization; // -0.5
    findings.push({
      description: 'SKILL.md is missing "## Customization" section',
      location: 'SKILL.md',
      severity: 'LOW',
    });
    recommendations.push({
      action: 'Add "## Customization" section documenting configurable parameters',
      priority: 'P3',
      effort: 'S',
      impact: 'LOW',
      dimension: 'implementationQuality',
    });
  }

  // Voice Notification
  if (!hasVoiceNotification) {
    score += SCORING.implementation.missingVoiceNotification; // -0.5
    findings.push({
      description: 'SKILL.md does not document Voice Notification pattern',
      location: 'SKILL.md',
      severity: 'LOW',
    });
    recommendations.push({
      action: 'Add Voice Notification section showing curl localhost:8888 usage',
      priority: 'P3',
      effort: 'S',
      impact: 'LOW',
      dimension: 'implementationQuality',
    });
  }

  // Workflow routing table
  if (!hasWorkflowTable) {
    score += SCORING.implementation.missingWorkflowTable; // -0.5
    findings.push({
      description: 'SKILL.md is missing a workflow routing table (| Workflow | Trigger | ...)',
      location: 'SKILL.md',
      severity: 'LOW',
    });
    recommendations.push({
      action: 'Add a markdown table mapping trigger keywords to workflow files',
      priority: 'P3',
      effort: 'S',
      impact: 'MEDIUM',
      dimension: 'implementationQuality',
    });
  }

  // Examples
  if (!hasExamples) {
    score += SCORING.implementation.missingExamples; // -1
    findings.push({
      description: 'SKILL.md has no examples section',
      location: 'SKILL.md',
      severity: 'MEDIUM',
    });
    recommendations.push({
      action: 'Add "## Examples" section with at least 2 concrete usage examples',
      priority: 'P2',
      effort: 'S',
      impact: 'MEDIUM',
      dimension: 'implementationQuality',
    });
  } else if (exampleCount < 2) {
    score += SCORING.implementation.fewExamples; // -0.5
    findings.push({
      description: `Only ${exampleCount} example(s) found — recommend at least 2`,
      location: 'SKILL.md',
      severity: 'LOW',
    });
    recommendations.push({
      action: 'Expand examples section to include at least 2 distinct usage scenarios',
      priority: 'P3',
      effort: 'S',
      impact: 'LOW',
      dimension: 'implementationQuality',
    });
  }

  // Flat structure (depth ≤2)
  if (!isFlatStructure) {
    score += SCORING.implementation.excessiveDepth; // -1
    findings.push({
      description: `Folder depth ${depth} exceeds maximum of 2 — nested structure adds navigation overhead`,
      location: skillPath,
      severity: 'MEDIUM',
    });
    recommendations.push({
      action: `Flatten directory structure to ≤2 levels deep (current depth: ${depth})`,
      priority: 'P2',
      effort: 'M',
      impact: 'LOW',
      dimension: 'implementationQuality',
    });
  }

  // No workflows despite substantial content
  if (workflowCount === 0 && lineCount > 50) {
    score += SCORING.implementation.noWorkflowsWithContent; // -0.5
    findings.push({
      description: `${lineCount} lines in SKILL.md but no Workflows/ files — behaviour is undocumented`,
      severity: 'LOW',
    });
    recommendations.push({
      action: 'Extract skill behaviours into Workflows/ markdown files',
      priority: 'P3',
      effort: 'M',
      impact: 'MEDIUM',
      dimension: 'implementationQuality',
    });
  }

  const dimensionResult = buildDimensionResult(score, findings, recommendations);

  return {
    skillName,
    score: dimensionResult.score,
    dimensionResult,
    structure: {
      hasTitleCase: isTitleCase(skillName),
      hasSkillMd,
      hasFrontmatter,
      hasDescription,
      hasUseWhenTriggers,
      hasCustomization,
      hasVoiceNotification,
      hasWorkflowTable,
      hasExamples,
      exampleCount,
      isFlatStructure,
      depth,
      workflowCount,
      toolCount,
    },
  };
}

// ============================================================================
// Report Printing
// ============================================================================

function printReport(result: StructuralResult): void {
  console.log(`# Structural Score: ${result.skillName}\n`);
  console.log(`**Dimension 2 — Implementation Quality**`);
  console.log(`**Score:** ${result.score}/10 | **Health:** ${result.dimensionResult.health}\n`);

  if (result.dimensionResult.findings.length > 0) {
    console.log('## Findings\n');
    console.log('| Severity | Description |');
    console.log('|----------|-------------|');
    for (const f of result.dimensionResult.findings) {
      const loc = f.location ? ` (${f.location})` : '';
      console.log(`| ${f.severity} | ${f.description}${loc} |`);
    }
    console.log('');
  }

  console.log('## Structure Checklist\n');
  console.log('| Check | Status |');
  console.log('|-------|--------|');
  const s = result.structure;
  console.log(`| TitleCase naming | ${s.hasTitleCase ? 'PASS' : 'FAIL'} |`);
  console.log(`| SKILL.md exists | ${s.hasSkillMd ? 'PASS' : 'FAIL'} |`);
  console.log(`| YAML frontmatter | ${s.hasFrontmatter ? 'PASS' : 'FAIL'} |`);
  console.log(`| description: field | ${s.hasDescription ? 'PASS' : 'FAIL'} |`);
  console.log(`| USE WHEN triggers | ${s.hasUseWhenTriggers ? 'PASS' : 'FAIL'} |`);
  console.log(`| Customization section | ${s.hasCustomization ? 'PASS' : 'FAIL'} |`);
  console.log(`| Voice Notification | ${s.hasVoiceNotification ? 'PASS' : 'FAIL'} |`);
  console.log(`| Workflow routing table | ${s.hasWorkflowTable ? 'PASS' : 'FAIL'} |`);
  console.log(`| Examples (≥2) | ${s.hasExamples ? (s.exampleCount >= 2 ? 'PASS' : `WARN (${s.exampleCount})`) : 'FAIL'} |`);
  console.log(`| Flat structure (depth ≤2) | ${s.isFlatStructure ? 'PASS' : `FAIL (depth: ${s.depth})`} |`);
  console.log(`| Workflows present | ${s.workflowCount > 0 ? `PASS (${s.workflowCount})` : 'NONE'} |`);
  console.log(`| Tools present | ${s.toolCount > 0 ? `YES (${s.toolCount})` : 'none (optional)'} |`);
  console.log('');

  if (result.dimensionResult.recommendations.length > 0) {
    console.log('## Recommendations\n');
    for (let i = 0; i < result.dimensionResult.recommendations.length; i++) {
      const r = result.dimensionResult.recommendations[i];
      console.log(`${i + 1}. [${r.priority}] ${r.action}`);
    }
    console.log('');
  }
}

// ============================================================================
// CLI Entry Point
// ============================================================================

if (import.meta.main) {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.log('Usage: bun run StructuralScorer.ts <skill-name>');
    console.log('       bun run StructuralScorer.ts Browser');
    console.log('       bun run StructuralScorer.ts Browser --json');
    console.log('       bun run StructuralScorer.ts --all');
    process.exit(1);
  }

  const jsonOutput = args.includes('--json');
  const filteredArgs = args.filter(a => !a.startsWith('--'));

  if (args.includes('--all')) {
    const skillDirs = getSkillDirectories();
    console.log('# All Skills — Implementation Quality Scores\n');
    console.log('| Skill | Score | Health | Issues |');
    console.log('|-------|-------|--------|--------|');

    for (const skillName of skillDirs) {
      const result = scoreStructure(skillName);
      if (result) {
        const issueCount = result.dimensionResult.findings.length;
        console.log(
          `| ${skillName} | ${result.score}/10 | ${result.dimensionResult.health} | ${issueCount} |`
        );
      }
    }
  } else {
    const skillName = filteredArgs[0];
    const result = scoreStructure(skillName);

    if (!result) {
      console.error(`Skill not found: ${skillName}`);
      process.exit(1);
    }

    if (jsonOutput) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      printReport(result);
    }
  }
}
