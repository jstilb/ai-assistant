#!/usr/bin/env bun
/**
 * SystemScanner.ts
 *
 * Unified system scanning tool for Kaya architecture visualization.
 * Scans skills, hooks, and memory to generate structured data for diagrams.
 *
 * Usage:
 *   bun SystemScanner.ts scan              # Full system scan (JSON output)
 *   bun SystemScanner.ts skills            # Scan skills only
 *   bun SystemScanner.ts hooks             # Scan hooks only
 *   bun SystemScanner.ts memory            # Scan memory structure
 *   bun SystemScanner.ts changes [hash]    # Check if system changed since hash
 */

import { readdir, readFile, stat } from 'fs/promises';
import { join, basename } from 'path';
import { existsSync } from 'fs';
import { createHash } from 'crypto';

const KAYA_DIR = process.env.KAYA_DIR || process.env.KAYA_HOME || join(process.env.HOME || '', '.claude');

// ============================================================================
// Types
// ============================================================================

export interface SkillInfo {
  name: string;
  directory: string;
  description: string;
  triggers: string[];
  workflows: string[];
  tools: string[];
  dependencies: string[];  // Skills this skill references
  isPrivate: boolean;      // _PREFIX naming convention
  hasTools: boolean;
  workflowCount: number;
}

export interface HookInfo {
  name: string;
  path: string;
  eventType: HookEventType;
  description: string;
}

export type HookEventType =
  | 'SessionStart'
  | 'SessionEnd'
  | 'UserPromptSubmit'
  | 'PreToolUse'
  | 'PostToolUse'
  | 'Stop'
  | 'Unknown';

export interface MemoryInfo {
  directories: DirectoryInfo[];
  totalFiles: number;
  totalSize: number;
  structure: Record<string, DirectoryInfo>;
}

export interface DirectoryInfo {
  name: string;
  path: string;
  fileCount: number;
  subdirectories: string[];
}

export interface SystemScan {
  timestamp: string;
  kayaDirectory: string;
  hash: string;
  skills: SkillInfo[];
  hooks: HookInfo[];
  memory: MemoryInfo;
  stats: {
    skillCount: number;
    publicSkillCount: number;
    privateSkillCount: number;
    hookCount: number;
    workflowCount: number;
    toolCount: number;
  };
}

// ============================================================================
// Skill Scanning
// ============================================================================

/**
 * Parse SKILL.md frontmatter and content for metadata
 */
async function parseSkillFile(skillPath: string): Promise<Partial<SkillInfo>> {
  const skillFile = join(skillPath, 'SKILL.md');
  if (!existsSync(skillFile)) {
    return {};
  }

  const content = await readFile(skillFile, 'utf-8');

  // Parse YAML frontmatter
  const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
  const frontmatter = frontmatterMatch ? frontmatterMatch[1] : '';

  // Extract name
  const nameMatch = frontmatter.match(/^name:\s*(.+)$/m);
  const name = nameMatch?.[1]?.trim() || basename(skillPath);

  // Extract description (USE WHEN triggers are usually in here)
  const descMatch = frontmatter.match(/^description:\s*(.+)$/m);
  const description = descMatch?.[1]?.trim() || '';

  // Extract triggers from description (after "USE WHEN")
  const triggers: string[] = [];
  const useWhenMatch = description.match(/USE WHEN\s+(.+)/i);
  if (useWhenMatch) {
    const triggerText = useWhenMatch[1];
    // Split on common delimiters
    const rawTriggers = triggerText.split(/,\s*|\s+OR\s+/i);
    triggers.push(...rawTriggers.map(t => t.trim().replace(/\.$/, '')));
  }

  // Extract dependencies (skills referenced in content)
  const dependencies: string[] = [];
  const skillRefPattern = /skills\/([A-Za-z_]+)\//g;
  let match;
  while ((match = skillRefPattern.exec(content)) !== null) {
    const dep = match[1];
    if (dep !== name && !dependencies.includes(dep)) {
      dependencies.push(dep);
    }
  }

  return {
    name,
    description,
    triggers,
    dependencies,
  };
}

/**
 * Scan all skills in the skills directory
 */
