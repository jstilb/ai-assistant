#!/usr/bin/env bun
/**
 * BehaviorGapAnalyzer - Automates Expected/Actual/Ideal comparison
 *
 * Analyzes the gap between what a skill's documentation claims (Expected),
 * what the code actually implements (Actual), and what it should ideally do (Ideal).
 *
 * Usage:
 *   bun run BehaviorGapAnalyzer.ts <skill-name>
 *   bun run BehaviorGapAnalyzer.ts Browser
 *   bun run BehaviorGapAnalyzer.ts Browser --json
 */

import { basename } from 'path';
import { GapLevel } from './constants';
import {
  getSkillPath,
  getSkillFiles,
  safeReadFile,
  skillExists,
  extractWorkflowTriggers,
  getDateString,
} from './utils';

// ============================================================================
// Types
// ============================================================================

export interface BehaviorGap {
  aspect: string;
  expected: string;
  actual: string;
  ideal: string;
  gapLevel: GapLevel;
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
  triggers: string[];
}

export interface ActualBehavior {
  hasSkillMd: boolean;
  workflowsImplemented: string[];
  toolsImplemented: string[];
  triggersActive: string[];
  integrationsActive: string[];
}

export interface EvalResult {
  taskId: string;
  passed: boolean;
  score: number;
  details?: string;
}

export interface GapAnalysisResult {
  skillName: string;
  analyzedAt: string;
  overallHealth: 'GREEN' | 'YELLOW' | 'RED';
  gaps: BehaviorGap[];
  summary: {
    highGaps: number;
    mediumGaps: number;
    lowGaps: number;
    totalGaps: number;
  };
  evalResults?: {
    ran: boolean;
    passRate: number;
    results: EvalResult[];
  };
}

// ============================================================================
// Core Functions
// ============================================================================

/**
 * Analyze behavior gaps for a skill
 */
export function analyzeGaps(skillName: string): GapAnalysisResult | null {
  if (!skillExists(skillName)) {
    return null;
  }

  const expected = extractExpected(skillName);
  const actual = extractActual(skillName);
  const gaps = compareExpectedActual(expected, actual, skillName);

  // Calculate summary
  const highGaps = gaps.filter(g => g.gapLevel === 'HIGH').length;
  const mediumGaps = gaps.filter(g => g.gapLevel === 'MEDIUM').length;
  const lowGaps = gaps.filter(g => g.gapLevel === 'LOW').length;

  // Determine overall health
  let overallHealth: 'GREEN' | 'YELLOW' | 'RED' = 'GREEN';
  if (highGaps > 0) {
    overallHealth = 'RED';
  } else if (mediumGaps > 2) {
    overallHealth = 'YELLOW';
  }

  return {
    skillName,
    analyzedAt: new Date().toISOString(),
    overallHealth,
    gaps,
    summary: {
      highGaps,
      mediumGaps,
      lowGaps,
      totalGaps: gaps.length,
    },
  };
}

/**
 * Extract expected behavior from SKILL.md documentation
 */
