/**
 * Evidence.ts - Filesystem evidence gathering for Phase 2 enrichment.
 *
 * Houses gatherEvidence() as a pure function. Takes config as a parameter
 * rather than reading class state. Imports CATASTROPHIC_PATTERNS from
 * WorkOrchestrator and VERIFICATION_ALLOWED_EXECUTABLES from SkepticalVerifier.
 */

import { join } from "path";
import { readFileSync } from "fs";
import { CATASTROPHIC_PATTERNS } from "../../VerificationUtils.ts";
import { VERIFICATION_ALLOWED_EXECUTABLES } from "../../../Tools/SkepticalVerifier.ts";
import type { EvidenceResult, ItemReviewSummary, SkepticalVerifierConfig } from "../../../Tools/SkepticalVerifier.ts";
import { scoreAndExtractSections, extractPathsFromDiffStat, parseMultiRepoDiffStat } from "./Tier1.ts";
import { getKayaHome } from "../../../../../../lib/core/KayaHome.ts";

// Reads KAYA_HOME env override → getKayaHome() (memoized).
const KAYA_HOME = getKayaHome();

/**
 * Gather real evidence from the filesystem for Phase 2 judgment enrichment.
 * Reads files referenced in ISC descriptions and runs verification commands.
 * All operations are best-effort — failures are silently skipped.
 */
