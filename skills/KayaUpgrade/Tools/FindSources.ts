#!/usr/bin/env bun

/**
 * FindSources.ts - Automated Source Discovery Tool
 *
 * Generates search queries and evaluation frameworks for discovering new
 * sources to add to Kaya upgrade monitoring.
 *
 * Usage:
 *   bun ~/.claude/skills/KayaUpgrade/Tools/FindSources.ts                    # All categories
 *   bun ~/.claude/skills/KayaUpgrade/Tools/FindSources.ts --category mcp     # Specific category
 *   bun ~/.claude/skills/KayaUpgrade/Tools/FindSources.ts --list-categories  # Show available categories
 *   bun ~/.claude/skills/KayaUpgrade/Tools/FindSources.ts --output <file>    # Save queries to file
 *
 * Note: This tool generates search queries for Claude to execute via WebSearch.
 * It does not perform searches directly (WebSearch is a Claude capability).
 *
 * Categories:
 *   - claude-code: Claude Code tutorials, workflows, extensions
 *   - mcp: Model Context Protocol servers, integrations
 *   - ai-agents: Multi-agent systems, orchestration, patterns
 *   - ai-coding: AI-assisted development tools and workflows
 *   - skills: Skill-based AI systems, Claude Skills
 *   - llm-engineering: LLM optimization, prompting, RAG
 *
 * Output:
 *   - Search queries for each category
 *   - Evaluation framework for scoring sources
 *   - Templates for adding sources to config
 */

import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { z } from 'zod';
import { createStateManager } from '../../CORE/Tools/StateManager.ts';

// Types
interface SearchCategory {
  name: string;
  description: string;
  keywords: string[];
  search_templates: string[];
  evaluation_weight: number; // How important this category is for Kaya
}

interface DiscoveredSource {
  name: string;
  url: string;
  type: 'youtube' | 'blog' | 'github' | 'newsletter' | 'other';
  category: string;
  discovered_at: string;
  evaluation?: SourceEvaluation;
}

interface SourceEvaluation {
  relevance: number;      // 1-5: How relevant to Kaya goals
  quality: number;        // 1-5: Content quality and depth
  frequency: number;      // 1-5: Update frequency (5 = very active)
  uniqueness: number;     // 1-5: Unique value vs other sources
  stack_alignment: number; // 1-5: TypeScript/CLI/modern stack alignment
  total_score: number;
  priority: 'HIGH' | 'MEDIUM' | 'LOW';
  notes: string;
}

interface DiscoveredSourcesState {
  last_discovery_timestamp: string;
  evaluated_sources: DiscoveredSource[];
}

// Config
const HOME = homedir();
const SKILL_DIR = join(HOME, '.claude', 'skills', 'KayaUpgrade');
const STATE_DIR = join(SKILL_DIR, 'State');
const STATE_FILE = join(STATE_DIR, 'discovered-sources.json');

