#!/usr/bin/env bun
/**
 * DeadCodeDetector - Detect dead code and hygiene issues in a skill
 *
 * Scores Dimension 6: Code Hygiene
 * Deterministic detection + optional inferential verification
 *
 * Detects:
 * - Unused exports (exported symbols not referenced elsewhere in the skill)
 * - Orphaned files (files not referenced by SKILL.md, workflows, or tool imports)
 * - Stale references (SKILL.md or workflow references to files that don't exist)
 * - TODO/FIXME/HACK markers in .ts files
 * - Deprecated code living outside a _DEPRECATED/ directory
 *
 * Verification (default ON, disable with --no-verify):
 * After deterministic detection, uses inference to cross-check orphaned files
 * and stale references. Catches false positives from dynamic path construction,
 * cross-format references, and moved files that regex cannot detect.
 *
 * Usage:
 *   bun run DeadCodeDetector.ts <skill-name>              # Human-readable report
 *   bun run DeadCodeDetector.ts <skill-name> --json       # JSON output
 *   bun run DeadCodeDetector.ts <skill-name> --no-verify  # Skip inferential verification
 */

import { existsSync, readdirSync, readFileSync } from 'fs';
import { join, basename, relative } from 'path';
import { inference } from '../../../../lib/core/Inference.ts';
import { SKILLS_DIR, KAYA_HOME, SCORING, type DimensionName } from './constants';
import { getSkillPath, getSkillFiles, safeReadFile, skillExists } from './utils';
import type { Finding, Recommendation, DimensionResult } from './report-builder';
import { buildDimensionResult } from './report-builder';

// ============================================================================
// Types
// ============================================================================

export interface UnusedExport {
  file: string;
  exportName: string;
}

export interface StaleReference {
  source: string;
  reference: string;
}

export interface TodoMarker {
  file: string;
  line: number;
  text: string;
}

export interface UnreachableBlock {
  file: string;
  line: number;
  reason: string;
}

export interface DeadCodeDetails {
  unusedExports: UnusedExport[];
  orphanedFiles: string[];
  staleReferences: StaleReference[];
  todoMarkers: TodoMarker[];
  deprecatedOutside: string[];
  unreachableBlocks: UnreachableBlock[];
}

export interface DeadCodeResult {
  skillName: string;
  score: number;
  dimensionResult: DimensionResult;
  details: DeadCodeDetails;
}

// ============================================================================
// Helpers
// ============================================================================

/** Escape a string for use inside a RegExp literal. */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Check if a character position falls inside a string literal. */
function isInsideStringLiteral(line: string, index: number): boolean {
  let inSingle = false, inDouble = false, inTemplate = false;
  for (let i = 0; i < index; i++) {
    const ch = line[i];
    if (ch === "'" && !inDouble && !inTemplate) inSingle = !inSingle;
    else if (ch === '"' && !inSingle && !inTemplate) inDouble = !inDouble;
    else if (ch === '`' && !inSingle && !inDouble) inTemplate = !inTemplate;
  }
  return inSingle || inDouble || inTemplate;
}

// ============================================================================
// Known-Output Helpers (suppress false positives for files a skill creates)
// ============================================================================

