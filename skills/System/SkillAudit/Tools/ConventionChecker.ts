#!/usr/bin/env bun
/**
 * ConventionChecker - Deterministic Kaya convention compliance analyzer
 *
 * Scores Dimension 7: Refactoring Need by scanning Tools/ .ts files for
 * known anti-patterns against Kaya coding conventions.
 *
 * Violations detected:
 *   - raw fetch() instead of CachedHTTPClient
 *   - raw JSON.parse(readFileSync()) instead of StateManager
 *   - `: any` type usage
 *   - @ts-ignore / @ts-expect-error suppressions
 *   - console.error() (informational — no score deduction)
 *   - Missing Zod validation on external inputs (informational)
 *
 * Usage:
 *   bun run ConventionChecker.ts <skill-name>
 *   bun run ConventionChecker.ts Browser --json
 */

import { join, basename } from 'path';
import { SKILLS_DIR, SCORING, CONVENTION_VIOLATIONS } from './constants';
import { getSkillPath, getSkillFiles, safeReadFile, skillExists } from './utils';
import type { Finding, Recommendation, DimensionResult } from './report-builder';
import { buildDimensionResult } from './report-builder';

// ============================================================================
// Types
// ============================================================================

export interface ConventionViolation {
  file: string;
  line: number;
  type: 'rawFetch' | 'rawJsonParse' | 'anyType' | 'tsIgnore' | 'consoleError' | 'missingZod';
  description: string;
  severity: 'HIGH' | 'MEDIUM' | 'LOW';
}

export interface ConventionCheckResult {
  skillName: string;
  score: number;
  dimensionResult: DimensionResult;
  violations: ConventionViolation[];
  summary: {
    rawFetchCount: number;
    rawJsonParseCount: number;
    anyTypeCount: number;
    tsIgnoreCount: number;
    consoleErrorCount: number;
    missingZodCount: number;
    totalViolations: number;
  };
}

// ============================================================================
// Core Functions
// ============================================================================

/**
 * Check Kaya convention compliance for a skill.
 * Returns null if the skill does not exist.
 */
export function checkConventions(skillName: string): ConventionCheckResult | null {
  if (!skillExists(skillName)) {
    return null;
  }

  const files = getSkillFiles(skillName);
  const violations: ConventionViolation[] = [];

  for (const toolPath of files.tools) {
    if (!toolPath.endsWith('.ts')) continue;
    // Skip test files — they reference banned patterns in string literals/assertions
    if (toolPath.endsWith('.test.ts') || toolPath.endsWith('.spec.ts')) continue;
    const content = safeReadFile(toolPath);
    if (!content) continue;

    const fileViolations = scanFile(toolPath, content);
    violations.push(...fileViolations);
  }

  const summary = buildSummary(violations);
  const score = calculateScore(summary);
  const dimensionResult = buildDimensionResultFromViolations(score, violations, summary);

  return {
    skillName,
    score,
    dimensionResult,
    violations,
    summary,
  };
}

// ============================================================================
// Scanning
// ============================================================================

/**
 * Scan a single .ts file for convention violations.
 */
