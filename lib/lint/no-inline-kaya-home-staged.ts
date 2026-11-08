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

import { addedLines, readStagedTsDiff } from "./StagedDiff.ts";
import { BANNED_PATTERNS } from "./no-inline-kaya-home.ts";

export interface LintResult {
  errors: string[];
  warnings: string[];
}

const EXEMPT_FILE = "lib/core/KayaHome.ts";
const TEST_PATTERN = /\.(test|spec|e2e)\.(ts|tsx)$|__tests__\//;

const COMPILED_PATTERNS = BANNED_PATTERNS.map((p) => new RegExp(p));

function isExempt(relativePath: string): boolean {
  if (relativePath === EXEMPT_FILE || relativePath.endsWith(EXEMPT_FILE)) return true;
  if (TEST_PATTERN.test(relativePath)) return true;
  if (relativePath.includes("node_modules/") || relativePath.includes("worktrees/")) return true;
  if (relativePath.includes("lib/lint/")) return true;
  // Vendored third-party plugin caches (gitignored — never actually appear in a
  // staged diff, but kept in sync with the full-tree rule's exemptions).
  if (relativePath.includes("plugins/cache/") || relativePath.includes("plugins/marketplaces/")) return true;
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
export async function checkNoInlineKayaHomeStaged(rootDir: string = process.cwd()): Promise<LintResult> {
  const errors: string[] = [];
  const warnings: string[] = [];

  const staged = readStagedTsDiff(rootDir, "no-inline-kaya-home-staged");
  if ("warning" in staged) {
    warnings.push(staged.warning);
    return { errors, warnings };
  }

  for (const { file, line, text: added } of addedLines(staged.diff, isExempt)) {
    // Exempt: ScaffoldCLI's generated-CLI template strings — self-contained
    // generated code that cannot import lib/core (see no-inline-kaya-home.ts).
    // Anchored on the generated-audit signature so real generator code is
    // still linted.
    if (file.endsWith("CreateCLI/Tools/ScaffoldCLI.ts") && added.includes("cli-audit.jsonl")) {
      continue;
    }
    for (const [i, pattern] of COMPILED_PATTERNS.entries()) {
      if (pattern.test(added)) {
        errors.push(
          `${file}:${line}: Inline Kaya home path pattern \`${BANNED_PATTERNS[i]}\` introduced. ` +
            `Use getKayaHome() from lib/core/KayaHome.ts.`,
        );
      }
    }
  }

  return { errors, warnings };
}