export function gatherEvidence(
  summary: ItemReviewSummary,
  config: Pick<SkepticalVerifierConfig, "spawnFn">,
): EvidenceResult {
  const files: EvidenceResult["files"] = [];
  const commands: EvidenceResult["commands"] = [];

  // Fix #4: track ISC verify-command execution outcomes so Tier1 can raise a
  // deterministic "0 command evidence gathered" alarm (the mq4kdqs0 class, where
  // every verify command was shell-operator-blocked and the verifier fell back
  // entirely on builder self-report). `declared` counts every ISC row that ships
  // a verify command; `executed` counts only those that actually ran a process;
  // `blocked` counts those a security gate rejected.
  const declaredCommandCount = summary.iscRows.filter(r => r.verification?.command).length;
  let executedCommandCount = 0;
  let blockedCommandCount = 0;

  const homePath = process.env.HOME || "";
  const kayaHome = KAYA_HOME;
  const workingDir = summary.workingDir;

  // Build candidate paths for a given file path — tries worktree-remapped first.
  const buildCandidates = (filePath: string): string[] => {
    const candidates: string[] = [];
    if (workingDir && !filePath.startsWith("/") && !filePath.startsWith("~")) {
      candidates.push(join(workingDir, filePath));
    }
    if (workingDir && filePath.startsWith(kayaHome + "/")) {
      const relativePath = filePath.slice(kayaHome.length + 1);
      candidates.push(join(workingDir, relativePath));
    }
    candidates.push(filePath);
    return candidates;
  };

  const PER_FILE_BUDGET = 4000;
  const iscDescriptions = summary.iscRows.map(r => r.description.toLowerCase());

  // Try to read a file from candidate paths, extract relevant sections for large markdown files.
  const tryReadFile = (candidates: string[]): string | null => {
    for (const candidate of candidates) {
      try {
        const raw = readFileSync(candidate, "utf-8");
        if (raw.length <= PER_FILE_BUDGET) return raw;
        if (raw.includes("\n## ")) {
          return scoreAndExtractSections(raw, iscDescriptions, PER_FILE_BUDGET);
        }
        return raw.slice(0, PER_FILE_BUDGET);
      } catch {
        // Try next candidate.
      }
    }
    return null;
  };

  const seenPaths = new Set<string>();
  const MAX_FILES = 12;

  // 1. Extract file paths from ISC row descriptions.
  const filePathPattern = /(?:^|\s|["'`(])((?:\/|\.\/|~\/|[\w-]+\/)[\w\-./]+\.\w{1,6})/g;

  for (const row of summary.iscRows) {
    let match: RegExpExecArray | null;
    while ((match = filePathPattern.exec(row.description)) !== null) {
      let filePath = match[1].trim();
      if (filePath.startsWith("~/")) {
        filePath = join(homePath, filePath.slice(2));
      }

      if (!seenPaths.has(filePath) && files.length < MAX_FILES) {
        seenPaths.add(filePath);
        const content = tryReadFile(buildCandidates(filePath));
        if (content) {
          files.push({ path: filePath, content });
        }
      }
    }
    filePathPattern.lastIndex = 0;
  }

  // 2. Diff-based evidence: extract file paths from gitDiffStat and read from worktree/repos.
  if (summary.gitDiffStat && files.length < MAX_FILES) {
    if (summary.repoContexts && summary.repoContexts.length > 0) {
      const repoSections = parseMultiRepoDiffStat(summary.gitDiffStat);
      for (const { name, diffStat } of repoSections) {
        const repo = summary.repoContexts.find(r => r.name === name);
        if (!repo) continue;
        const diffPaths = extractPathsFromDiffStat(diffStat);
        for (const diffPath of diffPaths) {
          if (files.length >= MAX_FILES) break;
          const absPath = join(repo.cwd, diffPath);
          const canonicalKey = `${name}/${diffPath}`;
          if (seenPaths.has(absPath) || seenPaths.has(canonicalKey)) continue;
          seenPaths.add(absPath);
          seenPaths.add(canonicalKey);
          try {
            const raw = readFileSync(absPath, "utf-8");
            const content = raw.length <= PER_FILE_BUDGET ? raw
              : raw.includes("\n## ") ? scoreAndExtractSections(raw, iscDescriptions, PER_FILE_BUDGET)
              : raw.slice(0, PER_FILE_BUDGET);
            files.push({ path: canonicalKey, content });
          } catch {
            // File may have been deleted in the diff.
          }
        }
      }
    } else if (workingDir) {
      const diffPaths = extractPathsFromDiffStat(summary.gitDiffStat);
      for (const diffPath of diffPaths) {
        if (files.length >= MAX_FILES) break;
        const absPath = join(workingDir, diffPath);
        const canonicalKey = diffPath;
        if (seenPaths.has(absPath) || seenPaths.has(canonicalKey)) continue;
        seenPaths.add(absPath);
        seenPaths.add(canonicalKey);
        try {
          const raw = readFileSync(absPath, "utf-8");
          const content = raw.length <= PER_FILE_BUDGET ? raw
            : raw.includes("\n## ") ? scoreAndExtractSections(raw, iscDescriptions, PER_FILE_BUDGET)
            : raw.slice(0, PER_FILE_BUDGET);
          files.push({ path: diffPath, content });
        } catch {
          // File may have been deleted in the diff.
        }
      }
    }
  }

  // 3. Run ISC verification commands (max 5, 10s timeout each).
  // ISC 15: Build a single find-cache upfront instead of spawning find per command.
  const findCache = new Map<string, string>();
  if (workingDir) {
    try {
      const allFiles = Bun.spawnSync(
        ["find", workingDir, "-type", "f",
         "\\(", "-name", "*.ts", "-o", "-name", "*.js", "-o", "-name", "*.mjs", "-o", "-name", "*.json", "\\)",
         "-not", "-path", "*/node_modules/*",
         "-not", "-path", "*/.git/*"],
        { timeout: 5000 }
      ).stdout.toString("utf-8").trim().split("\n").filter(Boolean);
      for (const absPath of allFiles) {
        const base = absPath.split("/").pop() ?? "";
        if (base && !findCache.has(base)) {
          findCache.set(base, absPath);
        }
      }
    } catch { /* find failed — continue without cache */ }
  }

  for (const row of summary.iscRows) {
    const cmd = row.verification?.command;
    if (!cmd || commands.length >= 5) continue;

    const expectedExitCode = row.verification?.expectedExitCode;

    // SECURITY GATE: Reject commands with shell operators.
    const SHELL_OPERATORS = /[|&;`$><(){}]/;
    if (SHELL_OPERATORS.test(cmd)) {
      blockedCommandCount++;
      commands.push({
        cmd,
        stdout: "[BLOCKED: command contains shell operator — rejected by gatherEvidence security gate]",
        exitCode: -1,
        expectedExitCode,
        passed: false,
      });
      continue;
    }

    // SECURITY GATE: Check CATASTROPHIC_PATTERNS.
    const matchedCatastrophic = CATASTROPHIC_PATTERNS.find(p => p.pattern.test(cmd));
    if (matchedCatastrophic) {
      blockedCommandCount++;
      commands.push({
        cmd,
        stdout: `[BLOCKED: command matches catastrophic pattern '${matchedCatastrophic.action}' — rejected by gatherEvidence security gate]`,
        exitCode: -1,
        expectedExitCode,
        passed: false,
      });
      continue;
    }

    // ISC 15: Resolve relative file paths using the pre-built find cache.
    let resolvedCmd = cmd;
    if (workingDir) {
      resolvedCmd = resolvedCmd.replace(
        /(?:^|\s)((?!\/)[a-zA-Z][\w./\-]*\.(?:ts|js|mjs|json))\b/g,
        (match, relPath) => {
          const prefix = match.slice(0, match.length - relPath.length);
          const { join: pathJoin } = require("path");
          const { existsSync } = require("fs");
          const directPath = pathJoin(workingDir, relPath);
          if (existsSync(directPath)) return `${prefix}${directPath}`;
          const base = relPath.split("/").pop() ?? "";
          const cached = base ? findCache.get(base) : undefined;
          if (cached) return `${prefix}${cached}`;
          if (relPath.includes("/")) {
            for (const [, absPath] of findCache) {
              if (absPath.endsWith(`/${relPath}`)) return `${prefix}${absPath}`;
            }
          }
          return match;
        }
      );
    }

    // ISC command allowlist check — only on default sh -c path.
    if (!config.spawnFn) {
      const firstToken = resolvedCmd.trim().split(/\s+/)[0] ?? "";
      const executableName = firstToken.split("/").pop() ?? firstToken;

      if (!VERIFICATION_ALLOWED_EXECUTABLES.has(executableName)) {
        console.error(
          `[SkepticalVerifier] BLOCKED ISC verification command: executable '${executableName}' not in allowlist. ` +
          `Full command: ${resolvedCmd.slice(0, 200)}`
        );
        blockedCommandCount++;
        commands.push({
          cmd: resolvedCmd,
          stdout: `[BLOCKED: executable '${executableName}' not in VERIFICATION_ALLOWED_EXECUTABLES]`,
          exitCode: 1,
          expectedExitCode,
          passed: false,
        });
        continue;
      }
    }

    const spawnFn = config.spawnFn ?? ((c: string) => {
      const proc = Bun.spawnSync(["sh", "-c", c], {
        timeout: 10000,
        ...(workingDir ? { cwd: workingDir } : {}),
      });
      const stdout = proc.stdout.toString("utf-8").slice(0, 2000);
      const stderr = proc.stderr.toString("utf-8").slice(0, 500);
      const output = stderr ? `${stdout}\nSTDERR: ${stderr}` : stdout;
      return { stdout: output.slice(0, 2000), exitCode: proc.exitCode };
    });
    const result = spawnFn(resolvedCmd);
    executedCommandCount++;
    commands.push({
      cmd: resolvedCmd,
      stdout: result.stdout,
      exitCode: result.exitCode,
      expectedExitCode,
      passed: result.exitCode === (expectedExitCode ?? 0),
    });
  }

  // 4. Merge builder-supplied execution evidence from ISC rows.
  for (const row of summary.iscRows) {
    if (!row.rowEvidence) continue;
    if (row.rowEvidence.files) {
      for (const filePath of row.rowEvidence.files) {
        if (files.length >= MAX_FILES || seenPaths.has(filePath)) continue;
        seenPaths.add(filePath);
        const content = tryReadFile(buildCandidates(filePath));
        if (content) files.push({ path: filePath, content });
      }
    }
    if (row.rowEvidence.summary && commands.length < 5) {
      commands.push({
        cmd: `[builder-evidence row #${row.id}]`,
        stdout: row.rowEvidence.summary,
        exitCode: 0,
        passed: true,
      });
    }
  }

  // Populate gitDiff evidence from summary.
  const gdStat = summary.gitDiffStat ?? "";
  const gdLines = gdStat.trim().split("\n").filter(Boolean);
  const gdHasDiff = gdLines.length > 0 && !gdStat.includes("0 files changed");
  const gdLinesChanged = gdLines.reduce((sum, line) => {
    const m = line.match(/(\d+) insertions?.*?(\d+) deletions?/);
    return sum + (m ? parseInt(m[1]) + parseInt(m[2]) : 0);
  }, 0);

  return {
    files,
    commands,
    gitDiff: { hasDiff: gdHasDiff, diffStat: gdStat, linesChanged: gdLinesChanged },
    commandEvidence: {
      declared: declaredCommandCount,
      executed: executedCommandCount,
      blocked: blockedCommandCount,
    },
  };
}
