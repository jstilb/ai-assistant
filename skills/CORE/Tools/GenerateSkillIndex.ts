#!/usr/bin/env bun
/**
 * GenerateSkillIndex.ts
 *
 * Parses all SKILL.md files and builds a searchable index for dynamic skill discovery.
 * Run this after adding/modifying skills to update the index.
 *
 * Usage: bun run ~/.claude/skills/CORE/Tools/GenerateSkillIndex.ts
 *
 * Output: ~/.claude/skills/skill-index.json
 */

import { readdir, readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import { existsSync } from 'fs';
import { homedir } from 'os';

const KAYA_HOME = process.env.KAYA_HOME || join(homedir(), ".claude");
const SKILLS_DIR = join(KAYA_HOME, 'skills');
const OUTPUT_FILE = join(SKILLS_DIR, 'skill-index.json');

interface SkillEntry {
  name: string;
  path: string;
  fullDescription: string;
  triggers: string[];
  workflows: string[];
  tier: 'always' | 'deferred';
}

interface SkillIndex {
  generated: string;
  totalSkills: number;
  alwaysLoadedCount: number;
  deferredCount: number;
  skills: Record<string, SkillEntry>;
}

// Skills that should always be fully loaded (Tier 1)
const ALWAYS_LOADED_SKILLS = [
  'CORE',
  'Development',
  'Research',
  'Blogging',
  'Art',
];

async function findSkillFiles(dir: string): Promise<string[]> {
  const skillFiles: string[] = [];

  try {
    const entries = await readdir(dir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = join(dir, entry.name);

      if (entry.isDirectory()) {
        // Skip hidden directories and node_modules
        if (entry.name.startsWith('.') || entry.name === 'node_modules') {
          continue;
        }

        // Check for SKILL.md in this directory
        const skillMdPath = join(fullPath, 'SKILL.md');
        if (existsSync(skillMdPath)) {
          skillFiles.push(skillMdPath);
        }

        // Recurse into subdirectories (for nested skills)
        const nestedFiles = await findSkillFiles(fullPath);
        skillFiles.push(...nestedFiles);
      }
    }
  } catch (error) {
    console.error(`Error scanning directory ${dir}:`, error);
  }

  return skillFiles;
}

function parseFrontmatter(content: string): { name: string; description: string } | null {
  const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (!frontmatterMatch) return null;

  const frontmatter = frontmatterMatch[1];

  // Extract name
  const nameMatch = frontmatter.match(/^name:\s*(.+)$/m);
  const name = nameMatch ? nameMatch[1].trim() : '';

  // Extract description (can be multi-line with |)
  let description = '';
  const descMatch = frontmatter.match(/^description:\s*\|?\s*([\s\S]*?)(?=\n[a-z]+:|$)/m);
  if (descMatch) {
    description = descMatch[1]
      .split('\n')
      .map(line => line.trim())
      .filter(line => line)
      .join(' ')
      .trim();
  }

  return { name, description };
}

function extractTriggers(description: string): string[] {
  const triggers: string[] = [];

  // Extract from USE WHEN patterns
  const useWhenMatch = description.match(/USE WHEN[^.]+/gi);
  if (useWhenMatch) {
    for (const match of useWhenMatch) {
      // Extract quoted phrases and keywords
      const words = match
        .replace(/USE WHEN/gi, '')
        .replace(/user (says|wants|mentions|asks)/gi, '')
        .replace(/['"]/g, '')
        .split(/[,\s]+/)
        .map(w => w.toLowerCase().trim())
        .filter(w => w.length > 2 && !['the', 'and', 'for', 'with', 'from', 'about'].includes(w));

      triggers.push(...words);
    }
  }

  // Also extract key terms from the description
  const keyTerms = description
    .toLowerCase()
    .match(/\b(scrape|parse|extract|research|blog|art|visual|mcp|osint|newsletter|voice|browser|automation|security|vuln|recon|upgrade|telos|gmail|youtube|clickup|cloudflare|lifelog|headshot|council|eval|fabric|dotfiles)\b/g);

  if (keyTerms) {
    triggers.push(...keyTerms);
  }

  // Deduplicate
  return [...new Set(triggers)];
}

function extractWorkflows(content: string): string[] {
  const workflows: string[] = [];

  // Look for workflow routing section
  const workflowMatches = content.matchAll(/[-*]\s*\*\*([A-Z][A-Z_]+)\*\*|→\s*`Workflows\/([^`]+)\.md`|[-*]\s*([A-Za-z]+)\s*→\s*`/g);

  for (const match of workflowMatches) {
    const workflow = match[1] || match[2] || match[3];
    if (workflow) {
      workflows.push(workflow);
    }
  }

  // Also check for workflow files mentioned
  const workflowFileMatches = content.matchAll(/Workflows?\/([A-Za-z]+)\.md/g);
  for (const match of workflowFileMatches) {
    if (match[1] && !workflows.includes(match[1])) {
      workflows.push(match[1]);
    }
  }

  return [...new Set(workflows)];
}

async function parseSkillFile(filePath: string): Promise<SkillEntry | null> {
  try {
    const content = await readFile(filePath, 'utf-8');
    const frontmatter = parseFrontmatter(content);

    if (!frontmatter || !frontmatter.name) {
      console.warn(`Skipping ${filePath}: No valid frontmatter`);
      return null;
    }

    const triggers = extractTriggers(frontmatter.description);
    const workflows = extractWorkflows(content);
    const tier = ALWAYS_LOADED_SKILLS.includes(frontmatter.name) ? 'always' : 'deferred';

    return {
      name: frontmatter.name,
      path: filePath.replace(SKILLS_DIR, '').replace(/^\//, ''),
      fullDescription: frontmatter.description,
      triggers,
      workflows,
      tier,
    };
  } catch (error) {
    console.error(`Error parsing ${filePath}:`, error);
    return null;
  }
}

// Skill categorization for markdown output
const CATEGORIES: Record<string, string[]> = {
  'Automation & Workflows': [
    'calendarassistant', 'gmail', 'telegram', 'proactiveengine',
    'automaintenance', 'autonomouswork', 'autoinfomanager'
  ],
  'Research & Analysis': [
    'osint', 'firstprinciples', 'council', 'redteam', 'fabric',
    'thealgorithm', 'becreative', 'specsheet'
  ],
  'Development & Security': [
    'browser', 'createcli', 'createskill', 'webassessment',
    'promptinjection', 'recon', 'agentprojectsetup', 'evals'
  ],
  'Content & Knowledge': [
    'telos', 'informationmanager', 'documents', 'anki',
    'pdf', 'docx', 'pptx', 'xlsx'
  ],
  'Shopping & Services': [
    'shopping', 'instacart', 'cooking', 'designer'
  ],
  'System Management': [
    'system', 'paisync', 'paiupgrade', 'queuerouter',
    'skillaudit', 'systemflowchart', 'geminisync'
  ],
  'Web Scraping': [
    'brightdata', 'apify'
  ],
  'CLI Tools': [
    'unixcli'
  ],
  'Agents': [
    'agents', '_ralphloop'
  ]
};

function categorizeSkill(skillKey: string): string | null {
  for (const [category, keys] of Object.entries(CATEGORIES)) {
    if (keys.includes(skillKey.toLowerCase())) {
      return category;
    }
  }
  return null;
}

function getTopTriggers(triggers: string[], max: number = 3): string {
  const filtered = triggers
    .filter(t => t.length > 2 && !['any', 'when', 'use', 'the', 'for'].includes(t.toLowerCase()))
    .slice(0, max);
  return filtered.join(', ');
}

function generateMarkdown(index: SkillIndex): string {
  const lines: string[] = [];

  lines.push(`# Kaya Skill Index (${index.totalSkills} Skills)`);
  lines.push('');
  lines.push('**Auto-loaded at session start.** Compact reference for available skills and their triggers.');
  lines.push('');
  lines.push('---');
  lines.push('');

  // Always Loaded section
  const alwaysLoaded = Object.entries(index.skills)
    .filter(([_, skill]) => skill.tier === 'always');

  lines.push(`## Always Loaded (${alwaysLoaded.length})`);
  lines.push('');
  lines.push('| Skill | Description | Triggers |');
  lines.push('|-------|-------------|----------|');

  for (const [key, skill] of alwaysLoaded) {
    const shortDesc = skill.fullDescription.split('.')[0].replace(/USE WHEN.*$/i, '').trim();
    const triggers = getTopTriggers(skill.triggers);
    lines.push(`| **${skill.name}** | ${shortDesc} | ${triggers} |`);
  }
  lines.push('');
  lines.push('---');
  lines.push('');

  // Categorized skills
  const categorized = new Map<string, Array<[string, SkillEntry]>>();

  for (const [key, skill] of Object.entries(index.skills)) {
    if (skill.tier === 'always') continue;

    const category = categorizeSkill(key);
    if (category) {
      if (!categorized.has(category)) {
        categorized.set(category, []);
      }
      categorized.get(category)!.push([key, skill]);
    }
  }

  for (const category of Object.keys(CATEGORIES)) {
    const skills = categorized.get(category);
    if (!skills || skills.length === 0) continue;

    lines.push(`## ${category}`);
    lines.push('');
    lines.push('| Skill | Description | Triggers |');
    lines.push('|-------|-------------|----------|');

    for (const [key, skill] of skills) {
      const shortDesc = skill.fullDescription.split('.')[0].replace(/USE WHEN.*$/i, '').trim();
      const triggers = getTopTriggers(skill.triggers);
      lines.push(`| ${skill.name} | ${shortDesc} | ${triggers} |`);
    }
    lines.push('');
    lines.push('---');
    lines.push('');
  }

  // Private skills
  const privateSkills = Object.entries(index.skills)
    .filter(([key, _]) => key.startsWith('_'));

  if (privateSkills.length > 0) {
    lines.push('## Private Skills (_PREFIX)');
    lines.push('');
    lines.push('| Skill | Description |');
    lines.push('|-------|-------------|');

    for (const [key, skill] of privateSkills) {
      const shortDesc = skill.fullDescription.split('.')[0].replace(/USE WHEN.*$/i, '').trim();
      lines.push(`| ${skill.name} | ${shortDesc} |`);
    }
    lines.push('');
    lines.push('---');
    lines.push('');
  }

  lines.push('## Quick Reference');
  lines.push('');
  lines.push('**Invoke skills:** Use Skill tool or `/skill-name`');
  lines.push('');
  lines.push('**Full skill details:** `skills/skill-index.json`');
  lines.push('');
  lines.push('**Create new skills:** `/create-skill` or invoke CreateSkill');
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push('*Auto-generated from skill-index.json. Run `bun Tools/GenerateSkillIndex.ts` to regenerate.*');

  return lines.join('\n');
}

async function main() {
  console.log('Generating skill index...\n');

  const skillFiles = await findSkillFiles(SKILLS_DIR);
  console.log(`Found ${skillFiles.length} SKILL.md files\n`);

  const index: SkillIndex = {
    generated: new Date().toISOString(),
    totalSkills: 0,
    alwaysLoadedCount: 0,
    deferredCount: 0,
    skills: {},
  };

  for (const filePath of skillFiles) {
    const skill = await parseSkillFile(filePath);
    if (skill) {
      const key = skill.name.toLowerCase();
      index.skills[key] = skill;
      index.totalSkills++;

      if (skill.tier === 'always') {
        index.alwaysLoadedCount++;
      } else {
        index.deferredCount++;
      }

      console.log(`  ${skill.tier === 'always' ? '🔒' : '📦'} ${skill.name}: ${skill.triggers.length} triggers, ${skill.workflows.length} workflows`);
    }
  }

  // Write the JSON index
  await writeFile(OUTPUT_FILE, JSON.stringify(index, null, 2));

  // Write the markdown SKILL-INDEX.md
  const markdownPath = join(SKILLS_DIR, 'CORE', 'SKILL-INDEX.md');
  const markdown = generateMarkdown(index);
  await writeFile(markdownPath, markdown);

  console.log(`\n✅ Index generated: ${OUTPUT_FILE}`);
  console.log(`✅ Markdown generated: ${markdownPath}`);
  console.log(`   Total: ${index.totalSkills} skills`);
  console.log(`   Always loaded: ${index.alwaysLoadedCount}`);
  console.log(`   Deferred: ${index.deferredCount}`);

  // Calculate token estimates
  const avgFullTokens = 150;
  const avgMinimalTokens = 25;
  const currentTokens = index.totalSkills * avgFullTokens;
  const newTokens = (index.alwaysLoadedCount * avgFullTokens) + (index.deferredCount * avgMinimalTokens);
  const savings = ((currentTokens - newTokens) / currentTokens * 100).toFixed(1);

  console.log(`\n📊 Estimated token impact:`);
  console.log(`   Current: ~${currentTokens.toLocaleString()} tokens`);
  console.log(`   After:   ~${newTokens.toLocaleString()} tokens`);
  console.log(`   Savings: ~${savings}%`);
}

main().catch(console.error);
