#!/usr/bin/env bun
/**
 * ValidateSkillStructure.ts
 *
 * Validates the Kaya skill system's structural integrity against 5 rules:
 *
 *   1. BROKEN_ROUTING_REF  (ERROR) — routing table paths that don't exist on disk
 *   2. MISSING_FROM_TABLE  (ERROR) — sub-skill dirs on disk absent from routing table
 *   3. ORPHANED_ROOT_DIR   (WARN)  — root dirs without SKILL.md that shadow a sub-skill
 *   4. EXCESSIVE_DEPTH     (ERROR) — SKILL.md found deeper than Category/SubSkill/
 *   5. NAME_MISMATCH       (WARN)  — SKILL.md `name:` field doesn't match directory name
 *
 * Usage:
 *   bun lib/core/ValidateSkillStructure.ts [--json] [--errors-only] [--skills-dir /path]
 *
 * Exit code: 0 if valid (zero ERRORs), 1 if any ERRORs.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { join, basename } from 'path';
import { parseArgs } from 'util';
import { getKayaHome } from './KayaHome.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ValidationSeverity = 'ERROR' | 'WARN';

export type ValidationRule =
  | 'BROKEN_ROUTING_REF'
  | 'MISSING_FROM_TABLE'
  | 'ORPHANED_ROOT_DIR'
  | 'EXCESSIVE_DEPTH'
  | 'NAME_MISMATCH';

export interface ValidationIssue {
  rule: ValidationRule;
  severity: ValidationSeverity;
  message: string;
  category?: string;
  subSkill?: string;
  path?: string;
}

export interface ValidationResult {
  valid: boolean;
  issues: ValidationIssue[];
  summary: {
    errors: number;
    warnings: number;
    categoriesChecked: number;
    subSkillsChecked: number;
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// frozen at import (getKayaHome cached); no test re-pins this module
const DEFAULT_SKILLS_DIR = join(getKayaHome(), 'skills');

/** Return names of immediate child directories inside `dir`. */
function childDirs(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((name) => {
    try {
      return statSync(join(dir, name)).isDirectory();
    } catch {
      return false;
    }
  });
}

/** True if `dir` contains a SKILL.md directly inside it. */
function hasSkillMd(dir: string): boolean {
  return existsSync(join(dir, 'SKILL.md'));
}

/**
 * A directory is a category if it has a SKILL.md AND at least one
 * immediate child directory that also has a SKILL.md (i.e. has sub-skills).
 */
function isCategory(dir: string): boolean {
  if (!hasSkillMd(dir)) return false;
  return childDirs(dir).some((child) => hasSkillMd(join(dir, child)));
}

// ---------------------------------------------------------------------------
// Rule 1 helper: parseRoutingTableEntries
// ---------------------------------------------------------------------------

/**
 * Parse the `## Sub-Skills` routing table from a category SKILL.md.
 * Returns an array of `{ name, path }` for every data row found.
 *
 * Expected row format:
 *   | **Name** | triggers | `path/to/SKILL.md` |
 */
