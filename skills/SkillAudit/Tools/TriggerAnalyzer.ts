#!/usr/bin/env bun
/**
 * TriggerAnalyzer - Analyze trigger overlap between skills
 *
 * Reads skill-index.json and calculates overlap percentages
 * to identify consolidation candidates.
 *
 * Usage:
 *   bun run TriggerAnalyzer.ts [--threshold 60]
 *   bun run TriggerAnalyzer.ts --matrix
 *   bun run TriggerAnalyzer.ts --regenerate  # Regenerate index if missing
 */

import { existsSync } from 'fs';
import { z } from 'zod';
import { createStateManager } from '../../CORE/Tools/StateManager';
import {
  SKILL_INDEX_PATH,
  TRIGGER_OVERLAP_THRESHOLD,
  MIN_TRIGGER_OVERLAP_DISPLAY,
} from './constants';
import {
  getSkillDirectories,
  getSkillPath,
  safeReadFile,
  extractTriggers,
  ensureMemoryDirectories,
} from './utils';

interface SkillEntry {
  name: string;
  path: string;
  fullDescription: string;
  triggers: string[];
  workflows: string[];
  tier: string;
}

interface SkillIndex {
  generated: string;
  totalSkills: number;
  skills: Record<string, SkillEntry>;
}

// Zod schema for SkillIndex validation via StateManager
const SkillEntrySchema = z.object({
  name: z.string(),
  path: z.string(),
  fullDescription: z.string().optional().default(''),
  triggers: z.array(z.string()).optional().default([]),
  workflows: z.array(z.string()).optional().default([]),
  tier: z.string().optional().default(''),
});

const SkillIndexSchema = z.object({
  generated: z.string(),
  totalSkills: z.number(),
  skills: z.record(SkillEntrySchema),
});

interface OverlapResult {
  skillA: string;
  skillB: string;
  overlap: number;
  sharedTriggers: string[];
}

interface FallbackSkillData {
  name: string;
  triggers: string[];
}

/**
 * Load skill index from file using StateManager, returns null if missing or invalid
 */
async function loadSkillIndex(): Promise<SkillIndex | null> {
  if (!existsSync(SKILL_INDEX_PATH)) {
    return null;
  }

  try {
    const manager = createStateManager({
      path: SKILL_INDEX_PATH,
      schema: SkillIndexSchema,
      defaults: { generated: '', totalSkills: 0, skills: {} },
    });
    return await manager.load();
  } catch (error) {
    console.error('Failed to load skill index:', error);
    return null;
  }
}

/**
 * Build fallback skill data by reading SKILL.md files directly
 */
function buildFallbackSkillData(): FallbackSkillData[] {
  console.log('Building skill data from SKILL.md files (fallback mode)...');
  const skillDirs = getSkillDirectories();
  const skills: FallbackSkillData[] = [];

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

/**
 * Convert SkillIndex to array format for analysis
 */
function indexToArray(index: SkillIndex): FallbackSkillData[] {
  return Object.values(index.skills).map(s => ({
    name: s.name,
    triggers: s.triggers || [],
  }));
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

function analyzeOverlaps(skills: FallbackSkillData[], threshold: number): OverlapResult[] {
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

function printMatrix(skills: FallbackSkillData[], minOverlap: number = MIN_TRIGGER_OVERLAP_DISPLAY): void {
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
  const shouldRegenerate = args.includes('--regenerate');

  // Ensure MEMORY directories exist
  ensureMemoryDirectories();

  console.log('# Trigger Overlap Analysis\n');
  console.log(`Generated: ${new Date().toISOString()}`);
  console.log(`Threshold: ${threshold}%\n`);

  // Try to load skill index via StateManager
  let skills: FallbackSkillData[];
  const index = await loadSkillIndex();

  if (!index) {
    console.log('⚠️  skill-index.json not found or invalid.\n');

    if (shouldRegenerate) {
      console.log('To regenerate the index, run:');
      console.log('  bun run ~/.claude/skills/CORE/Tools/GenerateSkillIndex.ts\n');
      console.log('Proceeding with fallback mode (reading SKILL.md files directly)...\n');
    } else {
      console.log('Using fallback mode: reading SKILL.md files directly.');
      console.log('For better performance, regenerate skill-index.json:\n');
      console.log('  bun run ~/.claude/skills/CORE/Tools/GenerateSkillIndex.ts\n');
      console.log('Or run this tool with --regenerate flag for the same suggestion.\n');
    }

    skills = buildFallbackSkillData();
    console.log(`Loaded ${skills.length} skills from SKILL.md files.\n`);
  } else {
    skills = indexToArray(index);
    console.log(`Loaded ${index.totalSkills} skills from skill-index.json.\n`);
  }

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

main().catch(console.error);
