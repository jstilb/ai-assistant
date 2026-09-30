#!/usr/bin/env bun

import { WorkQueue, type WorkItem } from "./WorkQueue.ts";
import { TransitionGuard } from "./TransitionGuard.ts";
import { parseArgs } from "util";
import { execFileSync, spawnSync } from "child_process";
import { existsSync, readFileSync, statSync, mkdirSync, openSync, writeSync, closeSync, unlinkSync } from "fs"; // openSync/writeSync/closeSync used by IntegratorFileLock
import { join } from "path";
import { getKayaHome, defaultKayaHome, runtimeDir } from "../../../../lib/core/KayaHome.ts";
import { getOrCreateWorktree, gcWorktreeForBranch } from "../../../../lib/core/WorktreeManager.ts";
import { resolveGuardHooks, buildGuardHookSettings, resolveEnforceTools } from "../../../../lib/core/AgentSpawner.ts";
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

export interface ReconcileOutcome {
  branch: string;
  status: "merged" | "failed" | "skipped";
  reason?: string;
  conflictResolved?: boolean;
  verificationPassed?: boolean;
  gcCandidate?: boolean;
}

export interface ReconcileResult {
  merged: string[];
  failed: string[];
  skipped: string[];
  outcomes: ReconcileOutcome[];
}

// Re-export for callers that imported from MergeOrchestrator
export type { MergeStrategy, MergeResult, SingleMergeResult };
export type { WorkItem };

// ============================================================================
// Inline FileLock (mirrors StateManager.ts FileLock — that class is private)
// ============================================================================

class IntegratorFileLock {
  private lockPath: string;
  private locked = false;
  private timeoutMs: number;

  constructor(lockPath: string, timeoutMs: number) {
    this.lockPath = lockPath;
    this.timeoutMs = timeoutMs;
  }

  async acquire(): Promise<void> {
    const start = Date.now();
    while (true) {
      let acquired = false;
      try {
        const fd = openSync(this.lockPath, "wx");
        writeSync(fd, String(Date.now()));
        closeSync(fd);
        acquired = true;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
          throw new Error(`Lock file error at ${this.lockPath}: ${(err as Error).message}`);
        }
      }

      if (acquired) {
        this.locked = true;
        return;
      }

      // Stale lock? Remove if older than 2x timeout.
      try {
        const content = readFileSync(this.lockPath, "utf-8");
        const lockTime = parseInt(content, 10);
        if (!isNaN(lockTime) && Date.now() - lockTime > this.timeoutMs * 2) {
          try { unlinkSync(this.lockPath); } catch { /* race — another process removed it */ }
        }
      } catch { /* lock vanished between EEXIST and this read */ }

      if (Date.now() - start > this.timeoutMs) {
        throw new Error(`Integrator lock acquisition timeout after ${this.timeoutMs}ms`);
      }

      await Bun.sleep(10);
    }
  }

  async release(): Promise<void> {
    if (this.locked && existsSync(this.lockPath)) {
      try { unlinkSync(this.lockPath); } catch { /* ignore */ }
      this.locked = false;
    }
  }
}

// ============================================================================
// OAuth token loader (mirrors LiveVerifier.ts)
// ============================================================================

function loadOAuthToken(): string | undefined {
  const candidates = [
    join(defaultKayaHome(), ".credentials.json"), // real-home creds — env-independent
    join(process.env.HOME ?? "", ".config", "claude", "credentials.json"),
  ];
  for (const p of candidates) {
    if (!existsSync(p)) continue;
    try {
      const data = JSON.parse(readFileSync(p, "utf-8"));
      const token = data?.claudeAiOauth?.accessToken ?? data?.access_token;
      if (token) return token as string;
    } catch { /* corrupt, skip */ }
  }
  return undefined;
}

// ============================================================================
// Main class
// ============================================================================

export class Integrator {
  private queue: WorkQueue;
  private guard: TransitionGuard;

  constructor(queue?: WorkQueue) {
    this.queue = queue ?? new WorkQueue();
    this.guard = new TransitionGuard(this.queue);
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
        item.metadata?.mergeStatus !== "merged" // idempotency
    );

    // Count already-merged items as skipped
    result.skipped = items.filter(
      (item: WorkItem) => item.metadata?.mergeStatus === "merged"
    ).length;