export function parseRoutingTableEntries(
  content: string,
): Array<{ name: string; path: string }> {
  const results: Array<{ name: string; path: string }> = [];
  const rowRegex = /\|\s*\*\*(.+?)\*\*\s*\|[^|]*\|\s*`([^`]+)`\s*\|/g;
  let match: RegExpExecArray | null;
  while ((match = rowRegex.exec(content)) !== null) {
    results.push({ name: match[1].trim(), path: match[2].trim() });
  }
  return results;
}

// ---------------------------------------------------------------------------
// Rule 1: BROKEN_ROUTING_REF
// ---------------------------------------------------------------------------

export function checkBrokenRoutingRefs(skillsDir: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  for (const catName of childDirs(skillsDir)) {
    const catDir = join(skillsDir, catName);
    if (!isCategory(catDir)) continue;

    const skillMdPath = join(catDir, 'SKILL.md');
    const content = readFileSync(skillMdPath, 'utf-8');
    const entries = parseRoutingTableEntries(content);

    for (const entry of entries) {
      const resolved = join(skillsDir, entry.path);
      if (!existsSync(resolved)) {
        issues.push({
          rule: 'BROKEN_ROUTING_REF',
          severity: 'ERROR',
          message: `${catName}/SKILL.md routes to "${entry.path}" but path does not exist`,
          category: catName,
          path: entry.path,
        });
      }
    }
  }

  return issues;
}

// ---------------------------------------------------------------------------
// Rule 2: MISSING_FROM_TABLE
// ---------------------------------------------------------------------------

export function checkMissingFromTable(skillsDir: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  for (const catName of childDirs(skillsDir)) {
    const catDir = join(skillsDir, catName);
    if (!isCategory(catDir)) continue;

    const skillMdPath = join(catDir, 'SKILL.md');
    const content = readFileSync(skillMdPath, 'utf-8');
    const entries = parseRoutingTableEntries(content);

    // Sub-skills referenced in the table (by their path's basename)
    const tabled = new Set(entries.map((e) => basename(e.path, '/SKILL.md').replace(/\/SKILL\.md$/, '')));
    // Also collect the raw directory name component just before SKILL.md
    const tabledDirs = new Set(
      entries.map((e) => {
        const parts = e.path.split('/');
        // path like "Category/SubSkill/SKILL.md" → parts[1] (or parts[-2])
        return parts.length >= 2 ? parts[parts.length - 2] : parts[0];
      }),
    );

    // Sub-skill dirs on disk
    for (const subName of childDirs(catDir)) {
      const subDir = join(catDir, subName);
      if (!hasSkillMd(subDir)) continue;

      if (!tabledDirs.has(subName) && !tabled.has(subName)) {
        issues.push({
          rule: 'MISSING_FROM_TABLE',
          severity: 'ERROR',
          message: `${catName}/${subName} exists on disk but is not in ${catName}/SKILL.md routing table`,
          category: catName,
          subSkill: subName,
          path: join(catDir, subName, 'SKILL.md'),
        });
      }
    }
  }

  return issues;
}

// ---------------------------------------------------------------------------
// Rule 3: ORPHANED_ROOT_DIR
// ---------------------------------------------------------------------------

export function checkOrphanedRootDirs(skillsDir: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  // Build a map: sub-skill name → category that contains it
  const subSkillIndex = new Map<string, string>();
  for (const catName of childDirs(skillsDir)) {
    const catDir = join(skillsDir, catName);
    if (!isCategory(catDir)) continue;
    for (const subName of childDirs(catDir)) {
      if (hasSkillMd(join(catDir, subName))) {
        subSkillIndex.set(subName, catName);
      }
    }
  }

  for (const rootName of childDirs(skillsDir)) {
    const rootDir = join(skillsDir, rootName);
    if (hasSkillMd(rootDir)) continue; // has its own SKILL.md → not orphaned

    const shadowedCat = subSkillIndex.get(rootName);
    if (shadowedCat !== undefined) {
      issues.push({
        rule: 'ORPHANED_ROOT_DIR',
        severity: 'WARN',
        message: `skills/${rootName}/ has no SKILL.md and shadows ${shadowedCat}/${rootName}`,
        path: rootDir,
      });
    }
  }

  return issues;
}

// ---------------------------------------------------------------------------
// Rule 4: EXCESSIVE_DEPTH
// ---------------------------------------------------------------------------

export function checkExcessiveDepth(skillsDir: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  /**
   * Recursively walk the tree.
   * depth 0 = skills/ root
   * depth 1 = Category/
   * depth 2 = Category/SubSkill/  ← SKILL.md OK here
   * depth 3+ = too deep
   */
  function walk(dir: string, depth: number): void {
    if (depth >= 3) {
      // Check if SKILL.md exists at this depth (violation)
      if (existsSync(join(dir, 'SKILL.md'))) {
        // Build relative path for message
        const rel = dir.replace(skillsDir + '/', '');
        issues.push({
          rule: 'EXCESSIVE_DEPTH',
          severity: 'ERROR',
          message: `${rel}/SKILL.md is at depth ${depth} (max 2)`,
          path: join(dir, 'SKILL.md'),
        });
      }
      // Don't recurse further — stop at depth 3 to avoid reporting deeper nesting
      return;
    }

    for (const child of childDirs(dir)) {
      walk(join(dir, child), depth + 1);
    }
  }

  walk(skillsDir, 0);
  return issues;
}

// ---------------------------------------------------------------------------
// Rule 5: NAME_MISMATCH
// ---------------------------------------------------------------------------

export function checkNameMismatch(skillsDir: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  function checkDir(dir: string): void {
    const skillMdPath = join(dir, 'SKILL.md');
    if (!existsSync(skillMdPath)) return;

    const content = readFileSync(skillMdPath, 'utf-8');
    const match = content.match(/^name:\s*(.+?)$/m);
    if (!match) return; // no name field — skip silently

    const nameInFile = match[1].trim();
    const dirName = basename(dir);

    if (nameInFile !== dirName) {
      const rel = dir.replace(skillsDir + '/', '');
      issues.push({
        rule: 'NAME_MISMATCH',
        severity: 'WARN',
        message: `${rel}/SKILL.md has name: "${nameInFile}" but directory is "${dirName}"`,
        path: skillMdPath,
      });
    }
  }

  // Check all category dirs and their sub-skill dirs
  for (const catName of childDirs(skillsDir)) {
    const catDir = join(skillsDir, catName);
    checkDir(catDir);
    for (const subName of childDirs(catDir)) {
      checkDir(join(catDir, subName));
    }
  }

  return issues;
}

// ---------------------------------------------------------------------------
// Top-level validator
// ---------------------------------------------------------------------------

export function validateSkillStructure(skillsDir: string = DEFAULT_SKILLS_DIR): ValidationResult {
  const issues: ValidationIssue[] = [
    ...checkBrokenRoutingRefs(skillsDir),
    ...checkMissingFromTable(skillsDir),
    ...checkOrphanedRootDirs(skillsDir),
    ...checkExcessiveDepth(skillsDir),
    ...checkNameMismatch(skillsDir),
  ];

  // Count stats
  let errors = 0;
  let warnings = 0;
  for (const issue of issues) {
    if (issue.severity === 'ERROR') errors++;
    else warnings++;
  }

  // categoriesChecked and subSkillsChecked
  let categoriesChecked = 0;
  let subSkillsChecked = 0;
  for (const catName of childDirs(skillsDir)) {
    const catDir = join(skillsDir, catName);
    if (!isCategory(catDir)) continue;
    categoriesChecked++;
    for (const subName of childDirs(catDir)) {
      if (hasSkillMd(join(catDir, subName))) subSkillsChecked++;
    }
  }

  return {
    valid: errors === 0,
    issues,
    summary: {
      errors,
      warnings,
      categoriesChecked,
      subSkillsChecked,
    },
  };
}

// ---------------------------------------------------------------------------
// CLI entrypoint
// ---------------------------------------------------------------------------

function severityLabel(s: ValidationSeverity): string {
  return s === 'ERROR' ? '[ERROR]' : '[WARN] ';
}

function main(): void {
  const { values } = parseArgs({
    options: {
      json: { type: 'boolean', default: false },
      'errors-only': { type: 'boolean', default: false },
      'skills-dir': { type: 'string' },
    },
    strict: false,
  });

  const skillsDir = (values['skills-dir'] as string | undefined) ?? DEFAULT_SKILLS_DIR;
  const result = validateSkillStructure(skillsDir);

  if (values['json']) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  } else {
    const filtered =
      values['errors-only']
        ? result.issues.filter((i) => i.severity === 'ERROR')
        : result.issues;

    console.log('Skill Structure Validation');
    console.log('==========================');

    if (filtered.length === 0) {
      console.log('\nNo issues found.');
    } else {
      console.log('');
      for (const issue of filtered) {
        console.log(`${severityLabel(issue.severity)} ${issue.rule}: ${issue.message}`);
      }
    }

    const { errors, warnings, categoriesChecked, subSkillsChecked } = result.summary;
    console.log(
      `\nSummary: ${errors} error${errors !== 1 ? 's' : ''}, ${warnings} warning${warnings !== 1 ? 's' : ''} (${categoriesChecked} categories, ${subSkillsChecked} sub-skills checked)`,
    );
  }

  process.exit(result.valid ? 0 : 1);
}

if (import.meta.main) main();