function scanFile(filePath: string, content: string): ConventionViolation[] {
  const violations: ConventionViolation[] = [];
  const lines = content.split('\n');
  const shortName = `Tools/${basename(filePath)}`;

  // Track whether the file uses Zod to check for missing validation later
  let hasZodImport = false;
  let acceptsExternalInput = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;
    const trimmed = line.trim();

    // Skip pure comment lines and regex/string literal definition lines to avoid
    // false positives where the pattern keywords appear inside a literal value.
    // A line is considered a literal definition if it starts with a regex delimiter
    // (e.g.  `rawFetch: /\bfetch/`) or if the trimmed form starts with `//` or `*`.
    const isCommentLine = trimmed.startsWith('//') || trimmed.startsWith('*');
    // Detect lines that contain a regex literal — either as a property assignment
    // (e.g. `tsIgnore: /@ts-ignore/`) or as an inline test expression
    // (e.g. `/\/\/\s*@ts-ignore/.test(line)`).
    const isRegexLiteralLine = /:\s*\/[^/]/.test(line) || /\/[^/]+\/[gimsuy]*\.test\(/.test(line);
    // Detect lines where the keyword appears only inside a string/template literal value
    // (e.g. description: `Raw fetch() call...`).  The heuristic: the line contains a
    // string-assignment prefix before the keyword.
    const isStringLiteralAssignment = /^\s*(description|action|console\.log)\s*[:(]/.test(line);
    // Detect method definitions like `async fetch(req, server)` in Bun.serve handlers
    const isMethodDefinition = /^\s*async\s+fetch\s*\(/.test(line);

    // Check raw fetch()
    if (!isCommentLine && !isRegexLiteralLine && !isStringLiteralAssignment && !isMethodDefinition && CONVENTION_VIOLATIONS.rawFetch.test(line)) {
      violations.push({
        file: shortName,
        line: lineNum,
        type: 'rawFetch',
        description: `Raw fetch() call — use CachedHTTPClient instead`,
        severity: 'HIGH',
      });
    }

    // Check raw JSON.parse(readFileSync())
    if (!isCommentLine && !isRegexLiteralLine && !isStringLiteralAssignment && CONVENTION_VIOLATIONS.rawJsonParseReadFile.test(line)) {
      violations.push({
        file: shortName,
        line: lineNum,
        type: 'rawJsonParse',
        description: `Raw JSON.parse(readFileSync()) — use StateManager instead`,
        severity: 'HIGH',
      });
    }

    // Check : any type usage — skip comment lines, import lines, regex literals, and string assignments
    if (
      !isCommentLine &&
      !isRegexLiteralLine &&
      !isStringLiteralAssignment &&
      !trimmed.startsWith('import ') &&
      CONVENTION_VIOLATIONS.anyType.test(line)
    ) {
      violations.push({
        file: shortName,
        line: lineNum,
        type: 'anyType',
        description: `\`: any\` type usage — use proper types, generics, or type narrowing`,
        severity: 'MEDIUM',
      });
    }

    // Check @ts-ignore — only flag lines where @ts-ignore is a TypeScript compiler directive.
    // Real directive: line starts with optional whitespace then `// @ts-ignore` (nothing before @).
    // This excludes prose comments like `// Check @ts-ignore patterns` and string literals.
    if (/^\s*\/\/\s*@ts-ignore/.test(line) || /^\s*\*\s*@ts-ignore/.test(line)) {
      violations.push({
        file: shortName,
        line: lineNum,
        type: 'tsIgnore',
        description: `@ts-ignore suppression — fix the underlying type error instead`,
        severity: 'MEDIUM',
      });
    }

    // Check @ts-expect-error — same directive-only matching
    if (/^\s*\/\/\s*@ts-expect-error/.test(line) || /^\s*\*\s*@ts-expect-error/.test(line)) {
      violations.push({
        file: shortName,
        line: lineNum,
        type: 'tsIgnore',
        description: `@ts-expect-error suppression — fix the underlying type error instead`,
        severity: 'MEDIUM',
      });
    }

    // Check console.error — informational only (no score deduction)
    if (!isCommentLine && CONVENTION_VIOLATIONS.consoleError.test(line)) {
      violations.push({
        file: shortName,
        line: lineNum,
        type: 'consoleError',
        description: `console.error() used — consider structured error handling via process.stderr`,
        severity: 'LOW',
      });
    }

    // Track Zod import presence
    if (/from\s+['"]zod['"]/.test(line) || /require\(['"]zod['"]\)/.test(line)) {
      hasZodImport = true;
    }

    // Detect external input patterns: process.argv, JSON.parse of unknown, readFileSync without types
    if (
      /process\.argv/.test(line) ||
      /JSON\.parse\(/.test(line) ||
      /readFileSync\(/.test(line)
    ) {
      acceptsExternalInput = true;
    }
  }

  // Informational: missing Zod on tools that accept external input
  if (acceptsExternalInput && !hasZodImport) {
    violations.push({
      file: shortName,
      line: 0,
      type: 'missingZod',
      description: `File accepts external input but does not import 'zod' for schema validation`,
      severity: 'LOW',
    });
  }

  return violations;
}

// ============================================================================
// Scoring
// ============================================================================

/**
 * Build a counts summary from the violations list.
 */
function buildSummary(violations: ConventionViolation[]): ConventionCheckResult['summary'] {
  const rawFetchCount = violations.filter(v => v.type === 'rawFetch').length;
  const rawJsonParseCount = violations.filter(v => v.type === 'rawJsonParse').length;
  const anyTypeCount = violations.filter(v => v.type === 'anyType').length;
  const tsIgnoreCount = violations.filter(v => v.type === 'tsIgnore').length;
  const consoleErrorCount = violations.filter(v => v.type === 'consoleError').length;
  const missingZodCount = violations.filter(v => v.type === 'missingZod').length;

  return {
    rawFetchCount,
    rawJsonParseCount,
    anyTypeCount,
    tsIgnoreCount,
    consoleErrorCount,
    missingZodCount,
    totalViolations: rawFetchCount + rawJsonParseCount + anyTypeCount + tsIgnoreCount + consoleErrorCount + missingZodCount,
  };
}

/**
 * Calculate a 1–10 score from violation counts.
 *
 * Starting score: 10
 *   -2 per raw fetch() (cap -4)
 *   -2 per raw JSON.parse(readFileSync()) (cap -4)
 *   -1 per `: any` type (cap -3)
 *   -1 per @ts-ignore/@ts-expect-error (cap -2)
 * Floor: 1
 */
function calculateScore(summary: ConventionCheckResult['summary']): number {
  let score = 10;

  const fetchDeduction = Math.min(summary.rawFetchCount * Math.abs(SCORING.refactoring.rawFetch), 4);
  const jsonDeduction = Math.min(summary.rawJsonParseCount * Math.abs(SCORING.refactoring.rawJsonParse), 4);
  const anyDeduction = Math.min(summary.anyTypeCount * Math.abs(SCORING.refactoring.anyType), 3);
  const tsIgnoreDeduction = Math.min(summary.tsIgnoreCount * Math.abs(SCORING.refactoring.tsIgnore), 2);

  score -= fetchDeduction + jsonDeduction + anyDeduction + tsIgnoreDeduction;

  return Math.max(1, score);
}

// ============================================================================
// DimensionResult Builder
// ============================================================================

/**
 * Build a DimensionResult for Dimension 7: Refactoring Need.
 */
function buildDimensionResultFromViolations(
  score: number,
  violations: ConventionViolation[],
  summary: ConventionCheckResult['summary']
): DimensionResult {
  const findings: Finding[] = [];
  const recommendations: Recommendation[] = [];

  // ---- Findings ----

  // HIGH severity: raw fetch
  const fetchViolations = violations.filter(v => v.type === 'rawFetch');
  for (const v of fetchViolations) {
    findings.push({
      description: v.description,
      location: `${v.file}:${v.line}`,
      severity: 'HIGH',
    });
  }

  // HIGH severity: raw JSON.parse(readFileSync())
  const jsonViolations = violations.filter(v => v.type === 'rawJsonParse');
  for (const v of jsonViolations) {
    findings.push({
      description: v.description,
      location: `${v.file}:${v.line}`,
      severity: 'HIGH',
    });
  }

  // MEDIUM severity: any type
  const anyViolations = violations.filter(v => v.type === 'anyType');
  for (const v of anyViolations) {
    findings.push({
      description: v.description,
      location: `${v.file}:${v.line}`,
      severity: 'MEDIUM',
    });
  }

  // MEDIUM severity: ts-ignore/ts-expect-error
  const tsIgnoreViolations = violations.filter(v => v.type === 'tsIgnore');
  for (const v of tsIgnoreViolations) {
    findings.push({
      description: v.description,
      location: `${v.file}:${v.line}`,
      severity: 'MEDIUM',
    });
  }

  // LOW severity: console.error (informational)
  const consoleViolations = violations.filter(v => v.type === 'consoleError');
  if (consoleViolations.length > 0) {
    findings.push({
      description: `${consoleViolations.length} console.error() call(s) — consider structured error handling`,
      location: consoleViolations.map(v => `${v.file}:${v.line}`).join(', '),
      severity: 'LOW',
    });
  }

  // LOW severity: missing Zod (informational)
  const missingZodViolations = violations.filter(v => v.type === 'missingZod');
  for (const v of missingZodViolations) {
    findings.push({
      description: v.description,
      location: v.file,
      severity: 'LOW',
    });
  }

  if (findings.length === 0) {
    findings.push({
      description: 'No convention violations detected',
      severity: 'LOW',
    });
  }

  // ---- Recommendations ----

  if (summary.rawFetchCount > 0) {
    recommendations.push({
      action: `Replace ${summary.rawFetchCount} raw fetch() call(s) with CachedHTTPClient`,
      priority: 'P1',
      effort: 'S',
      impact: 'HIGH',
      dimension: 'refactoringNeed',
    });
  }

  if (summary.rawJsonParseCount > 0) {
    recommendations.push({
      action: `Replace ${summary.rawJsonParseCount} raw JSON.parse(readFileSync()) call(s) with StateManager`,
      priority: 'P1',
      effort: 'S',
      impact: 'HIGH',
      dimension: 'refactoringNeed',
    });
  }

  if (summary.anyTypeCount > 0) {
    recommendations.push({
      action: `Eliminate ${summary.anyTypeCount} \`: any\` type usage(s) with proper generics or type narrowing`,
      priority: 'P2',
      effort: 'M',
      impact: 'MEDIUM',
      dimension: 'refactoringNeed',
    });
  }

  if (summary.tsIgnoreCount > 0) {
    recommendations.push({
      action: `Remove ${summary.tsIgnoreCount} @ts-ignore/@ts-expect-error suppression(s) by fixing root type errors`,
      priority: 'P2',
      effort: 'M',
      impact: 'MEDIUM',
      dimension: 'refactoringNeed',
    });
  }

  if (summary.missingZodCount > 0) {
    recommendations.push({
      action: `Add Zod schema validation to ${summary.missingZodCount} file(s) that accept external input`,
      priority: 'P3',
      effort: 'S',
      impact: 'LOW',
      dimension: 'refactoringNeed',
    });
  }

  return buildDimensionResult(score, findings, recommendations);
}

// ============================================================================
// CLI Interface
// ============================================================================

function printReport(result: ConventionCheckResult): void {
  console.log(`# Convention Check: ${result.skillName}\n`);
  console.log(`**Score:** ${result.score} / 10`);
  console.log(`**Health:** ${result.dimensionResult.health}\n`);

  console.log('## Summary\n');
  console.log(`- **Total Violations:** ${result.summary.totalViolations}`);
  console.log(`- **Raw fetch():** ${result.summary.rawFetchCount} (HIGH)`);
  console.log(`- **Raw JSON.parse(readFileSync()):** ${result.summary.rawJsonParseCount} (HIGH)`);
  console.log(`- **\`: any\` types:** ${result.summary.anyTypeCount} (MEDIUM)`);
  console.log(`- **@ts-ignore/@ts-expect-error:** ${result.summary.tsIgnoreCount} (MEDIUM)`);
  console.log(`- **console.error:** ${result.summary.consoleErrorCount} (informational)`);
  console.log(`- **Missing Zod validation:** ${result.summary.missingZodCount} (informational)`);
  console.log('');

  if (result.violations.length === 0) {
    console.log('No violations found. Skill follows Kaya conventions.\n');
    return;
  }

  // Group violations by type for display
  const high = result.violations.filter(v => v.severity === 'HIGH');
  const medium = result.violations.filter(v => v.severity === 'MEDIUM');
  const low = result.violations.filter(v => v.severity === 'LOW');

  if (high.length > 0) {
    console.log('## HIGH Severity Violations\n');
    for (const v of high) {
      const location = v.line > 0 ? `${v.file}:${v.line}` : v.file;
      console.log(`- **[${v.type}]** ${location}`);
      console.log(`  ${v.description}`);
    }
    console.log('');
  }

  if (medium.length > 0) {
    console.log('## MEDIUM Severity Violations\n');
    for (const v of medium) {
      const location = v.line > 0 ? `${v.file}:${v.line}` : v.file;
      console.log(`- **[${v.type}]** ${location}`);
      console.log(`  ${v.description}`);
    }
    console.log('');
  }

  if (low.length > 0) {
    console.log('## LOW / Informational Violations\n');
    for (const v of low) {
      const location = v.line > 0 ? `${v.file}:${v.line}` : v.file;
      console.log(`- **[${v.type}]** ${location}`);
      console.log(`  ${v.description}`);
    }
    console.log('');
  }

  if (result.dimensionResult.recommendations.length > 0) {
    console.log('## Recommendations\n');
    for (let i = 0; i < result.dimensionResult.recommendations.length; i++) {
      const r = result.dimensionResult.recommendations[i];
      console.log(`${i + 1}. [${r.priority}] ${r.action}`);
    }
    console.log('');
  }
}

function main(): void {
  const args = process.argv.slice(2);
  const jsonOutput = args.includes('--json');
  const skillName = args.find(a => !a.startsWith('--'));

  if (!skillName) {
    console.log('Usage: bun run ConventionChecker.ts <skill-name>');
    console.log('       bun run ConventionChecker.ts Browser');
    console.log('       bun run ConventionChecker.ts Browser --json');
    process.exit(1);
  }

  const result = checkConventions(skillName);

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
