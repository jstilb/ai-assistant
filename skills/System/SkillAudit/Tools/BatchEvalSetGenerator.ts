#!/usr/bin/env bun
/**
 * BatchEvalSetGenerator — Generate eval sets for trigger accuracy testing.
 *
 * Creates {query, should_trigger} pairs for each skill by:
 * - should_trigger=true: Natural phrasings of the skill's own USE WHEN triggers
 * - should_trigger=false: Queries from other skills' domains that should NOT match
 *
 * Usage:
 *   bun BatchEvalSetGenerator.ts <registry.json> <output-dir>
 *   bun BatchEvalSetGenerator.ts <registry.json> <output-dir> --skill Gmail
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { SKILLS_DIR } from './constants';
import { safeReadFile, extractTriggers } from './utils';

interface EvalQuery {
  query: string;
  should_trigger: boolean;
}

interface RegistryEntry {
  name: string;
  canonicalPath: string;
  type: 'leaf' | 'router';
  tier: string;
  category: string;
}

// ============================================================================
// Query Templates
// ============================================================================

const POSITIVE_TEMPLATES = [
  (trigger: string) => `${trigger}`,
  (trigger: string) => `I need to ${trigger}`,
  (trigger: string) => `Can you help me with ${trigger}?`,
  (trigger: string) => `Help me ${trigger}`,
  (trigger: string) => `I want to ${trigger}`,
  (trigger: string) => `How do I ${trigger}?`,
  (trigger: string) => `Please ${trigger}`,
  (trigger: string) => `Let's ${trigger}`,
  (trigger: string) => `${trigger} for me`,
  (trigger: string) => `I'd like to ${trigger}`,
  (trigger: string) => `Could you ${trigger}?`,
  (trigger: string) => `Run ${trigger}`,
];

// Generic queries that should not trigger any specific skill
const GENERIC_NEGATIVE_QUERIES = [
  'What is the weather like today?',
  'Tell me a joke',
  'What time is it?',
  'Explain quantum computing',
  'What is the meaning of life?',
  'How do computers work?',
  'Write a poem about the ocean',
  'What is 2 + 2?',
  'Summarize the history of the internet',
  'What are the planets in our solar system?',
  'Translate hello to French',
  'What is machine learning?',
  'Explain photosynthesis',
  'Who invented the telephone?',
  'What is a black hole?',
];

// ============================================================================
// Core Logic
// ============================================================================

function getSkillTriggers(canonicalPath: string): string[] {
  const skillMdPath = join(SKILLS_DIR, canonicalPath, 'SKILL.md');
  const content = safeReadFile(skillMdPath);
  if (!content) return [];
  return extractTriggers(content);
}

function getSkillDescription(canonicalPath: string): string {
  const skillMdPath = join(SKILLS_DIR, canonicalPath, 'SKILL.md');
  const content = safeReadFile(skillMdPath);
  if (!content) return '';
  const match = content.match(/description:\s*(.+?)(?:\n|$)/i);
  return match ? match[1].trim() : '';
}

/**
 * Build a pool of negative queries from other skills' trigger domains.
 * Returns queries grouped by source skill for diversity.
 */
function buildNegativePool(
  allEntries: RegistryEntry[],
  excludeSkill: string
): string[] {
  const negatives: string[] = [];

  for (const entry of allEntries) {
    if (entry.name === excludeSkill) continue;

    const triggers = getSkillTriggers(entry.canonicalPath);
    for (const trigger of triggers.slice(0, 3)) {
      // Create natural queries from other skills' triggers
      const templateIdx = Math.floor(Math.random() * POSITIVE_TEMPLATES.length);
      negatives.push(POSITIVE_TEMPLATES[templateIdx](trigger));
    }
  }

  return negatives;
}

/**
 * Generate an eval set for a single skill.
 * Returns 10 should-trigger + 10 should-not-trigger queries.
 */
