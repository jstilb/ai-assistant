/**
 * no-cross-skill-import.ts — Architecture lint rule (ADR-006).
 *
 * Rule: a file under skills/<Cat>/<SkillA>/ must not import (statically or
 * dynamically) from a different skills/<Cat2>/<SkillB>/ directory. Skills
 * depend DOWNWARD on lib/; cross-skill behavior goes through a seam in
 * lib/interfaces/ (see QueueTaskIntegration.ts) wired by a bin/ composition
 * root, or through an explicitly sanctioned lane (e.g. TelegramClient per
 * ADR-004).
 *
 * Deliberate exceptions carry a marker comment on the import line or the
 * line above it:   // cross-skill-allowed: <reason>
 * The marker is greppable, so the sanctioned surface is auditable:
 *   grep -rn 'cross-skill-allowed:' skills/
 *
 * Modes:
 *   - checkNoCrossSkillImport(rootDir)       — full-tree scan; unmarked
 *     violations are WARNINGS (the pre-ADR-006 tree has dozens; they are
 *     visible debt for S13/S15, not build-breakers).
 *   - checkNoCrossSkillImportStaged(rootDir) — staged-diff mode; NEWLY ADDED
 *     unmarked cross-skill import lines are ERRORS (no grandfathering).
 *     Used by pre-commit (bin/lint-cross-skill-staged.sh).
 */

import { execSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';

export interface LintResult {
  errors: string[];
  warnings: string[];
}

const MARKER = 'cross-skill-allowed:';

// skills/<Cat>/<Skill>/... — first two segments identify the skill.
const SKILL_FILE = /^skills\/([^/]+)\/([^/]+)\//;

// import ... from '<path>' | import('<path>') | require('<path>')
const IMPORT_RE = /(?:from\s*|import\s*\(\s*|require\s*\(\s*)['"]([^'"]+)['"]/g;

function resolveImport(fileRel: string, spec: string): string | null {
  if (!spec.startsWith('.')) return null; // package or absolute-alias import
  const parts = fileRel.split('/').slice(0, -1);
  for (const seg of spec.split('/')) {
    if (seg === '.' || seg === '') continue;
    if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  return parts.join('/');
}

/**
 * A cross-skill import that actually executes must resolve to a real file.
 * Resolutions that exist nowhere on disk are import-shaped noise, not
 * imports: template-literal code fixtures inside tests (e.g. SkillAudit's
 * ConventionChecker fixtures) and wrong-depth `import type` paths that only
 * survive because type imports are erased at runtime. Both classes produced
 * false "-> lib/core"-style violations before this guard.
 */
function resolvedTargetExists(rootDir: string, resolved: string): boolean {
  const p = `${rootDir}/${resolved}`;
  return (
    existsSync(p) ||
    existsSync(`${p}.ts`) ||
    existsSync(`${p}.tsx`) ||
    existsSync(`${p}.js`) ||
    existsSync(`${p}/index.ts`)
  );
}

/** Returns a violation description if (file, line) crosses skills unmarked. */
function violationOnLine(
  rootDir: string,
  fileRel: string,
  line: string,
  prevLine: string,
): string | null {
  const m = SKILL_FILE.exec(fileRel);
  if (!m) return null;
  const [, cat, skill] = m;
  if (line.includes(MARKER) || prevLine.includes(MARKER)) return null;

  for (const im of line.matchAll(IMPORT_RE)) {
    const resolved = resolveImport(fileRel, im[1] ?? '');
    if (!resolved) continue;
    if (!resolvedTargetExists(rootDir, resolved)) continue;
    const tm = SKILL_FILE.exec(resolved + '/');
    if (!tm) continue;
    const [, tCat, tSkill] = tm;
    if (tCat !== cat || tSkill !== skill) {
      return (
        `${fileRel}: imports across skills (${cat}/${skill} -> ${tCat}/${tSkill}: "${im[1]}"). ` +
        `Use a lib/interfaces seam (ADR-006) or mark deliberately with "// ${MARKER} <reason>".`
      );
    }
  }
  return null;
}

export async function checkNoCrossSkillImport(rootDir: string = process.cwd()): Promise<LintResult> {
  const errors: string[] = [];
  const warnings: string[] = [];
  let files: string[];
  try {
    files = execSync(`git ls-files 'skills/**/*.ts'`, { encoding: 'utf-8', cwd: rootDir })
      .split('\n')
      .filter(Boolean);
  } catch {
    return { errors, warnings };
  }
  for (const f of files) {
    let content: string;
    try {
      content = readFileSync(`${rootDir}/${f}`, 'utf-8');
    } catch {
      continue;
    }
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const v = violationOnLine(rootDir, f, lines[i] ?? '', lines[i - 1] ?? '');
      if (v) warnings.push(`${v} (line ${i + 1})`);
    }
  }
  return { errors, warnings };
}

export async function checkNoCrossSkillImportStaged(rootDir: string = process.cwd()): Promise<LintResult> {
  const errors: string[] = [];
  const warnings: string[] = [];
  let stagedOutput: string;
  try {
    stagedOutput = execSync(
      `git diff --cached --name-only --diff-filter=ACMR -- 'skills/*.ts' 'skills/**/*.ts'`,
      { encoding: 'utf-8', cwd: rootDir },
    );
  } catch {
    return { errors, warnings };
  }
  const stagedFiles = stagedOutput.split('\n').map((f) => f.trim()).filter(Boolean);
  for (const f of stagedFiles) {
    let diff: string;
    try {
      diff = execSync(`git diff --cached -U1 -- "${f}"`, {
        encoding: 'utf-8',
        cwd: rootDir,
        maxBuffer: 32 * 1024 * 1024,
      });
    } catch {
      continue;
    }
    let prev = '';
    for (const raw of diff.split('\n')) {
      if (!raw.startsWith('+') || raw.startsWith('+++')) {
        if (raw.startsWith(' ') || raw.startsWith('+')) prev = raw.slice(1);
        continue;
      }
      const line = raw.slice(1);
      const v = violationOnLine(rootDir, f, line, prev);
      if (v) errors.push(v);
      prev = line;
    }
  }
  return { errors, warnings };
}