/** Parse `known_outputs` from a skill's SKILL.md YAML frontmatter. */
function parseKnownOutputs(skillPath: string): string[] {
  const skillMd = join(skillPath, 'SKILL.md');
  if (!existsSync(skillMd)) return [];
  const content = readFileSync(skillMd, 'utf-8');
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (!fmMatch) return [];
  const line = fmMatch[1].match(/^known_outputs:\s*\[([^\]]*)\]/m);
  if (!line) return [];
  return line[1].split(',').map(s => s.trim().replace(/['"]/g, ''));
}

/** Check if a reference matches any known output pattern (supports leading `*` glob). */
function isKnownOutput(ref: string, patterns: string[]): boolean {
  const base = basename(ref);
  return patterns.some(pattern => {
    if (pattern.startsWith('*')) {
      return base.endsWith(pattern.slice(1));
    }
    return base === pattern;
  });
}

// ============================================================================
// Core Detection Functions
// ============================================================================

/**
 * Find all export declarations in a TypeScript file.
 * Returns exported symbol names (functions, consts, classes, interfaces, types, enums).
 */
export function extractExportedNames(content: string): string[] {
  const names: string[] = [];

  // export function/class/const/let/var FooBar
  const declMatches = content.matchAll(
    /^export\s+(?:async\s+)?(?:function|class|const|let|var|abstract\s+class)\s+(\w+)/gm
  );
  for (const m of declMatches) {
    names.push(m[1]);
  }

  // export interface FooBar / export type FooBar / export enum FooBar
  const typeMatches = content.matchAll(
    /^export\s+(?:interface|type|enum)\s+(\w+)/gm
  );
  for (const m of typeMatches) {
    names.push(m[1]);
  }

  // export { Foo, Bar, Baz } or export { Foo as Bar }
  const namedMatches = content.matchAll(/^export\s*\{([^}]+)\}/gm);
  for (const m of namedMatches) {
    const parts = m[1].split(',');
    for (const part of parts) {
      // Handle "Foo as Bar" — the external name is the alias
      const asMatch = part.match(/\bas\s+(\w+)/);
      if (asMatch) {
        names.push(asMatch[1]);
      } else {
        const name = part.trim().match(/^(\w+)/);
        if (name) {
          names.push(name[1]);
        }
      }
    }
  }

  return [...new Set(names)];
}

/**
 * Detect unused exports: exported names in Tools/ files that are not
 * referenced anywhere else in the skill.
 */
function detectUnusedExports(skillName: string): UnusedExport[] {
  const unused: UnusedExport[] = [];
  const files = getSkillFiles(skillName);

  if (files.tools.length === 0) return unused;

  // Collect all content from non-tool files for reference checking
  const allContents: Array<{ path: string; content: string }> = [];

  if (files.skillMd) {
    const c = safeReadFile(files.skillMd);
    if (c) allContents.push({ path: files.skillMd, content: c });
  }

  for (const wf of files.workflows) {
    const c = safeReadFile(wf);
    if (c) allContents.push({ path: wf, content: c });
  }

  for (const tool of files.tools) {
    const c = safeReadFile(tool);
    if (c) allContents.push({ path: tool, content: c });
  }

  // For each tool, find exports and check if they are referenced elsewhere
  for (const toolPath of files.tools) {
    const content = safeReadFile(toolPath);
    if (!content) continue;

    // CLI tools (files with import.meta.main) expose exports as public API —
    // consumers invoke via `bun Tools/Foo.ts`, not TS imports. Skip penalty.
    if (content.includes('import.meta.main')) continue;

    // Library modules imported by other tools expose exports as shared API — skip penalty.
    const toolBasename = basename(toolPath, '.ts');
    const isLibraryModule = allContents.some(({ path: p, content: c }) =>
      p !== toolPath && new RegExp(`from\\s+['"\`][^'"\`]*${escapeRegex(toolBasename)}(?:\\.ts)?['"\`]`).test(c)
    );
    if (isLibraryModule) continue;

    const exportedNames = extractExportedNames(content);

    for (const name of exportedNames) {
      // Skip the main entry function — always "used" as CLI entry point
      if (name === 'main') continue;

      // Count references across all other files (not counting the file itself)
      let referenced = false;
      for (const { path, content: refContent } of allContents) {
        if (path === toolPath) continue;
        // Look for the name used as an import, function call, or type reference
        // Use word boundary matching to avoid partial matches
        const pattern = new RegExp(`\\b${escapeRegex(name)}\\b`);
        if (pattern.test(refContent)) {
          referenced = true;
          break;
        }
      }

      if (!referenced) {
        unused.push({
          file: relative(getSkillPath(skillName), toolPath),
          exportName: name,
        });
      }
    }
  }

  return unused;
}

/** Directories to skip when crawling a skill tree. */
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  '.cache',
  'coverage',
  '__pycache__',
]);

/**
 * Collect all files recursively within the skill directory.
 * Excludes dotfiles, node_modules, and common build artifact directories.
 */
function collectAllSkillFiles(skillPath: string): string[] {
  const results: string[] = [];

  function walk(dir: string): void {
    let entries: ReturnType<typeof readdirSync>;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      if (SKIP_DIRS.has(entry.name)) continue;
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else {
        results.push(fullPath);
      }
    }
  }

  walk(skillPath);
  return results;
}

/** Directories whose contents are structurally recognized — files inside are NEVER orphaned. */
const RECOGNIZED_DIRS = new Set([
  'Workflows', 'Tools', 'State', 'Data', 'Templates',
  'Config', 'config', 'Evals', 'examples', '_DEPRECATED', 'Schemas',
]);

/** Root-level files that are infrastructure — never orphaned. */
const INFRA_FILES = new Set([
  'SKILL.md', 'package.json', 'tsconfig.json', 'bun.lock', 'bun.lockb', 'README.md',
]);

/**
 * Detect orphaned files using an inverted allowlist model.
 *
 * Instead of flagging everything not statically referenced (which produces
 * massive false positives from dynamic loading, directory scans, etc.),
 * this only examines files NOT in any recognized directory. Files in
 * recognized directories are structurally expected and never flagged.
 *
 * For root-level files outside recognized dirs, checks if the filename
 * appears in any .ts or .md file within the skill.
 */