function generateEvalSet(
  entry: RegistryEntry,
  allEntries: RegistryEntry[],
  targetPositive: number = 10,
  targetNegative: number = 10
): EvalQuery[] {
  const queries: EvalQuery[] = [];
  const triggers = getSkillTriggers(entry.canonicalPath);
  const description = getSkillDescription(entry.canonicalPath);

  // ── Positive queries (should_trigger = true) ──
  const usedQueries = new Set<string>();

  // First, use raw triggers with templates
  for (let i = 0; i < triggers.length && queries.length < targetPositive; i++) {
    const trigger = triggers[i];
    const templateIdx = (i * 3) % POSITIVE_TEMPLATES.length; // deterministic but varied
    const query = POSITIVE_TEMPLATES[templateIdx](trigger);
    if (!usedQueries.has(query.toLowerCase())) {
      usedQueries.add(query.toLowerCase());
      queries.push({ query, should_trigger: true });
    }
  }

  // If not enough from triggers, generate from description keywords
  if (queries.length < targetPositive && description) {
    const descWords = description
      .replace(/USE WHEN/i, '')
      .split(/[,|]/)
      .map(w => w.trim())
      .filter(w => w.length > 3);

    for (const phrase of descWords) {
      if (queries.length >= targetPositive) break;
      const query = `I need help with ${phrase.toLowerCase()}`;
      if (!usedQueries.has(query.toLowerCase())) {
        usedQueries.add(query.toLowerCase());
        queries.push({ query, should_trigger: true });
      }
    }
  }

  // Pad with simple trigger mentions if still short
  while (queries.length < targetPositive && triggers.length > 0) {
    const trigger = triggers[queries.length % triggers.length];
    const templateIdx = (queries.length * 7) % POSITIVE_TEMPLATES.length;
    const query = POSITIVE_TEMPLATES[templateIdx](trigger);
    if (!usedQueries.has(query.toLowerCase())) {
      usedQueries.add(query.toLowerCase());
      queries.push({ query, should_trigger: true });
    } else {
      // Avoid infinite loop
      break;
    }
  }

  // ── Negative queries (should_trigger = false) ──

  // Mix: 5 from other skills' domains + 5 generic
  const negativePool = buildNegativePool(allEntries, entry.name);

  // Shuffle deterministically using skill name as seed
  const seed = entry.name.split('').reduce((acc, c) => acc + c.charCodeAt(0), 0);
  const shuffled = [...negativePool].sort((a, b) => {
    const ha = hashStr(a + seed.toString());
    const hb = hashStr(b + seed.toString());
    return ha - hb;
  });

  // Pick from other skills
  const otherSkillNegatives = shuffled
    .filter(q => !usedQueries.has(q.toLowerCase()))
    .slice(0, Math.min(5, targetNegative));

  for (const query of otherSkillNegatives) {
    usedQueries.add(query.toLowerCase());
    queries.push({ query, should_trigger: false });
  }

  // Fill remaining from generic pool
  const genericShuffled = [...GENERIC_NEGATIVE_QUERIES].sort((a, b) => {
    const ha = hashStr(a + seed.toString());
    const hb = hashStr(b + seed.toString());
    return ha - hb;
  });

  for (const query of genericShuffled) {
    if (queries.filter(q => !q.should_trigger).length >= targetNegative) break;
    if (!usedQueries.has(query.toLowerCase())) {
      usedQueries.add(query.toLowerCase());
      queries.push({ query, should_trigger: false });
    }
  }

  return queries;
}

function hashStr(s: string): number {
  let hash = 0;
  for (let i = 0; i < s.length; i++) {
    hash = ((hash << 5) - hash + s.charCodeAt(i)) | 0;
  }
  return hash;
}

// ============================================================================
// CLI
// ============================================================================

function main(): void {
  const args = process.argv.slice(2);

  if (args.length < 2) {
    console.log('Usage: bun BatchEvalSetGenerator.ts <registry.json> <output-dir> [--skill <name>]');
    process.exit(1);
  }

  const registryPath = args[0];
  const outputDir = args[1];
  const skillFilter = args.indexOf('--skill') >= 0 ? args[args.indexOf('--skill') + 1] : null;

  if (!existsSync(registryPath)) {
    console.error(`Registry not found: ${registryPath}`);
    process.exit(1);
  }

  const registry = JSON.parse(readFileSync(registryPath, 'utf-8'));
  const entries: RegistryEntry[] = registry.entries;

  const targets = skillFilter
    ? entries.filter(e => e.name === skillFilter)
    : entries;

  if (targets.length === 0) {
    console.error(`No skills found${skillFilter ? ` matching "${skillFilter}"` : ''}`);
    process.exit(1);
  }

  mkdirSync(outputDir, { recursive: true });

  let generated = 0;
  for (const entry of targets) {
    const evalSet = generateEvalSet(entry, entries);
    const outPath = join(outputDir, `${entry.name}-evals.json`);
    writeFileSync(outPath, JSON.stringify(evalSet, null, 2));
    const posCount = evalSet.filter(q => q.should_trigger).length;
    const negCount = evalSet.filter(q => !q.should_trigger).length;
    console.log(`  ${entry.name}: ${posCount}+ / ${negCount}- → ${outPath}`);
    generated++;
  }

  console.log(`\nGenerated ${generated} eval sets in ${outputDir}`);
}

if (import.meta.main) {
  main();
}

export { generateEvalSet, buildNegativePool, getSkillTriggers, getSkillDescription };
export type { EvalQuery, RegistryEntry };
