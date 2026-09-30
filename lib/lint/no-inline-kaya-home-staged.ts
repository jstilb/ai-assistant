/**
 * no-inline-kaya-home-staged.ts — Architecture lint rule (staged-diff mode).
 *
 * Rule: Ban NEW inline Kaya home path construction introduced in staged
 * changes.
 *
 * The full-tree burn-down completed 2026-07-07
 * (plans/inline-kaya-home-burndown-2026-07.md) — checkNoInlineKayaHome in
 * no-inline-kaya-home.ts now returns zero errors and is a hard-fail gate. This
 * staged-diff mode remains the commit-time guard: it flags any inline
 * KAYA_HOME/KAYA_DIR path construction ADDED in `git diff --cached`, so the
 * class cannot regrow. The two files share exemptions (vendored plugin caches;
 * ScaffoldCLI generated-CLI template strings).
 *
 * Reuses BANNED_PATTERNS from no-inline-kaya-home.ts — do not duplicate the
 * regexes here.
 *
 * Used by pre-commit (bin/lint-kaya-home-staged.sh).
 */

import { execSync } from 'child_process';
import { BANNED_PATTERNS } from './no-inline-kaya-home.ts';

export interface LintResult {
  errors: string[];
  warnings: string[];
}

const EXEMPT_FILE = 'lib/core/KayaHome.ts';
const TEST_PATTERN = /\.(test|spec)\.(ts|tsx)$|__tests__\//;

const COMPILED_PATTERNS = BANNED_PATTERNS.map((p) => new RegExp(p));

function isExempt(relativePath: string): boolean {
  if (relativePath === EXEMPT_FILE || relativePath.endsWith(EXEMPT_FILE)) return true;
  if (TEST_PATTERN.test(relativePath)) return true;
  if (relativePath.includes('node_modules/') || relativePath.includes('worktrees/')) return true;
  if (relativePath.includes('lib/lint/')) return true;
  // Vendored third-party plugin caches (gitignored — never actually appear in a
  // staged diff, but kept in sync with the full-tree rule's exemptions).
  if (relativePath.includes('plugins/cache/') || relativePath.includes('plugins/marketplaces/')) return true;
  return false;
}

/**
 * Diff-based scan: only flags banned patterns introduced by added lines in
 * the current staged diff. Existing violations (all ~155 of them) are
 * grandfathered, but no new file may re-introduce inline Kaya home path
 * construction.
 *
 * Returned violations land in `errors` (not warnings) so pre-commit can fail
 * the commit on any hit.
 */
export async function checkNoInlineKayaHomeStaged(
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
      // Exempt: ScaffoldCLI's generated-CLI template strings — self-contained
      // generated code that cannot import lib/core (see no-inline-kaya-home.ts).
      // Anchored on the generated-audit signature so real generator code is
      // still linted.
      if (currentFile.endsWith('CreateCLI/Tools/ScaffoldCLI.ts') && added.includes('cli-audit.jsonl')) {
        currentLineNum++;
        continue;
      }
      for (let i = 0; i < COMPILED_PATTERNS.length; i++) {
        if (COMPILED_PATTERNS[i].test(added)) {
          errors.push(
            `${currentFile}:${currentLineNum}: Inline Kaya home path pattern \`${BANNED_PATTERNS[i]}\` introduced. ` +
              `Use getKayaHome() from lib/core/KayaHome.ts.`,
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
