/**
 * no-inline-memory-path.ts — Architecture lint rule.
 *
 * Rule: Ban hardcoded MEMORY/ path construction outside lib/core/MemoryPaths.ts
 *
 * Two modes:
 *   - checkNoInlineMemoryPath(rootDir)        — full-tree scan; surfaces all
 *                                              hits as warnings.
 *   - checkNoInlineMemoryPathStaged(rootDir)  — diff-based scan over staged
 *                                              changes; surfaces new hits as
 *                                              ERRORS. Used by pre-commit
 *                                              (bin/lint-memory-path-staged.sh).
 *
 * Banned patterns (both modes):
 *   - "/Users/<user>/.claude/MEMORY"          — literal absolute user paths
 *   - "/.claude/MEMORY"                       — partial hardcoded ".claude/MEMORY"
 *   - KAYA_HOME + "/MEMORY/..."               — concatenation with MEMORY/
 *   - KAYA_DIR + "/MEMORY/..."                — concatenation with MEMORY/
 *
 * Use MEMORY.<accessor>.read() / .path() / memPath() from lib/core/MemoryPaths.ts.
 *
 * The diff-based mode is the seam-enforcement contract for candidate #2
 * (MemoryPaths typed accessors). Once a file is migrated to the typed
 * accessors, no future commit may re-introduce inline MEMORY path construction.
 */

import { execSync } from 'child_process';

export interface LintResult {
  errors: string[];
  warnings: string[];
}

const EXEMPT_FILE = 'lib/core/MemoryPaths.ts';
const TEST_PATTERN = /\.(test|spec)\.(ts|tsx)$|__tests__\//;

const BANNED_PATTERNS = [
  // Literal absolute user MEMORY paths (worst — hardcodes a specific user)
  '/Users/[A-Za-z][^/]*/\\.claude/MEMORY',
  // Partial hardcoded ".claude/MEMORY" string segments (e.g. process.env.HOME + ".claude/MEMORY")
  "['\"][^'\"]*\\.claude/MEMORY",
  // String concatenation: KAYA_HOME + "/MEMORY/..." or "MEMORY/..."
  'KAYA_HOME\\s*\\+\\s*[\'"][^\'"]*MEMORY/',
  'KAYA_DIR\\s*\\+\\s*[\'"][^\'"]*MEMORY/',
  // join()-based construction of a MEMORY path (S7 hardening): any
  // join(<home-ish>, "MEMORY/...") should be memPath()/an accessor instead.
  // Bare "MEMORY/..." rel-string literals in data tables (LogRegistry,
  // MemoryCleanup policy rows) are intentionally NOT banned — construction
  // is the violation, not description.
  'join\\s*\\([^)]*[\'"]MEMORY/',
];

const COMPILED_PATTERNS = BANNED_PATTERNS.map((p) => new RegExp(p));

function isExempt(relativePath: string): boolean {
  if (relativePath === EXEMPT_FILE || relativePath.endsWith(EXEMPT_FILE)) return true;
  if (TEST_PATTERN.test(relativePath)) return true;
  if (relativePath.includes('node_modules/') || relativePath.includes('worktrees/')) return true;
  if (relativePath.includes('lib/lint/')) return true;
  return false;
}

export async function checkNoInlineMemoryPath(rootDir: string = process.cwd()): Promise<LintResult> {
  const errors: string[] = [];
  const warnings: string[] = [];

  for (const pattern of BANNED_PATTERNS) {
    try {
      const output = execSync(
        `grep -rn -E "${pattern}" "${rootDir}" --include="*.ts" --include="*.tsx" 2>/dev/null || true`,
        { encoding: 'utf-8', cwd: rootDir },
      );

      const lines = output.split('\n').filter((l) => l.trim());

      for (const line of lines) {
        const [filePart] = line.split(':');
        if (!filePart) continue;

        const relativePath = filePart.replace(rootDir + '/', '');
        if (isExempt(relativePath)) continue;

        warnings.push(
          `${line}: Inline MEMORY path construction. ` +
            `Use MEMORY.<accessor>.read() / .path() / memPath() from lib/core/MemoryPaths.ts. ` +
            `Hand-rolled path constructions bypass typed accessors and silently break KAYA_HOME overrides.`,
        );
      }
    } catch {
      // grep exits non-zero on no match — fine
    }
  }

  return { errors, warnings };
}

/**
 * Diff-based scan: only flags banned patterns introduced by added lines in
 * the current staged diff. Existing violations are grandfathered, but no new
 * file may re-introduce inline MEMORY path construction.
 *
 * Returned violations land in `errors` (not warnings) so pre-commit can fail
 * the commit on any hit.
 */
export async function checkNoInlineMemoryPathStaged(
  rootDir: string = process.cwd(),
): Promise<LintResult> {
  const errors: string[] = [];
  const warnings: string[] = [];

  let diffOutput: string;
  try {
    diffOutput = execSync(
      'git diff --cached -U0 --diff-filter=ACMR --no-color -- "*.ts" "*.tsx"',
      { encoding: 'utf-8', cwd: rootDir, maxBuffer: 32 * 1024 * 1024 },
    );
  } catch {
    return { errors, warnings };
  }

  let currentFile: string | null = null;
  let currentLineNum = 0;

  for (const rawLine of diffOutput.split('\n')) {
    if (rawLine.startsWith('+++ b/')) {
      currentFile = rawLine.slice(6);
      continue;
    }
    if (rawLine.startsWith('--- ')) continue;
    if (rawLine.startsWith('diff ') || rawLine.startsWith('index ')) {
      currentFile = null;
      continue;
    }
    if (rawLine.startsWith('@@')) {
      const match = /\+(\d+)(?:,\d+)?/.exec(rawLine);
      currentLineNum = match ? parseInt(match[1], 10) : 0;
      continue;
    }
    if (!currentFile || isExempt(currentFile)) continue;

    if (rawLine.startsWith('+') && !rawLine.startsWith('+++')) {
      const added = rawLine.slice(1);
      for (let i = 0; i < COMPILED_PATTERNS.length; i++) {
        if (COMPILED_PATTERNS[i].test(added)) {
          errors.push(
            `${currentFile}:${currentLineNum}: Inline MEMORY path pattern \`${BANNED_PATTERNS[i]}\` introduced. ` +
              `Use MEMORY.<accessor>.read() / .path() / memPath() from lib/core/MemoryPaths.ts.`,
          );
        }
      }
      currentLineNum++;
    } else if (!rawLine.startsWith('-')) {
      currentLineNum++;
    }
  }

  return { errors, warnings };
}
