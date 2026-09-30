/**
 * no-unguarded-hook-main.ts — Architecture lint rule.
 *
 * Rule: Every hooks/*.hook.ts file must guard its terminal main() invocation
 * with `if (import.meta.main) { ... }`.
 *
 * Background: 28 of 32 hooks/*.hook.ts files used to invoke main()
 * unconditionally at module scope. Test files import pure helpers from hook
 * files; the bare import executed the hook -> stdin wait -> process.exit(0),
 * which killed the Bun test process before any test could report. This made
 * `bun run test` FALSE-GREEN (exit 0, zero tests reported). See
 * docs/testing-baseline-2026-07.md.
 *
 * Two modes:
 *   - checkNoUnguardedHookMain(rootDir)        — full-tree scan of hooks/*.hook.ts;
 *                                                surfaces all hits as ERRORS.
 *                                                Used by lib/lint/run-all.ts.
 *   - checkNoUnguardedHookMainStaged(rootDir)  — diff-based scan over staged
 *                                                hooks/*.hook.ts files only;
 *                                                surfaces hits as ERRORS.
 *                                                Used by pre-commit
 *                                                (bin/lint-hook-guard-staged.sh).
 *
 * Unlike no-raw-stdin.ts (a banned-pattern rule with grandfathering), this is
 * a required-pattern rule: every hooks/*.hook.ts file, staged or not, must
 * contain `import.meta.main`. There is no grandfathering — all 32 hooks are
 * guarded as of this rule's introduction.
 */

import { execSync } from 'child_process';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

export interface LintResult {
  errors: string[];
  warnings: string[];
}

const HOOK_FILE_PATTERN = /\.hook\.ts$/;
const REQUIRED_MARKER = 'import.meta.main';

function violationMessage(relativePath: string): string {
  return (
    `${relativePath}: main() invocation is not guarded by \`if (import.meta.main)\`. ` +
    `An unguarded main() runs at import time, which poisons \`bun test\` (importing the file ` +
    `to reach a pure helper executes the hook and calls process.exit() before any test can ` +
    `report). Wrap the terminal main() invocation in \`if (import.meta.main) { main(); }\`.`
  );
}

/**
 * Full-tree scan: every direct child of hooks/ matching *.hook.ts must
 * contain the import.meta.main marker.
 */
export async function checkNoUnguardedHookMain(rootDir: string = process.cwd()): Promise<LintResult> {
  const errors: string[] = [];
  const warnings: string[] = [];

  const hooksDir = join(rootDir, 'hooks');
  let entries: string[];
  try {
    entries = readdirSync(hooksDir);
  } catch (err) {
    warnings.push(`[no-unguarded-hook-main] Could not read hooks directory (${hooksDir}): ${err}`);
    return { errors, warnings };
  }

  for (const entry of entries) {
    if (!HOOK_FILE_PATTERN.test(entry)) continue;

    const filePath = join(hooksDir, entry);
    let content: string;
    try {
      content = readFileSync(filePath, 'utf-8');
    } catch (err) {
      warnings.push(`[no-unguarded-hook-main] Could not read hooks/${entry}: ${err}`);
      continue;
    }

    if (!content.includes(REQUIRED_MARKER)) {
      errors.push(violationMessage(`hooks/${entry}`));
    }
  }

  return { errors, warnings };
}

/**
 * Diff-based scan: only checks hooks/*.hook.ts files present in the staged
 * index (added, copied, modified, or renamed). Reads the staged (index)
 * content via `git show :<path>` — not the working tree — so the check
 * reflects exactly what is about to be committed.
 */
export async function checkNoUnguardedHookMainStaged(rootDir: string = process.cwd()): Promise<LintResult> {
  const errors: string[] = [];
  const warnings: string[] = [];

  let stagedOutput: string;
  try {
    stagedOutput = execSync(
      `git diff --cached --name-only --diff-filter=ACMR -- 'hooks/*.hook.ts'`,
      { encoding: 'utf-8', cwd: rootDir },
    );
  } catch {
    return { errors, warnings };
  }

  const stagedFiles = stagedOutput
    .split('\n')
    .map((f) => f.trim())
    .filter((f) => f.length > 0 && HOOK_FILE_PATTERN.test(f));

  for (const relativePath of stagedFiles) {
    let content: string;
    try {
      content = execSync(`git show ":${relativePath}"`, {
        encoding: 'utf-8',
        cwd: rootDir,
        maxBuffer: 32 * 1024 * 1024,
      });
    } catch (err) {
      warnings.push(`[no-unguarded-hook-main] Could not read staged content of ${relativePath}: ${err}`);
      continue;
    }

    if (!content.includes(REQUIRED_MARKER)) {
      errors.push(violationMessage(relativePath));
    }
  }

  return { errors, warnings };
}
