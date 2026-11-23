#!/usr/bin/env bun

import { WorkQueue, type WorkItem } from "./WorkQueue.ts";
import { parseArgs } from "node:util";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync, mkdirSync } from "node:fs";
import { FileLock } from "../../../../lib/core/FileLock.ts";
import { join } from "node:path";
import { getKayaHome, runtimeDir } from "../../../../lib/core/KayaHome.ts";
import {
  revParseRef,
  changedFilesBetween,
  verifyMergeOnDisk,
  type DiskVerifyResult,
} from "../../../../lib/core/MergeSafety.ts";

// ============================================================================
// Types
// ============================================================================

type MergeStrategy = "pr" | "direct";

interface MergeResult {
  merged: number;
  conflicts: number;
  skipped: number;
  prUrls: string[];
}

interface SingleMergeResult {
  merged: boolean;
  prUrl?: string;
  reason?: string;
}

// Re-export for callers that imported from MergeOrchestrator
export type { MergeStrategy, MergeResult, SingleMergeResult };
export type { WorkItem };

// ============================================================================
// Main class
// ============================================================================

export class Integrator {
  private queue: WorkQueue;

  constructor(queue?: WorkQueue) {
    this.queue = queue ?? new WorkQueue();
  }

  // --------------------------------------------------------------------------
  // Public API (identical signatures to MergeOrchestrator — callers unchanged)
  // --------------------------------------------------------------------------

  /**
   * Check if an interactive session is active (uncommitted work at risk).
   * Returns lock info if locked and fresh, null if safe to merge.
   * Stale threshold: 2 hours.
   *
   * DRIFT GUARD: LucidTasks' executor/executorMerge.ts keeps a FAITHFUL REPLICA of this method
   * (checkInteractiveSessionLock, not imported — see its docstring for why) — if the lock
   * semantics change here, update that copy too.
   */
  checkInteractiveSessionLock(): { sessionId: string; startedAt: string; pid: number } | null {
    const lockPath = join(getKayaHome(), "MEMORY", "STATE", "interactive-session.lock");
    if (!existsSync(lockPath)) return null;
    try {
      const stat = statSync(lockPath);
      if (Date.now() - stat.mtimeMs > 2 * 60 * 60 * 1000) return null; // stale
      return JSON.parse(readFileSync(lockPath, "utf-8"));
    } catch {
      return null; // corrupt or race — safe to proceed
    }
  }

  /**
   * Merge all completed+verified items. Serialized via the integrator lock so
   * concurrent callers (e.g., two cron ticks) cannot race on the same branches.
   * Delegates to _mergeCompletedCore() — internal callers that already hold the
   * lock should call _mergeCompletedCore() directly to avoid deadlock.
   */
  async mergeCompleted(strategy: MergeStrategy): Promise<MergeResult> {
    return this.withIntegratorLock(() => this._mergeCompletedCore(strategy));
  }