function detectOrphanedFiles(skillName: string): string[] {
  const skillPath = getSkillPath(skillName);
  const allFiles = collectAllSkillFiles(skillPath);

  // Collect candidates: files NOT in any recognized directory and not infra files
  const candidates: string[] = [];

  for (const filePath of allFiles) {
    const relPath = relative(skillPath, filePath);
    const fileName = basename(filePath);

    // Infrastructure files at root — never orphaned
    if (INFRA_FILES.has(fileName)) continue;

    // Check if the file is inside a recognized directory
    const topDir = relPath.split('/')[0];
    if (RECOGNIZED_DIRS.has(topDir)) continue;

    // Also skip test files at any level
    if (relPath.includes('__tests__/') || /\.(?:test|spec)\.[tj]s$/.test(fileName)) continue;

    candidates.push(relPath);
  }

  if (candidates.length === 0) return [];

  // For candidates, check if filename appears in any .ts or .md file in the skill
  const files = getSkillFiles(skillName);
  const referenceSources: string[] = [];

  if (files.skillMd) {
    const c = safeReadFile(files.skillMd);
    if (c) referenceSources.push(c);
  }
  for (const wf of files.workflows) {
    const c = safeReadFile(wf);
    if (c) referenceSources.push(c);
  }
  for (const tool of files.tools) {
    const c = safeReadFile(tool);
    if (c) referenceSources.push(c);
  }

  const combinedContent = referenceSources.join('\n');

  const orphaned: string[] = [];
  for (const relPath of candidates) {
    const fileName = basename(relPath);
    const fileBaseName = fileName.replace(/\.\w+$/, '');

    // Check if the file name or base name appears anywhere in skill content
    if (combinedContent.includes(fileName) || combinedContent.includes(fileBaseName)) {
      continue;
    }

    orphaned.push(relPath);
  }

  return orphaned;
}

/**
 * Detect stale references: references in SKILL.md or workflow .md files
 * to .ts or .md files that don't actually exist in the skill directory.
 */
