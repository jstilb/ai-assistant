/**
 * no-raw-append.ts — Architecture lint rule.
 *
 * Rule: Ban appendFileSync outside lib/core/AppendLog.ts
 * Severity: ERROR
 *
 * Two modes:
 *   - checkNoRawAppend(rootDir)        — full-tree scan; surfaces all hits as
 *                                        errors. Used by lib/lint/run-all.ts.
 *   - checkNoRawAppendStaged(rootDir)  — diff-based scan over staged changes
 *                                        only; surfaces newly ADDED lines
 *                                        matching appendFileSync( as errors.
 *                                        Used by pre-commit
 *                                        (bin/lint-append-staged.sh).
 *                                        Existing appendFileSync sites
 *                                        anywhere in the tree are
 *                                        grandfathered — the migration to
 *                                        createAppendLog() is incremental
 *                                        (see lib/core/AppendLog.ts) — but no
 *                                        commit may introduce a fresh one.
 *
 * Usage: called by lib/lint/run-all.ts and bin/lint-append-staged.sh
 */

import { execSync } from 'child_process';

export interface LintResult {
  errors: string[];
  warnings: string[];
}

const EXEMPT_FILE = 'lib/core/AppendLog.ts';
const TEST_PATTERN = /\.(test|spec)\.(ts|tsx)$|__tests__\//;
const APPEND_PATTERN = /appendFileSync\s*\(/;

function isExempt(relativePath: string): boolean {
  if (relativePath === EXEMPT_FILE || relativePath.endsWith(EXEMPT_FILE)) return true;
  if (TEST_PATTERN.test(relativePath)) return true;
  if (relativePath.includes('node_modules/') || relativePath.includes('worktrees/')) return true;
  // The lint rule's own source (and any sibling lint rule) legitimately
  // mentions the banned token in patterns/messages — never a real call site.
  if (relativePath.includes('lib/lint/')) return true;
  return false;
}

export async function checkNoRawAppend(rootDir: string = process.cwd()): Promise<LintResult> {
  const errors: string[] = [];
  const warnings: string[] = [];

  try {
    // Search for appendFileSync usage across TypeScript files
    const output = execSync(
      `grep -rn "appendFileSync" "${rootDir}" --include="*.ts" --include="*.tsx" -l 2>/dev/null || true`,
      { encoding: 'utf-8', cwd: rootDir }
    );

    const files = output.split('\n').filter(f => f.trim());

    for (const file of files) {
      const relativePath = file.replace(rootDir + '/', '');
      if (isExempt(relativePath)) continue;

      errors.push(
        `${relativePath}: Uses appendFileSync directly. ` +
        `Use createAppendLog() from lib/core/AppendLog.ts instead. ` +
        `This ensures rotation and retention.`
      );
    }
  } catch (err) {
    warnings.push(`[no-raw-append] grep failed: ${err}`);
  }

  return { errors, warnings };
}

/**
 * Diff-based scan: only flags appendFileSync( calls introduced by ADDED
 * lines in the current staged diff. Existing violations anywhere in the
 * tree are grandfathered — the migration to createAppendLog() is
 * incremental — but no new commit may introduce a fresh raw-append site.
 *
 * Returned violations land in `errors` so pre-commit can fail the commit
 * on any hit.
 */
export async function checkNoRawAppendStaged(rootDir: string = process.cwd()): Promise<LintResult> {
  const errors: string[] = [];
  const warnings: string[] = [];

  let diffOutput: string;
  try {
    // -U0 trims context, --diff-filter=ACMR limits to added/changed/copied/renamed
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
      // @@ -a,b +c,d @@  — c is the starting new-file line number
      const match = /\+(\d+)(?:,\d+)?/.exec(rawLine);
      currentLineNum = match ? parseInt(match[1], 10) : 0;
      continue;
    }
    if (!currentFile || isExempt(currentFile)) continue;

    if (rawLine.startsWith('+') && !rawLine.startsWith('+++')) {
      const added = rawLine.slice(1);
      if (APPEND_PATTERN.test(added)) {
        errors.push(
          `${currentFile}:${currentLineNum}: Raw appendFileSync( introduced. ` +
          `Use createAppendLog() from lib/core/AppendLog.ts instead — it ` +
          `provides rotation and retention that raw appendFileSync does not.`,
        );
      }
      currentLineNum++;
    } else if (!rawLine.startsWith('-')) {
      // context line — advances the new-file counter
      currentLineNum++;
    }
    // '-' lines do not advance the new-file counter
  }

  return { errors, warnings };
}
