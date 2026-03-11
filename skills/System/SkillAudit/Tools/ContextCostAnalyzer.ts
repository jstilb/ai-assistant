#!/usr/bin/env bun
/**
 * ContextCostAnalyzer - Dimension 5: Context Efficiency
 *
 * Measures context token consumption and trigger precision for a skill.
 * Pure deterministic — no LLM calls. Scores against SCORING.contextEfficiency.
 *
 * Usage:
 *   bun run ContextCostAnalyzer.ts <skill-name>
 *   bun run ContextCostAnalyzer.ts Browser
 *   bun run ContextCostAnalyzer.ts Browser --json
 */

import { join } from 'path';
import {
  SKILLS_DIR,
  SCORING,
  MAX_DESCRIPTION_TOKENS,
  TOKEN_EXCESS_PENALTY_PER,
  AMBIGUOUS_TRIGGERS,
  FALSE_POSITIVE_TRIGGERS,
} from './constants';
import {
  getSkillPath,
  getSkillFiles,
  safeReadFile,
  skillExists,
  extractTriggers,
  countWords,
} from './utils';
import type { Finding, Recommendation, DimensionResult } from './report-builder';
import { buildDimensionResult } from './report-builder';

// ============================================================================
// Types
// ============================================================================

export interface ContextCostResult {
  skillName: string;
  score: number;
  dimensionResult: DimensionResult;
  details: {
    descriptionTokenEstimate: number;
    descriptionCharCount: number;
    triggerCount: number;
    ambiguousTriggers: string[];
    falsePositiveTriggers: string[];
    hasUseWhen: boolean;
    skillMdWordCount: number;
  };
}

// ============================================================================
// Core Function
// ============================================================================

/**
 * Analyze context cost and trigger precision for a skill.
 * Returns null if the skill does not exist.
 */
export function analyzeContextCost(skillName: string): ContextCostResult | null {
  if (!skillExists(skillName)) {
    return null;
  }

  const files = getSkillFiles(skillName);
  const skillMdContent = files.skillMd ? safeReadFile(files.skillMd) : null;

  const findings: Finding[] = [];
  const recommendations: Recommendation[] = [];

  // ── 1. Extract description line ─────────────────────────────────────────

  const descMatch = skillMdContent?.match(/^description:\s*(.+?)(?:\n|$)/im) ?? null;
  const descriptionText = descMatch ? descMatch[1].trim() : '';
  const descriptionCharCount = descriptionText.length;

  // ── 2. Token estimation ─────────────────────────────────────────────────

  const descriptionWordCount = descriptionText ? countWords(descriptionText) : 0;
  const descriptionTokenEstimate = Math.round(descriptionWordCount * 1.3);

  // ── 3. Trigger analysis ─────────────────────────────────────────────────

  const rawTriggers = skillMdContent ? extractTriggers(skillMdContent) : [];
  const triggerCount = rawTriggers.length;

  // Normalize triggers to individual words for matching against word lists
  const triggerWords: string[] = rawTriggers.flatMap(t =>
    t.toLowerCase().split(/\s+/).filter(Boolean)
  );

  const ambiguousFound: string[] = triggerWords.filter(w =>
    AMBIGUOUS_TRIGGERS.includes(w)
  );
  const falsePositiveFound: string[] = triggerWords.filter(w =>
    FALSE_POSITIVE_TRIGGERS.includes(w)
  );

  // Deduplicate
  const ambiguousTriggers = [...new Set(ambiguousFound)];
  const falsePositiveTriggers = [...new Set(falsePositiveFound)];

  // ── 4. USE WHEN presence ────────────────────────────────────────────────

  const hasUseWhen = descriptionText.toUpperCase().includes('USE WHEN');

  // ── 5. SKILL.md total size ──────────────────────────────────────────────

  const skillMdWordCount = skillMdContent ? countWords(skillMdContent) : 0;

  // ── Scoring ─────────────────────────────────────────────────────────────

  let score = 10;

  // Deduct for excess tokens over MAX_DESCRIPTION_TOKENS
  const excessTokens = Math.max(0, descriptionTokenEstimate - MAX_DESCRIPTION_TOKENS);
  if (excessTokens > 0) {
    const deduction = Math.floor(excessTokens / TOKEN_EXCESS_PENALTY_PER) *
      Math.abs(SCORING.contextEfficiency.perExcessTokens);
    score -= deduction;

    findings.push({
      description: `Description token estimate ${descriptionTokenEstimate} exceeds target ${MAX_DESCRIPTION_TOKENS} by ${excessTokens} tokens`,
      severity: excessTokens > TOKEN_EXCESS_PENALTY_PER * 3 ? 'HIGH' : 'MEDIUM',
    });
    recommendations.push({
      action: `Shorten description to under ${MAX_DESCRIPTION_TOKENS} tokens (currently ~${descriptionTokenEstimate})`,
      priority: excessTokens > TOKEN_EXCESS_PENALTY_PER * 3 ? 'P1' : 'P2',
      effort: 'S',
      impact: 'MEDIUM',
      dimension: 'contextEfficiency',
    });
  }

  // Deduct for ambiguous trigger words (cap at 3 deductions)
  const ambiguousDeductionCount = Math.min(ambiguousTriggers.length, 3);
  if (ambiguousDeductionCount > 0) {
    score += ambiguousDeductionCount * SCORING.contextEfficiency.ambiguousTrigger; // negative value

    findings.push({
      description: `${ambiguousTriggers.length} ambiguous trigger word(s) detected: ${ambiguousTriggers.join(', ')}`,
      severity: 'MEDIUM',
    });
    recommendations.push({
      action: `Replace ambiguous trigger words (${ambiguousTriggers.join(', ')}) with specific phrases`,
      priority: 'P2',
      effort: 'S',
      impact: 'MEDIUM',
      dimension: 'contextEfficiency',
    });
  }

  // Deduct for false-positive-prone trigger words (cap at 4 deductions mapped to 2 triggers)
  const falsePosDeductionCount = Math.min(falsePositiveTriggers.length, 2);
  if (falsePosDeductionCount > 0) {
    score += falsePosDeductionCount * SCORING.contextEfficiency.falsePositiveTrigger; // negative value

    findings.push({
      description: `${falsePositiveTriggers.length} false-positive-prone trigger word(s) detected: ${falsePositiveTriggers.join(', ')}`,
      severity: 'HIGH',
    });
    recommendations.push({
      action: `Remove false-positive-prone trigger words (${falsePositiveTriggers.join(', ')}) — they match too broadly`,
      priority: 'P1',
      effort: 'S',
      impact: 'HIGH',
      dimension: 'contextEfficiency',
    });
  }

  // Deduct for missing USE WHEN
  if (!hasUseWhen) {
    score += SCORING.contextEfficiency.missingUseWhen; // negative value

    findings.push({
      description: 'Description does not contain "USE WHEN" directive — ContextRouter cannot route precisely',
      severity: 'HIGH',
    });
    recommendations.push({
      action: 'Add "USE WHEN" to the SKILL.md description frontmatter to guide precise routing',
      priority: 'P1',
      effort: 'S',
      impact: 'HIGH',
      dimension: 'contextEfficiency',
    });
  }

  // Additional informational finding for long description character count
  if (descriptionCharCount > 200) {
    findings.push({
      description: `Description is ${descriptionCharCount} characters (threshold: 200) — increases ContextRouter load`,
      severity: 'LOW',
    });
  }

  // Floor at 1
  score = Math.max(1, score);

  const dimensionResult = buildDimensionResult(score, findings, recommendations);

  return {
    skillName,
    score: dimensionResult.score,
    dimensionResult,
    details: {
      descriptionTokenEstimate,
      descriptionCharCount,
      triggerCount,
      ambiguousTriggers,
      falsePositiveTriggers,
      hasUseWhen,
      skillMdWordCount,
    },
  };
}