function detectStaleReferences(skillName: string): StaleReference[] {
  const stale: StaleReference[] = [];
  const skillPath = getSkillPath(skillName);
  const files = getSkillFiles(skillName);

  const mdSources: Array<{ path: string; content: string }> = [];

  if (files.skillMd) {
    const c = safeReadFile(files.skillMd);
    if (c) mdSources.push({ path: files.skillMd, content: c });
  }

  for (const wf of files.workflows) {
    const c = safeReadFile(wf);
    if (c) mdSources.push({ path: wf, content: c });
  }

  // Patterns that reference specific files within the skill
  const fileRefPatterns: RegExp[] = [
    /(?:Tools|Workflows|State|Data|Templates)\/(\S+\.(?:ts|md|js|jsonl?|yaml|hbs))/g,
    /bun run\s+([\w/]+\.ts)/g,
    /`([\w/]+\.(?:ts|md|js|jsonl?|yaml|hbs))`/g,
  ];

  // Parse known output files for this skill (suppresses false positives for generated files)
  const knownOutputs = parseKnownOutputs(skillPath);

  for (const { path: sourcePath, content } of mdSources) {
    const relSource = relative(skillPath, sourcePath);

    // Strip fenced code blocks — example/template references inside code blocks
    // (e.g., directory structure examples) are not real file references.
    const proseContent = content.replace(/^```[\s\S]*?^```/gm, '');

    for (const pattern of fileRefPatterns) {
      pattern.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(proseContent)) !== null) {
        const ref = match[1].replace(/[^a-zA-Z0-9._\-/]+$/, '');
        if (!ref) continue;

        // Skip template placeholders and glob patterns (e.g., [ToolName].ts, *.md, {name}.ts)
        if (/[\[\]*{}]/.test(ref)) continue;

        // Skip generic placeholder names (e.g., ToolName.ts, tool_name.ts, WorkflowName.md)
        const refBasename = basename(ref).replace(/\.\w+$/, '');
        if (/Name/i.test(refBasename)) continue;

        // Skip refs on lines with documentation-example markers
        // (e.g., "✓ `ManageServer.ts`", "Bad: `Company/DueDiligence.md`", "e.g., `Foo.ts`")
        const matchLine = proseContent.substring(
          proseContent.lastIndexOf('\n', match.index) + 1,
          proseContent.indexOf('\n', match.index + match[0].length)
        );
        if (/(?:e\.g\.|✓|✗|WRONG|CORRECT|Good:|Bad:|example|Example|→)/.test(matchLine)) continue;

        // Skip known output files (files the skill creates, not imports)
        if (isKnownOutput(ref, knownOutputs)) continue;

        // Skip absolute paths that exist on disk
        if (ref.startsWith('/') && existsSync(ref)) continue;

        // Resolve relative to skill root, cross-skill, and CORE tools
        const refBase = basename(ref);
        const candidatePaths = [
          join(skillPath, ref),
          join(skillPath, 'Tools', refBase),
          join(skillPath, 'Tools', ref),                  // preserves lib/ subpath (e.g., Tools/lib/foo.ts)
          join(skillPath, 'Tools', 'lib', refBase),       // bare name in Tools/lib/
          join(skillPath, 'Workflows', refBase),
          join(skillPath, 'State', refBase),               // State/ data files
          join(skillPath, 'Data', refBase),                // Data/ directory
          join(skillPath, 'Templates', refBase),           // Templates/ directory
          join(skillPath, 'config', refBase),              // config/ subdir
          join(KAYA_HOME, 'skills', ref),                  // cross-skill: ../lib/core/Foo.ts
          join(KAYA_HOME, ref),                             // refs starting with lib/: lib/core/Foo.ts
          join(KAYA_HOME, 'lib', 'core', refBase),         // lib/core/Inference.ts (post-CORE migration)
          join(KAYA_HOME, 'lib', 'core', 'Tools', refBase), // lib/core/Tools/Foo.ts
          join(KAYA_HOME, 'skills', 'CORE', 'Tools', refBase),  // bare CORE tool names (legacy)
        ];

        const anyExists = candidatePaths.some(p => existsSync(p));

        // Cross-skill Tools/ search for bare .ts basenames not found locally
        if (!anyExists && refBase.endsWith('.ts')) {
          const skillsDir = join(KAYA_HOME, 'skills');
          try {
            const skillDirs = readdirSync(skillsDir, { withFileTypes: true })
              .filter(d => d.isDirectory())
              .map(d => d.name);
            if (skillDirs.some(s => existsSync(join(skillsDir, s, 'Tools', refBase)))) {
              continue;
            }
          } catch { /* skills dir may not exist */ }
        }

        if (!anyExists) {
          stale.push({ source: relSource, reference: ref });
        }
      }
    }
  }

  // Deduplicate: same source + reference pair
  const seen = new Set<string>();
  return stale.filter(s => {
    const key = `${s.source}::${s.reference}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ============================================================================
// Inferential Verification (cross-check deterministic findings with LLM)
// ============================================================================

/**
 * Verify orphaned file candidates using inference.
 * Reads each candidate + nearby source files and asks an LLM to confirm
 * whether each file is truly orphaned or actually consumed via dynamic paths,
 * config loading, cross-format references, etc.
 */
async function verifyOrphans(candidates: string[], skillPath: string): Promise<string[]> {
  if (candidates.length === 0) return [];

  const contextParts: string[] = [];

  // Read each candidate orphan (truncated)
  for (const orphan of candidates) {
    const content = safeReadFile(join(skillPath, orphan));
    contextParts.push(`=== ORPHAN CANDIDATE: ${orphan} ===\n${content?.slice(0, 500) ?? '(unreadable)'}`);
  }

  // Read .ts tool files that could consume the orphans
  const tsFiles = collectAllSkillFiles(skillPath).filter(f => f.endsWith('.ts'));
  for (const tsFile of tsFiles.slice(0, 8)) {
    const content = safeReadFile(tsFile);
    if (content) {
      contextParts.push(`=== SOURCE: ${relative(skillPath, tsFile)} ===\n${content.slice(0, 1500)}`);
    }
  }

  // Read .json config files that might reference data files
  const jsonFiles = collectAllSkillFiles(skillPath).filter(f =>
    f.endsWith('.json') && !f.includes('node_modules') && !f.includes('package.json')
  );
  for (const jsonFile of jsonFiles.slice(0, 5)) {
    const content = safeReadFile(jsonFile);
    if (content) {
      contextParts.push(`=== CONFIG: ${relative(skillPath, jsonFile)} ===\n${content.slice(0, 800)}`);
    }
  }

  const result = await inference({
    systemPrompt: `You verify whether files are truly orphaned in a codebase. For each candidate, check if ANY source file loads, references, or consumes it — including via readFileSync(), join() paths, JSON config references, data file patterns, or variable-based path construction. Return a JSON array of filenames that are genuinely orphaned. Exclude files that ARE used. If none are orphaned, return [].`,
    userPrompt: `Candidate orphaned files: ${JSON.stringify(candidates)}\n\n${contextParts.join('\n\n')}`,
    level: 'fast',
    expectJson: true,
    timeout: 30000,
  });

  if (result.success && Array.isArray(result.parsed)) {
    // Only return candidates that inference confirmed as orphaned
    return result.parsed.filter((f): f is string =>
      typeof f === 'string' && candidates.includes(f)
    );
  }

  // Fallback: if inference fails, return original candidates (don't suppress real issues)
  return candidates;
}

/**
 * Verify stale reference candidates using inference.
 * Checks if referenced files were moved (e.g. to lib/core/) or renamed
 * rather than truly missing.
 */
async function verifyStaleRefs(candidates: StaleReference[], skillPath: string): Promise<StaleReference[]> {
  if (candidates.length === 0) return [];

  const contextParts: string[] = [];

  // Read source files that contain the stale references
  const uniqueSources = [...new Set(candidates.map(c => c.source))];
  for (const source of uniqueSources) {
    const content = safeReadFile(join(skillPath, source));
    if (content) {
      contextParts.push(`=== SOURCE: ${source} ===\n${content.slice(0, 2000)}`);
    }
  }

  // List available files in the skill for matching
  const allFiles = collectAllSkillFiles(skillPath);
  contextParts.push(`=== AVAILABLE IN SKILL: ${allFiles.map(f => relative(skillPath, f)).join(', ')} ===`);

  // List lib/core/ files as potential moved targets
  const libCorePath = join(skillPath, '..', '..', 'lib', 'core');
  try {
    const libCoreFiles = readdirSync(libCorePath).filter(f => f.endsWith('.ts'));
    contextParts.push(`=== AVAILABLE IN lib/core/: ${libCoreFiles.join(', ')} ===`);
  } catch { /* lib/core may not exist */ }

  const result = await inference({
    systemPrompt: `You verify whether file references are truly stale (broken) in a codebase. A reference is stale ONLY if the target file does not exist anywhere — not in the skill directory, lib/core/, or as a moved/renamed version. A reference is NOT stale if the file exists at a different path. Return a JSON array of objects with "source" and "reference" fields for ONLY the references that are genuinely broken. Return [] if none are truly stale.`,
    userPrompt: `Stale reference candidates:\n${JSON.stringify(candidates, null, 2)}\n\n${contextParts.join('\n\n')}`,
    level: 'fast',
    expectJson: true,
    timeout: 30000,
  });

  if (result.success && Array.isArray(result.parsed)) {
    return result.parsed.filter((r): r is StaleReference => {
      if (typeof r !== 'object' || r === null) return false;
      const obj = r as Record<string, unknown>;
      return typeof obj.source === 'string' && typeof obj.reference === 'string' &&
        candidates.some(c => c.source === obj.source && c.reference === obj.reference);
    });
  }

  // Fallback: return original candidates if inference fails
  return candidates;
}

/**
 * Detect TODO, FIXME, and HACK comment markers in .ts files.
 */
function detectTodoMarkers(skillName: string): TodoMarker[] {
  const markers: TodoMarker[] = [];
  const files = getSkillFiles(skillName);
  const skillPath = getSkillPath(skillName);

  const todoPattern = /\/\/.*\b(TODO|FIXME|HACK)\b.*/gi;

  for (const toolPath of files.tools) {
    const content = safeReadFile(toolPath);
    if (!content) continue;

    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      todoPattern.lastIndex = 0;
      const match = todoPattern.exec(line);
      if (match) {
        markers.push({
          file: relative(skillPath, toolPath),
          line: i + 1,
          text: line.trim(),
        });
      }
    }
  }

  return markers;
}

/**
 * Detect deprecated code living outside a _DEPRECATED/ directory.
 * Checks for:
 * - Files whose basename contains "deprecated" (case-insensitive)
 * - Files with @deprecated JSDoc tags in their content
 * - Files with "deprecated" in their content header comment
 */
function detectDeprecatedOutside(skillName: string): string[] {
  const deprecated: string[] = [];
  const skillPath = getSkillPath(skillName);
  const allFiles = collectAllSkillFiles(skillPath);

  const deprecatedNamePattern = /deprecated/i;
  // Match @deprecated JSDoc or a "deprecated" comment near the top of a file
  const deprecatedContentPattern = /@deprecated\b|DEPRECATED:/i;

  for (const filePath of allFiles) {
    // Skip anything already in _DEPRECATED/
    if (filePath.includes('/_DEPRECATED/') || filePath.includes('\\_DEPRECATED\\')) {
      continue;
    }

    const relPath = relative(skillPath, filePath);
    const fileName = basename(filePath);

    // Check filename
    if (deprecatedNamePattern.test(fileName)) {
      deprecated.push(relPath);
      continue;
    }

    // Check content (only for text files)
    if (fileName.endsWith('.ts') || fileName.endsWith('.js') || fileName.endsWith('.md')) {
      const content = safeReadFile(filePath);
      if (!content) continue;

      // Only check the first 5 lines for file-level deprecation markers.
      // Files that discuss deprecation in body logic are not themselves deprecated.
      const lines = content.split('\n');
      const headerContent = lines.slice(0, 5).join('\n');

      if (deprecatedContentPattern.test(headerContent)) {
        deprecated.push(relPath);
      }
    }
  }

  return [...new Set(deprecated)];
}

/**
 * Detect unreachable code blocks in TypeScript files.
 * Finds:
 * - Statements after unconditional return/throw/process.exit() in same block
 * - if(false) / if(true){...}else{...} literal guards
 */
function detectUnreachableCode(skillName: string): UnreachableBlock[] {
  const blocks: UnreachableBlock[] = [];
  const files = getSkillFiles(skillName);
  const skillPath = getSkillPath(skillName);

  for (const toolPath of files.tools) {
    const content = safeReadFile(toolPath);
    if (!content) continue;

    const relPath = relative(skillPath, toolPath);
    const lines = content.split('\n');
    let inBlockComment = false;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // Track block comments
      if (line.includes('/*')) inBlockComment = true;
      if (line.includes('*/')) { inBlockComment = false; continue; }
      if (inBlockComment) continue;

      // Skip single-line comments and strings
      const trimmed = line.trim();
      if (trimmed.startsWith('//')) continue;
      if (trimmed.startsWith('*')) continue;

      // Check for unconditional return/throw/process.exit followed by code at same indent
      if (/^\s*(return\b|throw\b|process\.exit\s*\()/.test(line) && trimmed.endsWith(';')) {
        const indent = line.match(/^(\s*)/)?.[1] ?? '';
        // Check next non-empty line
        for (let j = i + 1; j < lines.length; j++) {
          const nextLine = lines[j];
          const nextTrimmed = nextLine.trim();
          if (nextTrimmed === '' || nextTrimmed.startsWith('//') || nextTrimmed.startsWith('*')) continue;
          const nextIndent = nextLine.match(/^(\s*)/)?.[1] ?? '';
          // Same or deeper indent and not a closing brace = unreachable
          if (nextIndent.length >= indent.length && nextTrimmed !== '}' && nextTrimmed !== '});') {
            blocks.push({
              file: relPath,
              line: j + 1,
              reason: 'code after return/throw/process.exit()',
            });
          }
          break;
        }
      }

      // Check for if(false) or if(true){...}else{...} literal guards
      const ifFalseMatch = /\bif\s*\(\s*false\s*\)/.exec(line);
      if (ifFalseMatch && !isInsideStringLiteral(line, ifFalseMatch.index)) {
        blocks.push({
          file: relPath,
          line: i + 1,
          reason: 'if(false) block',
        });
      }
      const ifTrueMatch = /\bif\s*\(\s*true\s*\)/.exec(line);
      if (ifTrueMatch && !isInsideStringLiteral(line, ifTrueMatch.index)) {
        // Check if there's an else block — the else is unreachable
        for (let j = i + 1; j < lines.length && j < i + 50; j++) {
          if (/\belse\b/.test(lines[j])) {
            blocks.push({
              file: relPath,
              line: j + 1,
              reason: 'else branch after if(true)',
            });
            break;
          }
          // Stop looking after the block closes at same indent
          if (lines[j].trim() === '}' && (lines[j].match(/^(\s*)/)?.[1] ?? '').length <= (line.match(/^(\s*)/)?.[1] ?? '').length) {
            break;
          }
        }
      }
    }
  }

  return blocks;
}

// ============================================================================
// Scoring
// ============================================================================

export function computeScore(details: DeadCodeDetails): number {
  let score = 10;

  // Per-category penalty caps prevent any single finding type from tanking the score.
  // Without caps, a skill with a few residual orphans could score 1/10.
  const orphanPenalty = Math.max(-3, details.orphanedFiles.length * SCORING.codeHygiene.orphanedFile);
  const exportPenalty = Math.max(-2, details.unusedExports.length * SCORING.codeHygiene.unusedExport);
  const stalePenalty = Math.max(-2, details.staleReferences.length * SCORING.codeHygiene.staleReference);
  const todoPenalty = Math.max(-2, details.todoMarkers.length * SCORING.codeHygiene.unaddressedTodo);
  const deprecatedPenalty = Math.max(-2, details.deprecatedOutside.length * SCORING.codeHygiene.deprecatedOutsideDir);
  const unreachablePenalty = Math.max(-2, details.unreachableBlocks.length * SCORING.codeHygiene.unreachableCode);

  score += orphanPenalty + exportPenalty + stalePenalty + todoPenalty + deprecatedPenalty + unreachablePenalty;

  return Math.max(1, score);
}

function buildFindings(details: DeadCodeDetails, skillPath: string): Finding[] {
  const findings: Finding[] = [];

  for (const f of details.orphanedFiles) {
    findings.push({
      description: `Orphaned file: ${f}`,
      location: f,
      severity: 'MEDIUM',
    });
  }

  for (const u of details.unusedExports) {
    findings.push({
      description: `Unused export \`${u.exportName}\` in ${u.file}`,
      location: u.file,
      severity: 'LOW',
    });
  }

  for (const s of details.staleReferences) {
    findings.push({
      description: `Stale reference to \`${s.reference}\` in ${s.source}`,
      location: s.source,
      severity: 'HIGH',
    });
  }

  for (const t of details.todoMarkers) {
    findings.push({
      description: `Unaddressed marker: ${t.text.slice(0, 80)}`,
      location: `${t.file}:${t.line}`,
      severity: 'LOW',
    });
  }

  for (const d of details.deprecatedOutside) {
    findings.push({
      description: `Deprecated code outside _DEPRECATED/: ${d}`,
      location: d,
      severity: 'MEDIUM',
    });
  }

  for (const u of details.unreachableBlocks) {
    findings.push({
      description: `Unreachable code: ${u.reason}`,
      location: `${u.file}:${u.line}`,
      severity: 'LOW',
    });
  }

  return findings;
}

