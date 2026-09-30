/**
 * VerifyContextResolver.ts — Extracted from WorkOrchestrator.ts
 *
 * Resolves the verification context (working directory, git diff range, repo path)
 * for a work item, and detects the project context (language, framework, test pattern).
 *
 * Exported:
 * - VerifyContextResolver: resolveVerifyContext, getGitDiffStat, resolveRowCwd,
 *                          resolveItemCwd, detectProjectContext
 */

import { existsSync } from "fs";
import { join } from "path";
import { execFileSync } from "child_process";
import type { WorkItem, WorkItemMetadata } from "./WorkQueue.ts";
import type { ProjectContext } from "./SkepticalVerifier.ts";
import type { VerifyContext, RepoContext } from "./WorkOrchestrator.ts";
import type { ISCRow } from "./WorkOrchestrator.ts";
import { getKayaHome } from "../../../../lib/core/KayaHome.ts";

export class VerifyContextResolver {
  /**
   * Resolve the working directory for an item (worktreePath > outputPath > projectPath > cwd).
   */
  resolveItemCwd(item: WorkItem): string {
    const worktreePath = item.metadata?.worktreePath as string | undefined;
    if (worktreePath && existsSync(worktreePath)) return worktreePath;
    if (item.outputPath && existsSync(item.outputPath)) return item.outputPath;
    if (item.projectPath && existsSync(item.projectPath)) return item.projectPath;
    return process.cwd();
  }

  /**
   * Resolve the best git diff context for an item.
   * Multi-repo path: checks metadata.repoContexts first.
   * Single-repo path: worktreePath > outputPath > projectPath > process.cwd()
   */
  resolveVerifyContext(item: WorkItem): VerifyContext {
    const rawRepoContexts = item.metadata?.repoContexts as RepoContext[] | undefined;
    if (Array.isArray(rawRepoContexts) && rawRepoContexts.length > 0) {
      const validRepos = rawRepoContexts.filter(r => existsSync(r.cwd));
      if (validRepos.length >= 2) {
        return { kind: "multi", repos: validRepos };
      }
      if (validRepos.length === 1) {
        const r = validRepos[0];
        return { kind: "single", cwd: r.cwd, startSha: r.startSha, pathFilter: r.pathFilter };
      }
    }

    const worktreePath = item.metadata?.worktreePath as string | undefined;
    const startSha = item.metadata?.startSha as string | undefined;
    const pathFilter = item.metadata?.diffPathFilter as string[] | undefined;

    if (worktreePath && existsSync(worktreePath)) {
      return { kind: "single", cwd: worktreePath, startSha, pathFilter };
    }
    if (worktreePath && !existsSync(worktreePath)) {
      const branch = item.metadata?.worktreeBranch as string | undefined;
      if (branch) {
        try {
          execFileSync("git", ["worktree", "add", worktreePath, branch], {
            encoding: "utf-8", timeout: 30000, stdio: ["pipe", "pipe", "pipe"],
          });
          if (existsSync(worktreePath)) {
            return { kind: "single", cwd: worktreePath, startSha, pathFilter };
          }
        } catch (e) {
          console.warn(`[VerifyContextResolver] Worktree recreation failed for branch "${branch}": ${e instanceof Error ? e.message : String(e)}`);
          const mergedCwd = item.projectPath && existsSync(item.projectPath)
            ? item.projectPath
            : item.outputPath && existsSync(item.outputPath)
              ? item.outputPath
              : null;
          if (mergedCwd) {
            try {
              const merged = execFileSync("git", ["branch", "--merged", "main"], {
                encoding: "utf-8", timeout: 10000, cwd: mergedCwd, stdio: ["pipe", "pipe", "pipe"],
              });
              if (merged.split("\n").some(b => b.trim() === branch)) {
                console.warn(`[VerifyContextResolver] Branch "${branch}" already merged to main — verifying against ${mergedCwd}`);
                return { kind: "single", cwd: mergedCwd, startSha: undefined, pathFilter };
              }
            } catch { /* git branch check failed */ }
          }
        }
      }
    }
    if (item.outputPath && existsSync(item.outputPath)) {
      return { kind: "single", cwd: item.outputPath, startSha, pathFilter };
    }
    if (item.projectPath && existsSync(item.projectPath)) {
      return { kind: "single", cwd: item.projectPath, startSha, pathFilter };
    }
    console.warn(`[VerifyContextResolver] resolveVerifyContext falling through to process.cwd() for item ${item.id}`);
    return { kind: "single", cwd: process.cwd(), startSha, pathFilter };
  }

