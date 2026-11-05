/**
 * no-cross-skill-import.ts — Architecture lint rule (ADR-006, ADR-030).
 *
 * Rule: a file under skills/<Cat>/<SkillA>/ must not import (statically or
 * dynamically) from a different skills/<Cat2>/<SkillB>/ directory. Skills
 * depend DOWNWARD on lib/; cross-skill behavior goes through a seam in
 * lib/interfaces/ (see QueueTaskIntegration.ts) wired by a bin/ composition
 * root, through shared code in lib/, or through an explicitly sanctioned lane
 * (e.g. TelegramClient per ADR-004; the lanes are listed in ADR-030).
 *
 * Deliberate exceptions carry a marker comment on the import statement, on a
 * line of a multi-line import statement, or on the line above it:
 *     // cross-skill-allowed: <reason>
 * The marker is greppable, so the sanctioned surface is auditable:
 *   grep -rn 'cross-skill-allowed:' skills/
 *
 * Two shapes are checked:
 *   1. Specifier imports: `from "<rel>"`, `import("<rel>")`, `require("<rel>")`.
 *   2. Hidden imports: `import(NAME)` where `const NAME = "<rel>"` (or an
 *      `import(\`<rel>...\`)` template) points into another skill. A variable
 *      specifier hides the dependency from tsc and from shape 1. Variable
 *      specifiers whose value is not a visible literal in the same file cannot
 *      be resolved statically; those are not flagged.
 *
 * Modes:
 *   - checkNoCrossSkillImport(rootDir)       — full-tree scan; every unmarked
 *     violation is an ERROR (the tree is clean since ADR-030; keep it so).
 *   - checkNoCrossSkillImportStaged(rootDir) — staged mode; a violation that
 *     the staged blob has more of than HEAD is an ERROR. Used by pre-commit
 *     (bin/lint-cross-skill-staged.sh).
 */

import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

export interface LintResult {
  errors: string[];
  warnings: string[];
}

const MARKER = "cross-skill-allowed:";

// skills/<Cat>/<Skill>/... — first two segments identify the skill.
const SKILL_FILE = /^skills\/([^/]+)\/([^/]+)\//;

// import ... from '<path>' | import('<path>') | require('<path>')
const IMPORT_RE = /(?:from\s*|import\s*\(\s*|require\s*\(\s*)['"]([^'"]+)['"]/g;

// const NAME = "<relative path>"   (a path held in a variable)
const PATH_CONST_RE = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::\s*string\s*)?=\s*['"](\.[^'"]*)['"]/g;

// import(`<relative prefix>...`) template specifier
const TEMPLATE_IMPORT_RE = /import\s*\(\s*`(\.[^`$?]*)/g;

// A line that starts an import/export statement (start of a multi-line import).
const STATEMENT_START = /^\s*(?:import|export)\b/;

function resolveImport(fileRel: string, spec: string): string | null {
  if (!spec.startsWith(".")) return null; // package or absolute-alias import
  const parts = fileRel.split("/").slice(0, -1);
  for (const seg of spec.split("/")) {
    if (seg === "." || seg === "") continue;
    if (seg === "..") parts.pop();
    else parts.push(seg);
  }
  return parts.join("/");
}

/**
 * A cross-skill import that actually executes must resolve to a real file.
 * Resolutions that exist nowhere on disk are import-shaped noise, not
 * imports: template-literal code fixtures inside tests (e.g. SkillAudit's
 * ConventionChecker fixtures) and wrong-depth `import type` paths that only
 * survive because type imports are erased at runtime.
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

/** Describes the violation if `spec` imported from `fileRel` crosses skills, else null. */
function crossSkillTarget(rootDir: string, fileRel: string, spec: string): string | null {
  const m = SKILL_FILE.exec(fileRel);
  if (!m) return null;
  const [, cat, skill] = m;
  const resolved = resolveImport(fileRel, spec);
  if (!resolved) return null;
  if (!resolvedTargetExists(rootDir, resolved)) return null;
  const tm = SKILL_FILE.exec(`${resolved}/`);
  if (!tm) return null;
  const [, tCat, tSkill] = tm;
  if (tCat === cat && tSkill === skill) return null;
  return `${cat}/${skill} -> ${tCat}/${tSkill}`;
}

/** True if a marker sits on line `i`, the line above it, or inside the statement that ends at `i`. */
function isMarked(lines: string[], i: number): boolean {
  if ((lines[i] ?? "").includes(MARKER)) return true;
  if ((lines[i - 1] ?? "").includes(MARKER)) return true;
  // Multi-line import: `} from "x"` — walk up to the statement start (max 40 lines).
  if (!/^\s*\}\s*from\b/.test(lines[i] ?? "")) return false;
  for (let j = i - 1; j >= 0 && j >= i - 40; j--) {
    const l = lines[j] ?? "";
    if (l.includes(MARKER)) return true;
    if (STATEMENT_START.test(l)) {
      return (lines[j - 1] ?? "").includes(MARKER);
    }
  }
  return false;
}

/**
 * Violations in one file's content, without line numbers in the message key
 * (so staged mode can compare against HEAD). `line` is 1-based.
 */