function buildRecommendations(details: DeadCodeDetails): Recommendation[] {
  const recs: Recommendation[] = [];
  const dim: DimensionName = 'codeHygiene';

  if (details.staleReferences.length > 0) {
    recs.push({
      action: `Fix ${details.staleReferences.length} stale file reference(s) in SKILL.md or workflow docs`,
      priority: 'P1',
      effort: 'S',
      impact: 'HIGH',
      dimension: dim,
    });
  }

  if (details.orphanedFiles.length > 0) {
    recs.push({
      action: `Remove or integrate ${details.orphanedFiles.length} orphaned file(s) not referenced anywhere`,
      priority: 'P2',
      effort: 'S',
      impact: 'MEDIUM',
      dimension: dim,
    });
  }

  if (details.deprecatedOutside.length > 0) {
    recs.push({
      action: `Move ${details.deprecatedOutside.length} deprecated file(s) into a _DEPRECATED/ directory or delete them`,
      priority: 'P2',
      effort: 'S',
      impact: 'MEDIUM',
      dimension: dim,
    });
  }

  if (details.unusedExports.length > 0) {
    recs.push({
      action: `Remove or internalize ${details.unusedExports.length} unused export(s)`,
      priority: 'P3',
      effort: 'S',
      impact: 'LOW',
      dimension: dim,
    });
  }

  if (details.todoMarkers.length > 0) {
    recs.push({
      action: `Address ${details.todoMarkers.length} TODO/FIXME/HACK marker(s) or convert to tracked issues`,
      priority: 'P3',
      effort: 'M',
      impact: 'LOW',
      dimension: dim,
    });
  }

  if (details.unreachableBlocks.length > 0) {
    recs.push({
      action: `Remove ${details.unreachableBlocks.length} unreachable code block(s)`,
      priority: 'P3',
      effort: 'S',
      impact: 'LOW',
      dimension: dim,
    });
  }

  return recs;
}