export function extractExpected(skillName: string): ExpectedBehavior {
  const files = getSkillFiles(skillName);
  const skillMdContent = files.skillMd ? safeReadFile(files.skillMd) : null;

  const result: ExpectedBehavior = {
    purpose: '',
    triggers: [],
    workflows: [],
    integrations: [],
    examples: [],
  };

  if (!skillMdContent) {
    return result;
  }

  // Extract purpose from description or first heading
  const descMatch = skillMdContent.match(/description:\s*(.+?)(?:\n|$)/i);
  if (descMatch) {
    result.purpose = descMatch[1].trim();
  } else {
    const firstParagraph = skillMdContent.match(/^#[^#].+?\n+([^#\n][^\n]+)/m);
    if (firstParagraph) {
      result.purpose = firstParagraph[1].trim();
    }
  }

  // Extract triggers from USE WHEN
  const useWhenMatch = skillMdContent.match(/USE WHEN\s+(.+?)(?:\.|$)/i);
  if (useWhenMatch) {
    result.triggers = useWhenMatch[1].split(/,\s*|\s+OR\s+/i).map(t => t.trim().toLowerCase()).filter(Boolean);
  }

  // Extract workflow expectations from workflow tables
  const workflowTableMatch = skillMdContent.match(/\|[^|]*Workflow[^|]*\|[\s\S]*?\n\n/i);
  if (workflowTableMatch) {
    const rows = workflowTableMatch[0].split('\n').filter(r => r.includes('|') && !r.includes('---'));
    for (const row of rows.slice(1)) { // Skip header
      const cells = row.split('|').map(c => c.trim()).filter(Boolean);
      if (cells.length >= 2) {
        const name = cells[0].replace(/\*\*/g, '');
        const purpose = cells.length >= 3 ? cells[2] : cells[1];
        result.workflows.push({
          name,
          purpose,
          triggers: [],
        });
      }
    }
  }

  // Extract integrations from Uses/Feeds Into sections
  const usesMatch = skillMdContent.match(/###?\s*Uses\s*\n([\s\S]*?)(?=\n###?|\n---|\n##|$)/i);
  if (usesMatch) {
    const skillRefs = usesMatch[1].match(/\*\*([A-Za-z]+)\*\*/g);
    if (skillRefs) {
      result.integrations.push(...skillRefs.map(ref => ref.replace(/\*\*/g, '')));
    }
  }

  // Extract examples
  const exampleMatches = skillMdContent.match(/\*\*Example \d+[^*]*\*\*[^*]*/gi);
  if (exampleMatches) {
    result.examples = exampleMatches.map(e => e.trim());
  }

  return result;
}

/**
 * Extract actual behavior from Tools/ and Workflows/ directories
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

  // Extract actual triggers from workflow files using shared utility
  for (const workflowPath of files.workflows) {
    const content = safeReadFile(workflowPath);
    if (content) {
      const triggers = extractWorkflowTriggers(content);
      result.triggersActive.push(...triggers.map(t => t.toLowerCase()));
    }
  }

  // Extract actual integrations from tool imports
  for (const toolPath of files.tools) {
    const content = safeReadFile(toolPath);
    if (content) {
      // Look for skill imports
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

/**
 * Compare expected vs actual and generate gaps
 */
function compareExpectedActual(
  expected: ExpectedBehavior,
  actual: ActualBehavior,
  skillName: string
): BehaviorGap[] {
  const gaps: BehaviorGap[] = [];

  // Gap 1: Purpose clarity
  if (!expected.purpose) {
    gaps.push({
      aspect: 'Purpose',
      expected: 'Clear description of what skill does',
      actual: 'No description found in SKILL.md',
      ideal: 'Concise purpose statement with USE WHEN triggers',
      gapLevel: 'HIGH',
      recommendation: 'Add description with USE WHEN triggers to SKILL.md frontmatter',
    });
  }

  // Gap 2: Workflow implementation
  const expectedWorkflowNames = expected.workflows.map(w => w.name);
  const missingWorkflows = expectedWorkflowNames.filter(
    name => !actual.workflowsImplemented.some(impl =>
      impl.toLowerCase() === name.toLowerCase() ||
      impl.toLowerCase().includes(name.toLowerCase())
    )
  );

  if (missingWorkflows.length > 0) {
    gaps.push({
      aspect: 'Workflow Implementation',
      expected: `${expectedWorkflowNames.length} workflows documented: ${expectedWorkflowNames.join(', ')}`,
      actual: `${actual.workflowsImplemented.length} workflows implemented: ${actual.workflowsImplemented.join(', ')}`,
      ideal: 'All documented workflows have corresponding implementation files',
      gapLevel: missingWorkflows.length > 2 ? 'HIGH' : 'MEDIUM',
      recommendation: `Create missing workflow files: ${missingWorkflows.join(', ')}`,
    });
  }

  // Gap 3: Trigger coverage
  if (expected.triggers.length > 0 && actual.triggersActive.length === 0) {
    gaps.push({
      aspect: 'Trigger Coverage',
      expected: `Triggers documented: ${expected.triggers.slice(0, 5).join(', ')}`,
      actual: 'No triggers found in workflow files',
      ideal: 'Each workflow has explicit trigger phrases that match documentation',
      gapLevel: 'MEDIUM',
      recommendation: 'Add ## Trigger sections to each workflow with specific invocation phrases',
    });
  }

  // Gap 4: Integration gaps
  const expectedIntegrations = new Set(expected.integrations);
  const actualIntegrations = new Set(actual.integrationsActive);
  const missingIntegrations = [...expectedIntegrations].filter(i => !actualIntegrations.has(i));

  if (missingIntegrations.length > 0) {
    gaps.push({
      aspect: 'Integration Implementation',
      expected: `Integrations documented: ${expected.integrations.join(', ')}`,
      actual: `Integrations active in code: ${actual.integrationsActive.join(', ') || 'none'}`,
      ideal: 'All documented integrations have code-level implementation',
      gapLevel: missingIntegrations.length > 1 ? 'MEDIUM' : 'LOW',
      recommendation: `Implement integrations with: ${missingIntegrations.join(', ')}`,
    });
  }

  // Gap 5: Examples vs implementations
  if (expected.examples.length >= 2 && actual.workflowsImplemented.length === 0) {
    gaps.push({
      aspect: 'Example Support',
      expected: `${expected.examples.length} examples documented`,
      actual: 'No workflow implementations to support examples',
      ideal: 'Each example scenario has corresponding workflow implementation',
      gapLevel: 'HIGH',
      recommendation: 'Create workflow implementations that support the documented examples',
    });
  }

  // Gap 6: Tool coverage
  if (actual.workflowsImplemented.length > 3 && actual.toolsImplemented.length === 0) {
    gaps.push({
      aspect: 'Tool Support',
      expected: 'Complex skill should have supporting tools',
      actual: 'No tools implemented despite multiple workflows',
      ideal: 'Reusable logic extracted into Tools/ for workflow composition',
      gapLevel: 'LOW',
      recommendation: 'Consider extracting common logic into reusable tools',
    });
  }

  return gaps;
}

// ============================================================================
// Eval Integration
// ============================================================================

/**
 * Run behavioral evals for a skill using the baseline suite
 * @param skillName - Name of the skill to evaluate
 * @returns Eval results or null if evals unavailable
 */
export async function runBehaviorEvals(skillName: string): Promise<{
  passRate: number;
  results: EvalResult[];
} | null> {
  const { existsSync } = await import('fs');
  const { join } = await import('path');
  const { $ } = await import('bun');

  const evalsPath = join(
    process.env.HOME || '',
    '.claude/skills/Evals/Tools/EvalExecutor.ts'
  );

  // Check if Evals infrastructure exists
  if (!existsSync(evalsPath)) {
    console.log('  ⚠️  Evals infrastructure not available');
    return null;
  }

  // Check for skill-specific evals
  const skillEvalsPath = join(
    process.env.HOME || '',
    `.claude/skills/${skillName}/Evals`
  );
  const baselineEvalsPath = join(
    process.env.HOME || '',
    '.claude/skills/SkillAudit/Evals/baseline.eval.yaml'
  );

  try {
    // Run baseline evals
    const result = await $`bun ${evalsPath} suite -n skill-baseline`.quiet();
    const output = result.stdout.toString();

    // Parse results (simplified - real implementation would parse JSON output)
    const passMatch = output.match(/(\d+)\/(\d+) tasks passed/);
    const scoreMatch = output.match(/Mean score: ([\d.]+)%/);

    if (passMatch && scoreMatch) {
      const passed = parseInt(passMatch[1]);
      const total = parseInt(passMatch[2]);
      const passRate = passed / total;

      return {
        passRate,
        results: [
          {
            taskId: 'skill-baseline',
            passed: passRate >= 0.75,
            score: parseFloat(scoreMatch[1]) / 100,
            details: `${passed}/${total} tests passed`,
          },
        ],
      };
    }
  } catch (e) {
    console.log(`  ⚠️  Eval execution failed: ${e}`);
  }

  return null;
}

/**
 * Analyze gaps with optional eval integration
 */
export async function analyzeGapsWithEvals(
  skillName: string,
  runEvals: boolean = false
): Promise<GapAnalysisResult | null> {
  const result = analyzeGaps(skillName);
  if (!result) return null;

  if (runEvals) {
    console.log(`\n  Running behavioral evals for ${skillName}...`);
    const evalResults = await runBehaviorEvals(skillName);

    if (evalResults) {
      result.evalResults = {
        ran: true,
        passRate: evalResults.passRate,
        results: evalResults.results,
      };

      // Strengthen gap levels based on eval evidence
      if (evalResults.passRate < 0.5) {
        // Add a high-priority gap if evals failing
        result.gaps.push({
          aspect: 'Behavioral Testing',
          expected: 'Skill passes baseline behavioral tests',
          actual: `${(evalResults.passRate * 100).toFixed(0)}% pass rate`,
          ideal: '≥80% pass rate on baseline tests',
          gapLevel: 'HIGH',
          recommendation: 'Fix failing behavioral tests before deployment',
        });
        result.summary.highGaps++;
        result.summary.totalGaps++;
        result.overallHealth = 'RED';
      } else if (evalResults.passRate < 0.8) {
        result.gaps.push({
          aspect: 'Behavioral Testing',
          expected: 'Skill passes baseline behavioral tests',
          actual: `${(evalResults.passRate * 100).toFixed(0)}% pass rate`,
          ideal: '≥80% pass rate on baseline tests',
          gapLevel: 'MEDIUM',
          recommendation: 'Improve test coverage to reach 80%+ pass rate',
        });
        result.summary.mediumGaps++;
        result.summary.totalGaps++;
        if (result.overallHealth === 'GREEN') {
          result.overallHealth = 'YELLOW';
        }
      }
    } else {
      result.evalResults = { ran: false, passRate: 0, results: [] };
    }
  }

  return result;
}

// ============================================================================
// CLI Interface
// ============================================================================

function printReport(result: GapAnalysisResult): void {
  const healthEmoji = {
    GREEN: '🟢',
    YELLOW: '🟡',
    RED: '🔴',
  };

  console.log(`# Behavior Gap Analysis: ${result.skillName}\n`);
  console.log(`**Analyzed:** ${result.analyzedAt}`);
  console.log(`**Overall Health:** ${healthEmoji[result.overallHealth]} ${result.overallHealth}\n`);

  console.log('## Summary\n');
  console.log(`- **Total Gaps:** ${result.summary.totalGaps}`);
  console.log(`- **High (Critical):** ${result.summary.highGaps}`);
  console.log(`- **Medium (Notable):** ${result.summary.mediumGaps}`);
  console.log(`- **Low (Minor):** ${result.summary.lowGaps}`);
  console.log('');

  if (result.gaps.length === 0) {
    console.log('No significant gaps found between documentation and implementation.\n');
    return;
  }

  console.log('## Detailed Gap Analysis\n');

  // Group by gap level
  const highGaps = result.gaps.filter(g => g.gapLevel === 'HIGH');
  const mediumGaps = result.gaps.filter(g => g.gapLevel === 'MEDIUM');
  const lowGaps = result.gaps.filter(g => g.gapLevel === 'LOW');

  if (highGaps.length > 0) {
    console.log('### 🔴 High Priority Gaps\n');
    for (const gap of highGaps) {
      printGap(gap);
    }
  }

  if (mediumGaps.length > 0) {
    console.log('### 🟡 Medium Priority Gaps\n');
    for (const gap of mediumGaps) {
      printGap(gap);
    }
  }

  if (lowGaps.length > 0) {
    console.log('### 🟢 Low Priority Gaps\n');
    for (const gap of lowGaps) {
      printGap(gap);
    }
  }

  console.log('## Recommendations\n');
  console.log('Based on the analysis, prioritize:\n');
  let priority = 1;
  for (const gap of [...highGaps, ...mediumGaps, ...lowGaps].slice(0, 5)) {
    console.log(`${priority}. **${gap.aspect}:** ${gap.recommendation}`);
    priority++;
  }
}

function printGap(gap: BehaviorGap): void {
  console.log(`#### ${gap.aspect}\n`);
  console.log('| Dimension | Value |');
  console.log('|-----------|-------|');
  console.log(`| **Expected (Docs)** | ${gap.expected} |`);
  console.log(`| **Actual (Code)** | ${gap.actual} |`);
  console.log(`| **Ideal (Vision)** | ${gap.ideal} |`);
  console.log(`| **Gap Level** | ${gap.gapLevel} |`);
  console.log('');
  console.log(`**Recommendation:** ${gap.recommendation}\n`);
}

function main(): void {
  const args = process.argv.slice(2);
  const jsonOutput = args.includes('--json');
  const skillName = args.find(a => !a.startsWith('--'));

  if (!skillName) {
    console.log('Usage: bun run BehaviorGapAnalyzer.ts <skill-name>');
    console.log('       bun run BehaviorGapAnalyzer.ts Browser');
    console.log('       bun run BehaviorGapAnalyzer.ts Browser --json');
    process.exit(1);
  }

  const result = analyzeGaps(skillName);

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

// Run CLI if executed directly
if (import.meta.main) {
  main();
}
