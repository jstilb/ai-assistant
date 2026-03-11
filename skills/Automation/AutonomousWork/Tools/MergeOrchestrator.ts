#!/usr/bin/env bun

import { WorkQueue, type WorkItem } from "./WorkQueue.ts";
import { TransitionGuard } from "./TransitionGuard.ts";
import { parseArgs } from "util";
import { execFileSync } from "child_process";

type MergeStrategy = "pr" | "direct";

interface MergeResult {
  merged: number;
  conflicts: number;
  skipped: number;
  prUrls: string[];
}

export class MergeOrchestrator {
  private queue: WorkQueue;
  private guard: TransitionGuard;

  constructor(queue?: WorkQueue) {
    this.queue = queue ?? new WorkQueue();
    this.guard = new TransitionGuard(this.queue);
  }

  mergeCompleted(strategy: MergeStrategy): MergeResult {
    const items = this.queue.getAllItems();
    const result: MergeResult = { merged: 0, conflicts: 0, skipped: 0, prUrls: [] };

    const eligible = items.filter(
      (item: WorkItem) =>
        item.status === "completed" &&
        item.verification?.status === "verified" &&
        item.metadata?.worktreeBranch != null &&
        item.metadata?.mergeStatus !== "merged"  // idempotency
    );

    // Count already-merged items as skipped (not all non-eligible)
    result.skipped = items.filter(
      (item: WorkItem) => item.metadata?.mergeStatus === "merged"
    ).length;

    for (const item of eligible) {
      const branch = item.metadata!.worktreeBranch as string;
      // Resolve project repo path — use projectPath if available, else cwd
      const repoPath = this.resolveRepoPath(item);

      // Set merge_started BEFORE git operation (atomic status tracking)
      this.queue.setMetadata(item.id, { mergeStatus: "merge_started" });

      const hasConflict = this.detectConflict(branch, repoPath);

      if (!hasConflict) {
        try {
          if (strategy === "pr") {
            // Step 1: Push branch to remote
            this.pushBranch(branch, repoPath);

            // Step 2: Create PR
            const verifiedCount = item.verification?.iscRowsVerified ?? 0;
            const prOutput = execFileSync(
              "gh",
              [
                "pr",
                "create",
                "--title",
                `Merge: ${item.title}`,
                "--body",
                `Verified by SkepticalVerifier. ISC rows: ${verifiedCount} verified.`,
                "--head",
                branch,
                "--base",
                "main",
              ],
              { cwd: repoPath, timeout: 30_000, stdio: "pipe", encoding: "utf-8" }
            );

            // Parse PR URL from gh output (last line is the URL)
            const prUrl = prOutput.trim().split("\n").pop()?.trim() ?? "";
            if (prUrl) {
              result.prUrls.push(prUrl);
            }

            // Step 3: Auto-merge the PR
            if (prUrl) {
              try {
                execFileSync(
                  "gh",
                  ["pr", "merge", prUrl, "--auto", "--merge"],
                  { cwd: repoPath, timeout: 30_000, stdio: "pipe" }
                );
              } catch {
                // Auto-merge may not be enabled on the repo — fall back to direct merge
                try {
                  execFileSync(
                    "gh",
                    ["pr", "merge", prUrl, "--merge"],
                    { cwd: repoPath, timeout: 30_000, stdio: "pipe" }
                  );
                } catch {
                  // Non-fatal — PR is created, merge can be done manually
                  console.warn(`[MergeOrchestrator] PR created but merge failed for ${prUrl}. Merge manually.`);
                }
              }
            }

            this.queue.setMetadata(item.id, {
              mergeStatus: "merged",
              mergedAt: new Date().toISOString(),
              prUrl,
            });
          } else {
            execFileSync(
              "git",
              ["merge", "--no-ff", branch, "-m", `Merge verified: ${item.title}`],
              { cwd: repoPath, timeout: 30_000, stdio: "pipe" }
            );

            // Push merged main to remote
            try {
              execFileSync(
                "git",
                ["push", "origin", "HEAD"],
                { cwd: repoPath, timeout: 60_000, stdio: "pipe" }
              );
            } catch {
              console.warn(`[MergeOrchestrator] Direct merge succeeded but push failed for ${item.title}. Push manually.`);
            }

            this.queue.setMetadata(item.id, {
              mergeStatus: "merged",
              mergedAt: new Date().toISOString(),
            });
          }

          result.merged++;
        } catch (err) {
          // Merge attempt failed — record as conflict in metadata (don't change WorkStatus)
          this.queue.setMetadata(item.id, {
            mergeStatus: "conflict",
            conflictDetectedAt: new Date().toISOString(),
            conflictReason: `Merge failed during ${strategy} strategy: ${err instanceof Error ? err.message : String(err)}`,
          });
          result.conflicts++;
        }
      } else {
        // Conflict detected via merge-tree — record in metadata only
        this.queue.setMetadata(item.id, {
          mergeStatus: "conflict",
          conflictDetectedAt: new Date().toISOString(),
          conflictReason: `Merge conflict detected when attempting to merge branch '${branch}' into HEAD.`,
        });
        result.conflicts++;
      }
    }

    return result;
  }