// ============================================================================
// Main Exported Function
// ============================================================================

/**
 * Run all dead code and hygiene checks for a skill.
 * Returns null if the skill doesn't exist.
 *
 * @param options.verify - When true (default), runs inferential verification on
 *   orphaned files and stale references to eliminate false positives. Set to false
 *   for fast/cheap runs that skip LLM calls.
 */
export async function detectDeadCode(
  skillName: string,
  options?: { verify?: boolean },
): Promise<DeadCodeResult | null> {
  if (!skillExists(skillName)) {
    return null;
  }

  const skillPath = getSkillPath(skillName);
  const verify = options?.verify !== false;

  const unusedExports = detectUnusedExports(skillName);
  let orphanedFiles = detectOrphanedFiles(skillName);
  let staleReferences = detectStaleReferences(skillName);
  const todoMarkers = detectTodoMarkers(skillName);
  const deprecatedOutside = detectDeprecatedOutside(skillName);
  const unreachableBlocks = detectUnreachableCode(skillName);

  // Inferential verification: cross-check deterministic findings with LLM
  if (verify && (orphanedFiles.length > 0 || staleReferences.length > 0)) {
    const [verifiedOrphans, verifiedStaleRefs] = await Promise.all([
      orphanedFiles.length > 0 ? verifyOrphans(orphanedFiles, skillPath) : Promise.resolve([]),
      staleReferences.length > 0 ? verifyStaleRefs(staleReferences, skillPath) : Promise.resolve([]),
    ]);
    orphanedFiles = verifiedOrphans;
    staleReferences = verifiedStaleRefs;
  }

  const details: DeadCodeDetails = {
    unusedExports,
    orphanedFiles,
    staleReferences,
    todoMarkers,
    deprecatedOutside,
    unreachableBlocks,
  };

  const score = computeScore(details);
  const findings = buildFindings(details, skillPath);
  const recommendations = buildRecommendations(details);
  const dimensionResult = buildDimensionResult(score, findings, recommendations);

  return {
    skillName,
    score,
    dimensionResult,
    details,
  };
}

