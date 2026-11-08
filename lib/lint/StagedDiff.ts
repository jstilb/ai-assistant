/**
 * StagedDiff.ts — shared plumbing for the pattern lints in this directory.
 *
 * - grepTree(): full-tree grep without a shell (patterns may contain quotes).
 * - readStagedTsDiff() + addedLines(): the staged-mode "only lines this commit
 *   ADDS" walk, with new-file line numbers.
 *
 * Formerly copied into no-inline-kaya-home(-staged), no-inline-memory-path,
 * no-raw-append and no-raw-stdin.
 */

import { execFileSync, execSync } from "node:child_process";

/** grep -rnE without a shell: patterns may contain quotes. Exit 1 (no match) → "". */
export function grepTree(pattern: string, rootDir: string): string {
  try {
    return execFileSync("grep", ["-rn", "-E", pattern, rootDir, "--include=*.ts", "--include=*.tsx"], {
      encoding: "utf-8",
      cwd: rootDir,
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch (err) {
    if ((err as { status?: number }).status === 1) return "";
    throw err;
  }
}

/**
 * The staged diff of *.ts / *.tsx files (-U0, added/changed/copied/renamed
 * only). If git fails, returns a warning instead: the commit is not blocked,
 * but visibly — a skipped check is not a clean pass.
 */
export function readStagedTsDiff(rootDir: string, lintName: string): { diff: string } | { warning: string } {
  try {
    return {
      diff: execSync('git diff --cached -U0 --diff-filter=ACMR --no-color -- "*.ts" "*.tsx"', {
        encoding: "utf-8",
        cwd: rootDir,
        maxBuffer: 32 * 1024 * 1024,
      }),
    };
  } catch (err) {
    return { warning: `${lintName}: check skipped, git failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

export interface AddedLine {
  file: string;
  /** 1-based line number in the new file. */
  line: number;
  /** The added text, without the leading "+". */
  text: string;
}

/**
 * Every line a unified diff ADDS, with its new-file line number. Files for
 * which `isExempt(file)` is true are skipped entirely.
 */
export function addedLines(diff: string, isExempt: (file: string) => boolean = () => false): AddedLine[] {
  const out: AddedLine[] = [];
  let currentFile: string | null = null;
  let currentLineNum = 0;

  for (const rawLine of diff.split("\n")) {
    if (rawLine.startsWith("+++ b/")) {
      currentFile = rawLine.slice(6);
      continue;
    }
    if (rawLine.startsWith("--- ")) continue;
    if (rawLine.startsWith("diff ") || rawLine.startsWith("index ")) {
      currentFile = null;
      continue;
    }
    if (rawLine.startsWith("@@")) {
      // @@ -a,b +c,d @@  — c is the starting new-file line number
      const match = /\+(\d+)(?:,\d+)?/.exec(rawLine);
      currentLineNum = parseInt(match?.[1] ?? "0", 10);
      continue;
    }
    if (!currentFile || isExempt(currentFile)) continue;

    if (rawLine.startsWith("+") && !rawLine.startsWith("+++")) {
      out.push({ file: currentFile, line: currentLineNum, text: rawLine.slice(1) });
      currentLineNum++;
    } else if (!rawLine.startsWith("-")) {
      // context line — advances the new-file counter
      currentLineNum++;
    }
    // '-' lines do not advance the new-file counter
  }
  return out;
}