export async function scanSkills(): Promise<SkillInfo[]> {
  const skillsDir = join(KAYA_DIR, 'skills');
  if (!existsSync(skillsDir)) {
    return [];
  }

  const skills: SkillInfo[] = [];
  const entries = await readdir(skillsDir, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;

    const skillPath = join(skillsDir, entry.name);
    const parsed = await parseSkillFile(skillPath);

    // Check for workflows
    const workflowsDir = join(skillPath, 'Workflows');
    let workflows: string[] = [];
    if (existsSync(workflowsDir)) {
      const wfEntries = await readdir(workflowsDir);
      workflows = wfEntries.filter(f => f.endsWith('.md')).map(f => f.replace('.md', ''));
    }

    // Check for tools
    const toolsDir = join(skillPath, 'Tools');
    let tools: string[] = [];
    if (existsSync(toolsDir)) {
      const toolEntries = await readdir(toolsDir);
      tools = toolEntries.filter(f => f.endsWith('.ts')).map(f => f.replace('.ts', ''));
    }

    skills.push({
      name: parsed.name || entry.name,
      directory: entry.name,
      description: parsed.description || '',
      triggers: parsed.triggers || [],
      workflows,
      tools,
      dependencies: parsed.dependencies || [],
      isPrivate: entry.name.startsWith('_'),
      hasTools: tools.length > 0,
      workflowCount: workflows.length,
    });
  }

  return skills.sort((a, b) => a.name.localeCompare(b.name));
}

// ============================================================================
// Hook Scanning
// ============================================================================

/**
 * Determine hook event type from filename and content
 */
function determineHookEventType(filename: string, content: string): HookEventType {
  const lower = filename.toLowerCase();

  if (lower.includes('sessionstart') || lower.includes('startup')) return 'SessionStart';
  if (lower.includes('sessionend')) return 'SessionEnd';
  if (lower.includes('userpromptsubmit') || lower.includes('promptsubmit')) return 'UserPromptSubmit';
  if (lower.includes('pretooluse')) return 'PreToolUse';
  if (lower.includes('posttooluse')) return 'PostToolUse';
  if (lower.includes('stop')) return 'Stop';

  // Check content for event type hints
  if (content.includes('SessionStart')) return 'SessionStart';
  if (content.includes('SessionEnd')) return 'SessionEnd';
  if (content.includes('UserPromptSubmit')) return 'UserPromptSubmit';
  if (content.includes('PreToolUse')) return 'PreToolUse';
  if (content.includes('PostToolUse')) return 'PostToolUse';
  if (content.includes('Stop')) return 'Stop';

  return 'Unknown';
}

/**
 * Scan all hooks in the hooks directory
 */
export async function scanHooks(): Promise<HookInfo[]> {
  const hooksDir = join(KAYA_DIR, 'hooks');
  if (!existsSync(hooksDir)) {
    return [];
  }

  const hooks: HookInfo[] = [];
  const entries = await readdir(hooksDir, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.ts')) continue;

    const hookPath = join(hooksDir, entry.name);
    const content = await readFile(hookPath, 'utf-8');

    // Extract description from JSDoc or first comment
    const descMatch = content.match(/\/\*\*\s*\n\s*\*\s*([^\n]+)/);
    const description = descMatch?.[1]?.trim() || entry.name.replace('.ts', '');

    hooks.push({
      name: entry.name.replace('.ts', ''),
      path: hookPath,
      eventType: determineHookEventType(entry.name, content),
      description,
    });
  }

  return hooks.sort((a, b) => a.name.localeCompare(b.name));
}

// ============================================================================
// Memory Scanning
// ============================================================================

/**
 * Recursively count files and get directory info
 */
async function scanDirectory(dirPath: string, depth: number = 0): Promise<DirectoryInfo | null> {
  if (!existsSync(dirPath)) {
    return null;
  }

  const entries = await readdir(dirPath, { withFileTypes: true });
  const subdirectories: string[] = [];
  let fileCount = 0;

  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;

    if (entry.isDirectory()) {
      subdirectories.push(entry.name);
    } else {
      fileCount++;
    }
  }

  return {
    name: basename(dirPath),
    path: dirPath,
    fileCount,
    subdirectories,
  };
}

/**
 * Scan MEMORY directory structure
 */
export async function scanMemory(): Promise<MemoryInfo> {
  const memoryDir = join(KAYA_DIR, 'MEMORY');
  const directories: DirectoryInfo[] = [];
  const structure: Record<string, DirectoryInfo> = {};
  let totalFiles = 0;
  let totalSize = 0;

  if (!existsSync(memoryDir)) {
    return { directories, totalFiles, totalSize, structure };
  }

  const topLevel = await readdir(memoryDir, { withFileTypes: true });

  for (const entry of topLevel) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;

    const dirPath = join(memoryDir, entry.name);
    const info = await scanDirectory(dirPath);

    if (info) {
      directories.push(info);
      structure[entry.name] = info;

      // Recursively count files
      const countFiles = async (path: string): Promise<number> => {
        let count = 0;
        const entries = await readdir(path, { withFileTypes: true });
        for (const e of entries) {
          if (e.name.startsWith('.')) continue;
          const fullPath = join(path, e.name);
          if (e.isDirectory()) {
            count += await countFiles(fullPath);
          } else {
            count++;
            try {
              const s = await stat(fullPath);
              totalSize += s.size;
            } catch {}
          }
        }
        return count;
      };

      totalFiles += await countFiles(dirPath);
    }
  }

  return { directories, totalFiles, totalSize, structure };
}

