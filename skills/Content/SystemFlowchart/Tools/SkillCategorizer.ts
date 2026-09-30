#!/usr/bin/env bun
/**
 * SkillCategorizer.ts
 *
 * Groups Kaya skills into Meta/Orchestration/Specialized display buckets for the
 * skill-ecosystem diagram.
 *
 * Bucket source: each skill's ground-truth parent directory (`SkillInfo.category`,
 * e.g. "Content", "System" — an objective on-disk fact since the 2026-03-03
 * skill-category reorg put every skill under skills/<Category>/<Skill>/). This is a
 * fixed lookup table over that ground truth, not a guess from description/trigger text.
 *
 * Categories:
 * - Meta: Skills about skills/system (parent category "System")
 * - Orchestration: Coordination/execution engines (parent category "Agents"/"Automation")
 * - Specialized: Domain-specific functionality (all other parent categories)
 *
 * Usage:
 *   bun SkillCategorizer.ts                # Categorize all skills
 *   bun SkillCategorizer.ts --json         # JSON output
 *   bun SkillCategorizer.ts --diagram      # Output for diagram generation
 */

import { scanSkills, type SkillInfo } from './SystemScanner.ts';

// ============================================================================
// Types
// ============================================================================

export type SkillCategory = 'Meta' | 'Orchestration' | 'Specialized';

export interface CategorizedSkill extends SkillInfo {
  bucket: SkillCategory;
  categoryReason: string;
}

export interface CategoryGroup {
  category: SkillCategory;
  description: string;
  skills: CategorizedSkill[];
  count: number;
}

export interface CategorizationResult {
  timestamp: string;
  categories: CategoryGroup[];
  skillsByCategory: Record<SkillCategory, string[]>;
  stats: {
    total: number;
    meta: number;
    orchestration: number;
    specialized: number;
  };
}

// ============================================================================
// Category Definitions
// ============================================================================

/**
 * Ground-truth mapping from a skill's parent directory (`SkillInfo.category`, set by
 * `SystemScanner.scanSkills()` from the actual skills/<Category>/<Skill>/ path on disk)
 * to this tool's Meta/Orchestration/Specialized display bucket. Any parent category not
 * listed here defaults to Specialized. No description/trigger text is interpreted.
 */
const CATEGORY_TO_BUCKET: Record<string, SkillCategory> = {
  System: 'Meta',
  Agents: 'Orchestration',
  Automation: 'Orchestration',
};

// ============================================================================
// Categorization Logic
// ============================================================================

/**
 * Determine the display bucket of a skill from its ground-truth parent directory.
 */
export function categorizeSkill(skill: SkillInfo): { bucket: SkillCategory; reason: string } {
  const bucket = CATEGORY_TO_BUCKET[skill.category] ?? 'Specialized';
  const reason = skill.category
    ? `Parent directory category: ${skill.category}`
    : 'No parent category directory found (defaults to Specialized)';
  return { bucket, reason };
}

/**
 * Categorize all skills
 */
export async function categorizeSkills(): Promise<CategorizationResult> {
  const skills = await scanSkills();

  const categorized: CategorizedSkill[] = skills.map(skill => {
    const { bucket, reason } = categorizeSkill(skill);
    return {
      ...skill,
      bucket,
      categoryReason: reason,
    };
  });

  // Group by bucket
  const meta = categorized.filter(s => s.bucket === 'Meta');
  const orchestration = categorized.filter(s => s.bucket === 'Orchestration');
  const specialized = categorized.filter(s => s.bucket === 'Specialized');

  const categories: CategoryGroup[] = [
    {
      category: 'Meta',
      description: 'Skills about skills/system - infrastructure, configuration, visualization',
      skills: meta,
      count: meta.length,
    },
    {
      category: 'Orchestration',
      description: 'Coordination/execution engines - multi-agent, workflows, scheduling',
      skills: orchestration,
      count: orchestration.length,
    },
    {
      category: 'Specialized',
      description: 'Domain-specific functionality - research, automation, content',
      skills: specialized,
      count: specialized.length,
    },
  ];

  return {
    timestamp: new Date().toISOString(),
    categories,
    skillsByCategory: {
      Meta: meta.map(s => s.name),
      Orchestration: orchestration.map(s => s.name),
      Specialized: specialized.map(s => s.name),
    },
    stats: {
      total: skills.length,
      meta: meta.length,
      orchestration: orchestration.length,
      specialized: specialized.length,
    },
  };
}

/**
 * Generate Mermaid diagram data for categorized skills
 */
export async function generateDiagramData(): Promise<string> {
  const result = await categorizeSkills();

  let mermaid = `flowchart TB
    subgraph Meta["Meta Skills"]
        direction TB
`;

  // Add Meta skills
  for (const skill of result.categories[0].skills) {
    const id = skill.name.replace(/[^a-zA-Z0-9]/g, '');
    mermaid += `        ${id}["${skill.name}"]\n`;
  }

  mermaid += `    end

    subgraph Orchestration["Orchestration Skills"]
        direction TB
`;

  // Add Orchestration skills
  for (const skill of result.categories[1].skills) {
    const id = skill.name.replace(/[^a-zA-Z0-9]/g, '');
    mermaid += `        ${id}["${skill.name}"]\n`;
  }

  mermaid += `    end

    subgraph Specialized["Specialized Skills"]
        direction TB
`;

  // Add Specialized skills (grouped in rows for readability)
  const specialized = result.categories[2].skills;
  for (let i = 0; i < specialized.length; i += 4) {
    const row = specialized.slice(i, i + 4);
    for (const skill of row) {
      const id = skill.name.replace(/[^a-zA-Z0-9]/g, '');
      mermaid += `        ${id}["${skill.name}"]\n`;
    }
  }

  mermaid += `    end

    %% Category relationships
    Meta --> Orchestration
    Meta --> Specialized
    Orchestration --> Specialized
`;

  return mermaid;
}

// ============================================================================
// CLI
// ============================================================================

async function main() {
  const args = process.argv.slice(2);
  const isJson = args.includes('--json');
  const isDiagram = args.includes('--diagram');

  if (isDiagram) {
    const diagram = await generateDiagramData();
    console.log(diagram);
    return;
  }

  const result = await categorizeSkills();

  if (isJson) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  // Pretty print
  console.log('\n📊 Kaya Skill Categorization\n');
  console.log(`Total Skills: ${result.stats.total}`);
  console.log(`  Meta: ${result.stats.meta}`);
  console.log(`  Orchestration: ${result.stats.orchestration}`);
  console.log(`  Specialized: ${result.stats.specialized}\n`);

  for (const group of result.categories) {
    console.log(`\n## ${group.category} (${group.count})`);
    console.log(`${group.description}\n`);
    for (const skill of group.skills) {
      const privateTag = skill.isPrivate ? ' [private]' : '';
      console.log(`  - ${skill.name}${privateTag}`);
      console.log(`    Reason: ${skill.categoryReason}`);
    }
  }
}

if (import.meta.main) {
  main().catch(console.error);
}
