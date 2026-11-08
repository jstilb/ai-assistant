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

import { execSync } from "node:child_process";
import { addedLines, readStagedTsDiff } from "./StagedDiff.ts";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface LintResult {
  errors: string[];
  warnings: string[];
}

const EXEMPT_FILE = "lib/core/AppendLog.ts";
const TEST_PATTERN = /\.(test|spec|e2e)\.(ts|tsx)$|__tests__\//;
const APPEND_PATTERN = /appendFileSync\s*\(/;

function isExempt(relativePath: string): boolean {
  if (relativePath === EXEMPT_FILE || relativePath.endsWith(EXEMPT_FILE)) return true;
  if (TEST_PATTERN.test(relativePath)) return true;
  if (relativePath.includes("node_modules/") || relativePath.includes("worktrees/")) return true;
  // The lint rule's own source (and any sibling lint rule) legitimately
  // mentions the banned token in patterns/messages — never a real call site.
  if (relativePath.includes("lib/lint/")) return true;
  return false;
}

/**
 * A call is allowed when the call line or one of the ALLOW_WINDOW lines above
 * it carries an explicit marker — `lint-allow: no-raw-append` (preferred) or
 * the older `EXEMPT (appendFileSync sweep)` comment. Use it only for appends
 * that are NOT growing logs (a Markdown section, a shell rc file, a one-shot
 * report), where rotation would be wrong. Always state the reason.
 */
const ALLOW_MARKER = /lint-allow:\s*no-raw-append|EXEMPT \(appendFileSync sweep\)/;
const ALLOW_WINDOW = 12;
const COMMENT_LINE = /^\s*(\/\/|\*|\/\*)/;

/** Real `appendFileSync(` call lines (1-based) in `source` with no allow marker. */
export function findRawAppendCalls(source: string): number[] {
  const lines = source.split("\n");
  const hits: number[] = [];
  lines.forEach((line, i) => {
    if (!APPEND_PATTERN.test(line) || COMMENT_LINE.test(line)) return;
    const window = lines.slice(Math.max(0, i - ALLOW_WINDOW), i + 1);
    if (window.some((l) => ALLOW_MARKER.test(l))) return;
    hits.push(i + 1);
  });
  return hits;
}

export async function checkNoRawAppend(rootDir: string = process.cwd()): Promise<LintResult> {
  const errors: string[] = [];
  const warnings: string[] = [];

  try {
    // Candidate files: tracked .ts/.tsx that mention the token at all.
    const output = execSync(
      `git ls-files -z -- "*.ts" "*.tsx" | xargs -0 grep -l "appendFileSync" 2>/dev/null || true`,
      { encoding: "utf-8", cwd: rootDir, maxBuffer: 32 * 1024 * 1024 },
    );

    const files = output.split("\n").filter((f) => f.trim());

    for (const relativePath of files) {
      if (isExempt(relativePath)) continue;
      let source: string;
      try {
        source = readFileSync(join(rootDir, relativePath), "utf-8");
      } catch (err) {
        warnings.push(`[no-raw-append] cannot read ${relativePath}: ${err}`);
        continue;
      }
      for (const line of findRawAppendCalls(source)) {
        errors.push(
          `${relativePath}:${line}: Uses appendFileSync directly. ` +
            `Use createAppendLog() from lib/core/AppendLog.ts instead (rotation and retention). ` +
            `If this is not a growing log, mark it with "// lint-allow: no-raw-append — <reason>".`,
        );
      }
    }
  } catch (err) {
    warnings.push(`[no-raw-append] scan failed: ${err}`);
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

  const staged = readStagedTsDiff(rootDir, "no-raw-append");
  if ("warning" in staged) {
    warnings.push(staged.warning);
    return { errors, warnings };
  }

  for (const { file, line, text: added } of addedLines(staged.diff, isExempt)) {
    if (APPEND_PATTERN.test(added) && !COMMENT_LINE.test(added) && !ALLOW_MARKER.test(added)) {
      errors.push(
        `${file}:${line}: Raw appendFileSync( introduced. ` +
          `Use createAppendLog() from lib/core/AppendLog.ts instead — it ` +
          `provides rotation and retention that raw appendFileSync does not.`,
      );
    }
  }

  return { errors, warnings };
}
