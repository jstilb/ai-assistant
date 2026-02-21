#!/usr/bin/env bun
/**
 * SkillScorer - Calculate dimension scores for a skill
 *
 * Performs automated checks and generates a preliminary
 * score report for manual review.
 *
 * Usage:
 *   bun run SkillScorer.ts <skill-name>
 *   bun run SkillScorer.ts Browser
 *   bun run SkillScorer.ts --all
 */

import { readFileSync, readdirSync, existsSync, statSync } from 'fs';
import { join, basename } from 'path';
import { SKILLS_DIR, SCORING } from './constants';
import {
  getSkillDirectories,
  getSkillPath,
  getSkillFiles,
  safeReadFile,
  isTitleCase,
  countLines,
  countWords,
  extractTriggers,
} from './utils';
import { runBehaviorEvals } from './BehaviorGapAnalyzer';

interface SkillAnalysis {
  name: string;
  path: string;
  structure: StructureAnalysis;
  content: ContentAnalysis;
  metrics: MetricAnalysis;
  scores: DimensionScores;
}

interface StructureAnalysis {
  hasTitleCase: boolean;
  hasSkillMd: boolean;
  hasFrontmatter: boolean;
  hasCustomizationSection: boolean;
  hasVoiceNotification: boolean;
  isFlatStructure: boolean;
  hasWorkflowsDir: boolean;
  hasToolsDir: boolean;
  depth: number;
}

interface ContentAnalysis {
  hasDescription: boolean;
  hasUseWhenTriggers: boolean;
  hasWorkflowTable: boolean;
  hasExamples: boolean;
  exampleCount: number;
  hasQuickReference: boolean;
  hasIntegrationSection: boolean;
}

interface MetricAnalysis {
  lineCount: number;
  workflowCount: number;
  toolCount: number;
  wordCount: number;
  triggerCount: number;
}

interface EvalMetrics {
  evalCoverage: number;  // % of workflows with evals (0-100)
  evalPassRate: number;  // % of evals passing (0-100)
  evalCount: number;     // Total number of evals
  lastRun?: string;      // ISO timestamp of last eval run
}

interface DimensionScores {
  implementation: number;
  implementationNotes: string[];
  evalMetrics?: EvalMetrics;  // Optional eval results if available
}

function analyzeStructure(skillPath: string, skillName: string): StructureAnalysis {
  const skillMdPath = join(skillPath, 'SKILL.md');
  const hasSkillMd = existsSync(skillMdPath);

  let hasFrontmatter = false;
  let hasCustomizationSection = false;
  let hasVoiceNotification = false;

  if (hasSkillMd) {
    const content = safeReadFile(skillMdPath) || '';
    hasFrontmatter = content.startsWith('---');
    hasCustomizationSection = content.includes('## Customization');
    hasVoiceNotification = content.includes('Voice Notification') || content.includes('curl.*localhost:8888');
  }

  // Check folder depth
  let maxDepth = 0;
  function checkDepth(dir: string, currentDepth: number): void {
    if (currentDepth > maxDepth) maxDepth = currentDepth;
    if (currentDepth > 3) return; // Don't go too deep

    try {
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory() && !entry.name.startsWith('.')) {
          checkDepth(join(dir, entry.name), currentDepth + 1);
        }
      }
    } catch {
      // Ignore errors
    }
  }
  checkDepth(skillPath, 0);

  return {
    hasTitleCase: isTitleCase(skillName),
    hasSkillMd,
    hasFrontmatter,
    hasCustomizationSection,
    hasVoiceNotification,
    isFlatStructure: maxDepth <= 2,
    hasWorkflowsDir: existsSync(join(skillPath, 'Workflows')),
    hasToolsDir: existsSync(join(skillPath, 'Tools')),
    depth: maxDepth,
  };
}

