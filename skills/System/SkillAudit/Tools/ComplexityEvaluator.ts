#!/usr/bin/env bun
/**
 * ComplexityEvaluator - LOC-vs-value and deterministic/inferential boundary analysis
 *
 * Scores Dimension 9: Complexity AND Dimension 11: Agent Balance.
 * Measures code size, workflow count, interface count, and categorizes
 * each operation as deterministic or inferential. Flags boundary violations
 * where LLM is used for regex-level tasks or regex approximates LLM judgment.
 *
 * Usage:
 *   bun run ComplexityEvaluator.ts <skill-name>
 *   bun run ComplexityEvaluator.ts Browser
 *   bun run ComplexityEvaluator.ts Browser --json
 */

import { join, basename } from 'path';
import { SKILLS_DIR, SCORING, MAX_WORKFLOWS_IDEAL } from './constants';
import { getSkillPath, getSkillFiles, safeReadFile, skillExists, countLines } from './utils';
import type { Finding, Recommendation, DimensionResult } from './report-builder';
import { buildDimensionResult } from './report-builder';

// ============================================================================
// Types
// ============================================================================

export interface ComplexityResult {
  skillName: string;
  complexityScore: number;
  agentBalanceScore: number;
  complexityDimension: DimensionResult;
  agentBalanceDimension: DimensionResult;
  details: {
    totalLoc: number;
    workflowCount: number;
    toolCount: number;
    interfaceCount: number;
    deterministicOps: number;
    inferentialOps: number;
    overEngineeringSignals: string[];
    balanceIssues: string[];
  };
}

// ============================================================================
// Over-engineering Detection
// ============================================================================

/**
 * Patterns that signal over-engineering.
 * Each produces a descriptive string for the findings array.
 */
interface OverEngineeringCheck {
  pattern: RegExp;
  description: (match: RegExpMatchArray) => string;
}

const OVER_ENGINEERING_PATTERNS: OverEngineeringCheck[] = [
  {
    // Only flag functions that delegate directly to another function (true passthrough)
    pattern: /function\s+\w+\([^)]*\)\s*:\s*\w+\s*\{\s*return\s+\w+\([^)]*\)\s*;?\s*\}/g,
    description: () => 'Wrapper function delegates directly to another function',
  },
  {
    // Factory functions that just call constructors
    pattern: /function\s+create\w+\([^)]*\)[^{]*\{[^}]*return\s+new\s+\w+/g,
    description: () => 'Factory function delegates directly to constructor',
  },
  {
    // Re-exported symbols that are just pass-throughs
    pattern: /export\s+\{\s*\w+\s+as\s+\w+\s*\}/g,
    description: (m) => `Re-export alias: ${m[0].trim().slice(0, 60)}`,
  },
  {
    // Functions with 6+ parameters — consider options object
    pattern: /function\s+\w+\((?:[^,)]*,){5,}[^)]*\)/g,
    description: () => 'Function with 6+ parameters — consider options object',
  },
];

/**
 * Identify over-engineering signals from a single TypeScript file's content.
 */