// Categories with search patterns
const CATEGORIES: Record<string, SearchCategory> = {
  'claude-code': {
    name: 'Claude Code',
    description: 'Claude Code tutorials, workflows, extensions, and best practices',
    keywords: ['claude code', 'claude-code', 'anthropic claude cli', 'claude terminal'],
    search_templates: [
      'Claude Code tutorial YouTube {year}',
      'Claude Code best practices blog',
      'claude-code GitHub projects',
      'Claude Code workflow automation',
      'Anthropic Claude Code tips',
      'Claude Code vs Cursor comparison'
    ],
    evaluation_weight: 1.5
  },
  'mcp': {
    name: 'Model Context Protocol',
    description: 'MCP servers, tools, and integration patterns',
    keywords: ['model context protocol', 'mcp server', 'mcp tools', 'anthropic mcp'],
    search_templates: [
      'MCP server tutorial YouTube {year}',
      'Model Context Protocol examples GitHub',
      'building MCP servers TypeScript',
      'MCP integration patterns blog',
      'awesome MCP servers list',
      'MCP server development guide'
    ],
    evaluation_weight: 1.4
  },
  'ai-agents': {
    name: 'AI Agents',
    description: 'Multi-agent systems, orchestration, and agent patterns',
    keywords: ['ai agents', 'multi-agent', 'agent orchestration', 'agentic ai'],
    search_templates: [
      'AI agent patterns tutorial YouTube {year}',
      'multi-agent orchestration frameworks',
      'building AI agents TypeScript',
      'agent-based AI systems blog',
      'AI agent architecture patterns',
      'autonomous AI agents development'
    ],
    evaluation_weight: 1.3
  },
  'ai-coding': {
    name: 'AI Coding',
    description: 'AI-assisted development tools and coding workflows',
    keywords: ['ai coding', 'ai programming', 'ai development', 'llm coding'],
    search_templates: [
      'AI coding assistant comparison {year}',
      'AI pair programming tools',
      'LLM for software development blog',
      'AI code generation best practices',
      'AI-assisted development workflow YouTube',
      'AI coding tools GitHub'
    ],
    evaluation_weight: 1.2
  },
  'skills': {
    name: 'Skills & Plugins',
    description: 'Skill-based AI systems, Claude Skills, plugin architectures',
    keywords: ['claude skills', 'ai skills', 'plugin system', 'extension system'],
    search_templates: [
      'Claude Skills tutorial {year}',
      'AI skill system architecture',
      'building AI plugins blog',
      'modular AI systems patterns',
      'skill-based AI assistants',
      'AI extension development'
    ],
    evaluation_weight: 1.4
  },
  'llm-engineering': {
    name: 'LLM Engineering',
    description: 'LLM optimization, prompting techniques, RAG patterns',
    keywords: ['llm engineering', 'prompt engineering', 'rag', 'llm optimization'],
    search_templates: [
      'LLM engineering best practices {year}',
      'advanced prompt engineering guide',
      'RAG implementation patterns',
      'LLM optimization techniques blog',
      'production LLM systems YouTube',
      'LLM application architecture'
    ],
    evaluation_weight: 1.1
  }
};

// Parse args
const args = process.argv.slice(2);
const LIST_CATEGORIES = args.includes('--list-categories');
const categoryIndex = args.indexOf('--category');
const SPECIFIC_CATEGORY = categoryIndex !== -1 ? args[categoryIndex + 1] : null;
const outputIndex = args.indexOf('--output');
const OUTPUT_FILE = outputIndex !== -1 ? args[outputIndex + 1] : null;

// Zod schema for discovered sources state
const SourceEvaluationSchema = z.object({
  relevance: z.number(),
  quality: z.number(),
  frequency: z.number(),
  uniqueness: z.number(),
  stack_alignment: z.number(),
  total_score: z.number(),
  priority: z.enum(['HIGH', 'MEDIUM', 'LOW']),
  notes: z.string(),
});

const DiscoveredSourceSchema = z.object({
  name: z.string(),
  url: z.string(),
  type: z.enum(['youtube', 'blog', 'github', 'newsletter', 'other']),
  category: z.string(),
  discovered_at: z.string(),
  evaluation: SourceEvaluationSchema.optional(),
});

const DiscoveredSourcesStateSchema = z.object({
  last_discovery_timestamp: z.string(),
  evaluated_sources: z.array(DiscoveredSourceSchema),
});

// StateManager for discovered sources state
const discoveredSourcesManager = createStateManager<DiscoveredSourcesState>({
  path: STATE_FILE,
  schema: DiscoveredSourcesStateSchema,
  defaults: () => ({
    last_discovery_timestamp: new Date(0).toISOString(),
    evaluated_sources: []
  }),
});

// Utilities
function ensureDir(dirPath: string): void {
  if (!existsSync(dirPath)) {
    mkdirSync(dirPath, { recursive: true });
  }
}

async function loadState(): Promise<DiscoveredSourcesState> {
  try {
    return await discoveredSourcesManager.load();
  } catch (error) {
    console.warn('⚠️ Failed to load state, starting fresh');
    return {
      last_discovery_timestamp: new Date(0).toISOString(),
      evaluated_sources: []
    };
  }
}

