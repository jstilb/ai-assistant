#!/usr/bin/env bun
/**
 * SkillCategorizer.ts
 *
 * Categorizes Kaya skills into Meta/Orchestration/Specialized categories.
 * Based on skill analysis, triggers, and dependencies.
 *
 * Categories:
 * - Meta: Skills about skills/system (CORE, SystemFlowchart, SkillAudit, CreateSkill, System)
 * - Orchestration: Coordination/execution engines (THEALGORITHM, Agents, Council, etc.)
 * - Specialized: Domain-specific functionality (all others)
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
  category: SkillCategory;
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
 * Meta skills - skills about skills/system
 */
const META_SKILLS = new Set([
  'CORE',
  'System',
  'SystemFlowchart',
  'SkillAudit',
  'CreateSkill',
  'GeminiSync',      // System sync
  'PAISync',         // System sync
  'PAIUpgrade',      // System upgrade
]);

/**
 * Meta skill indicators in triggers/description
 */
const META_INDICATORS = [
  'system', 'skill', 'audit', 'integrity', 'architecture',
  'flowchart', 'diagram', 'sync', 'upgrade', 'infrastructure',
];

/**
 * Orchestration skills - coordination/execution engines
 */
const ORCHESTRATION_SKILLS = new Set([
  'THEALGORITHM',
  'Agents',
  'Council',
  'RedTeam',
  '_RALPHLOOP',
  'AutoMaintenance',
  'AutoInfoManager',
  'ContinualLearning',
  'ProactiveEngine',
  'QueueRouter',
  'AutonomousWork',
]);

/**
 * Orchestration indicators in triggers/description
 */
const ORCHESTRATION_INDICATORS = [
  'algorithm', 'agent', 'orchestrat', 'parallel', 'spawn',
  'debate', 'council', 'maintenance', 'workflow', 'queue',
  'autonomous', 'proactive', 'schedule', 'execution', 'coordinate',
];

// ============================================================================
// Categorization Logic
// ============================================================================

/**
 * Determine the category of a skill based on its properties
 */
function categorizeSkill(skill: SkillInfo): { category: SkillCategory; reason: string } {
  const name = skill.name;
  const lowerName = name.toLowerCase();
  const lowerDesc = skill.description.toLowerCase();
  const triggers = skill.triggers.map(t => t.toLowerCase());

  // Check explicit Meta skills
  if (META_SKILLS.has(name)) {
    return { category: 'Meta', reason: 'Explicitly defined as Meta skill' };
  }

  // Check explicit Orchestration skills
  if (ORCHESTRATION_SKILLS.has(name)) {
    return { category: 'Orchestration', reason: 'Explicitly defined as Orchestration skill' };
  }

  // Check for Meta indicators
  const metaMatches = META_INDICATORS.filter(ind =>
    lowerName.includes(ind) ||
    lowerDesc.includes(ind) ||
    triggers.some(t => t.includes(ind))
  );
  if (metaMatches.length >= 2) {
    return { category: 'Meta', reason: `Contains Meta indicators: ${metaMatches.join(', ')}` };
  }

  // Check for Orchestration indicators
  const orchMatches = ORCHESTRATION_INDICATORS.filter(ind =>
    lowerName.includes(ind) ||
    lowerDesc.includes(ind) ||
    triggers.some(t => t.includes(ind))
  );
  if (orchMatches.length >= 2) {
    return { category: 'Orchestration', reason: `Contains Orchestration indicators: ${orchMatches.join(', ')}` };
  }

  // Check dependencies - if it depends heavily on orchestration skills, it might be one
  const orchDeps = skill.dependencies.filter(d => ORCHESTRATION_SKILLS.has(d));
  if (orchDeps.length >= 2) {
    return { category: 'Orchestration', reason: `Depends on Orchestration skills: ${orchDeps.join(', ')}` };
  }

  // Default to Specialized
  return { category: 'Specialized', reason: 'Domain-specific functionality' };
}

/**
 * Categorize all skills
 */
export async function categorizeSkills(): Promise<CategorizationResult> {
  const skills = await scanSkills();

  const categorized: CategorizedSkill[] = skills.map(skill => {
    const { category, reason } = categorizeSkill(skill);
    return {
      ...skill,
      category,
      categoryReason: reason,
    };
  });

  // Group by category
  const meta = categorized.filter(s => s.category === 'Meta');
  const orchestration = categorized.filter(s => s.category === 'Orchestration');
  const specialized = categorized.filter(s => s.category === 'Specialized');

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

main().catch(console.error);