    // Defer all merges if an interactive session is active
    const batchLock = this.checkInteractiveSessionLock();
    if (batchLock) {
      console.warn(`[Integrator] Deferring all merges — interactive session ${batchLock.sessionId} is active`);
      result.skipped += eligible.length;
      return result;
    }

    for (const item of eligible) {
      if (this.requiresHumanApproval(item)) {
        this.queue.setMetadata(item.id, { mergeStatus: "pending_approval", mergeReason: "Requires human approval before merge" });
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
                `(isAncestor=${diskResult.isAncestor}) — refusing to record 'merged'`
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
              execFileSync("git", ["push", "origin", "HEAD"],
                { cwd: repoPath, timeout: 60_000, stdio: "pipe" });
            } catch {
              console.warn(`[Integrator] Direct merge succeeded but push failed for ${item.title}. Push manually.`);
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
  async mergeItem(itemId: string, strategy: MergeStrategy = "pr", opts: { skipSessionLock?: boolean } = {}): Promise<SingleMergeResult> {
    return this.withIntegratorLock(() => this._mergeItemCore(itemId, strategy, opts));
  }

  private _mergeItemCore(itemId: string, strategy: MergeStrategy, opts: { skipSessionLock?: boolean }): SingleMergeResult {
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
        console.warn(`[Integrator] Deferring merge for "${item.title}" — interactive session ${sessionLock.sessionId} is active`);
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
            `(isAncestor=${diskResult.isAncestor}) — refusing to record 'merged'`
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
            .catch(() => { /* fail-open */ });
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
          execFileSync("git", ["push", "origin", "HEAD"],
            { cwd: repoPath, timeout: 60_000, stdio: "pipe" });
        } catch {
          console.warn(`[Integrator] Direct merge succeeded but push failed for ${item.title}.`);
        }
        this.queue.setMetadata(itemId, { mergeStatus: "merged", mergedAt: new Date().toISOString() });
        const wtPath = item.metadata?.worktreePath as string | undefined;
        if (wtPath) {
          import("../../../../lib/core/WorktreeManager.ts")
            .then(({ markWorktreeMerged }) => markWorktreeMerged(wtPath))
            .catch(() => { /* fail-open */ });
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
  async approveAndMerge(itemId: string, strategy: MergeStrategy = "direct", approvedBy: string = "Jm"): Promise<SingleMergeResult> {
    const a = this.approve(itemId, approvedBy);
    if (!a.approved) return { merged: false, reason: a.reason };
    return this.mergeItem(itemId, strategy, { skipSessionLock: true });
  }

  /**
   * Slice 3 — Items waiting on a merge approval.
   */
  listPendingApproval(): Array<{ id: string; title: string; branch?: string; reason: string }> {
    return this.queue.getAllItems()
      .filter((item) =>
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
        reason: (item.metadata?.mergeReason as string | undefined) ?? "Requires human approval (settings/secrets/deploy)",
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
    const approved = this.queue.getAllItems().filter((item) =>
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
  // New: reconcile()
  // --------------------------------------------------------------------------

  /**
   * Serialized reconcile: discovers branches that diverged from main (feature/work-*,
   * worktree-*, session/*, feat/*), merges them into a dedicated integration worktree
   * with optional conflict resolution via headless claude -p agent, then fast-forwards
   * main. Only one reconcile runs at a time (global FileLock).
   */
  async reconcile(opts: { branch?: string; _conflictResolverForTest?: () => { status: number | null } } = {}): Promise<ReconcileResult> {
    const repoRoot = getKayaHome();
    const locksDir = join(runtimeDir(), "locks");
    mkdirSync(locksDir, { recursive: true });

    const lock = new IntegratorFileLock(join(locksDir, "integrator.lock"), 30_000);
    await lock.acquire();

    const result: ReconcileResult = { merged: [], failed: [], skipped: [], outcomes: [] };

    try {
      // --- Candidate discovery ---
      let candidates: string[];

      if (opts.branch) {
        candidates = [opts.branch];
      } else {
        const branchListOutput = (() => {
          try {
            return execFileSync("git", ["branch", "--format=%(refname:short)"], {
              cwd: repoRoot, encoding: "utf-8", stdio: "pipe", timeout: 10_000,
            }).trim();
          } catch {
            return "";
          }
        })();

        const allBranches = branchListOutput.split("\n").map(b => b.trim()).filter(Boolean);

        // Branches checked out in active worktrees
        const worktreeListOutput = (() => {
          try {
            return execFileSync("git", ["worktree", "list", "--porcelain"], {
              cwd: repoRoot, encoding: "utf-8", stdio: "pipe", timeout: 10_000,
            });
          } catch {
            return "";
          }
        })();
        const activeWorktreeBranches = new Set<string>();
        for (const line of worktreeListOutput.split("\n")) {
          const m = line.match(/^branch refs\/heads\/(.+)$/);
          if (m) activeWorktreeBranches.add(m[1]);
        }

        // Filter: keep matching prefixes, exclude main/master + active worktree branches
        const CANDIDATE_PATTERNS = /^(feature\/work-|worktree-|session\/|feat\/)/;
        const EXCLUDE_BASES = new Set(["main", "master"]);

        candidates = allBranches.filter(b => {
          if (EXCLUDE_BASES.has(b)) return false;
          if (activeWorktreeBranches.has(b)) return false;
          if (!CANDIDATE_PATTERNS.test(b)) return false;
          return true;
        });

        // Exclude branches already merged into main (is-ancestor)
        candidates = candidates.filter(b => {
          try {
            execFileSync("git", ["merge-base", "--is-ancestor", b, "main"], {
              cwd: repoRoot, stdio: "pipe", timeout: 10_000,
            });
            return false; // exit 0 = already ancestor = skip
          } catch {
            return true; // non-zero = not an ancestor = keep
          }
        });
      }

      if (candidates.length === 0) {
        return result;
      }

      // --- Integration worktree ---
      const integrationBranch = "integration/reconcile-tmp";
      const wt = await getOrCreateWorktree({
        repoRoot,
        branch: integrationBranch,
        createdBy: "integrator",
      });
      const wtPath = wt.path;

      // Bring the integration worktree to main's commit. We CANNOT `git checkout main`
      // here: main is permanently checked out in the shared tree (~/.claude),
      // and git forbids the same branch being checked out in two worktrees — that throws
      // "fatal: 'main' is already used by worktree". Instead, hard-reset the temp
      // integration branch (integration/reconcile-tmp) to main's SHA; HEAD stays on the
      // temp branch. main itself is later advanced via `git update-ref` (no checkout).
      const syncIntegrationToMain = (): string => {
        const mainSha = execFileSync("git", ["rev-parse", "main"], {
          cwd: repoRoot, encoding: "utf-8", stdio: "pipe", timeout: 10_000,
        }).trim();
        execFileSync("git", ["reset", "--hard", mainSha], {
          cwd: wtPath, stdio: "pipe", timeout: 30_000,
        });
        return mainSha;
      };
      syncIntegrationToMain();

      // --- Process each candidate ---
      for (const branch of candidates) {
        // Re-sync the integration worktree to (the possibly-advanced) main before each branch.
        // Capture the SHA so we can use it as the CAS expected-old value below.
        let expectedMainSha: string;
        try {
          expectedMainSha = syncIntegrationToMain();
        } catch (e) {
          result.failed.push(branch);
          result.outcomes.push({
            branch,
            status: "failed",
            reason: `Could not sync integration worktree to main: ${e instanceof Error ? e.message : String(e)}`,
          });
          console.error(`[Integrator] FAIL ${branch}: could not sync to main`);
          continue;
        }

        // Attempt merge
        let mergeSucceeded = false;
        let conflictResolved = false;

        try {
          execFileSync("git", ["merge", "--no-ff", branch, "-m", `Reconcile: ${branch}`], {
            cwd: wtPath, stdio: "pipe", timeout: 60_000,
          });
          mergeSucceeded = true;
        } catch {
          // Check for actual conflict markers
          const statusOutput = (() => {
            try {
              return execFileSync("git", ["status", "--porcelain"], {
                cwd: wtPath, encoding: "utf-8", stdio: "pipe", timeout: 10_000,
              });
            } catch {
              return "";
            }
          })();

          const hasConflictMarkers = statusOutput.split("\n").some(
            line => /^(UU|AA|DD|AU|UA) /.test(line)
          );

          if (!hasConflictMarkers) {
            // Merge failed for non-conflict reasons (e.g., branch doesn't exist)
            try { execFileSync("git", ["merge", "--abort"], { cwd: wtPath, stdio: "pipe", timeout: 10_000 }); } catch { /* may not be in a merge state */ }
            result.failed.push(branch);
            result.outcomes.push({ branch, status: "failed", reason: "Merge failed (non-conflict)" });
            console.error(`[Integrator] FAIL ${branch}: merge failed (non-conflict)`);
            continue;
          }

          // Spawn conflict-resolver agent
          const conflictResolverPrompt = [
            `You are resolving git merge conflicts in: ${wtPath}`,
            `Steps:`,
            `1. Run: git -C "${wtPath}" diff --name-only --diff-filter=U`,
            `2. For each conflicted file: read both sides with git show MERGE_HEAD:<file> and git show HEAD:<file>`,
            `3. Edit each file to remove conflict markers and produce the correct merged content`,
            `4. Run: git -C "${wtPath}" add <file> for each resolved file`,
            `Do NOT commit. Just resolve the conflicts and stage the files.`,
          ].join("\n");

          const env: Record<string, string> = {};
          for (const [k, v] of Object.entries(process.env)) {
            if (v !== undefined) env[k] = v;
          }
          delete env.ANTHROPIC_API_KEY;
          delete env.CLAUDECODE;
          for (const key of Object.keys(env)) {
            if (key.startsWith("CLAUDE_CODE_") && key !== "CLAUDE_CODE_OAUTH_TOKEN") delete env[key];
          }
          if (!env.CLAUDE_CODE_OAUTH_TOKEN) {
            const token = loadOAuthToken();
            if (token) env.CLAUDE_CODE_OAUTH_TOKEN = token;
          }

          // S-06 slice-3: honor the same two headless-spawn switches as
          // AgentSpawner.spawnAgentSync — guardHooks (SecurityValidator +
          // PromptInjectionDefender via inline --settings) and enforceTools
          // (the real tool boundary; --allowedTools is inert under
          // --dangerously-skip-permissions, see AgentSpawner.ts's doc
          // comment). Both resolve via the SAME helpers AgentSpawner exports
          // (explicit option → env var → default OFF) — no duplicated JSON,
          // no duplicated env-var parsing. Neither is plumbed through
          // `opts` here (env-var-only control), matching this call site's
          // existing all-env-driven configuration.
          const conflictResolverAllowedTools = "Bash,Read,Edit";
          const conflictResolverArgs: string[] = [
            "-p",
            "--model", "sonnet",
            "--dangerously-skip-permissions",
            "--allowedTools", conflictResolverAllowedTools,
          ];
          if (resolveEnforceTools(undefined, process.env)) {
            conflictResolverArgs.push("--tools", conflictResolverAllowedTools);
          }
          conflictResolverArgs.push("--setting-sources", "");
          if (resolveGuardHooks(undefined, process.env)) {
            conflictResolverArgs.push("--settings", buildGuardHookSettings(getKayaHome()));
          }
          conflictResolverArgs.push("--output-format", "text", conflictResolverPrompt);

          const agentResult = opts._conflictResolverForTest
            ? opts._conflictResolverForTest()
            : spawnSync(
                "claude",
                conflictResolverArgs,
                { cwd: wtPath, encoding: "utf-8", timeout: 120_000, env, maxBuffer: 32 * 1024 * 1024 }
              );

          // Check if conflicts remain
          const postAgentStatus = (() => {
            try {
              return execFileSync("git", ["status", "--porcelain"], {
                cwd: wtPath, encoding: "utf-8", stdio: "pipe", timeout: 10_000,
              });
            } catch {
              return "";
            }
          })();

          const conflictsRemain = postAgentStatus.split("\n").some(
            line => /^(UU|AA|DD|AU|UA) /.test(line)
          );

          if (agentResult.status !== 0 || conflictsRemain) {
            // Agent failed or conflicts remain — abort
            try { execFileSync("git", ["merge", "--abort"], { cwd: wtPath, stdio: "pipe", timeout: 10_000 }); } catch { /* best effort */ }
            result.failed.push(branch);
            result.outcomes.push({
              branch,
              status: "failed",
              reason: conflictsRemain
                ? "Conflict resolution agent ran but conflicts remain"
                : `Conflict resolver agent exited non-zero (exit ${agentResult.status ?? "?"}): ${agentResult.stderr?.slice(0, 200) ?? ""}`,
            });
            console.error(`[Integrator] FAIL ${branch}: conflict not resolved`);
            continue;
          }

          // Agent resolved conflicts — commit
          try {
            execFileSync("git", ["commit", "-m", `Reconcile (conflict resolved): ${branch}`], {
              cwd: wtPath, stdio: "pipe", timeout: 30_000,
            });
            mergeSucceeded = true;
            conflictResolved = true;
          } catch (e) {
            try { execFileSync("git", ["merge", "--abort"], { cwd: wtPath, stdio: "pipe", timeout: 10_000 }); } catch { /* best effort */ }
            result.failed.push(branch);
            result.outcomes.push({ branch, status: "failed", reason: `Could not commit after conflict resolution: ${e instanceof Error ? e.message : String(e)}` });
            console.error(`[Integrator] FAIL ${branch}: commit after resolution failed`);
            continue;
          }
        }

        if (!mergeSucceeded) continue;

        // Verify branch is ancestor of merge result
        const isAnc = this.isAncestor(branch, "HEAD", wtPath);
        if (!isAnc) {
          result.failed.push(branch);
          result.outcomes.push({ branch, status: "failed", reason: "Branch not ancestor of merge result — integrity check failed" });
          console.error(`[Integrator] FAIL ${branch}: ancestor verify failed`);
          continue;
        }

        // Non-fatal build check
        let verificationPassed: boolean | undefined;
        try {
          execFileSync("bun", ["build", "--target=bun", join(repoRoot, "lib/core/KayaHome.ts"), "--outfile=/dev/null"], {
            cwd: wtPath, timeout: 30_000, stdio: "pipe",
          });
          verificationPassed = true;
        } catch {
          verificationPassed = false;
          console.warn(`[Integrator] WARN ${branch}: bun build check failed (non-fatal)`);
        }

        // Advance main: CAS (compare-and-swap) update-ref with retry.
        //
        // Problem with bare 3-arg update-ref: it's unconditional last-writer-wins.
        // Concurrent reconcile() calls each read main=X, commit on top of X, then
        // update-ref → the second clobbers the first → orphaned commit (BUG #2).
        //
        // Fix: 4-arg form `git update-ref refs/heads/main <new> <expected-old>` fails
        // atomically if main has moved. On failure we re-sync the integration worktree
        // to the new main, re-merge this branch on top, and retry — up to MAX_CAS_RETRIES.
        // On exhaustion, fail LOUDLY (never silently drop a commit).
        const MAX_CAS_RETRIES = 3;
        let casSucceeded = false;
        let finalOldMainSha = expectedMainSha;
        let finalNewMainSha = "";
        let skipToNextBranch = false;

        for (let attempt = 0; attempt < MAX_CAS_RETRIES; attempt++) {
          if (attempt > 0) {
            // CAS was rejected — another writer advanced main while we were merging.
            // Re-sync the integration worktree to the new main and re-merge this branch.
            console.warn(
              `[Integrator] CAS rejected for "${branch}" (attempt ${attempt}/${MAX_CAS_RETRIES}) — ` +
              `re-syncing to new main and re-merging`
            );
            try {
              expectedMainSha = syncIntegrationToMain();
              execFileSync("git", ["merge", "--no-ff", branch, "-m", `Reconcile: ${branch}`], {
                cwd: wtPath, stdio: "pipe", timeout: 60_000,
              });
              // Re-verify ancestry after re-merge (do not re-run the conflict resolver
              // on retry — if this re-merge conflicts, fail the branch loudly)
              if (!this.isAncestor(branch, "HEAD", wtPath)) {
                throw new Error("branch not ancestor of re-merge result — integrity check failed");
              }
            } catch (retryErr) {
              result.failed.push(branch);
              result.outcomes.push({
                branch,
                status: "failed",
                reason: `CAS retry ${attempt}: re-merge onto new main failed: ${retryErr instanceof Error ? retryErr.message : String(retryErr)}`,
              });
              console.error(`[Integrator] FAIL "${branch}": re-merge failed on CAS retry ${attempt}`);
              skipToNextBranch = true;
              break;
            }
          }

          const integrationSha = (() => {
            try {
              return execFileSync("git", ["rev-parse", "HEAD"], {
                cwd: wtPath, encoding: "utf-8", stdio: "pipe", timeout: 10_000,
              }).trim();
            } catch { return ""; }
          })();

          if (!integrationSha) {
            result.failed.push(branch);
            result.outcomes.push({ branch, status: "failed", reason: "Could not resolve integration HEAD SHA" });
            skipToNextBranch = true;
            break;
          }

          try {
            // 4-arg CAS: exits non-zero if refs/heads/main !== expectedMainSha
            execFileSync("git", ["update-ref", "refs/heads/main", integrationSha, expectedMainSha], {
              cwd: repoRoot, stdio: "pipe", timeout: 10_000,
            });
            finalOldMainSha = expectedMainSha;
            finalNewMainSha = integrationSha;
            casSucceeded = true;
            break; // success
          } catch {
            // CAS rejected — re-read current main for the next attempt
            try {
              expectedMainSha = execFileSync("git", ["rev-parse", "main"], {
                cwd: repoRoot, encoding: "utf-8", stdio: "pipe", timeout: 10_000,
              }).trim();
            } catch { /* ignore — will retry */ }
          }
        }

        if (skipToNextBranch) continue;

        if (!casSucceeded) {
          result.failed.push(branch);
          result.outcomes.push({
            branch,
            status: "failed",
            reason: `refs/heads/main CAS exhausted after ${MAX_CAS_RETRIES} attempts — concurrent writers kept advancing main`,
          });
          console.error(`[Integrator] FAIL "${branch}": CAS exhausted after ${MAX_CAS_RETRIES} attempts`);
          continue;
        }

        // Working-tree sync: bring the shared tree's on-disk files into line with
        // the new main HEAD (BUG #1 fix). The ref is already correct; this step
        // restores the actual file contents on disk.
        //
        // We use a TARGETED per-file checkout (not git reset --hard) so uncommitted
        // edits to OTHER files in the interactive session are preserved. Only the
        // files actually changed by this merge are touched.
        try {
          const changedFiles = execFileSync(
            "git", ["diff", "--name-only", finalOldMainSha, finalNewMainSha],
            { cwd: repoRoot, encoding: "utf-8", stdio: "pipe", timeout: 15_000 }
          ).trim().split("\n").filter(Boolean);
          if (changedFiles.length > 0) {
            // Batch in groups of 100 to stay well within OS ARG_MAX
            const BATCH = 100;
            for (let i = 0; i < changedFiles.length; i += BATCH) {
              execFileSync("git", ["checkout", "HEAD", "--", ...changedFiles.slice(i, i + BATCH)], {
                cwd: repoRoot, stdio: "pipe", timeout: 30_000,
              });
            }
            console.log(
              `[Integrator] Synced ${changedFiles.length} file(s) in shared tree ` +
              `after advancing main to ${finalNewMainSha.slice(0, 8)}`
            );
          }
        } catch (wtSyncErr) {
          // Non-fatal: the ref is already correct. The working tree is stale but
          // will be correct after the next explicit checkout. Warn loudly.
          console.warn(
            `[Integrator] WARN: main ref advanced to ${finalNewMainSha.slice(0, 8)} ` +
            `but working-tree sync failed — ` +
            `run: git -C ${repoRoot} checkout HEAD -- . to fix manually. ` +
            `(${wtSyncErr instanceof Error ? wtSyncErr.message : String(wtSyncErr)})`
          );
        }

        result.merged.push(branch);
        result.outcomes.push({
          branch,
          status: "merged",
          conflictResolved,
          verificationPassed,
          gcCandidate: true,
        });
      }
    } finally {
      await lock.release();
    }

    // --- Post-reconcile GC (outside the integrator lock) ---
    // For each successfully merged branch marked gcCandidate, attempt liveness-
    // gated GC of its worktree. Guards: merged + clean + stale + not integrator
    // reuse branch. Any failure is non-fatal and logged; we never block reconcile.
    const gcCandidates = result.outcomes.filter(o => o.status === "merged" && o.gcCandidate);
    for (const outcome of gcCandidates) {
      try {
        const gcResult = await gcWorktreeForBranch(outcome.branch, repoRoot);
        if (gcResult.removed.length > 0) {
          console.log(`[Integrator] GC removed worktree for "${outcome.branch}": ${gcResult.removed.join(", ")}`);
        } else if (gcResult.skipped.length > 0) {
          const reasons = gcResult.skipped.map(s => s.reason).join("; ");
          console.log(`[Integrator] GC skipped worktree for "${outcome.branch}": ${reasons}`);
        }
        for (const e of gcResult.errors) {
          console.warn(`[Integrator] GC error for "${outcome.branch}": ${e}`);
        }
      } catch (e) {
        // GC is best-effort — never block or fail the reconcile result
        console.warn(`[Integrator] GC threw for "${outcome.branch}": ${e instanceof Error ? e.message : String(e)}`);
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
   * Async lock wrapper — ALL merge paths use this (reconcile, mergeItem, mergeCompleted).
   * A single lock file serializes concurrent processes from any path.
   *
   * DEADLOCK RULE: Never call mergeItem() or mergeCompleted() from inside a fn passed
   * to withIntegratorLock (or from reconcile(), which uses its own direct lock acquire).
   * Internal callers that already hold the lock must use _mergeItemCore() /
   * _mergeCompletedCore() directly — those are the unlocked variants.
   *
   * Lock is async (IntegratorFileLock with Bun.sleep) so it does not block the
   * event loop, correctly yielding to concurrent async operations (including other
   * lock holders that need to run their release() path).
   */
  private async withIntegratorLock<T>(fn: () => Promise<T> | T): Promise<T> {
    const locksDir = join(runtimeDir(), "locks");
    mkdirSync(locksDir, { recursive: true });
    const lock = new IntegratorFileLock(join(locksDir, "integrator.lock"), 30_000);
    await lock.acquire();
    try {
      return await fn();
    } finally {
      await lock.release();
    }
  }

  private requiresHumanApproval(item: WorkItem): boolean {
    if (item.metadata?.mergeApproved === true) return false;
    const workType = item.workType ?? item.metadata?.workType as string | undefined;
    if (workType === "deploy" || workType === "publish") return true;

    const affectsSettings = item.metadata?.affectsSettings as boolean | undefined;
    if (affectsSettings) return true;

    const iscRows = item.metadata?.iscRows as Array<{ description?: string; source?: string }> | undefined;
    if (iscRows?.some(r =>
      /settings\.json|secrets\.json|\.env\b/i.test(r.description ?? "") ||
      /settings\.json|secrets\.json|\.env\b/i.test(r.source ?? "")
    )) return true;

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
          } catch { /* not a git repo */ }
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
   * this file uses elsewhere (checkInteractiveSessionLock, verifyDirectMergeLanded,
   * reconcile()'s _conflictResolverForTest) — `gh` talks to real GitHub and has no hermetic
   * fake-able equivalent, whereas every git command around it (push/fetch/ancestor-check in
   * verifyPrMergeLanded) is real and runs against a real repo in tests.
   */
  private ghCreatePr(repoPath: string, title: string, branch: string, verifiedCount: number): string {
    const prOutput = execFileSync(
      "gh",
      ["pr", "create", "--title", `Merge: ${title}`, "--body",
       `Verified by SkepticalVerifier. ISC rows: ${verifiedCount} verified.`,
       "--head", branch, "--base", "main"],
      { cwd: repoPath, timeout: 30_000, stdio: "pipe", encoding: "utf-8" }
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
      execFileSync("gh", ["pr", "merge", prUrl, "--auto", "--merge"],
        { cwd: repoPath, timeout: 30_000, stdio: "pipe" });
    } catch {
      try {
        execFileSync("gh", ["pr", "merge", prUrl, "--merge"],
          { cwd: repoPath, timeout: 30_000, stdio: "pipe" });
      } catch {
        console.warn(`[Integrator] PR created but merge failed for ${prUrl}. Merge manually.`);
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
        return { ok: false, reason: `refusing to merge into '${current || "?"}' — could not check out base branch '${base}' first: ${e instanceof Error ? e.message : String(e)}` };
      }
    }
    const beforeSha = revParseRef(cwd, base);
    try {
      execFileSync("git", ["merge", "--no-ff", branch, "-m", `Merge verified: ${title}`], { cwd, timeout: 30_000, stdio: "pipe" });
    } catch (e) {
      return { ok: false, reason: `git merge --no-ff ${branch} into ${base} failed: ${e instanceof Error ? e.message : String(e)}` };
    }
    const diskResult = this.verifyDirectMergeLanded(cwd, branch, base, beforeSha);
    if (!diskResult.clean) {
      const dirty = diskResult.diffOutput.trim();
      return {
        ok: false,
        reason: `merge of '${branch}' into '${base}' did not verify clean (isAncestor=${diskResult.isAncestor}` +
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
      return execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd, timeout: 10_000, stdio: "pipe", encoding: "utf-8" }).trim();
    } catch {
      return "";
    }
  }

  private resolveBaseBranch(cwd: string): string {
    for (const b of ["main", "master"]) {
      try {
        execFileSync("git", ["rev-parse", "--verify", "--quiet", `refs/heads/${b}`], { cwd, timeout: 10_000, stdio: "pipe" });
        return b;
      } catch { /* branch not present */ }
    }
    return this.currentBranch(cwd) || "main";
  }

  private isAncestor(ancestor: string, descendant: string, cwd: string): boolean {
    try {
      execFileSync("git", ["merge-base", "--is-ancestor", ancestor, descendant], { cwd, timeout: 10_000, stdio: "pipe" });
      return true;
    } catch {
      return false;
    }
  }

  private detectConflict(branch: string, cwd?: string): boolean {
    const opts = { encoding: "utf-8" as const, timeout: 10_000, stdio: "pipe" as const, ...(cwd ? { cwd } : {}) };
    try {
      const mergeBase = execFileSync("git", ["merge-base", "HEAD", branch], opts).trim();
      const result = execFileSync("git", ["merge-tree", mergeBase, "HEAD", branch],
        { ...opts, timeout: 30_000 });
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
Integrator — Merge completed/verified feature branches + reconcile diverged branches

USAGE
  integrator reconcile [--branch <name>] [--json]
  integrator merge     --strategy <pr|direct> [--json]
  integrator pending   [--json]
  integrator approve   <id> [--merge] [--strategy <pr|direct>] [--by <name>] [--json]
  integrator drain     [--strategy <pr|direct>] [--json]
  integrator --help

COMMANDS
  reconcile       Discover and merge diverged branches via integration worktree
                  (conflict resolution via headless claude -p agent)
  merge           Merge all completed, verified branches (approval-required items skipped)
  pending         List verified-locally items waiting on a merge approval (Slice 3)
  approve <id>    Grant merge approval for an item; add --merge to merge it immediately
  drain           Merge all items that have a recorded approval (mergeApproved === true)

OPTIONS
  --branch        (reconcile) process only this branch
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
      branch: { type: "string" },
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

  if (command === "reconcile") {
    const reconcileResult = await integrator.reconcile({
      branch: values.branch as string | undefined,
    });
    if (values.json) {
      console.log(JSON.stringify(reconcileResult, null, 2));
    } else {
      console.log(`Reconcile: merged ${reconcileResult.merged.length}  failed ${reconcileResult.failed.length}  skipped ${reconcileResult.skipped.length}`);
      for (const o of reconcileResult.outcomes) {
        const flags = [
          o.conflictResolved ? "conflict-resolved" : null,
          o.verificationPassed === false ? "build-warn" : null,
        ].filter(Boolean).join(",");
        console.log(`  ${o.status.toUpperCase()} ${o.branch}${flags ? ` (${flags})` : ""}${o.reason ? ` — ${o.reason}` : ""}`);
      }
    }
    process.exit(reconcileResult.failed.length > 0 ? 1 : 0);
  }

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
      console.log(`Merged: ${mergeResult.merged}  Conflicts: ${mergeResult.conflicts}  Skipped: ${mergeResult.skipped}`);
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
    if (!id) { console.error("Usage: approve <id> [--merge] [--strategy pr|direct] [--by <name>]"); process.exit(1); }
    const strategy = (values.strategy === "pr" ? "pr" : "direct") as MergeStrategy;
    const by = (values.by as string | undefined) ?? "Jm";
    const result = values.merge
      ? await integrator.approveAndMerge(id, strategy, by)
      : integrator.approve(id, by);
    if (values.json) {
      console.log(JSON.stringify(result, null, 2));
    } else if ("merged" in result) {
      console.log(result.merged ? `${id} → approved + merged` : `${id} → approved but not merged: ${result.reason ?? "?"}`);
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
      console.log(`Drained approved: Merged ${drainResult.merged}  Conflicts ${drainResult.conflicts}  Skipped ${drainResult.skipped}`);
      for (const url of drainResult.prUrls) console.log(`  ${url}`);
    }
    process.exit(0);
  }

  console.error(`Unknown command: ${command ?? "(none)"}\n\n${USAGE}`);
  process.exit(1);
}
