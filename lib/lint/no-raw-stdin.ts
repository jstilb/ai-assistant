/**
 * no-raw-stdin.ts — Architecture lint rule.
 *
 * Rule: Ban raw stdin reading outside the hook and credential input providers.
 *
 * Two modes:
 *   - checkNoRawStdin(rootDir)        — full-tree scan; surfaces all hits as
 *                                       warnings. Used by lib/lint/run-all.ts.
 *   - checkNoRawStdinStaged(rootDir)  — diff-based scan over staged changes
 *                                       only; surfaces new hits as ERRORS.
 *                                       Used by pre-commit (bin/lint-stdin-staged.sh).
 *                                       Grandfathered violations are not flagged.
 *
 * Banned patterns (both modes):
 *   - function readStdin(
 *   - function readStdinWithTimeout(
 *   - Bun.stdin.text() / Bun.stdin.stream()
 *   - readFileSync('/dev/stdin'
 *   - readFileSync(0
 *
 * The diff-based mode is the seam-enforcement contract for candidate #1
 * (HookInput). Once a hook is migrated to readSecurityHookInput /
 * readObservabilityHookInput, no future commit may re-introduce inline
 * stdin reads in that file or any hook.
 */

import { execSync } from 'child_process';

export interface LintResult {
  errors: string[];
  warnings: string[];
}

const EXEMPT_FILE = 'lib/hook-utils.ts';
const CREDENTIAL_INPUT_PROVIDER = 'lib/core/SecretInput.ts';
const TEST_PATTERN = /\.(test|spec)\.(ts|tsx)$|__tests__\//;

const BANNED_PATTERNS = [
  'function readStdin[^a-zA-Z]',
  'function readStdinWithTimeout[^a-zA-Z]',
  'Bun\\.stdin\\.text\\(\\)',
  'Bun\\.stdin\\.stream\\(\\)',
  "readFileSync\\('/dev/stdin'",
  'readFileSync\\(0',
];

const COMPILED_PATTERNS = BANNED_PATTERNS.map(p => new RegExp(p));

function isExempt(relativePath: string): boolean {
  if (relativePath === CREDENTIAL_INPUT_PROVIDER) return true;
  if (relativePath === EXEMPT_FILE || relativePath.endsWith(EXEMPT_FILE)) return true;
  if (TEST_PATTERN.test(relativePath)) return true;
  if (relativePath.includes('node_modules/') || relativePath.includes('worktrees/')) return true;
  if (relativePath.includes('lib/lint/')) return true;
  return false;
}

export async function checkNoRawStdin(rootDir: string = process.cwd()): Promise<LintResult> {
  const errors: string[] = [];
  const warnings: string[] = [];

  for (const pattern of BANNED_PATTERNS) {
    try {
      const output = execSync(
        `grep -rn -E "${pattern}" "${rootDir}" --include="*.ts" --include="*.tsx" 2>/dev/null || true`,
        { encoding: 'utf-8', cwd: rootDir }
      );

      const lines = output.split('\n').filter(l => l.trim());

      for (const line of lines) {
        const [filePart] = line.split(':');
        if (!filePart) continue;

        const relativePath = filePart.replace(rootDir + '/', '');
        if (isExempt(relativePath)) continue;

        warnings.push(
          `${line}: Raw stdin reading. ` +
          `Use the hook readers from lib/hook-utils.ts or readSecretInput from lib/core/SecretInput.ts for credentials. ` +
          `Inline stdin reading causes inconsistent timeout and error handling across hooks.`
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
 * hook may re-introduce inline stdin reading.
 *
 * Returned violations land in `errors` (not warnings) so pre-commit can fail
 * the commit on any hit.
 */
export async function checkNoRawStdinStaged(rootDir: string = process.cwd()): Promise<LintResult> {
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
      for (let i = 0; i < COMPILED_PATTERNS.length; i++) {
        if (COMPILED_PATTERNS[i].test(added)) {
          errors.push(
            `${currentFile}:${currentLineNum}: Raw stdin pattern \`${BANNED_PATTERNS[i]}\` introduced. ` +
            `Use the hook readers from lib/hook-utils.ts or readSecretInput from lib/core/SecretInput.ts for credentials.`,
          );
        }
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