  /**
   * Resolve the git repo path for an item.
   * Uses projectPath if available, falls back to process.cwd().
   */
  private resolveRepoPath(item: WorkItem): string {
    if (item.projectPath) return item.projectPath;
    // Try to extract from worktree path (worktrees are under .claude/worktrees/<repo>/)
    const wtPath = item.metadata?.worktreePath as string | undefined;
    if (wtPath) {
      const match = wtPath.match(/\.claude\/worktrees\/([^/]+)\//);
      if (match) {
        const repoName = match[1];
        // Check common project locations
        const candidates = [
          `${process.env.HOME}/Desktop/projects/${repoName}`,
          `${process.env.HOME}/projects/${repoName}`,
          `${process.env.HOME}/${repoName}`,
        ];
        for (const c of candidates) {
          try {
            execFileSync("git", ["rev-parse", "--git-dir"], { cwd: c, timeout: 5_000, stdio: "pipe" });
            return c;
          } catch { /* not a git repo */ }
        }
      }
    }
    return process.cwd();
  }

  /**
   * Push a branch to the remote. Idempotent — if already pushed, this is a no-op.
   */
  private pushBranch(branch: string, cwd: string): void {
    execFileSync(
      "git",
      ["push", "-u", "origin", branch],
      { cwd, timeout: 60_000, stdio: "pipe" }
    );
  }

  /**
   * Conflict detection using git merge-tree (plumbing command).
   * Never touches the working tree — eliminates race conditions entirely.
   */
  private detectConflict(branch: string, cwd?: string): boolean {
    const opts = { encoding: "utf-8" as const, timeout: 10_000, stdio: "pipe" as const, ...(cwd ? { cwd } : {}) };
    try {
      const mergeBase = execFileSync("git", ["merge-base", "HEAD", branch], opts).trim();
      const result = execFileSync("git", ["merge-tree", mergeBase, "HEAD", branch],
        { ...opts, timeout: 30_000 });
      // merge-tree outputs conflict markers — if present, it's a conflict
      return result.includes("<<<<<<<");
    } catch {
      return true; // assume conflict on error
    }
  }
}

// --- CLI ---

const USAGE = `
MergeOrchestrator — Merge completed and verified feature branches

USAGE
  merge-orchestrator merge --strategy <pr|direct> [--json]
  merge-orchestrator --help

COMMANDS
  merge         Merge all completed, verified branches

OPTIONS
  --strategy    pr      Open a GitHub PR for each branch
                direct  git merge --no-ff directly into HEAD
  --json        Output results as JSON
  --help        Show this help message
`.trim();

if (import.meta.main) {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    options: {
      strategy: { type: "string" },
      json: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
    allowPositionals: true,
    strict: false,
  });

  if (values.help) {
    console.log(USAGE);
    process.exit(0);
  }

  const command = positionals[0];

  if (command !== "merge") {
    console.error(`Unknown command: ${command ?? "(none)"}\n\n${USAGE}`);
    process.exit(1);
  }

  const strategy = values.strategy as string | undefined;
  if (strategy !== "pr" && strategy !== "direct") {
    console.error(`--strategy must be "pr" or "direct"\n\n${USAGE}`);
    process.exit(1);
  }

  const orchestrator = new MergeOrchestrator();
  const mergeResult = orchestrator.mergeCompleted(strategy);

  if (values.json) {
    console.log(JSON.stringify(mergeResult, null, 2));
  } else {
    console.log(
      `Merged: ${mergeResult.merged}  Conflicts: ${mergeResult.conflicts}  Skipped: ${mergeResult.skipped}`
    );
    if (mergeResult.prUrls.length > 0) {
      console.log(`PRs created:`);
      for (const url of mergeResult.prUrls) {
        console.log(`  ${url}`);
      }
    }
  }
}
