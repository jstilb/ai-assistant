/**
 * WorktreeOps.ts — git worktree lifecycle for work items: resolve the target
 * repo root, create/reuse a feature-branch worktree via WorktreeManager, and
 * clean it up on completion/failure.
 *
 * Extracted from WorkOrchestrator.ts (S11 decomposition, pass 3). Functions take
 * explicit `queue` + a `logCaughtError` callback (matching the orchestrator's
 * own `guard.logCaughtError` signature) rather than reaching into `this`, same
 * DI shape as PhaseBookkeeping.ts / Verification.ts. `WorktreeManager` stays a
 * dynamic import inside the two functions that touch it — unchanged from the
 * orchestrator — so pure ISC/report call paths never pull it in.
 */

import { existsSync } from "fs";
import { execFileSync } from "child_process";
import type { WorkQueue, WorkItem } from "../../WorkQueue.ts";

export type LogCaughtError = (itemId: string, location: string, error: unknown) => void;

/** Check if a path is a git repo different from Kaya. Returns repo root or null. */
export function tryResolveGitRoot(candidatePath: string | undefined | null): string | null {
  if (!candidatePath || !existsSync(candidatePath)) return null;
  try {
    const root = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      encoding: "utf-8",
      cwd: candidatePath,
      timeout: 5000,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    if (root && root !== process.cwd()) return root;
  } catch {
    // Not a git repo or git error
  }
  return null;
}

/** Resolve a path's git toplevel with no Kaya-exclusion. Null = missing/not a repo. */
function gitToplevel(candidatePath: string): string | null {
  if (!existsSync(candidatePath)) return null;
  try {
    const root = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      encoding: "utf-8",
      cwd: candidatePath,
      timeout: 5000,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    return root || null;
  } catch {
    return null;
  }
}

/**
 * Resolve the git repo root for worktree creation.
 * For items targeting external projects (kaya-canvas, kaya-mobile, etc.),
 * creates the worktree from the project's repo — not ~/.claude.
 *
 * Resolution:
 * 1. item.projectPath / item.outputPath (explicit) — must resolve to a real
 *    git repository, otherwise THROWS.
 * 2. No explicit path → process.cwd() (Kaya-internal item).
 *
 * HISTORY (2026-08-01, markdown-regex remediation): a title-prefix heuristic
 * (`/^([\w-]+):\s/` → ~/Desktop/projects/<name>) used to sit between those
 * two steps — a hand-written parse of prose that PICKED THE TARGET REPOSITORY
 * and persisted the guess via queue.setProjectPath(). An item titled
 * "auth: fix login race" would silently target ~/Desktop/projects/auth if
 * that directory happened to be a repo. Cross-repo items must carry an
 * explicit projectPath (see memory: AW cross-repo worktree gotchas); when the
 * declared path doesn't resolve we fail loud rather than guessing — a
 * worktree created in the wrong repo persists bad state downstream.
 */
export function resolveRepoRoot(_queue: WorkQueue, item: WorkItem | undefined): string {
  if (!item) return process.cwd();

  const candidatePath = item.projectPath || item.outputPath;
  if (!candidatePath) {
    // No explicit target — Kaya-internal item works in the Kaya repo.
    return process.cwd();
  }

  const root = gitToplevel(candidatePath);
  if (root === null) {
    throw new Error(
      `resolveRepoRoot: item ${item.id} declares projectPath/outputPath "${candidatePath}", ` +
      `but it is not an existing git repository. Refusing to guess the target repo — ` +
      `fix the item's projectPath, or remove it to target the Kaya repo.`
    );
  }
  return root;
}

/**
 * Reuses (or creates) the git worktree + feature branch for an item, persisting
 * `worktreePath`/`worktreeBranch`/`startSha` in item metadata for cleanup + git
 * diff range. Throws on worktree-creation failure — caller should retry(id, error).
 */
export async function ensureFeatureBranch(
  queue: WorkQueue,
  logCaughtError: LogCaughtError,
  itemId: string,
): Promise<{ branch: string; workingDir: string }> {
  const sanitizedId = itemId.replace(/[^a-zA-Z0-9-]/g, "-");
  const featureBranch = `feature/work-${sanitizedId}`;

  // Reuse existing worktree from metadata (handles retry case where worktree persists)
  const item = queue.getItem(itemId);
  const existingPath = item?.metadata?.worktreePath as string | undefined;
  const existingBranch = item?.metadata?.worktreeBranch as string | undefined;
  const intendedRepo = resolveRepoRoot(queue, item);

  if (existingPath && existsSync(existingPath)) {
    // Stale worktree detection: if the existing worktree was created from the wrong repo
    // (e.g., ~/.claude instead of the target project), clean it up and recreate
    const existingRepo = tryResolveGitRoot(existingPath);
    const intendedIsExternal = intendedRepo !== process.cwd();
    const existingIsKaya = existingRepo === null || existingRepo === process.cwd();
    if (intendedIsExternal && existingIsKaya) {
      // Wrong repo — clean up stale worktree and fall through to recreate
      try {
        const { removeWorktree } = await import("../../../../../../lib/core/WorktreeManager.ts");
        await removeWorktree(existingPath);
      } catch { /* best-effort cleanup */ }
    } else {
      return { branch: existingBranch ?? featureBranch, workingDir: existingPath };
    }
  }

  try {
    const { getOrCreateWorktree } = await import("../../../../../../lib/core/WorktreeManager.ts");
    const entry = await getOrCreateWorktree({
      repoRoot: intendedRepo,
      branch: featureBranch,
      createdBy: `orchestrator:${sanitizedId}`,
      keepUntilMerged: true,
    });
    // Persist worktree path and starting SHA in item metadata for cleanup + git diff range
    const startSha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf-8", cwd: entry.path }).trim();
    queue.setMetadata(itemId, { worktreePath: entry.path, worktreeBranch: featureBranch, startSha });
    return { branch: featureBranch, workingDir: entry.path };
  } catch (e) {
    logCaughtError(itemId, "ensureFeatureBranch.getOrCreateWorktree", e);
    throw new Error(`ensureFeatureBranch failed for ${itemId}: ${e instanceof Error ? e.message : String(e)}. Caller should use retry(id, error).`);
  }
}

/** Remove an item's worktree (best-effort — non-blocking on failure, orphan worktree is disk space only). */
export async function cleanupWorktree(
  queue: WorkQueue,
  logCaughtError: LogCaughtError,
  itemId: string,
): Promise<void> {
  const item = queue.getItem(itemId);
  const wtPath = item?.metadata?.worktreePath as string | undefined;
  if (!wtPath) return;

  try {
    const { removeWorktree } = await import("../../../../../../lib/core/WorktreeManager.ts");
    await removeWorktree(wtPath);
  } catch (e) {
    // Non-blocking — worktree cleanup failure means orphan worktree (disk space only)
    logCaughtError(itemId, "cleanupWorktree", e);
  }
}