  private getSingleRepoDiffStat(cwd?: string, startSha?: string, pathFilter?: string[]): string {
    try {
      // --stat defaults to 80 cols in non-tty and truncates long paths to
      // ".../tail" — downstream consumers feed these paths to bun test, so
      // force a width that never truncates.
      const args = startSha
        ? ["diff", "--stat=1000,980", "-M", `${startSha}..HEAD`]
        : ["diff", "--stat=1000,980", "-M", "HEAD~1"];
      if (pathFilter && pathFilter.length > 0) {
        args.push("--", ...pathFilter);
      }
      return execFileSync("git", args, { encoding: "utf-8", timeout: 10000, ...(cwd ? { cwd } : {}) });
    } catch (e) {
      console.error(`[VerifyContextResolver] getGitDiffStat failed: ${e instanceof Error ? e.message : String(e)}`);
      return "";
    }
  }

  getGitDiffStat(verifyCtx: VerifyContext): string {
    if (verifyCtx.kind === "single") {
      return this.getSingleRepoDiffStat(verifyCtx.cwd, verifyCtx.startSha, verifyCtx.pathFilter);
    }
    const sections: string[] = [];
    for (const repo of verifyCtx.repos) {
      const repoDiff = this.getSingleRepoDiffStat(repo.cwd, repo.startSha, repo.pathFilter);
      sections.push(`[${repo.name}]\n${repoDiff}`);
    }
    return sections.join("\n");
  }

  /**
   * For per-ISC-row cwd resolution in multi-repo contexts.
   */
  resolveRowCwd(row: ISCRow, verifyCtx: VerifyContext): string {
    if (verifyCtx.kind === "single") {
      return verifyCtx.cwd;
    }
    const cmd = row.verification?.command ?? "";
    const args = cmd.split(/\s+/).filter(a => !a.startsWith("-") && a.length > 0);
    for (const pathArg of args) {
      for (const repo of verifyCtx.repos) {
        if (existsSync(join(repo.cwd, pathArg))) {
          return repo.cwd;
        }
      }
    }
    return verifyCtx.repos[0].cwd;
  }

  detectProjectContext(workingDir: string): ProjectContext {
    // getKayaHome() (not a module-scope constant) — evaluated live on every
    // call so it always reflects the CURRENT env override. A frozen
    // module-level constant built from the env at import time is unsafe
    // under bun test: when multiple test files share one bun process,
    // whichever file's import first evaluates this module freezes the
    // value for every other file for the rest of the process, even after
    // a later file pins its own home dir (env-keyed getKayaHome() has no
    // such staleness — see lib/core/KayaHome.ts).
    const kayaSkillsDir = join(getKayaHome(), "skills");
    const isKayaSkill = workingDir.startsWith(kayaSkillsDir + "/") || workingDir === kayaSkillsDir;

    let language: ProjectContext["language"] = "unknown";
    let framework: string | undefined;

    try {
      if (existsSync(join(workingDir, "package.json")) || existsSync(join(workingDir, "bun.lockb"))) {
        language = "typescript";
        framework = existsSync(join(workingDir, "bun.lockb")) ? "bun" : "node";
      } else if (existsSync(join(workingDir, "pyproject.toml")) || existsSync(join(workingDir, "setup.py")) || existsSync(join(workingDir, "requirements.txt"))) {
        language = "python";
        framework = "pytest";
      } else if (existsSync(join(workingDir, "go.mod"))) {
        language = "go";
        framework = "go-test";
      } else if (existsSync(join(workingDir, "Cargo.toml"))) {
        language = "rust";
        framework = "cargo";
      }
    } catch {
      // workingDir may not exist — fall through to defaults
    }

    if (isKayaSkill && language === "unknown") {
      language = "typescript";
      framework = "bun";
    }

    const testPattern: ProjectContext["testPattern"] =
      language === "python" ? "pytest-style" :
      language === "typescript" ? "jest-style" :
      "unknown";

    return { language, isKayaSkill, framework, testPattern };
  }
}
