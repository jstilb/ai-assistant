#!/usr/bin/env bun
/**
 * BehaviorVerifier - Score Dimension 1: Behavioral Fidelity
 *
 * Deep expected-vs-actual-vs-ideal comparison. Detects gaps between what
 * SKILL.md documents and what the Workflows/ + Tools/ actually implement.
 * Produces the three-column gap table and a DimensionResult for v2 reports.
 *
 * Usage:
 *   bun run BehaviorVerifier.ts <skill-name>
 *   bun run BehaviorVerifier.ts Browser
 *   bun run BehaviorVerifier.ts Browser --json
 */

import { basename, join } from 'path';
import { existsSync, readdirSync } from 'fs';
import { homedir } from 'os';
import { SCORING } from './constants';
import {
  getSkillPath,
  getSkillFiles,
  safeReadFile,
  skillExists,
  extractWorkflowTriggers,
} from './utils';
import type { Finding, Recommendation, DimensionResult } from './report-builder';
import { buildDimensionResult } from './report-builder';

// ============================================================================
// Types
// ============================================================================

export interface BehaviorGap {
  aspect: string;
  expected: string;
  actual: string;
  ideal: string;
  gapLevel: 'HIGH' | 'MEDIUM' | 'LOW';
  recommendation: string;
}

export interface ExpectedBehavior {
  purpose: string;
  triggers: string[];
  workflows: WorkflowExpectation[];
  integrations: string[];
  examples: string[];
}

export interface WorkflowExpectation {
  name: string;
  purpose: string;
}

export interface ActualBehavior {
  hasSkillMd: boolean;
  workflowsImplemented: string[];
  toolsImplemented: string[];
  triggersActive: string[];
  integrationsActive: string[];
}

export interface BehaviorResult {
  skillName: string;
  score: number;
  dimensionResult: DimensionResult;
  gaps: BehaviorGap[];
}

// ============================================================================
// Extraction Functions
// ============================================================================

/**
 * Extract documented (expected) behavior from SKILL.md.
 */