export function findViolations(
  rootDir: string,
  fileRel: string,
  content: string,
): Array<{ key: string; line: number; message: string }> {
  const out: Array<{ key: string; line: number; message: string }> = [];
  if (!SKILL_FILE.test(fileRel)) return out;
  const lines = content.split("\n");

  // Variable names holding a relative path literal, with the line they are declared on.
  const pathConsts = new Map<string, { spec: string; line: number }>();
  for (const [li, text] of lines.entries()) {
    for (const cm of text.matchAll(PATH_CONST_RE)) {
      pathConsts.set(cm[1] ?? "", { spec: cm[2] ?? "", line: li });
    }
  }

  for (const [i, line] of lines.entries()) {
    for (const im of line.matchAll(IMPORT_RE)) {
      const spec = im[1] ?? "";
      const t = crossSkillTarget(rootDir, fileRel, spec);
      if (!t || isMarked(lines, i)) continue;
      out.push({
        key: `${fileRel}|${spec}`,
        line: i + 1,
        message:
          `${fileRel}: imports across skills (${t}: "${spec}"). ` +
          `Move shared code to lib/, use a lib/interfaces seam (ADR-006), or mark with "// ${MARKER} <reason>".`,
      });
    }

    for (const tm of line.matchAll(TEMPLATE_IMPORT_RE)) {
      const spec = tm[1] ?? "";
      const t = crossSkillTarget(rootDir, fileRel, spec);
      if (!t || isMarked(lines, i)) continue;
      out.push({
        key: `${fileRel}|template|${spec}`,
        line: i + 1,
        message:
          `${fileRel}: template-literal import hides a cross-skill dependency (${t}: \`${spec}…\`). ` +
          `Use a static specifier or mark with "// ${MARKER} <reason>".`,
      });
    }

    for (const vm of line.matchAll(/\bimport\s*\(\s*([A-Za-z_$][\w$]*)\s*\)/g)) {
      const decl = pathConsts.get(vm[1] ?? "");
      if (!decl) continue;
      const t = crossSkillTarget(rootDir, fileRel, decl.spec);
      if (!t) continue;
      if (isMarked(lines, i) || isMarked(lines, decl.line)) continue;
      out.push({
        key: `${fileRel}|variable|${decl.spec}`,
        line: i + 1,
        message:
          `${fileRel}: variable-specifier import hides a cross-skill dependency (${t}: ${vm[1]} = "${decl.spec}"). ` +
          `Use a static specifier (tsc and this lint can then see it) and mark with "// ${MARKER} <reason>".`,
      });
    }
  }
  return out;
}

export async function checkNoCrossSkillImport(rootDir: string = process.cwd()): Promise<LintResult> {
  const errors: string[] = [];
  const warnings: string[] = [];
  let files: string[];
  try {
    files = execSync(`git ls-files 'skills/**/*.ts'`, { encoding: "utf-8", cwd: rootDir }).split("\n").filter(Boolean);
  } catch (err) {
    // Fail open (the commit is not blocked) but visibly: a skipped check is not a clean pass.
    warnings.push(
      `no-cross-skill-import: check skipped, git failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return { errors, warnings };
  }
  for (const f of files) {
    let content: string;
    try {
      content = readFileSync(`${rootDir}/${f}`, "utf-8");
    } catch (err) {
      warnings.push(`${f}: unreadable, skipped: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    for (const v of findViolations(rootDir, f, content)) {
      errors.push(`${v.message} (line ${v.line})`);
    }
  }
  return { errors, warnings };
}

export async function checkNoCrossSkillImportStaged(rootDir: string = process.cwd()): Promise<LintResult> {
  const errors: string[] = [];
  const warnings: string[] = [];
  let stagedOutput: string;
  try {
    stagedOutput = execSync(`git diff --cached --name-only --diff-filter=ACMR -- 'skills/*.ts' 'skills/**/*.ts'`, {
      encoding: "utf-8",
      cwd: rootDir,
    });
  } catch (err) {
    // Fail open (the commit is not blocked) but visibly: a skipped check is not a clean pass.
    warnings.push(
      `no-cross-skill-import: check skipped, git failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return { errors, warnings };
  }
  const stagedFiles = stagedOutput
    .split("\n")
    .map((f) => f.trim())
    .filter(Boolean);
  for (const f of stagedFiles) {
    let staged: string;
    try {
      staged = execSync(`git show ":${f}"`, { encoding: "utf-8", cwd: rootDir, maxBuffer: 32 * 1024 * 1024 });
    } catch (err) {
      warnings.push(
        `${f}: git show of the staged blob failed, skipped: ${err instanceof Error ? err.message : String(err)}`,
      );
      continue;
    }
    let head = "";
    try {
      head = execSync(`git show "HEAD:${f}"`, {
        encoding: "utf-8",
        cwd: rootDir,
        maxBuffer: 32 * 1024 * 1024,
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch {
      head = ""; // new file: every violation is new
    }
    const before = new Map<string, number>();
    for (const v of findViolations(rootDir, f, head)) before.set(v.key, (before.get(v.key) ?? 0) + 1);
    for (const v of findViolations(rootDir, f, staged)) {
      const left = before.get(v.key) ?? 0;
      if (left > 0) {
        before.set(v.key, left - 1); // already present in HEAD
        continue;
      }
      errors.push(`${v.message} (line ${v.line})`);
    }
  }
  return { errors, warnings };
}