async function saveState(state: DiscoveredSourcesState): Promise<void> {
  await discoveredSourcesManager.save(state);
}

/**
 * Generate search queries for a category
 */
function generateSearchQueries(category: SearchCategory): string[] {
  const currentYear = new Date().getFullYear();
  const queries: string[] = [];

  for (const template of category.search_templates) {
    // Replace {year} with current year
    const query = template.replace('{year}', String(currentYear));
    queries.push(query);
  }

  // Add some variation queries
  for (const keyword of category.keywords.slice(0, 2)) {
    queries.push(`${keyword} YouTube channel`);
    queries.push(`best ${keyword} blogs ${currentYear}`);
    queries.push(`site:github.com ${keyword}`);
  }

  return queries;
}

/**
 * Generate the evaluation framework output
 */
function generateEvaluationFramework(): string {
  return `
## Source Evaluation Framework

Score each discovered source from 1-5 on these criteria:

| Criterion | Weight | Description |
|-----------|--------|-------------|
| **Relevance** | 30% | How directly relevant to Kaya's goals (claude code, agents, skills, etc.) |
| **Quality** | 25% | Content depth, accuracy, and production value |
| **Frequency** | 20% | How often new content is published (5 = weekly+, 1 = dormant) |
| **Uniqueness** | 15% | Unique perspective or expertise not found elsewhere |
| **Stack Alignment** | 10% | TypeScript, CLI-first, modern tooling alignment |

### Priority Assignment

Calculate weighted score:
\`\`\`
total = (relevance * 0.30) + (quality * 0.25) + (frequency * 0.20) +
        (uniqueness * 0.15) + (stack_alignment * 0.10)
\`\`\`

| Score Range | Priority | Action |
|-------------|----------|--------|
| ≥ 4.0 | 🔥 HIGH | Add immediately to monitoring |
| 3.0 - 3.9 | 📌 MEDIUM | Consider adding, review first |
| < 3.0 | 💡 LOW | Optional, low impact expected |

### Source Type Templates

**YouTube Channel:**
\`\`\`json
{
  "name": "[Channel Name]",
  "channel_id": "@[handle]",
  "url": "https://www.youtube.com/@[handle]",
  "priority": "[HIGH|MEDIUM|LOW]",
  "description": "[What this channel covers]"
}
\`\`\`

**GitHub Repository:**
\`\`\`json
{
  "name": "[Repo Name]",
  "owner": "[owner]",
  "repo": "[repo]",
  "priority": "[HIGH|MEDIUM|LOW]",
  "check_commits": true,
  "check_releases": true
}
\`\`\`

**Blog/Newsletter:**
\`\`\`json
{
  "name": "[Blog Name]",
  "url": "[URL]",
  "priority": "[HIGH|MEDIUM|LOW]",
  "type": "blog"
}
\`\`\`
`;
}

/**
 * Calculate priority from scores
 */
function calculatePriority(scores: {
  relevance: number;
  quality: number;
  frequency: number;
  uniqueness: number;
  stack_alignment: number;
}): { total: number; priority: 'HIGH' | 'MEDIUM' | 'LOW' } {
  const total =
    (scores.relevance * 0.30) +
    (scores.quality * 0.25) +
    (scores.frequency * 0.20) +
    (scores.uniqueness * 0.15) +
    (scores.stack_alignment * 0.10);

  let priority: 'HIGH' | 'MEDIUM' | 'LOW' = 'LOW';
  if (total >= 4.0) priority = 'HIGH';
  else if (total >= 3.0) priority = 'MEDIUM';

  return { total, priority };
}

/**
 * Generate discovery task output for a single category
 */
function generateCategoryOutput(categoryKey: string, category: SearchCategory): string {
  const queries = generateSearchQueries(category);

  let output = `
### ${category.name}

**Description:** ${category.description}

**Keywords:** ${category.keywords.join(', ')}

**Evaluation Weight:** ${category.evaluation_weight}x (higher = more important for Kaya)

**Search Queries to Execute:**

${queries.map((q, i) => `${i + 1}. \`${q}\``).join('\n')}

