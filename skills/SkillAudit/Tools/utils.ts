#!/usr/bin/env bun
/**
 * Shared utilities for SkillAudit tools
 *
 * Common functions for file operations, skill discovery,
 * and data extraction used across all SkillAudit tools.
 */

import { existsSync, readdirSync, mkdirSync, statSync, readFileSync } from 'fs';
import { join } from 'path';
import { SKILLS_DIR, MEMORY_DIR, SKILL_AUDITS_DIR } from './constants';

/**
 * Get all skill directories, optionally filtering by pattern
 */
export function getSkillDirectories(includePrivate = true): string[] {
  if (!existsSync(SKILLS_DIR)) {
    console.error(`Skills directory not found: ${SKILLS_DIR}`);
    return [];
  }

  const entries = readdirSync(SKILLS_DIR, { withFileTypes: true });
  return entries
    .filter(e => {
      if (!e.isDirectory()) return false;
      if (e.name.startsWith('.')) return false;
      if (!includePrivate && e.name.startsWith('_')) return false;
      return true;
    })
    .map(e => e.name)
    .sort();
}

/**
 * Ensure a directory exists, creating it if necessary
 */
export function ensureDirectory(dirPath: string): boolean {
  try {
    if (!existsSync(dirPath)) {
      mkdirSync(dirPath, { recursive: true });
    }
    return true;
  } catch (error) {
    console.error(`Failed to create directory ${dirPath}:`, error);
    return false;
  }
}

/**
 * Ensure MEMORY directories exist
 */
export function ensureMemoryDirectories(): boolean {
  return ensureDirectory(MEMORY_DIR) && ensureDirectory(SKILL_AUDITS_DIR);
}

/**
 * Check if a skill exists
 */
export function skillExists(skillName: string): boolean {
  const skillPath = join(SKILLS_DIR, skillName);
  return existsSync(skillPath) && statSync(skillPath).isDirectory();
}

/**
 * Get the path to a skill directory
 */
export function getSkillPath(skillName: string): string {
  return join(SKILLS_DIR, skillName);
}

/**
 * Get files in a skill directory by type
 */
export function getSkillFiles(skillName: string): {
  skillMd: string | null;
  workflows: string[];
  tools: string[];
  otherMd: string[];
} {
  const skillPath = getSkillPath(skillName);
  const result = {
    skillMd: null as string | null,
    workflows: [] as string[],
    tools: [] as string[],
    otherMd: [] as string[],
  };

  if (!skillExists(skillName)) {
    return result;
  }

  // Check for SKILL.md
  const skillMdPath = join(skillPath, 'SKILL.md');
  if (existsSync(skillMdPath)) {
    result.skillMd = skillMdPath;
  }

  // Check Workflows/
  const workflowsDir = join(skillPath, 'Workflows');
  if (existsSync(workflowsDir)) {
    try {
      result.workflows = readdirSync(workflowsDir)
        .filter(f => f.endsWith('.md') && !f.startsWith('.'))
        .map(f => join(workflowsDir, f));
    } catch {
      // Ignore errors
    }
  }

  // Check Tools/
  const toolsDir = join(skillPath, 'Tools');
  if (existsSync(toolsDir)) {
    try {
      result.tools = readdirSync(toolsDir)
        .filter(f => (f.endsWith('.ts') || f.endsWith('.js')) && !f.startsWith('.'))
        .map(f => join(toolsDir, f));
    } catch {
      // Ignore errors
    }
  }

  // Check for other .md files at root level
  try {
    result.otherMd = readdirSync(skillPath)
      .filter(f => f.endsWith('.md') && f !== 'SKILL.md' && !f.startsWith('.'))
      .map(f => join(skillPath, f));
  } catch {
    // Ignore errors
  }

  return result;
}

/**
 * Read a file safely, returning null on error
 */
export function safeReadFile(filePath: string): string | null {
  try {
    if (!existsSync(filePath)) {
      return null;
    }
    return readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }
}

/**
 * Extract triggers from a SKILL.md file content
 */
export function extractTriggers(skillMdContent: string): string[] {
  const triggers: string[] = [];

  // Extract from description line
  const descMatch = skillMdContent.match(/description:\s*(.+?)(?:\n|$)/i);
  if (descMatch) {
    const desc = descMatch[1];
    // Look for USE WHEN patterns
    const useWhenMatch = desc.match(/USE WHEN\s+(.+?)(?:\.|$)/i);
    if (useWhenMatch) {
      const triggerList = useWhenMatch[1].split(/,\s*|\s+OR\s+/i);
      triggers.push(...triggerList.map(t => t.trim().toLowerCase()).filter(Boolean));
    }
  }

  // Extract from workflow trigger patterns
  const triggerMatches = skillMdContent.match(/##?\s*Trigger\s*\n+([\s\S]*?)(?=\n##|\n---|\n\n\n|$)/gi);
  if (triggerMatches) {
    for (const match of triggerMatches) {
      const lines = match.split('\n').slice(1);
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith('-') || trimmed.startsWith('*')) {
          const trigger = trimmed.replace(/^[-*]\s*["']?/, '').replace(/["']?\s*$/, '').toLowerCase();
          if (trigger && !trigger.startsWith('#')) {
            triggers.push(trigger);
          }
        }
      }
    }
  }

  // Deduplicate
  return [...new Set(triggers)];
}

/**
 * Check if a name follows TitleCase convention
 */
export function isTitleCase(name: string): boolean {
  return /^[A-Z][a-zA-Z0-9]*$/.test(name) || /^_[A-Z]+$/.test(name);
}

/**
 * Get current date in YYYY-MM-DD format
 */
export function getDateString(): string {
  return new Date().toISOString().split('T')[0];
}

/**
 * Get current timestamp in ISO format
 */
export function getTimestamp(): string {
  return new Date().toISOString();
}

/**
 * Count lines in a string
 */
export function countLines(content: string): number {
  return content.split('\n').length;
}

/**
 * Count words in a string
 */
export function countWords(content: string): number {
  return content.split(/\s+/).filter(Boolean).length;
}

/**
 * Extract trigger phrases from a workflow markdown file's ## Trigger section.
 *
 * This is distinct from extractTriggers() which operates on SKILL.md content.
 * This function extracts from individual workflow files that have a "## Trigger"
 * section with bulleted trigger phrases.
 */
export function extractWorkflowTriggers(content: string): string[] {
  const triggers: string[] = [];
  const triggerMatch = content.match(/##?\s*Trigger\s*\n+([\s\S]*?)(?=\n##|\n---|\n\n\n|$)/i);

  if (triggerMatch) {
    const lines = triggerMatch[1].split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith('-') || trimmed.startsWith('*')) {
        const trigger = trimmed.replace(/^[-*]\s*["']?/, '').replace(/["']?\s*$/, '');
        if (trigger && !trigger.startsWith('#')) {
          triggers.push(trigger);
        }
      }
    }
  }

  return triggers;
}