function analyzeContent(skillPath: string): ContentAnalysis {
  const skillMdPath = join(skillPath, 'SKILL.md');
  const content = safeReadFile(skillMdPath);

  if (!content) {
    return {
      hasDescription: false,
      hasUseWhenTriggers: false,
      hasWorkflowTable: false,
      hasExamples: false,
      exampleCount: 0,
      hasQuickReference: false,
      hasIntegrationSection: false,
    };
  }

  // Count examples
  const exampleMatches = content.match(/\*\*Example \d+/gi) || [];
  const exampleCount = exampleMatches.length;

  return {
    hasDescription: content.includes('description:'),
    hasUseWhenTriggers: content.toLowerCase().includes('use when'),
    hasWorkflowTable: content.includes('| Workflow') || content.includes('| Trigger'),
    hasExamples: exampleCount > 0 || content.includes('## Examples'),
    exampleCount,
    hasQuickReference: content.includes('Quick Reference') || content.includes('Quick Start'),
    hasIntegrationSection: content.includes('## Integration'),
  };
}

function analyzeMetrics(skillPath: string): MetricAnalysis {
  const skillMdPath = join(skillPath, 'SKILL.md');
  const content = safeReadFile(skillMdPath);

  let lineCount = 0;
  let wordCount = 0;
  let triggerCount = 0;

  if (content) {
    lineCount = countLines(content);
    wordCount = countWords(content);
    triggerCount = extractTriggers(content).length;
  }

  // Count workflows using utility function
  const skillName = basename(skillPath);
  const files = getSkillFiles(skillName);

  return {
    lineCount,
    workflowCount: files.workflows.length,
    toolCount: files.tools.length,
    wordCount,
    triggerCount,
  };
}

function calculateImplementationScore(structure: StructureAnalysis, content: ContentAnalysis, metrics: MetricAnalysis): DimensionScores {
  let score = 10;
  const notes: string[] = [];

  // Structure checks
  if (!structure.hasTitleCase) {
    score += SCORING.implementation.missingTitleCase;
    notes.push('Missing TitleCase naming');
  }
  if (!structure.hasSkillMd) {
    score += SCORING.implementation.missingSkillMd;
    notes.push('Missing SKILL.md');
  }
  if (!structure.hasFrontmatter) {
    score += SCORING.implementation.missingFrontmatter;
    notes.push('Missing YAML frontmatter');
  }
  if (!structure.hasCustomizationSection) {
    score += SCORING.implementation.missingCustomization;
    notes.push('Missing Customization section');
  }
  if (!structure.hasVoiceNotification) {
    score += SCORING.implementation.missingVoiceNotification;
    notes.push('Missing Voice Notification pattern');
  }
  if (!structure.isFlatStructure) {
    score += SCORING.implementation.excessiveDepth;
    notes.push(`Folder depth ${structure.depth} exceeds max 2`);
  }

  // Content checks
  if (!content.hasDescription) {
    score += SCORING.implementation.missingDescription;
    notes.push('Missing description');
  }
  if (!content.hasUseWhenTriggers) {
    score += SCORING.implementation.missingTriggers;
    notes.push('Missing USE WHEN triggers');
  }
  if (!content.hasWorkflowTable) {
    score += SCORING.implementation.missingWorkflowTable;
    notes.push('Missing workflow routing table');
  }
  if (!content.hasExamples) {
    score += SCORING.implementation.missingExamples;
    notes.push('Missing examples section');
  } else if (content.exampleCount < 2) {
    score += SCORING.implementation.fewExamples;
    notes.push(`Only ${content.exampleCount} example(s), recommend 2+`);
  }

  // Metrics checks
  if (metrics.workflowCount === 0 && metrics.lineCount > 50) {
    score += SCORING.implementation.noWorkflowsWithContent;
    notes.push('No workflows despite substantial content');
  }

  return {
    implementation: Math.max(1, Math.round(score * 10) / 10),
    implementationNotes: notes,
  };
}

/**
 * Fetch eval metrics for a skill (if evals have been run)
 */
