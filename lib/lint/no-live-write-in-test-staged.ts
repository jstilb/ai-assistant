/**
 * no-live-write-in-test-staged.ts — Architecture lint rule (staged-diff mode).
 *
 * Staged-diff twin of no-live-write-in-test.ts's full-tree scan. Reuses
 * LIVE_WRITER_NAMES / importsLiveWriter / hasNoKayaHomePin / violationMessage
 * from that file — do not duplicate the detection logic here.
 *
 * Unlike no-inline-kaya-home-staged.ts (which only inspects newly ADDED
 * diff lines, because that rule bans a pattern that can be introduced on a
 * single line), this rule checks a whole-file PROPERTY — "does this file,
 * in its entirety, ever pin KAYA_HOME anywhere?" — so it inspects the
 * staged CONTENT of each staged test file in full, mirroring
 * no-unguarded-hook-main.ts's checkNoUnguardedHookMainStaged (another
 * whole-file-property staged rule) rather than no-inline-kaya-home-staged.ts's
 * line-by-line diff walk.
 *
 * Severity: WARNING (non-blocking) — see no-live-write-in-test.ts's doc
 * comment for the rationale and the accepted false-positive class.
 *
 * Used by pre-commit via bin/lint-live-write-staged.sh.
 */

import { execSync } from 'child_process';
import {
  importsLiveWriter,
  hasNoKayaHomePin,
  violationMessage,
  type LintResult,
} from './no-live-write-in-test.ts';

export type { LintResult };

const TEST_FILE_PATTERN = /(\.test\.ts$)|(__tests__\/.*\.ts$)/;

function isExempt(relativePath: string): boolean {
  if (relativePath.includes('node_modules/') || relativePath.includes('worktrees/')) return true;
  if (relativePath.includes('lib/lint/')) return true;
  return false;
}

/**
 * Diff-based scan: only checks *.test.ts / __tests__/*.ts files present in
 * the staged index (added, copied, modified, or renamed). Reads the staged
 * (index) content via `git show :<path>` — not the working tree — so the
 * check reflects exactly what is about to be committed.
 */
export async function checkNoLiveWriteInTestStaged(
  rootDir: string = process.cwd(),
): Promise<LintResult> {
  const errors: string[] = [];
  const warnings: string[] = [];

  let stagedOutput: string;
  try {
    stagedOutput = execSync(`git diff --cached --name-only --diff-filter=ACMR -- '*.ts'`, {
      encoding: 'utf-8',
      cwd: rootDir,
      maxBuffer: 32 * 1024 * 1024,
    });
  } catch {
    return { errors, warnings };
  }

  const stagedFiles = stagedOutput
    .split('\n')
    .map((f) => f.trim())
    .filter((f) => f.length > 0 && TEST_FILE_PATTERN.test(f) && !isExempt(f));

  for (const relativePath of stagedFiles) {
    let content: string;
    try {
      content = execSync(`git show ":${relativePath}"`, {
        encoding: 'utf-8',
        cwd: rootDir,
        maxBuffer: 32 * 1024 * 1024,
      });
    } catch (err) {
      warnings.push(`[no-live-write-in-test] Could not read staged content of ${relativePath}: ${err}`);
      continue;
    }

    const writers = importsLiveWriter(content);
    if (writers.length === 0) continue;
    if (hasNoKayaHomePin(content)) {
      warnings.push(violationMessage(relativePath, writers));
    }
  }

  return { errors, warnings };
}