// ============================================================================
// CLI Interface
// ============================================================================

function printReport(result: DeadCodeResult): void {
  const { skillName, score, details } = result;

  console.log(`# Dead Code Analysis: ${skillName}\n`);
  console.log(`**Dimension 6: Code Hygiene**`);
  console.log(`**Score:** ${score.toFixed(1)} / 10`);
  console.log(`**Health:** ${result.dimensionResult.health}\n`);

  // Summary counts
  console.log('## Summary\n');
  console.log(`- Stale references:        ${details.staleReferences.length}`);
  console.log(`- Orphaned files:          ${details.orphanedFiles.length}`);
  console.log(`- Deprecated outside dir:  ${details.deprecatedOutside.length}`);
  console.log(`- Unused exports:          ${details.unusedExports.length}`);
  console.log(`- TODO/FIXME/HACK markers: ${details.todoMarkers.length}`);
  console.log('');

  // Stale references (highest severity)
  if (details.staleReferences.length > 0) {
    console.log('## Stale References\n');
    for (const s of details.staleReferences) {
      console.log(`- ${s.source} → \`${s.reference}\` (file does not exist)`);
    }
    console.log('');
  }

  // Orphaned files
  if (details.orphanedFiles.length > 0) {
    console.log('## Orphaned Files\n');
    for (const f of details.orphanedFiles) {
      console.log(`- ${f}`);
    }
    console.log('');
  }

  // Deprecated outside _DEPRECATED/
  if (details.deprecatedOutside.length > 0) {
    console.log('## Deprecated Code Outside _DEPRECATED/\n');
    for (const d of details.deprecatedOutside) {
      console.log(`- ${d}`);
    }
    console.log('');
  }

  // Unused exports
  if (details.unusedExports.length > 0) {
    console.log('## Unused Exports\n');
    for (const u of details.unusedExports) {
      console.log(`- \`${u.exportName}\` in ${u.file}`);
    }
    console.log('');
  }

  // Unaddressed markers
  if (details.todoMarkers.length > 0) {
    console.log('## TODO/FIXME/HACK Markers\n');
    for (const t of details.todoMarkers) {
      console.log(`- ${t.file}:${t.line} — ${t.text}`);
    }
    console.log('');
  }

  // Recommendations
  if (result.dimensionResult.recommendations.length > 0) {
    console.log('## Recommendations\n');
    for (const r of result.dimensionResult.recommendations) {
      console.log(`[${r.priority}] ${r.action}`);
    }
    console.log('');
  }

  if (
    details.staleReferences.length === 0 &&
    details.orphanedFiles.length === 0 &&
    details.deprecatedOutside.length === 0 &&
    details.unusedExports.length === 0 &&
    details.todoMarkers.length === 0
  ) {
    console.log('No hygiene issues detected. Code is clean.\n');
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const jsonOutput = args.includes('--json');
  const noVerify = args.includes('--no-verify');
  const skillName = args.find(a => !a.startsWith('--'));

  if (!skillName) {
    console.log('Usage: bun run DeadCodeDetector.ts <skill-name>');
    console.log('       bun run DeadCodeDetector.ts <skill-name> --json');
    console.log('       bun run DeadCodeDetector.ts <skill-name> --no-verify  # skip inferential verification');
    process.exit(1);
  }

  const result = await detectDeadCode(skillName, { verify: !noVerify });

  if (!result) {
    console.error(`Skill not found: ${skillName}`);
    process.exit(1);
  }

  if (jsonOutput) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    printReport(result);
  }
}

// Run CLI if executed directly
if (import.meta.main) {
  main();
}