function detectOverEngineeringInFile(content: string, fileName: string): string[] {
  const signals: string[] = [];

  // Check OVER_ENGINEERING_PATTERNS first
  for (const check of OVER_ENGINEERING_PATTERNS) {
    const matches = content.match(check.pattern);
    if (matches && matches.length > 0) {
      for (const match of matches) {
        signals.push(`${fileName}: ${check.description([match] as unknown as RegExpMatchArray)}`);
      }
    }
  }

  // Count interface definitions — excessive interfaces in simple tools indicate over-typing
  const interfaceMatches = content.match(/^interface\s+\w+/gm) || [];
  const typeAliasMatches = content.match(/^type\s+\w+\s*=/gm) || [];
  const totalTypeDecls = interfaceMatches.length + typeAliasMatches.length;

  const fileLines = content.split('\n').length;
  const typeThreshold = fileLines > 200 ? 15 : 8;
  if (totalTypeDecls > typeThreshold) {
    signals.push(`${fileName}: ${totalTypeDecls} type/interface declarations (possible over-typing for scope)`);
  }

  // Deep nesting — functions inside functions inside functions
  const deepNestingMatch = content.match(/function[^{]*\{[^}]*function[^{]*\{[^}]*function/g);
  if (deepNestingMatch && deepNestingMatch.length > 0) {
    signals.push(`${fileName}: deeply nested function definitions (3+ levels)`);
  }

  // Excessive abstraction: abstract base classes or overly complex inheritance
  if (content.includes('abstract class') || content.includes('implements ')) {
    const classCount = (content.match(/\bclass\s+\w+/g) || []).length;
    if (classCount > 2) {
      signals.push(`${fileName}: ${classCount} class definitions — OOP hierarchy in a script context`);
    }
  }

  return signals;
}

// ============================================================================
// Agent Balance Detection
// ============================================================================

/**
 * Inferential operation indicators — these require LLM judgment.
 */
const INFERENTIAL_PATTERNS = [
  // Direct Inference.ts usage
  /\bInference\.ts\b/,
  /bun.*Inference\.ts/,
  // Task delegation
  /\bTask\s*\(/,
  /\$`bun.*Inference/,
  // LLM provider imports
  /from\s+['"]anthropic['"]/,
  /from\s+['"]openai['"]/,
  /from\s+['"]@anthropic['"]/,
  // Direct API calls
  /\.messages\.create\(/,
  /client\.chat\.completions/,
  // Inference tool via pipe
  /echo.*\|\s*bun.*Inference/,
] as const;

/**
 * Deterministic operation indicators — pure computation, no LLM.
 */
const DETERMINISTIC_PATTERNS = [
  // File system
  /\breadFileSync\b|\bwriteFileSync\b|\bexistsSync\b|\breaddirSync\b/,
  // String operations
  /\.match\(|\.replace\(|\.split\(|\.trim\(|\.includes\(/,
  // JSON
  /JSON\.parse\(|JSON\.stringify\(/,
  // Path operations
  /\bjoin\(|\bbasename\(|\bdirname\(|\bextname\(/,
  // Regex
  /new RegExp\(|\/[^/]+\/[gimsuy]*/,
] as const;

/**
 * Patterns where LLM is used for something a regex/deterministic op could handle.
 * Heuristic: LLM calls with very short prompts or for simple extraction tasks.
 */
const LLM_OVERKILL_SIGNALS = [
  // Passing a simple string check to LLM
  /Inference.*"(?:is|check|does|are)\s+\w{1,20}\s+(?:a|an|the|in|at)/i,
  // Using Task for file listing
  /Task\s*\([^)]*list.*files/i,
  /Task\s*\([^)]*read.*file/i,
] as const;

/**
 * Patterns where conditions are approximating LLM judgment.
 * Heuristic: a chain of 6+ else-if blocks all doing string-match operations on the same
 * variable characterizes keyword-based text classification that an LLM handles better.
 * We require a very long chain to avoid false-positives on normal branching code.
 */
const REGEX_OVERKILL_SIGNALS = [
  // Six or more consecutive else-if blocks all calling includes()/match() on a single line —
  // this is the keyword-classifier smell. Requires all on single lines to avoid cross-function FP.
  /(?:else\s+if\b[^\n]*\b(?:includes|indexOf|match)\b[^\n]*\n){5,}/,
] as const;

interface BalanceCounts {
  deterministicOps: number;
  inferentialOps: number;
  issues: string[];
}

/**
 * Analyze a single TypeScript file for deterministic/inferential balance.
 */
function analyzeFileBalance(content: string, fileName: string): BalanceCounts {
  let deterministicOps = 0;
  let inferentialOps = 0;
  const issues: string[] = [];

  // Count deterministic operations
  for (const pattern of DETERMINISTIC_PATTERNS) {
    const matches = content.match(new RegExp(pattern.source, 'g'));
    if (matches) deterministicOps += matches.length;
  }

  // Count inferential operations
  for (const pattern of INFERENTIAL_PATTERNS) {
    const matches = content.match(new RegExp(pattern.source, 'g'));
    if (matches) {
      inferentialOps += matches.length;
    }
  }

  // Check for LLM overkill (inferential where deterministic suffices)
  for (const signal of LLM_OVERKILL_SIGNALS) {
    if (signal.test(content)) {
      issues.push(`${fileName}: LLM used for a task that could be regex/deterministic`);
      break; // One flag per file for this category
    }
  }

  // Check for regex approximating LLM judgment
  for (const signal of REGEX_OVERKILL_SIGNALS) {
    if (signal.test(content)) {
      issues.push(`${fileName}: Complex regex/conditional logic approximating NLP judgment — consider LLM`);
      break;
    }
  }

  return { deterministicOps, inferentialOps, issues };
}

// ============================================================================
// Interface Counting
// ============================================================================

/**
 * Count interface and type alias declarations across all TypeScript tool files.
 */
function countInterfacesInContent(content: string): number {
  const interfaces = (content.match(/^interface\s+\w+/gm) || []).length;
  const typeAliases = (content.match(/^type\s+\w+\s*=/gm) || []).length;
  return interfaces + typeAliases;
}

// ============================================================================
// Scoring
// ============================================================================

/**
 * Score Dimension 9: Complexity.
 * Starts at 10, deducts per SCORING.complexity rules.
 */
function scoreComplexity(
  totalLoc: number,
  workflowCount: number,
  overEngineeringSignals: string[],
  toolCount: number
): number {
  let score = 10;

  // Too many workflows
  if (workflowCount > MAX_WORKFLOWS_IDEAL) {
    score += SCORING.complexity.tooManyWorkflows;
  }

  // High LOC per tool — normalize by tool count so multi-tool skills aren't penalized unfairly
  const locPerTool = toolCount > 0 ? totalLoc / toolCount : totalLoc;
  if (locPerTool > 400) {
    score += SCORING.complexity.highLocSimplePurpose;
  }

  // Over-engineering signal deductions capped at -3 total
  const signalDeduction = Math.max(-3, overEngineeringSignals.length * SCORING.complexity.unnecessaryAbstraction);
  score += signalDeduction;

  return Math.min(10, Math.max(1, Math.round(score * 10) / 10));
}

/**
 * Score Dimension 11: Agent Balance.
 * Starts at 10, deducts per SCORING.agentBalance rules.
 */
function scoreAgentBalance(
  deterministicOps: number,
  inferentialOps: number,
  balanceIssues: string[]
): number {
  let score = 10;

  // Count each distinct balance issue type
  const llmOverkillCount = balanceIssues.filter(i => i.includes('LLM used for a task')).length;
  const regexOverkillCount = balanceIssues.filter(i => i.includes('approximating NLP')).length;

  score += llmOverkillCount * SCORING.agentBalance.llmWhereRegexSuffices;
  score += regexOverkillCount * SCORING.agentBalance.regexWhereJudgmentNeeded;

  // If skill has inferential ops but zero deterministic ops: likely a workflow conductor
  // that should be done via hooks — but only flag if inferential calls are heavy
  if (inferentialOps > 5 && deterministicOps < 3) {
    score += SCORING.agentBalance.hookEligibleAsToolInstead;
  }

  return Math.min(10, Math.max(1, Math.round(score * 10) / 10));
}

// ============================================================================
// Main Export
// ============================================================================

/**
 * Evaluate complexity and agent balance for a skill.
 */
export function evaluateComplexity(skillName: string): ComplexityResult | null {
  if (!skillExists(skillName)) {
    return null;
  }

  const files = getSkillFiles(skillName);

  // 1. Aggregate metrics across all TypeScript tool files
  let totalLoc = 0;
  let interfaceCount = 0;
  let totalDeterministic = 0;
  let totalInferential = 0;
  const overEngineeringSignals: string[] = [];
  const balanceIssues: string[] = [];

  for (const toolPath of files.tools) {
    const content = safeReadFile(toolPath);
    if (!content) continue;

    const fileName = basename(toolPath);
    totalLoc += countLines(content);
    interfaceCount += countInterfacesInContent(content);

    // Over-engineering analysis
    const oeSignals = detectOverEngineeringInFile(content, fileName);
    overEngineeringSignals.push(...oeSignals);

    // Balance analysis
    const balance = analyzeFileBalance(content, fileName);
    totalDeterministic += balance.deterministicOps;
    totalInferential += balance.inferentialOps;
    balanceIssues.push(...balance.issues);
  }

  const workflowCount = files.workflows.length;
  const toolCount = files.tools.length;

  // Additional over-engineering checks at skill level
  if (workflowCount > MAX_WORKFLOWS_IDEAL) {
    overEngineeringSignals.push(
      `${workflowCount} workflows exceeds ideal maximum of ${MAX_WORKFLOWS_IDEAL}`
    );
  }

  if (totalLoc > 300 && toolCount === 1) {
    overEngineeringSignals.push(
      `Single tool file with ${totalLoc} LOC — consider splitting by responsibility`
    );
  }

  // 2. Compute scores
  const complexityScore = scoreComplexity(totalLoc, workflowCount, overEngineeringSignals, toolCount);
  const agentBalanceScore = scoreAgentBalance(totalDeterministic, totalInferential, balanceIssues);

  // 3. Complexity findings and recommendations
  const complexityFindings: Finding[] = [];
  const complexityRecommendations: Recommendation[] = [];

  if (workflowCount > MAX_WORKFLOWS_IDEAL) {
    complexityFindings.push({
      description: `${workflowCount} workflows exceeds recommended maximum of ${MAX_WORKFLOWS_IDEAL}`,
      severity: 'MEDIUM',
    });
    complexityRecommendations.push({
      action: `Consolidate workflows to ${MAX_WORKFLOWS_IDEAL} or fewer — group related flows`,
      priority: 'P2',
      effort: 'M',
      impact: 'MEDIUM',
      dimension: 'complexity',
    });
  }

  const locPerToolForFinding = toolCount > 0 ? totalLoc / toolCount : totalLoc;
  if (locPerToolForFinding > 400) {
    complexityFindings.push({
      description: `${Math.round(locPerToolForFinding)} LOC per tool (${totalLoc} total across ${toolCount} tools) — verify value justifies size`,
      severity: 'LOW',
    });
    complexityRecommendations.push({
      action: 'Review whether all LOC is justified — extract shared utilities to CORE/Tools',
      priority: 'P3',
      effort: 'M',
      impact: 'LOW',
      dimension: 'complexity',
    });
  }

  for (const signal of overEngineeringSignals.slice(0, 3)) {
    complexityFindings.push({
      description: signal,
      severity: 'LOW',
    });
  }

  if (overEngineeringSignals.length > 0 && complexityRecommendations.length === 0) {
    complexityRecommendations.push({
      action: 'Simplify: remove wrapper layers and reduce interface count to match actual complexity',
      priority: 'P3',
      effort: 'S',
      impact: 'LOW',
      dimension: 'complexity',
    });
  }

  if (totalLoc === 0 && toolCount === 0) {
    complexityFindings.push({
      description: 'Skill has no TypeScript tool files — no complexity to measure',
      severity: 'LOW',
    });
  }

  // 4. Agent balance findings and recommendations
  const balanceFindings: Finding[] = [];
  const balanceRecommendations: Recommendation[] = [];

  for (const issue of balanceIssues) {
    const isLlmOverkill = issue.includes('LLM used for a task');
    balanceFindings.push({
      description: issue,
      severity: isLlmOverkill ? 'MEDIUM' : 'LOW',
    });
  }

  if (balanceIssues.some(i => i.includes('LLM used for a task'))) {
    balanceRecommendations.push({
      action: 'Replace LLM calls with deterministic regex or string operations for simple extraction tasks',
      priority: 'P2',
      effort: 'S',
      impact: 'MEDIUM',
      dimension: 'agentBalance',
    });
  }

  if (balanceIssues.some(i => i.includes('approximating NLP'))) {
    balanceRecommendations.push({
      action: 'Replace complex keyword-matching conditionals with an LLM call for classification tasks',
      priority: 'P2',
      effort: 'M',
      impact: 'MEDIUM',
      dimension: 'agentBalance',
    });
  }

  if (balanceIssues.length === 0 && (totalDeterministic > 0 || totalInferential > 0)) {
    balanceFindings.push({
      description: `Appropriate balance: ${totalDeterministic} deterministic ops, ${totalInferential} inferential ops`,
      severity: 'LOW',
    });
  }

  // 5. Build dimension results
  const complexityDimension = buildDimensionResult(
    complexityScore,
    complexityFindings,
    complexityRecommendations
  );

  const agentBalanceDimension = buildDimensionResult(
    agentBalanceScore,
    balanceFindings,
    balanceRecommendations
  );

  return {
    skillName,
    complexityScore,
    agentBalanceScore,
    complexityDimension,
    agentBalanceDimension,
    details: {
      totalLoc,
      workflowCount,
      toolCount,
      interfaceCount,
      deterministicOps: totalDeterministic,
      inferentialOps: totalInferential,
      overEngineeringSignals,
      balanceIssues,
    },
  };
}

// ============================================================================
// CLI Interface
// ============================================================================

function printReport(result: ComplexityResult): void {
  console.log(`# Complexity & Agent Balance Evaluation: ${result.skillName}\n`);

  console.log('## Scores\n');
  console.log(`- **Complexity (D9):** ${result.complexityScore} / 10 — ${result.complexityDimension.health}`);
  console.log(`- **Agent Balance (D11):** ${result.agentBalanceScore} / 10 — ${result.agentBalanceDimension.health}`);
  console.log('');

  const d = result.details;

  console.log('## Metrics\n');
  console.log(`- **Total LOC (tools):** ${d.totalLoc}`);
  console.log(`- **Workflow Count:** ${d.workflowCount} (max recommended: ${MAX_WORKFLOWS_IDEAL})`);
  console.log(`- **Tool Count:** ${d.toolCount}`);
  console.log(`- **Interface/Type Declarations:** ${d.interfaceCount}`);
  console.log(`- **Deterministic Operations:** ${d.deterministicOps}`);
  console.log(`- **Inferential Operations:** ${d.inferentialOps}`);
  console.log('');

  if (d.overEngineeringSignals.length > 0) {
    console.log('## Over-Engineering Signals\n');
    for (const signal of d.overEngineeringSignals) {
      console.log(`- ${signal}`);
    }
    console.log('');
  }

  if (d.balanceIssues.length > 0) {
    console.log('## Agent Balance Issues\n');
    for (const issue of d.balanceIssues) {
      console.log(`- ${issue}`);
    }
    console.log('');
  }

  if (result.complexityDimension.findings.length > 0) {
    console.log('## Complexity Findings\n');
    for (const f of result.complexityDimension.findings) {
      const loc = f.location ? ` (${f.location})` : '';
      console.log(`- [${f.severity}] ${f.description}${loc}`);
    }
    console.log('');
  }

  if (result.agentBalanceDimension.findings.length > 0) {
    console.log('## Agent Balance Findings\n');
    for (const f of result.agentBalanceDimension.findings) {
      const loc = f.location ? ` (${f.location})` : '';
      console.log(`- [${f.severity}] ${f.description}${loc}`);
    }
    console.log('');
  }

  const allRecs = [
    ...result.complexityDimension.recommendations,
    ...result.agentBalanceDimension.recommendations,
  ];

  if (allRecs.length > 0) {
    console.log('## Recommendations\n');
    for (const rec of allRecs) {
      console.log(`- [${rec.priority}] [D${rec.dimension === 'complexity' ? '9' : '11'}] ${rec.action}`);
    }
    console.log('');
  }
}

function main(): void {
  const args = process.argv.slice(2);
  const jsonOutput = args.includes('--json');
  const skillName = args.find(a => !a.startsWith('--'));

  if (!skillName) {
    console.log('Usage: bun run ComplexityEvaluator.ts <skill-name>');
    console.log('       bun run ComplexityEvaluator.ts Browser');
    console.log('       bun run ComplexityEvaluator.ts Browser --json');
    process.exit(1);
  }

  const result = evaluateComplexity(skillName);

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