**What to Look For:**
- YouTube channels with regular content on ${category.keywords[0]}
- Blogs with technical depth (not just news aggregation)
- GitHub repos with active maintenance (commits in last 3 months)
- Newsletters with curated, high-signal content

`;

  return output;
}

// Main execution
async function main() {
  // Handle --list-categories
  if (LIST_CATEGORIES) {
    console.log('Available Categories:\n');
    for (const [key, category] of Object.entries(CATEGORIES)) {
      console.log(`  ${key}`);
      console.log(`    ${category.description}`);
      console.log(`    Weight: ${category.evaluation_weight}x`);
      console.log();
    }
    return;
  }

  console.log('🔍 Kaya Source Discovery Tool\n');
  console.log(`📅 Date: ${new Date().toISOString().split('T')[0]}`);
  console.log();

  // Determine which categories to process
  let categoriesToProcess: [string, SearchCategory][] = [];

  if (SPECIFIC_CATEGORY) {
    if (!(SPECIFIC_CATEGORY in CATEGORIES)) {
      console.error(`❌ Unknown category: ${SPECIFIC_CATEGORY}`);
      console.log(`Use --list-categories to see available options.`);
      process.exit(1);
    }
    categoriesToProcess = [[SPECIFIC_CATEGORY, CATEGORIES[SPECIFIC_CATEGORY]]];
    console.log(`📂 Processing category: ${SPECIFIC_CATEGORY}\n`);
  } else {
    categoriesToProcess = Object.entries(CATEGORIES);
    console.log(`📂 Processing all ${categoriesToProcess.length} categories\n`);
  }

  // Generate output
  let fullOutput = `# Kaya Source Discovery Report

**Generated:** ${new Date().toISOString()}
**Categories:** ${categoriesToProcess.map(([k]) => k).join(', ')}

---

## How to Use This Report

1. **Execute the search queries** listed below using Claude's WebSearch capability
2. **Evaluate each discovered source** using the evaluation framework
3. **Add high-scoring sources** to the appropriate config files:
   - YouTube channels → \`youtube-channels.json\`
   - GitHub repos → \`sources.json\`
   - Blogs → Request addition to base monitoring

---
${generateEvaluationFramework()}
---

## Search Queries by Category

`;

  // Process each category
  for (const [key, category] of categoriesToProcess) {
    fullOutput += generateCategoryOutput(key, category);
    fullOutput += '---\n';
  }

  // Add quick reference section
  fullOutput += `
## Quick Reference: Where to Add Sources

| Source Type | Config File | Location |
|-------------|-------------|----------|
| YouTube Channels | \`youtube-channels.json\` | \`~/.claude/skills/KayaUpgrade/\` or USER customization |
| GitHub Repos | \`sources.json\` | \`~/.claude/skills/KayaUpgrade/\` |
| Blogs/Changelogs | \`sources.json\` | \`~/.claude/skills/KayaUpgrade/\` |

### YouTube Channel Configuration

YouTube channels are configured in \`youtube-channels.json\` in the KayaUpgrade skill directory.

---

## Next Steps

1. Copy search queries from the category you want to explore
2. Run them through Claude's WebSearch
3. For each promising result, evaluate using the framework
4. Add high-scoring sources to the appropriate config
5. Run \`check for upgrades\` to start monitoring new sources

`;

  // Output result
  if (OUTPUT_FILE) {
    ensureDir(dirname(OUTPUT_FILE));
    writeFileSync(OUTPUT_FILE, fullOutput, 'utf-8');
    console.log(`✅ Discovery report saved to: ${OUTPUT_FILE}`);
  } else {
    console.log(fullOutput);
  }

  // Update state
  const state = await loadState();
  state.last_discovery_timestamp = new Date().toISOString();
  await saveState(state);

  console.log('═'.repeat(80));
  console.log('\n📊 STATUS: Source discovery queries generated');
  console.log('➡️ NEXT: Execute search queries via WebSearch and evaluate results');
  console.log('💡 TIP: Use --category <name> to focus on a specific category');
  console.log();
}

main().catch(error => {
  console.error('❌ Fatal error:', error);
  process.exit(1);
});
