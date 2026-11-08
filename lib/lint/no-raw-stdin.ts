/**
 * no-raw-stdin.ts — Architecture lint rule.
 *
 * Rule: Ban raw stdin reading outside the hook and credential input providers.
 * Hooks use lib/hook-utils.ts. CLIs (lib, bin, skills) that read piped input
 * use readStdinText() from lib/core/CliStdin.ts.
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

import { addedLines, grepTree, readStagedTsDiff } from "./StagedDiff.ts";

export interface LintResult {
  errors: string[];
  warnings: string[];
}

const EXEMPT_FILE = "lib/hook-utils.ts";
const CREDENTIAL_INPUT_PROVIDER = "lib/core/SecretInput.ts";
const CLI_STDIN_HELPER = "lib/core/CliStdin.ts";
const TEST_PATTERN = /\.(test|spec|e2e)\.(ts|tsx)$|__tests__\//;

const BANNED_PATTERNS = [
  "function readStdin[^a-zA-Z]",
  "function readStdinWithTimeout[^a-zA-Z]",
  "Bun\\.stdin\\.text\\(\\)",
  "Bun\\.stdin\\.stream\\(\\)",
  "readFileSync\\('/dev/stdin'",
  "readFileSync\\(0",
];

const COMPILED_PATTERNS = BANNED_PATTERNS.map((p) => new RegExp(p));

function isExempt(relativePath: string): boolean {
  if (relativePath === CREDENTIAL_INPUT_PROVIDER) return true;
  if (relativePath === CLI_STDIN_HELPER) return true;
  if (relativePath === EXEMPT_FILE || relativePath.endsWith(EXEMPT_FILE)) return true;
  if (TEST_PATTERN.test(relativePath)) return true;
  if (relativePath.includes("node_modules/") || relativePath.includes("worktrees/")) return true;
  if (relativePath.includes("lib/lint/")) return true;
  return false;
}

export async function checkNoRawStdin(rootDir: string = process.cwd()): Promise<LintResult> {
  const errors: string[] = [];
  const warnings: string[] = [];

  for (const pattern of BANNED_PATTERNS) {
    try {
      const output = grepTree(pattern, rootDir);

      const lines = output.split("\n").filter((l) => l.trim());

      for (const line of lines) {
        const [filePart] = line.split(":");
        if (!filePart) continue;

        const relativePath = filePart.replace(rootDir + "/", "");
        if (isExempt(relativePath)) continue;

        warnings.push(
          `${line}: Raw stdin reading. ` +
            `Use the hook readers from lib/hook-utils.ts, readStdinText from lib/core/CliStdin.ts for CLIs, or readSecretInput from lib/core/SecretInput.ts for credentials. ` +
            `Inline stdin reading causes inconsistent timeout and error handling across hooks.`,
        );
      }
    } catch (err) {
      // grep exits 1 on no match — expected. Any other status (2 = grep error) means the scan did
      // not run, which must not look like a clean pass.
      if ((err as { status?: number }).status !== 1) {
        warnings.push(`no-raw-stdin: grep failed, scan skipped: ${err instanceof Error ? err.message : String(err)}`);
      }
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

  const staged = readStagedTsDiff(rootDir, "no-raw-stdin");
  if ("warning" in staged) {
    warnings.push(staged.warning);
    return { errors, warnings };
  }

  for (const { file, line, text: added } of addedLines(staged.diff, isExempt)) {
    for (const [i, pattern] of COMPILED_PATTERNS.entries()) {
      if (pattern.test(added)) {
        errors.push(
          `${file}:${line}: Raw stdin pattern \`${BANNED_PATTERNS[i]}\` introduced. ` +
            `Use the hook readers from lib/hook-utils.ts or readSecretInput from lib/core/SecretInput.ts for credentials.`,
        );
      }
    }
  }

  return { errors, warnings };
}
