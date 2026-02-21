#!/usr/bin/env bun
/**
 * SkillInventory - Shared skill discovery module
 *
 * Provides unified skill discovery and inventory collection
 * used by all SkillAudit workflows.
 *
 * Usage (CLI):
 *   bun run SkillInventory.ts                    # List all skills
 *   bun run SkillInventory.ts Browser            # Single skill inventory
 *   bun run SkillInventory.ts --json             # JSON output
 *   bun run SkillInventory.ts --summary          # Quick summary
 *
 * Usage (Import):
 *   import { collectInventory, collectAllInventories } from './SkillInventory';
 */

import { existsSync, statSync } from 'fs';
import { join, basename } from 'path';
import { SKILLS_DIR, MAX_WORKFLOWS_IDEAL, MIN_LINES_SUBSTANTIAL } from './constants';
import {
  getSkillDirectories,
  getSkillPath,
  getSkillFiles,
  safeReadFile,
  isTitleCase,
  countLines,
  countWords,
  extractTriggers,
  getDateString,
} from './utils';
import { extractDependenciesFromContent, type SkillDependencies } from './DependencyMapper';

// ============================================================================
// Types
// ============================================================================

export interface FileInventory {
  skillMd: string | null;
  workflows: string[];
  tools: string[];
  otherMd: string[];
  totalFiles: number;
}

export interface MetricAnalysis {
  lineCount: number;
  wordCount: number;
  workflowCount: number;
  toolCount: number;
  triggerCount: number;
  complexity: 'simple' | 'moderate' | 'complex';
}

// SkillDependencies is imported from DependencyMapper.ts (canonical implementation)

export interface SkillInventory {
  name: string;
  path: string;
  isPrivate: boolean;
  hasTitleCase: boolean;
  files: FileInventory;
  metrics: MetricAnalysis;
  dependencies: SkillDependencies;
  triggers: string[];
  description: string;
}

export interface InventorySummary {
  totalSkills: number;
  privateSkills: number;
  publicSkills: number;
  totalWorkflows: number;
  totalTools: number;
  averageWorkflows: number;
  complexSkills: string[];
  simpleSkills: string[];
}

// ============================================================================
// Core Functions
// ============================================================================

/**
 * Collect complete inventory for a single skill
 */
export function collectInventory(skillName: string): SkillInventory | null {
  const skillPath = getSkillPath(skillName);

  if (!existsSync(skillPath) || !statSync(skillPath).isDirectory()) {
    return null;
  }

  const files = getSkillFiles(skillName);
  const skillMdContent = files.skillMd ? safeReadFile(files.skillMd) : null;

  // Extract metrics
  const lineCount = skillMdContent ? countLines(skillMdContent) : 0;
  const wordCount = skillMdContent ? countWords(skillMdContent) : 0;
  const triggers = skillMdContent ? extractTriggers(skillMdContent) : [];

  // Determine complexity
  let complexity: 'simple' | 'moderate' | 'complex' = 'simple';
  if (files.workflows.length > MAX_WORKFLOWS_IDEAL || lineCount > 300) {
    complexity = 'complex';
  } else if (files.workflows.length >= 3 || lineCount > MIN_LINES_SUBSTANTIAL) {
    complexity = 'moderate';
  }

  // Extract dependencies from SKILL.md (uses canonical implementation from DependencyMapper)
  const dependencies = extractDependenciesFromContent(skillMdContent);

  // Extract description
  const description = extractDescription(skillMdContent);

  return {
    name: skillName,
    path: skillPath,
    isPrivate: skillName.startsWith('_'),
    hasTitleCase: isTitleCase(skillName),
    files: {
      skillMd: files.skillMd,
      workflows: files.workflows,
      tools: files.tools,
      otherMd: files.otherMd,
      totalFiles: (files.skillMd ? 1 : 0) + files.workflows.length + files.tools.length + files.otherMd.length,
    },
    metrics: {
      lineCount,
      wordCount,
      workflowCount: files.workflows.length,
      toolCount: files.tools.length,
      triggerCount: triggers.length,
      complexity,
    },
    dependencies,
    triggers,
    description,
  };
}

/**
 * Collect inventories for all skills
 */
export function collectAllInventories(includePrivate = true): SkillInventory[] {
  const skillDirs = getSkillDirectories(includePrivate);
  const inventories: SkillInventory[] = [];

  for (const skillName of skillDirs) {
    const inventory = collectInventory(skillName);
    if (inventory) {
      inventories.push(inventory);
    }
  }

  return inventories;
}

/**
 * Generate summary statistics from inventories
 */
export function generateSummary(inventories: SkillInventory[]): InventorySummary {
  const totalWorkflows = inventories.reduce((sum, inv) => sum + inv.metrics.workflowCount, 0);
  const totalTools = inventories.reduce((sum, inv) => sum + inv.metrics.toolCount, 0);
  const privateSkills = inventories.filter(inv => inv.isPrivate).length;

  return {
    totalSkills: inventories.length,
    privateSkills,
    publicSkills: inventories.length - privateSkills,
    totalWorkflows,
    totalTools,
    averageWorkflows: Math.round((totalWorkflows / inventories.length) * 10) / 10,
    complexSkills: inventories.filter(inv => inv.metrics.complexity === 'complex').map(inv => inv.name),
    simpleSkills: inventories.filter(inv => inv.metrics.complexity === 'simple').map(inv => inv.name),
  };
}

/**
 * Get workflow count for a skill (convenience function)
 */
export function getWorkflowCount(skillName: string): number {
  const files = getSkillFiles(skillName);
  return files.workflows.length;
}

/**
 * Get workflow names for a skill
 */