  private _mergeCompletedCore(strategy: MergeStrategy): MergeResult {
    const items = this.queue.getAllItems();
    const result: MergeResult = { merged: 0, conflicts: 0, skipped: 0, prUrls: [] };

    const eligible = items.filter(
      (item: WorkItem) =>
        item.status === "completed" &&
        item.verification?.status === "verified" &&
        item.metadata?.worktreeBranch != null &&
        item.metadata?.mergeStatus !== "merged", // idempotency
    );

    // Count already-merged items as skipped
    result.skipped = items.filter((item: WorkItem) => item.metadata?.mergeStatus === "merged").length;

    // Defer all merges if an interactive session is active
    const batchLock = this.checkInteractiveSessionLock();
    if (batchLock) {
      console.warn(`[Integrator] Deferring all merges — interactive session ${batchLock.sessionId} is active`);
      result.skipped += eligible.length;
      return result;
    }

    for (const item of eligible) {
      if (this.requiresHumanApproval(item)) {
        this.queue.setMetadata(item.id, {
          mergeStatus: "pending_approval",
          mergeReason: "Requires human approval before merge",
        });
        result.skipped++;
        continue;
      }
      const branch = item.metadata!.worktreeBranch as string;
      const repoPath = this.resolveRepoPath(item);

      this.queue.setMetadata(item.id, { mergeStatus: "merge_started" });

      const hasConflict = this.detectConflict(branch, repoPath);

      if (!hasConflict) {
        try {
          // S13: "pr" and "direct" intentionally keep DIFFERENT merge strategies (GitHub PR vs.
          // local git merge --no-ff) — that divergence is by design (different delivery
          // mechanisms for different repos/policies). What is NOT allowed to diverge is
          // post-merge verification: both branches below now confirm the merge genuinely landed
          // via lib/core/MergeSafety.ts before recording mergeStatus "merged" — see
          // verifyPrMergeLanded()/mergeIntoBase()'s docstrings.
          if (strategy === "pr") {
            this.pushBranch(branch, repoPath);

            const verifiedCount = item.verification?.iscRowsVerified ?? 0;
            const prUrl = this.ghCreatePr(repoPath, item.title, branch, verifiedCount);
            if (prUrl) result.prUrls.push(prUrl);

            if (prUrl) this.ghAttemptMerge(repoPath, prUrl);

            // S13: loud-fail — do not record "merged" unless MergeSafety confirms the PR
            // genuinely landed (this replaces the old unconditional success report, which
            // marked "merged" even when BOTH gh pr merge attempts above failed).
            const diskResult = this.verifyPrMergeLanded(repoPath, branch);
            if (!diskResult.clean) {
              throw new Error(
                `PR merge for '${branch}'${prUrl ? ` (${prUrl})` : ""} not verified as landed ` +
                  `(isAncestor=${diskResult.isAncestor}) — refusing to record 'merged'`,
              );
            }

            this.queue.setMetadata(item.id, {
              mergeStatus: "merged",
              mergedAt: new Date().toISOString(),
              prUrl,
            });
          } else {
            const md = this.mergeIntoBase(branch, item.title, repoPath);
            if (!md.ok) throw new Error(md.reason);

            try {
              execFileSync("git", ["push", "origin", "HEAD"], { cwd: repoPath, timeout: 60_000, stdio: "pipe" });
            } catch (err) {
              console.warn(
                `[Integrator] Direct merge succeeded but push failed for ${item.title}. Push manually. (${err instanceof Error ? err.message : String(err)})`,
              );
            }

            this.queue.setMetadata(item.id, {
              mergeStatus: "merged",
              mergedAt: new Date().toISOString(),
            });
          }

          result.merged++;
        } catch (err) {
          this.queue.setMetadata(item.id, {
            mergeStatus: "conflict",
            conflictDetectedAt: new Date().toISOString(),
            conflictReason: `Merge failed during ${strategy} strategy: ${err instanceof Error ? err.message : String(err)}`,
          });
          result.conflicts++;
        }
      } else {
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
   * Merge a single completed+verified item's feature branch. Serialized via the
   * integrator lock so concurrent callers cannot race on the same branch.
   * Internal callers holding the lock should call _mergeItemCore() directly.
   * Called inline from reportDone() after completion gate passes.
   * Returns immediately without merging if human approval is required.
   */
  async mergeItem(
    itemId: string,
    strategy: MergeStrategy = "pr",
    opts: { skipSessionLock?: boolean } = {},
  ): Promise<SingleMergeResult> {
    return this.withIntegratorLock(() => this._mergeItemCore(itemId, strategy, opts));
  }

  private _mergeItemCore(
    itemId: string,
    strategy: MergeStrategy,
    opts: { skipSessionLock?: boolean },
  ): SingleMergeResult {
    const item = this.queue.getItem(itemId);
    if (!item) {
      return { merged: false, reason: `Item ${itemId} not found` };
    }

    if (item.status !== "completed" || item.verification?.status !== "verified") {
      return { merged: false, reason: "Item not completed or not verified" };
    }
    const branch = item.metadata?.worktreeBranch as string | undefined;
    if (!branch) {
      return { merged: false, reason: "No worktreeBranch in metadata" };
    }
    if (item.metadata?.mergeStatus === "merged") {
      return { merged: false, reason: "Already merged" };
    }

    if (this.requiresHumanApproval(item)) {
      const reason = "Requires human approval: item modifies settings, secrets, or is a deploy/publish operation";
      this.queue.setMetadata(itemId, { mergeStatus: "pending_approval", mergeReason: reason });
      return { merged: false, reason };
    }

    if (!opts.skipSessionLock) {
      const sessionLock = this.checkInteractiveSessionLock();
      if (sessionLock) {
        console.warn(
          `[Integrator] Deferring merge for "${item.title}" — interactive session ${sessionLock.sessionId} is active`,
        );
        this.queue.setMetadata(itemId, { mergeStatus: "deferred" });
        return { merged: false, reason: "Deferred: interactive session active" };
      }
    }

    const repoPath = this.resolveRepoPath(item);
    this.queue.setMetadata(itemId, { mergeStatus: "merge_started" });

    const hasConflict = this.detectConflict(branch, repoPath);
    if (hasConflict) {
      this.queue.setMetadata(itemId, {
        mergeStatus: "conflict",
        conflictDetectedAt: new Date().toISOString(),
        conflictReason: `Merge conflict detected when attempting to merge branch '${branch}' into HEAD.`,
      });
      return { merged: false, reason: "Merge conflict detected" };
    }

    try {
      // S13: "pr" and "direct" intentionally keep DIFFERENT merge strategies (GitHub PR vs.
      // local git merge --no-ff) — that divergence is by design. Post-merge verification is
      // NOT allowed to diverge: both branches confirm the merge genuinely landed via
      // lib/core/MergeSafety.ts before recording mergeStatus "merged" — see
      // verifyPrMergeLanded()/mergeIntoBase()'s docstrings.
      if (strategy === "pr") {
        this.pushBranch(branch, repoPath);

        const verifiedCount = item.verification?.iscRowsVerified ?? 0;
        const prUrl = this.ghCreatePr(repoPath, item.title, branch, verifiedCount);

        if (prUrl) this.ghAttemptMerge(repoPath, prUrl);

        // S13: loud-fail — do not record "merged" unless MergeSafety confirms the PR genuinely
        // landed (this replaces the old unconditional success report, which returned
        // { merged: true } even when BOTH gh pr merge attempts above failed).
        const diskResult = this.verifyPrMergeLanded(repoPath, branch);
        if (!diskResult.clean) {
          throw new Error(
            `PR merge for '${branch}'${prUrl ? ` (${prUrl})` : ""} not verified as landed ` +
              `(isAncestor=${diskResult.isAncestor}) — refusing to record 'merged'`,
          );
        }

        this.queue.setMetadata(itemId, {
          mergeStatus: "merged",
          mergedAt: new Date().toISOString(),
          prUrl,
        });
        const wtPathPr = item.metadata?.worktreePath as string | undefined;
        if (wtPathPr) {
          import("../../../../lib/core/WorktreeManager.ts")
            .then(({ markWorktreeMerged }) => markWorktreeMerged(wtPathPr))
            .catch(() => {
              /* fail-open */
            });
        }
        return { merged: true, prUrl };
      } else {
        const md = this.mergeIntoBase(branch, item.title, repoPath);
        if (!md.ok) {
          this.queue.setMetadata(itemId, {
            mergeStatus: "conflict",
            conflictDetectedAt: new Date().toISOString(),
            conflictReason: md.reason,
          });
          return { merged: false, reason: md.reason };
        }
        try {
          execFileSync("git", ["push", "origin", "HEAD"], { cwd: repoPath, timeout: 60_000, stdio: "pipe" });
        } catch (err) {
          console.warn(
            `[Integrator] Direct merge succeeded but push failed for ${item.title}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        this.queue.setMetadata(itemId, { mergeStatus: "merged", mergedAt: new Date().toISOString() });
        const wtPath = item.metadata?.worktreePath as string | undefined;
        if (wtPath) {
          import("../../../../lib/core/WorktreeManager.ts")
            .then(({ markWorktreeMerged }) => markWorktreeMerged(wtPath))
            .catch(() => {
              /* fail-open */
            });
        }
        return { merged: true };
      }
    } catch (err) {
      this.queue.setMetadata(itemId, {
        mergeStatus: "conflict",
        conflictDetectedAt: new Date().toISOString(),
        conflictReason: `Merge failed: ${err instanceof Error ? err.message : String(err)}`,
      });
      return { merged: false, reason: `Merge failed: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  /**
   * Slice 3 — Grant human approval to merge an item to main.
   */
  approve(itemId: string, approvedBy: string = "Jm"): { approved: boolean; reason?: string } {
    const item = this.queue.getItem(itemId);
    if (!item) return { approved: false, reason: `Item ${itemId} not found` };
    if (item.status !== "completed" || item.verification?.status !== "verified") {
      return { approved: false, reason: "Item is not completed+verified yet — nothing to approve" };
    }
    if (item.metadata?.mergeStatus === "merged") {
      return { approved: false, reason: "Already merged" };
    }
    this.queue.setMetadata(itemId, {
      mergeApproved: true,
      mergeApprovedBy: approvedBy,
      mergeApprovedAt: new Date().toISOString(),
      mergeStatus: "approved",
    });
    return { approved: true };
  }

  /** Slice 3 — Approve and immediately merge a single item. */
  async approveAndMerge(
    itemId: string,
    strategy: MergeStrategy = "direct",
    approvedBy: string = "Jm",
  ): Promise<SingleMergeResult> {
    const a = this.approve(itemId, approvedBy);
    if (!a.approved) return { merged: false, reason: a.reason };
    return this.mergeItem(itemId, strategy, { skipSessionLock: true });
  }

  /**
   * Slice 3 — Items waiting on a merge approval.
   */
  listPendingApproval(): Array<{ id: string; title: string; branch?: string; reason: string }> {
    return this.queue
      .getAllItems()
      .filter(
        (item) =>
          item.status === "completed" &&
          item.verification?.status === "verified" &&
          item.metadata?.mergeStatus !== "merged" &&
          item.metadata?.mergeApproved !== true &&
          this.requiresHumanApproval(item),
      )
      .map((item) => ({
        id: item.id,
        title: item.title,
        branch: item.metadata?.worktreeBranch as string | undefined,
        reason:
          (item.metadata?.mergeReason as string | undefined) ?? "Requires human approval (settings/secrets/deploy)",
      }));
  }

  /**
   * Slice 3 — Approval-gated drain.
   * Each mergeItem() call independently acquires+releases the integrator lock
   * (rather than holding it for the entire batch) so other merge operations
   * can interleave between items.
   */
  async drainApproved(strategy: MergeStrategy = "direct"): Promise<MergeResult> {
    const result: MergeResult = { merged: 0, conflicts: 0, skipped: 0, prUrls: [] };
    const approved = this.queue
      .getAllItems()
      .filter(
        (item) =>
          item.status === "completed" &&
          item.verification?.status === "verified" &&
          item.metadata?.mergeApproved === true &&
          item.metadata?.worktreeBranch != null &&
          item.metadata?.mergeStatus !== "merged",
      );
    for (const item of approved) {
      const r = await this.mergeItem(item.id, strategy, { skipSessionLock: true });
      if (r.merged) {
        result.merged++;
        if (r.prUrl) result.prUrls.push(r.prUrl);
      } else if (r.reason?.includes("conflict")) {
        result.conflicts++;
      } else {
        result.skipped++;
      }
    }
    return result;
  }

  // --------------------------------------------------------------------------
  // Private helpers (preserved from MergeOrchestrator with identical logic)
  // --------------------------------------------------------------------------

  // --------------------------------------------------------------------------
  // Serialization helpers
  // --------------------------------------------------------------------------

  /**
   * Async lock wrapper — ALL merge paths use this (mergeItem, mergeCompleted).
   * A single lock file serializes concurrent processes from any path.
   *
   * DEADLOCK RULE: Never call mergeItem() or mergeCompleted() from inside a fn passed
   * to withIntegratorLock.
   * Internal callers that already hold the lock must use _mergeItemCore() /
   * _mergeCompletedCore() directly — those are the unlocked variants.
   *
   * Lock is async (lib/core FileLock with Bun.sleep) so it does not block the
   * event loop, correctly yielding to concurrent async operations (including other
   * lock holders that need to run their release() path).
   */
  private async withIntegratorLock<T>(fn: () => Promise<T> | T): Promise<T> {
    const locksDir = join(runtimeDir(), "locks");
    mkdirSync(locksDir, { recursive: true });
    const lock = new FileLock(join(locksDir, "integrator.lock"), 30_000, "Integrator lock");
    await lock.acquire();
    try {
      return await fn();
    } finally {
      await lock.release();
    }
  }

  private requiresHumanApproval(item: WorkItem): boolean {
    if (item.metadata?.mergeApproved === true) return false;
    const workType = item.workType ?? (item.metadata?.workType as string | undefined);
    if (workType === "deploy" || workType === "publish") return true;

    const affectsSettings = item.metadata?.affectsSettings as boolean | undefined;
    if (affectsSettings) return true;

    const iscRows = item.metadata?.iscRows as Array<{ description?: string; source?: string }> | undefined;
    if (
      iscRows?.some(
        (r) =>
          /settings\.json|secrets\.json|\.env\b/i.test(r.description ?? "") ||
          /settings\.json|secrets\.json|\.env\b/i.test(r.source ?? ""),
      )
    )
      return true;

    return false;
  }

  private resolveRepoPath(item: WorkItem): string {
    if (item.projectPath) return item.projectPath;
    const wtPath = item.metadata?.worktreePath as string | undefined;
    if (wtPath) {
      const match = wtPath.match(/\.claude\/worktrees\/([^/]+)\//);
      if (match) {
        const repoName = match[1];
        const candidates = [
          `${process.env.HOME}/Desktop/projects/${repoName}`,
          `${process.env.HOME}/projects/${repoName}`,
          `${process.env.HOME}/${repoName}`,
        ];
        for (const c of candidates) {
          try {
            execFileSync("git", ["rev-parse", "--git-dir"], { cwd: c, timeout: 5_000, stdio: "pipe" });
            return c;
          } catch {
            /* not a git repo */
          }
        }
      }
    }
    return process.cwd();
  }

  private pushBranch(branch: string, cwd: string): void {
    execFileSync("git", ["push", "-u", "origin", branch], { cwd, timeout: 60_000, stdio: "pipe" });
  }

  /**
   * `gh pr create` — isolated as its own method (rather than inlined at both "pr" strategy call
   * sites) so tests can override just the external `gh` CLI call on an instance, the same idiom
   * this file uses elsewhere (checkInteractiveSessionLock, verifyDirectMergeLanded) — `gh` talks to real GitHub and has no hermetic
   * fake-able equivalent, whereas every git command around it (push/fetch/ancestor-check in
   * verifyPrMergeLanded) is real and runs against a real repo in tests.
   */
  private ghCreatePr(repoPath: string, title: string, branch: string, verifiedCount: number): string {
    const prOutput = execFileSync(
      "gh",
      [
        "pr",
        "create",
        "--title",
        `Merge: ${title}`,
        "--body",
        `Verified by SkepticalVerifier. ISC rows: ${verifiedCount} verified.`,
        "--head",
        branch,
        "--base",
        "main",
      ],
      { cwd: repoPath, timeout: 30_000, stdio: "pipe", encoding: "utf-8" },
    );
    return prOutput.trim().split("\n").pop()?.trim() ?? "";
  }

  /**
   * `gh pr merge` (auto, falling back to immediate) — best-effort by design: a failure here is
   * NOT the last word on whether the merge landed. verifyPrMergeLanded (via MergeSafety.ts)
   * always runs afterward and is what actually gates "merged" — see its docstring and the S13
   * comment at both call sites.
   */
  private ghAttemptMerge(repoPath: string, prUrl: string): void {
    try {
      execFileSync("gh", ["pr", "merge", prUrl, "--auto", "--merge"], {
        cwd: repoPath,
        timeout: 30_000,
        stdio: "pipe",
      });
    } catch {
      try {
        execFileSync("gh", ["pr", "merge", prUrl, "--merge"], { cwd: repoPath, timeout: 30_000, stdio: "pipe" });
      } catch (err) {
        console.warn(
          `[Integrator] PR created but merge failed for ${prUrl}. Merge manually. (${err instanceof Error ? err.message : String(err)})`,
        );
      }
    }
  }

  /**
   * "direct" strategy merge — local `git merge --no-ff` into the base branch, cwd IS the real
   * working tree that gets merged into.
   *
   * S13: post-merge verification now delegates to lib/core/MergeSafety.ts's scoped
   * ancestor+disk-diff check (see that module's docstring) instead of the old ad-hoc
   * `isAncestor(branch, "HEAD", cwd)`-only check — this repo's `cwd` can be the shared kaya
   * tree in some call paths (resolveRepoPath's process.cwd() fallback), so the disk-diff half
   * is a real guard here too, not just theater: a stale on-disk file after a racing writer is
   * exactly the class of bug MergeSafety.ts exists to catch.
   */
  private mergeIntoBase(branch: string, title: string, cwd: string): { ok: boolean; reason?: string } {
    const base = this.resolveBaseBranch(cwd);
    const current = this.currentBranch(cwd);
    if (current !== base) {
      try {
        execFileSync("git", ["checkout", base], { cwd, timeout: 30_000, stdio: "pipe" });
      } catch (e) {
        return {
          ok: false,
          reason: `refusing to merge into '${current || "?"}' — could not check out base branch '${base}' first: ${e instanceof Error ? e.message : String(e)}`,
        };
      }
    }
    const beforeSha = revParseRef(cwd, base);
    try {
      execFileSync("git", ["merge", "--no-ff", branch, "-m", `Merge verified: ${title}`], {
        cwd,
        timeout: 30_000,
        stdio: "pipe",
      });
    } catch (e) {
      return {
        ok: false,
        reason: `git merge --no-ff ${branch} into ${base} failed: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
    const diskResult = this.verifyDirectMergeLanded(cwd, branch, base, beforeSha);
    if (!diskResult.clean) {
      const dirty = diskResult.diffOutput.trim();
      return {
        ok: false,
        reason:
          `merge of '${branch}' into '${base}' did not verify clean (isAncestor=${diskResult.isAncestor}` +
          `${dirty ? `, working tree diverged from HEAD: ${dirty.slice(0, 300)}` : ""}) — not recording 'merged'`,
      };
    }
    return { ok: true };
  }

  /**
   * Isolated as its own method (rather than inlined in mergeIntoBase) so tests can override just
   * the MergeSafety judgment on an instance — same idiom this file already uses for
   * checkInteractiveSessionLock overrides in Integrator.test.ts — without faking git itself.
   */
  private verifyDirectMergeLanded(cwd: string, branch: string, base: string, beforeSha: string): DiskVerifyResult {
    const afterSha = revParseRef(cwd, base);
    const changed = changedFilesBetween(cwd, beforeSha, afterSha);
    return verifyMergeOnDisk(cwd, changed, branch, base);
  }

  /**
   * "pr" strategy merge lands on GitHub, not in this local working tree — there is no local
   * disk mutation to diff (see MergeSafety.ts's own docstring: "a caller with no local
   * working-tree checkout of `base`... e.g. a GitHub-side PR merge" is EXACTLY this case), so
   * changedFiles is deliberately `[]` and `clean` reduces to the ancestor check alone, run
   * against the freshly-fetched `origin/<base>` (the local `<base>` branch is never checked out
   * or advanced by the "pr" strategy, so comparing against it would be meaningless).
   */
  private verifyPrMergeLanded(repoPath: string, branch: string): DiskVerifyResult {
    const base = this.resolveBaseBranch(repoPath);
    try {
      execFileSync("git", ["fetch", "origin", base], { cwd: repoPath, timeout: 30_000, stdio: "pipe" });
    } catch {
      // Best-effort: if the fetch fails, origin/<base> is stale/missing and the ancestor check
      // below correctly (and safely) reports not-clean rather than throwing here.
    }
    return verifyMergeOnDisk(repoPath, [], branch, `origin/${base}`);
  }

  private currentBranch(cwd: string): string {
    try {
      return execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
        cwd,
        timeout: 10_000,
        stdio: "pipe",
        encoding: "utf-8",
      }).trim();
    } catch {
      return "";
    }
  }

  private resolveBaseBranch(cwd: string): string {
    for (const b of ["main", "master"]) {
      try {
        execFileSync("git", ["rev-parse", "--verify", "--quiet", `refs/heads/${b}`], {
          cwd,
          timeout: 10_000,
          stdio: "pipe",
        });
        return b;
      } catch {
        /* branch not present */
      }
    }
    return this.currentBranch(cwd) || "main";
  }

  private detectConflict(branch: string, cwd?: string): boolean {
    const opts = { encoding: "utf-8" as const, timeout: 10_000, stdio: "pipe" as const, ...(cwd ? { cwd } : {}) };
    try {
      const mergeBase = execFileSync("git", ["merge-base", "HEAD", branch], opts).trim();
      const result = execFileSync("git", ["merge-tree", mergeBase, "HEAD", branch], { ...opts, timeout: 30_000 });
      return result.includes("<<<<<<<");
    } catch {
      return true; // assume conflict on error
    }
  }
}

// ============================================================================
// CLI
// ============================================================================

const USAGE = `
Integrator — Merge completed/verified feature branches

USAGE
  integrator merge     --strategy <pr|direct> [--json]
  integrator pending   [--json]
  integrator approve   <id> [--merge] [--strategy <pr|direct>] [--by <name>] [--json]
  integrator drain     [--strategy <pr|direct>] [--json]
  integrator --help

COMMANDS
  merge           Merge all completed, verified branches (approval-required items skipped)
  pending         List verified-locally items waiting on a merge approval (Slice 3)
  approve <id>    Grant merge approval for an item; add --merge to merge it immediately
  drain           Merge all items that have a recorded approval (mergeApproved === true)

OPTIONS
  --strategy      pr      Open a GitHub PR for each branch
                  direct  git merge --no-ff directly into HEAD (default for approve/drain)
  --merge         (approve) merge immediately after approving
  --by            (approve) name of the approver (default: Jm)
  --json          Output results as JSON
  --help          Show this help message
`.trim();

if (import.meta.main) {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    options: {
      strategy: { type: "string" },
      by: { type: "string" },
      merge: { type: "boolean", default: false },
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
  const integrator = new Integrator();

  if (command === "merge") {
    const strategy = values.strategy as string | undefined;
    if (strategy !== "pr" && strategy !== "direct") {
      console.error(`--strategy must be "pr" or "direct"\n\n${USAGE}`);
      process.exit(1);
    }
    const mergeResult = await integrator.mergeCompleted(strategy);
    if (values.json) {
      console.log(JSON.stringify(mergeResult, null, 2));
    } else {
      console.log(
        `Merged: ${mergeResult.merged}  Conflicts: ${mergeResult.conflicts}  Skipped: ${mergeResult.skipped}`,
      );
      for (const url of mergeResult.prUrls) console.log(`  ${url}`);
    }
    process.exit(0);
  }

  if (command === "pending") {
    const pending = integrator.listPendingApproval();
    if (values.json) {
      console.log(JSON.stringify(pending, null, 2));
    } else if (pending.length === 0) {
      console.log("No items pending merge approval.");
    } else {
      console.log(`${pending.length} item(s) pending merge approval:`);
      for (const p of pending) console.log(`  ${p.id} — ${p.title} [${p.branch ?? "no branch"}] (${p.reason})`);
    }
    process.exit(0);
  }

  if (command === "approve") {
    const id = positionals[1];
    if (!id) {
      console.error("Usage: approve <id> [--merge] [--strategy pr|direct] [--by <name>]");
      process.exit(1);
    }
    const strategy = (values.strategy === "pr" ? "pr" : "direct") as MergeStrategy;
    const by = (values.by as string | undefined) ?? "Jm";
    const result = values.merge ? await integrator.approveAndMerge(id, strategy, by) : integrator.approve(id, by);
    if (values.json) {
      console.log(JSON.stringify(result, null, 2));
    } else if ("merged" in result) {
      console.log(
        result.merged ? `${id} → approved + merged` : `${id} → approved but not merged: ${result.reason ?? "?"}`,
      );
    } else {
      console.log(result.approved ? `${id} → approved (run 'drain' to merge)` : `Not approved: ${result.reason}`);
    }
    process.exit(("merged" in result ? result.merged : result.approved) ? 0 : 1);
  }

  if (command === "drain") {
    const strategy = (values.strategy === "pr" ? "pr" : "direct") as MergeStrategy;
    const drainResult = await integrator.drainApproved(strategy);
    if (values.json) {
      console.log(JSON.stringify(drainResult, null, 2));
    } else {
      console.log(
        `Drained approved: Merged ${drainResult.merged}  Conflicts ${drainResult.conflicts}  Skipped ${drainResult.skipped}`,
      );
      for (const url of drainResult.prUrls) console.log(`  ${url}`);
    }
    process.exit(0);
  }

  console.error(`Unknown command: ${command ?? "(none)"}\n\n${USAGE}`);
  process.exit(1);
}