// ============================================================================
// CLI Interface
// ============================================================================

function printReport(result: ContextCostResult): void {
  const healthEmoji: Record<string, string> = {
    GREEN: '🟢',
    YELLOW: '🟡',
    RED: '🔴',
  };

  const { dimensionResult: dr, details } = result;
  const emoji = healthEmoji[dr.health] ?? '';

  console.log(`# Context Cost Analysis: ${result.skillName}\n`);
  console.log(`**Dimension:** 5 — Context Efficiency`);
  console.log(`**Score:** ${result.score} / 10 | **Health:** ${emoji} ${dr.health}\n`);

  console.log('## Details\n');
  console.log(`| Metric | Value |`);
  console.log(`|--------|-------|`);
  console.log(`| Description token estimate | ${details.descriptionTokenEstimate} (target: <${MAX_DESCRIPTION_TOKENS}) |`);
  console.log(`| Description character count | ${details.descriptionCharCount} |`);
  console.log(`| Trigger count | ${details.triggerCount} |`);
  console.log(`| Ambiguous trigger words | ${details.ambiguousTriggers.length > 0 ? details.ambiguousTriggers.join(', ') : 'none'} |`);
  console.log(`| False-positive trigger words | ${details.falsePositiveTriggers.length > 0 ? details.falsePositiveTriggers.join(', ') : 'none'} |`);
  console.log(`| USE WHEN present | ${details.hasUseWhen ? 'yes' : 'no'} |`);
  console.log(`| SKILL.md word count | ${details.skillMdWordCount} |`);
  console.log('');

  if (dr.findings.length === 0) {
    console.log('## Findings\n');
    console.log('No issues found.\n');
    return;
  }

  console.log('## Findings\n');
  for (let i = 0; i < dr.findings.length; i++) {
    const f = dr.findings[i];
    console.log(`${i + 1}. [${f.severity}] ${f.description}`);
  }
  console.log('');

  if (dr.recommendations.length > 0) {
    console.log('## Recommendations\n');
    for (let i = 0; i < dr.recommendations.length; i++) {
      const r = dr.recommendations[i];
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
    console.log('Usage: bun run ContextCostAnalyzer.ts <skill-name>');
    console.log('       bun run ContextCostAnalyzer.ts Browser');
    console.log('       bun run ContextCostAnalyzer.ts Browser --json');
    process.exit(1);
  }

  const result = analyzeContextCost(skillName);

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