async function fetchEvalMetrics(skillName: string, workflowCount: number): Promise<EvalMetrics | undefined> {
  try {
    const evalResults = await runBehaviorEvals(skillName);
    if (!evalResults) return undefined;

    // Calculate coverage: what % of workflows have associated evals?
    // For now, we consider having ANY evals as covering the skill
    const evalCoverage = workflowCount > 0 && evalResults.results.length > 0
      ? Math.min(100, (evalResults.results.length / workflowCount) * 100)
      : 0;

    return {
      evalCoverage: Math.round(evalCoverage),
      evalPassRate: Math.round(evalResults.passRate * 100),
      evalCount: evalResults.results.length,
      lastRun: new Date().toISOString(),
    };
  } catch {
    // Evals not available or failed - that's OK, metrics are optional
    return undefined;
  }
}

function analyzeSkill(skillName: string): SkillAnalysis | null {
  const skillPath = getSkillPath(skillName);

  if (!existsSync(skillPath)) {
    console.error(`Skill not found: ${skillName}`);
    return null;
  }

  const structure = analyzeStructure(skillPath, skillName);
  const content = analyzeContent(skillPath);
  const metrics = analyzeMetrics(skillPath);
  const scores = calculateImplementationScore(structure, content, metrics);

  return {
    name: skillName,
    path: skillPath,
    structure,
    content,
    metrics,
    scores,
  };
}

/**
 * Analyze skill with optional eval metrics (async version)
 */
async function analyzeSkillWithEvals(skillName: string, runEvals: boolean = false): Promise<SkillAnalysis | null> {
  const skillPath = getSkillPath(skillName);

  if (!existsSync(skillPath)) {
    console.error(`Skill not found: ${skillName}`);
    return null;
  }

  const structure = analyzeStructure(skillPath, skillName);
  const content = analyzeContent(skillPath);
  const metrics = analyzeMetrics(skillPath);
  const scores = calculateImplementationScore(structure, content, metrics);

  // Optionally run evals and add metrics
  if (runEvals) {
    scores.evalMetrics = await fetchEvalMetrics(skillName, metrics.workflowCount);
  }

  return {
    name: skillName,
    path: skillPath,
    structure,
    content,
    metrics,
    scores,
  };
}