// ============================================================================
// Change Detection
// ============================================================================

/**
 * Generate a hash of the system state for change detection
 */
export async function generateSystemHash(): Promise<string> {
  const hash = createHash('sha256');

  // Hash skills directory structure
  const skillsDir = join(KAYA_DIR, 'skills');
  if (existsSync(skillsDir)) {
    const skills = await readdir(skillsDir);
    for (const skill of skills.sort()) {
      hash.update(`skill:${skill}`);
      const skillPath = join(skillsDir, skill, 'SKILL.md');
      if (existsSync(skillPath)) {
        const stat1 = await stat(skillPath);
        hash.update(`mtime:${stat1.mtime.getTime()}`);
      }
    }
  }

  // Hash hooks directory structure
  const hooksDir = join(KAYA_DIR, 'hooks');
  if (existsSync(hooksDir)) {
    const hooks = await readdir(hooksDir);
    for (const hook of hooks.sort()) {
      hash.update(`hook:${hook}`);
      const hookPath = join(hooksDir, hook);
      if (existsSync(hookPath)) {
        const stat2 = await stat(hookPath);
        hash.update(`mtime:${stat2.mtime.getTime()}`);
      }
    }
  }

  // Hash memory top-level structure
  const memoryDir = join(KAYA_DIR, 'MEMORY');
  if (existsSync(memoryDir)) {
    const memDirs = await readdir(memoryDir);
    hash.update(`memory:${memDirs.sort().join(',')}`);
  }

  return hash.digest('hex').substring(0, 16);
}

/**
 * Check if system has changed since the given hash
 */
export async function detectChanges(cachedHash: string): Promise<boolean> {
  const currentHash = await generateSystemHash();
  return currentHash !== cachedHash;
}

// ============================================================================
// Full System Scan
// ============================================================================

/**
 * Perform a full system scan
 */
export async function fullScan(): Promise<SystemScan> {
  const skills = await scanSkills();
  const hooks = await scanHooks();
  const memory = await scanMemory();
  const hash = await generateSystemHash();

  // Calculate stats
  const publicSkills = skills.filter(s => !s.isPrivate);
  const privateSkills = skills.filter(s => s.isPrivate);
  const totalWorkflows = skills.reduce((sum, s) => sum + s.workflowCount, 0);
  const totalTools = skills.reduce((sum, s) => sum + s.tools.length, 0);

  return {
    timestamp: new Date().toISOString(),
    kayaDirectory: KAYA_DIR,
    hash,
    skills,
    hooks,
    memory,
    stats: {
      skillCount: skills.length,
      publicSkillCount: publicSkills.length,
      privateSkillCount: privateSkills.length,
      hookCount: hooks.length,
      workflowCount: totalWorkflows,
      toolCount: totalTools,
    },
  };
}

// ============================================================================
// CLI
// ============================================================================

async function main() {
  const args = process.argv.slice(2);
  const command = args[0] || 'scan';

  switch (command) {
    case 'scan':
      const scan = await fullScan();
      console.log(JSON.stringify(scan, null, 2));
      break;

    case 'skills':
      const skills = await scanSkills();
      console.log(JSON.stringify(skills, null, 2));
      break;

    case 'hooks':
      const hooks = await scanHooks();
      console.log(JSON.stringify(hooks, null, 2));
      break;

    case 'memory':
      const memory = await scanMemory();
      console.log(JSON.stringify(memory, null, 2));
      break;

    case 'hash':
      const hash = await generateSystemHash();
      console.log(hash);
      break;

    case 'changes':
      const cachedHash = args[1];
      if (!cachedHash) {
        console.error('Usage: SystemScanner.ts changes <cached-hash>');
        process.exit(1);
      }
      const changed = await detectChanges(cachedHash);
      console.log(changed ? 'true' : 'false');
      process.exit(changed ? 0 : 1);
      break;

    default:
      console.log(`
SystemScanner - Kaya System Architecture Scanner

Usage:
  bun SystemScanner.ts scan              Full system scan (JSON output)
  bun SystemScanner.ts skills            Scan skills only
  bun SystemScanner.ts hooks             Scan hooks only
  bun SystemScanner.ts memory            Scan memory structure
  bun SystemScanner.ts hash              Generate current system hash
  bun SystemScanner.ts changes <hash>    Check if system changed since hash
`);
  }
}

main().catch(console.error);