export function getWorkflowNames(skillName: string): string[] {
  const files = getSkillFiles(skillName);
  return files.workflows.map(f => basename(f, '.md'));
}

// ============================================================================
// Helper Functions
// ============================================================================

// extractDependencies is now imported as extractDependenciesFromContent from DependencyMapper.ts

function extractDescription(content: string | null): string {
  if (!content) return '';

  // Try frontmatter description
  const frontmatterMatch = content.match(/description:\s*(.+?)(?:\n|$)/i);
  if (frontmatterMatch) {
    return frontmatterMatch[1].trim();
  }

  // Try first paragraph after heading
  const paragraphMatch = content.match(/^#[^#].+?\n+([^#\n][^\n]+)/m);
  if (paragraphMatch) {
    return paragraphMatch[1].trim().slice(0, 200);
  }

  return '';
}

// ============================================================================
// CLI Interface
// ============================================================================

function printInventory(inv: SkillInventory): void {
  console.log(`# Skill Inventory: ${inv.name}\n`);
  console.log(`**Path:** ${inv.path}`);
  console.log(`**Type:** ${inv.isPrivate ? 'Private' : 'Public'}`);
  console.log(`**Complexity:** ${inv.metrics.complexity}`);
  console.log('');

  if (inv.description) {
    console.log(`**Description:** ${inv.description}\n`);
  }

  console.log('## Files\n');
  console.log(`- **SKILL.md:** ${inv.files.skillMd ? '✓' : '✗'}`);
  console.log(`- **Workflows:** ${inv.metrics.workflowCount}`);
  if (inv.files.workflows.length > 0) {
    for (const wf of inv.files.workflows) {
      console.log(`  - ${basename(wf)}`);
    }
  }
  console.log(`- **Tools:** ${inv.metrics.toolCount}`);
  if (inv.files.tools.length > 0) {
    for (const tool of inv.files.tools) {
      console.log(`  - ${basename(tool)}`);
    }
  }
  console.log('');

  console.log('## Metrics\n');
  console.log(`- **Lines:** ${inv.metrics.lineCount}`);
  console.log(`- **Words:** ${inv.metrics.wordCount}`);
  console.log(`- **Triggers:** ${inv.metrics.triggerCount}`);
  console.log('');

  if (inv.triggers.length > 0) {
    console.log('## Triggers\n');
    for (const trigger of inv.triggers.slice(0, 10)) {
      console.log(`- ${trigger}`);
    }
    if (inv.triggers.length > 10) {
      console.log(`- ... and ${inv.triggers.length - 10} more`);
    }
    console.log('');
  }

  if (inv.dependencies.uses.length > 0 || inv.dependencies.feedsInto.length > 0) {
    console.log('## Dependencies\n');
    if (inv.dependencies.uses.length > 0) {
      console.log(`**Uses:** ${inv.dependencies.uses.join(', ')}`);
    }
    if (inv.dependencies.feedsInto.length > 0) {
      console.log(`**Feeds Into:** ${inv.dependencies.feedsInto.join(', ')}`);
    }
    if (inv.dependencies.mcps.length > 0) {
      console.log(`**MCPs:** ${inv.dependencies.mcps.join(', ')}`);
    }
    console.log('');
  }
}

function printSummary(summary: InventorySummary): void {
  console.log('# Skill Ecosystem Summary\n');
  console.log(`**Generated:** ${getDateString()}\n`);

  console.log('## Overview\n');
  console.log(`- **Total Skills:** ${summary.totalSkills}`);
  console.log(`- **Public Skills:** ${summary.publicSkills}`);
  console.log(`- **Private Skills:** ${summary.privateSkills}`);
  console.log(`- **Total Workflows:** ${summary.totalWorkflows}`);
  console.log(`- **Total Tools:** ${summary.totalTools}`);
  console.log(`- **Average Workflows/Skill:** ${summary.averageWorkflows}`);
  console.log('');

  if (summary.complexSkills.length > 0) {
    console.log('## Complex Skills (>7 workflows or >300 lines)\n');
    for (const skill of summary.complexSkills) {
      console.log(`- ${skill}`);
    }
    console.log('');
  }
}

function main(): void {
  const args = process.argv.slice(2);
  const jsonOutput = args.includes('--json');
  const summaryOnly = args.includes('--summary');
  const skillName = args.find(a => !a.startsWith('--'));

  if (skillName) {
    // Single skill inventory
    const inventory = collectInventory(skillName);
    if (!inventory) {
      console.error(`Skill not found: ${skillName}`);
      process.exit(1);
    }

    if (jsonOutput) {
      console.log(JSON.stringify(inventory, null, 2));
    } else {
      printInventory(inventory);
    }
  } else if (summaryOnly) {
    // Summary only
    const inventories = collectAllInventories();
    const summary = generateSummary(inventories);

    if (jsonOutput) {
      console.log(JSON.stringify(summary, null, 2));
    } else {
      printSummary(summary);
    }
  } else {
    // All skills
    const inventories = collectAllInventories();

    if (jsonOutput) {
      console.log(JSON.stringify(inventories, null, 2));
    } else {
      const summary = generateSummary(inventories);
      printSummary(summary);

      console.log('## All Skills\n');
      console.log('| Skill | Workflows | Tools | Complexity |');
      console.log('|-------|-----------|-------|------------|');
      for (const inv of inventories.sort((a, b) => a.name.localeCompare(b.name))) {
        console.log(`| ${inv.name} | ${inv.metrics.workflowCount} | ${inv.metrics.toolCount} | ${inv.metrics.complexity} |`);
      }
    }
  }
}

// Run CLI if executed directly
if (import.meta.main) {
  main();
}