export function extractExpected(skillName: string): ExpectedBehavior {
  const files = getSkillFiles(skillName);
  const content = files.skillMd ? (safeReadFile(files.skillMd) ?? '') : '';

  const result: ExpectedBehavior = {
    purpose: '',
    triggers: [],
    workflows: [],
    integrations: [],
    examples: [],
  };

  if (!content) return result;

  // Purpose: prefer description field, fall back to first paragraph after heading
  const descMatch = content.match(/description:\s*(.+?)(?:\n|$)/i);
  if (descMatch) {
    result.purpose = descMatch[1].trim();
  } else {
    const firstPara = content.match(/^#[^#].+?\n+([^#\n][^\n]+)/m);
    if (firstPara) {
      result.purpose = firstPara[1].trim();
    }
  }

  // USE WHEN triggers
  const useWhenMatch = content.match(/USE WHEN\s+(.+?)(?:\.|$)/i);
  if (useWhenMatch) {
    result.triggers = useWhenMatch[1]
      .split(/,\s*|\s+OR\s+/i)
      .map(t => t.trim().toLowerCase())
      .filter(Boolean);
  }

  // Workflow expectations from routing table
  const tableMatch = content.match(/\|[^|]*(Workflow|Trigger|Command|Route)[^|]*\|[\s\S]*?(?=\n\n|\n##|\n---|\Z)/i);
  if (tableMatch) {
    const rows = tableMatch[0]
      .split('\n')
      .filter(r => r.includes('|') && !r.includes('---'));
    for (const row of rows.slice(1)) {
      const cells = row.split('|').map(c => c.trim()).filter(Boolean);
      if (cells.length >= 2) {
        const name = cells[0].replace(/\*\*/g, '');
        const purpose = cells.length >= 3 ? cells[2] : cells[1];
        result.workflows.push({ name, purpose });
      }
    }
  }

  // Integrations from "### Uses" section
  const usesMatch = content.match(/###?\s*Uses\s*\n([\s\S]*?)(?=\n###?|\n---|\n##|$)/i);
  if (usesMatch) {
    const skillRefs = usesMatch[1].match(/\*\*([A-Za-z]+)\*\*/g);
    if (skillRefs) {
      result.integrations.push(...skillRefs.map(ref => ref.replace(/\*\*/g, '')));
    }
  }

  // Examples
  const exampleMatches = content.match(/\*\*Example \d+[^*]*\*\*[^*]*/gi);
  if (exampleMatches) {
    result.examples = exampleMatches.map(e => e.trim());
  }

  return result;
}

/**
 * Extract implemented (actual) behavior from Workflows/ and Tools/ directories.
 */
export function extractActual(skillName: string): ActualBehavior {
  const files = getSkillFiles(skillName);

  const result: ActualBehavior = {
    hasSkillMd: files.skillMd !== null,
    workflowsImplemented: files.workflows.map(f => basename(f, '.md')),
    toolsImplemented: files.tools.map(f => basename(f, '.ts')),
    triggersActive: [],
    integrationsActive: [],
  };

  // Collect active triggers from workflow files
  for (const workflowPath of files.workflows) {
    const content = safeReadFile(workflowPath);
    if (content) {
      const triggers = extractWorkflowTriggers(content);
      result.triggersActive.push(...triggers.map(t => t.toLowerCase()));
    }
  }

  // Collect active integrations from tool imports
  for (const toolPath of files.tools) {
    const content = safeReadFile(toolPath);
    if (content) {
      const skillImports = content.match(/from\s+['"].*skills\/([A-Za-z]+)/gi);
      if (skillImports) {
        for (const imp of skillImports) {
          const match = imp.match(/skills\/([A-Za-z]+)/);
          if (match && match[1] !== skillName) {
            result.integrationsActive.push(match[1]);
          }
        }
      }
    }
  }

  return result;
}

// ============================================================================
// Gap Detection
// ============================================================================

function detectGaps(
  expected: ExpectedBehavior,
  actual: ActualBehavior,
  skillName: string,
): BehaviorGap[] {
  const gaps: BehaviorGap[] = [];

  // Gap 1: Purpose clarity
  if (!expected.purpose) {
    gaps.push({
      aspect: 'Purpose',
      expected: 'Clear description of what the skill does',
      actual: 'No description found in SKILL.md',
      ideal: 'Concise purpose statement with USE WHEN triggers in frontmatter',
      gapLevel: 'HIGH',
      recommendation: 'Add description with USE WHEN triggers to SKILL.md frontmatter',
    });
  }

  // Gap 2: Workflow implementation coverage
  const expectedNames = expected.workflows.map(w => w.name);
  const missingWorkflows = expectedNames.filter(
    name =>
      !actual.workflowsImplemented.some(
        impl =>
          impl.toLowerCase() === name.toLowerCase() ||
          impl.toLowerCase().includes(name.toLowerCase())
      )
  );

  if (missingWorkflows.length > 0) {
    gaps.push({
      aspect: 'Workflow Implementation',
      expected: `${expectedNames.length} workflow(s) documented: ${expectedNames.join(', ')}`,
      actual: `${actual.workflowsImplemented.length} workflow(s) implemented: ${
        actual.workflowsImplemented.length > 0
          ? actual.workflowsImplemented.join(', ')
          : 'none'
      }`,
      ideal: 'Every documented workflow has a corresponding Workflows/*.md file',
      gapLevel: missingWorkflows.length > 2 ? 'HIGH' : 'MEDIUM',
      recommendation: `Create missing workflow file(s): ${missingWorkflows.join(', ')}`,
    });
  }

  // Gap 3: Trigger coverage
  if (expected.triggers.length > 0 && actual.triggersActive.length === 0) {
    gaps.push({
      aspect: 'Trigger Coverage',
      expected: `Triggers documented: ${expected.triggers.slice(0, 5).join(', ')}`,
      actual: 'No trigger phrases found in Workflows/ files',
      ideal: 'Each workflow has a "## Trigger" section with specific invocation phrases',
      gapLevel: 'MEDIUM',
      recommendation:
        'Add "## Trigger" sections to each workflow file listing specific invocation phrases',
    });
  }

  // Gap 4: Integration implementation
  const expectedIntegrations = new Set(expected.integrations);
  const actualIntegrations = new Set(actual.integrationsActive);
  const missingIntegrations = [...expectedIntegrations].filter(
    i => !actualIntegrations.has(i)
  );

  if (missingIntegrations.length > 0) {
    gaps.push({
      aspect: 'Integration Implementation',
      expected: `Integrations documented: ${expected.integrations.join(', ')}`,
      actual: `Integrations active in code: ${
        actual.integrationsActive.length > 0 ? actual.integrationsActive.join(', ') : 'none'
      }`,
      ideal: 'All documented integrations have code-level imports and usage',
      gapLevel: missingIntegrations.length > 1 ? 'MEDIUM' : 'LOW',
      recommendation: `Implement code-level integration with: ${missingIntegrations.join(', ')}`,
    });
  }

  // Gap 5: Example support
  if (expected.examples.length >= 2 && actual.workflowsImplemented.length === 0) {
    gaps.push({
      aspect: 'Example Support',
      expected: `${expected.examples.length} examples documented`,
      actual: 'No workflow implementations to back the examples',
      ideal: 'Every example scenario has a corresponding workflow file implementation',
      gapLevel: 'HIGH',
      recommendation:
        'Create Workflows/ files that implement the scenarios described in examples',
    });
  }

  // Gap 6: Simulation coverage
  const simScenariosDir = join(homedir(), '.claude', 'skills', 'Simulation', 'Scenarios');
  const hasSimScenarios = existsSync(simScenariosDir) && (() => {
    try {
      const files = readdirSync(simScenariosDir);
      return files.some(f => f.toLowerCase().includes(skillName.toLowerCase()));
    } catch { return false; }
  })();

  if (!hasSimScenarios && actual.toolsImplemented.length > 0) {
    gaps.push({
      aspect: 'Simulation Coverage',
      expected: 'At least one chaos scenario defined for skills with tools',
      actual: 'No simulation scenarios found',
      ideal: 'Resilience scenarios in Simulation/Scenarios/ test fault tolerance',
      gapLevel: 'LOW',
      recommendation: 'Create a resilience scenario in skills/System/Simulation/Scenarios/',
    });
  }

  // Gap 7: Tool support for complex skills
  if (actual.workflowsImplemented.length > 3 && actual.toolsImplemented.length === 0) {
    gaps.push({
      aspect: 'Tool Support',
      expected: 'Complex skill (>3 workflows) should have reusable supporting tools',
      actual: 'No tools implemented despite multiple workflows',
      ideal: 'Common logic extracted into Tools/ for composition across workflows',
      gapLevel: 'LOW',
      recommendation: 'Consider extracting shared logic into reusable Tools/*.ts files',
    });
  }

  return gaps;
}

// ============================================================================
// Core Public Function
// ============================================================================

/**
 * Verify behavioral fidelity for a skill.
 * Returns null if the skill directory does not exist.
 */
export function verifyBehavior(skillName: string): BehaviorResult | null {
  if (!skillExists(skillName)) {
    return null;
  }

  const expected = extractExpected(skillName);
  const actual = extractActual(skillName);
  const gaps = detectGaps(expected, actual, skillName);

  // Translate gaps into findings + recommendations for DimensionResult
  const findings: Finding[] = [];
  const recommendations: Recommendation[] = [];
  let score = 10;

  for (const gap of gaps) {
    // Score deduction
    if (gap.gapLevel === 'HIGH') {
      score += SCORING.behavioralFidelity.highGap; // -2
    } else if (gap.gapLevel === 'MEDIUM') {
      score += SCORING.behavioralFidelity.mediumGap; // -1
    } else {
      score += SCORING.behavioralFidelity.lowGap; // -0.5
    }

    // Severity mapping: HIGH gap → HIGH severity, etc.
    const severityMap = {
      HIGH: 'HIGH',
      MEDIUM: 'MEDIUM',
      LOW: 'LOW',
    } as const;

    findings.push({
      description: `[${gap.aspect}] Expected: ${gap.expected} | Actual: ${gap.actual}`,
      severity: severityMap[gap.gapLevel],
    });

    const priorityMap = {
      HIGH: 'P1',
      MEDIUM: 'P2',
      LOW: 'P3',
    } as const;

    const effortMap = {
      HIGH: 'M',
      MEDIUM: 'M',
      LOW: 'S',
    } as const;

    const impactMap = {
      HIGH: 'HIGH',
      MEDIUM: 'MEDIUM',
      LOW: 'LOW',
    } as const;

    recommendations.push({
      action: gap.recommendation,
      priority: priorityMap[gap.gapLevel],
      effort: effortMap[gap.gapLevel],
      impact: impactMap[gap.gapLevel],
      dimension: 'behavioralFidelity',
    });
  }

  const dimensionResult = buildDimensionResult(score, findings, recommendations);

  return {
    skillName,
    score: dimensionResult.score,
    dimensionResult,
    gaps,
  };
}

// ============================================================================
// Report Printing
// ============================================================================

function printReport(result: BehaviorResult): void {
  const highGaps = result.gaps.filter(g => g.gapLevel === 'HIGH');
  const mediumGaps = result.gaps.filter(g => g.gapLevel === 'MEDIUM');
  const lowGaps = result.gaps.filter(g => g.gapLevel === 'LOW');

  console.log(`# Behavior Verification: ${result.skillName}\n`);
  console.log('**Dimension 1 — Behavioral Fidelity**');
  console.log(`**Score:** ${result.score}/10 | **Health:** ${result.dimensionResult.health}\n`);

  console.log('## Summary\n');
  console.log(`- Total Gaps: ${result.gaps.length}`);
  console.log(`- HIGH: ${highGaps.length}`);
  console.log(`- MEDIUM: ${mediumGaps.length}`);
  console.log(`- LOW: ${lowGaps.length}`);
  console.log('');

  if (result.gaps.length === 0) {
    console.log('No behavioral gaps found between documentation and implementation.\n');
    return;
  }

  console.log('## Gap Analysis\n');

  const printGapGroup = (label: string, gapList: BehaviorGap[]): void => {
    if (gapList.length === 0) return;
    console.log(`### ${label}\n`);
    console.log('| Aspect | Expected | Actual | Ideal |');
    console.log('|--------|----------|--------|-------|');
    for (const gap of gapList) {
      console.log(`| ${gap.aspect} | ${gap.expected} | ${gap.actual} | ${gap.ideal} |`);
    }
    console.log('');
    console.log('**Recommendations:**');
    for (const gap of gapList) {
      console.log(`- [${gap.gapLevel}] ${gap.recommendation}`);
    }
    console.log('');
  };

  printGapGroup('HIGH Priority Gaps', highGaps);
  printGapGroup('MEDIUM Priority Gaps', mediumGaps);
  printGapGroup('LOW Priority Gaps', lowGaps);

  if (result.dimensionResult.recommendations.length > 0) {
    console.log('## Action Plan\n');
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
  const jsonOutput = args.includes('--json');
  const skillName = args.find(a => !a.startsWith('--'));

  if (!skillName) {
    console.log('Usage: bun run BehaviorVerifier.ts <skill-name>');
    console.log('       bun run BehaviorVerifier.ts Browser');
    console.log('       bun run BehaviorVerifier.ts Browser --json');
    process.exit(1);
  }

  const result = verifyBehavior(skillName);

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