function printReport(analysis: SkillAnalysis): void {
  console.log(`# Skill Analysis: ${analysis.name}\n`);
  console.log(`Path: ${analysis.path}`);
  console.log(`Generated: ${new Date().toISOString()}\n`);

  console.log('## Automated Scores\n');
  console.log(`**Implementation:** ${analysis.scores.implementation}/10\n`);

  if (analysis.scores.implementationNotes.length > 0) {
    console.log('**Issues found:**');
    for (const note of analysis.scores.implementationNotes) {
      console.log(`- ${note}`);
    }
    console.log('');
  }

  console.log('## Structure Analysis\n');
  console.log('| Check | Status |');
  console.log('|-------|--------|');
  console.log(`| TitleCase naming | ${analysis.structure.hasTitleCase ? '✓' : '✗'} |`);
  console.log(`| SKILL.md exists | ${analysis.structure.hasSkillMd ? '✓' : '✗'} |`);
  console.log(`| YAML frontmatter | ${analysis.structure.hasFrontmatter ? '✓' : '✗'} |`);
  console.log(`| Customization section | ${analysis.structure.hasCustomizationSection ? '✓' : '✗'} |`);
  console.log(`| Voice notification | ${analysis.structure.hasVoiceNotification ? '✓' : '✗'} |`);
  console.log(`| Flat structure (≤2) | ${analysis.structure.isFlatStructure ? '✓' : '✗'} (depth: ${analysis.structure.depth}) |`);
  console.log(`| Workflows/ dir | ${analysis.structure.hasWorkflowsDir ? '✓' : '✗'} |`);
  console.log(`| Tools/ dir | ${analysis.structure.hasToolsDir ? '✓' : '○ (optional)'} |`);
  console.log('');

  console.log('## Content Analysis\n');
  console.log('| Check | Status |');
  console.log('|-------|--------|');
  console.log(`| Description | ${analysis.content.hasDescription ? '✓' : '✗'} |`);
  console.log(`| USE WHEN triggers | ${analysis.content.hasUseWhenTriggers ? '✓' : '✗'} |`);
  console.log(`| Workflow table | ${analysis.content.hasWorkflowTable ? '✓' : '✗'} |`);
  console.log(`| Examples section | ${analysis.content.hasExamples ? '✓' : '✗'} (${analysis.content.exampleCount} found) |`);
  console.log(`| Quick reference | ${analysis.content.hasQuickReference ? '✓' : '○'} |`);
  console.log(`| Integration section | ${analysis.content.hasIntegrationSection ? '✓' : '○'} |`);
  console.log('');

  console.log('## Metrics\n');
  console.log(`- **Lines in SKILL.md:** ${analysis.metrics.lineCount}`);
  console.log(`- **Word count:** ${analysis.metrics.wordCount}`);
  console.log(`- **Workflows:** ${analysis.metrics.workflowCount}`);
  console.log(`- **Tools:** ${analysis.metrics.toolCount}`);
  console.log(`- **Trigger keywords:** ~${analysis.metrics.triggerCount}`);
  console.log('');

  // Eval metrics section (if available)
  if (analysis.scores.evalMetrics) {
    const em = analysis.scores.evalMetrics;
    console.log('## Eval Metrics\n');
    console.log(`- **Eval Coverage:** ${em.evalCoverage}%`);
    console.log(`- **Eval Pass Rate:** ${em.evalPassRate}%`);
    console.log(`- **Total Evals:** ${em.evalCount}`);
    if (em.lastRun) {
      console.log(`- **Last Run:** ${em.lastRun}`);
    }
    console.log('');

    // Eval-based recommendations
    if (em.evalCoverage < 50) {
      console.log('⚠️  Low eval coverage - consider adding more behavioral tests');
    }
    if (em.evalPassRate < 75) {
      console.log('⚠️  Low pass rate - skill may have implementation issues');
    }
    console.log('');
  }

  console.log('## Manual Review Required\n');
  console.log('The following dimensions require human judgment:\n');
  console.log('- **Utility:** Is this skill valuable? How often used?');
  console.log('- **Integration:** How well connected to other skills?');
  console.log('- **Abstraction:** Is scope appropriate (not too broad/narrow)?');
  console.log('- **Potential:** What could this skill become?');
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.log('Usage: bun run SkillScorer.ts <skill-name>');
    console.log('       bun run SkillScorer.ts Browser');
    console.log('       bun run SkillScorer.ts Browser --with-evals');
    console.log('       bun run SkillScorer.ts --all');
    console.log('       bun run SkillScorer.ts --all --with-evals');
    process.exit(1);
  }

  const withEvals = args.includes('--with-evals');
  const filteredArgs = args.filter(a => a !== '--with-evals');

  if (filteredArgs[0] === '--all') {
    // Score all skills using utility function
    const skillDirs = getSkillDirectories();

    console.log('# All Skills Implementation Scores\n');
    if (withEvals) {
      console.log('| Skill | Score | Issues | Eval Coverage | Eval Pass Rate |');
      console.log('|-------|-------|--------|---------------|----------------|');
    } else {
      console.log('| Skill | Score | Issues |');
      console.log('|-------|-------|--------|');
    }

    for (const skillName of skillDirs) {
      const analysis = withEvals
        ? await analyzeSkillWithEvals(skillName, true)
        : analyzeSkill(skillName);
      if (analysis) {
        const issues = analysis.scores.implementationNotes.length;
        if (withEvals && analysis.scores.evalMetrics) {
          const em = analysis.scores.evalMetrics;
          console.log(`| ${skillName} | ${analysis.scores.implementation}/10 | ${issues} | ${em.evalCoverage}% | ${em.evalPassRate}% |`);
        } else {
          console.log(`| ${skillName} | ${analysis.scores.implementation}/10 | ${issues} |${withEvals ? ' N/A | N/A |' : ''}`);
        }
      }
    }
  } else {
    const skillName = filteredArgs[0];
    const analysis = withEvals
      ? await analyzeSkillWithEvals(skillName, true)
      : analyzeSkill(skillName);
    if (analysis) {
      printReport(analysis);
    }
  }
}

main().catch(console.error);
