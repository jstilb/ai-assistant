#!/usr/bin/env bun
/**
 * MergeSafety.ts — Shared post-merge verification for any worktree→main merge path.
 *
 * Extracted (slice S13) from LucidTasks' `executor/executorMerge.ts` (Lane A auto-merge, slice
 * F2) so OTHER merge lanes — starting with AutonomousWork's `Integrator.ts` (pr/direct merge
 * modes), which had NO equivalent verification at all before this — can share the exact same
 * check instead of re-deriving it. A merge-safety correctness fix landing in only one lane
 * (because each lane hand-rolled its own copy) was the concrete drift risk this extraction
 * closes: fix the check here once, both lanes benefit.
 *
 * THE CHECK (CLAUDE.md's documented post-worktree-merge recipe):
 *   1. `git merge-base --is-ancestor <branch> <base>` — did the branch genuinely land in
 *      `<base>`'s history (default "main")?
 *   2. `git diff --stat HEAD -- <changed files>` is empty — does the working tree at `repoRoot`
 *      actually match HEAD for the files this merge touched (catches a CAS update-ref that
 *      raced, or a targeted working-tree sync that left files stale)?
 *
 * SCOPED, NOT REPO-GLOBAL — this is the load-bearing design decision, found and fixed twice
 * during slice F2's fix round (see executorMerge.ts's git history / F2 fix-round docstrings for
 * the full write-up): an early implementation swept the WHOLE repo (`git log --all --not main
 * --no-walk`, then `git log --all --not main`) and false-positived on every OTHER in-flight
 * worktree branch — the live kaya repo permanently carries a dozen-plus of those. Both checks
 * here are scoped to the ONE branch / ONE file list the caller names; no other ref in the
 * repository ever enters the computation.
 *
 * Pure functions, no DI bag: callers needing to fake this out in unit tests wrap these functions
 * behind their OWN injectable deps (see executorMerge.ts's `AutoMergeDeps.verifyDisk` for the
 * pattern) — this module itself stays a thin, dependency-free git wrapper.
 */

import { execFileSync } from "child_process";

// ============================================================================
// Types
// ============================================================================

export interface DiskVerifyResult {
  clean: boolean;
  diffOutput: string;
  /** true when `git merge-base --is-ancestor <branch> <base>` exits 0 — the merge genuinely landed. */
  isAncestor: boolean;
}

// ============================================================================
// Git plumbing
// ============================================================================

function gitOut(args: string[], cwd: string): string {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf-8", maxBuffer: 16 * 1024 * 1024 });
  } catch (err) {
    return `(git ${args.join(" ")} failed: ${err instanceof Error ? err.message : String(err)})`;
  }
}

/** `git rev-parse <ref>` (default "main"), trimmed. Empty string on failure. */
export function revParseRef(repoRoot: string, ref = "main"): string {
  return gitOut(["rev-parse", ref], repoRoot).trim();
}

/** `git diff --name-only <beforeSha> <afterSha>` — the files touched between two commits. */
export function changedFilesBetween(repoRoot: string, beforeSha: string, afterSha: string): string[] {
  return gitOut(["diff", "--name-only", beforeSha, afterSha], repoRoot)
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

/**
 * `git merge-base --is-ancestor <branch> <base>` — exit 0 means `branch` is genuinely reachable
 * from `base`'s current tip, i.e. this merge really landed. Exit non-zero (execFileSync throws)
 * means it did not — a real, still-unmerged branch. Scoped to exactly these two refs; nothing
 * else in the repository is inspected.
 */
export function isBranchAncestor(repoRoot: string, branch: string, base = "main"): boolean {
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", branch, base], { cwd: repoRoot, encoding: "utf-8" });
    return true;
  } catch {
    return false;
  }
}

/**
 * `git diff --stat HEAD -- <changed files>` must be empty (working tree matches HEAD for the
 * files this merge touched) AND `branch` must be an ancestor of `base` — the two checks
 * CLAUDE.md documents as mandatory after any worktree→main merge. Both are SCOPED to this one
 * merge (this branch, these files) — see the module docstring for why a repo-global sweep is
 * wrong.
 *
 * `changedFiles` may legitimately be empty (a caller with no local working-tree checkout of
 * `base` to diff against, e.g. a GitHub-side PR merge) — in that case the disk-diff half is
 * trivially clean and `clean` reduces to the ancestor check alone.
 */
export function verifyMergeOnDisk(repoRoot: string, changedFiles: string[], branch: string, base = "main"): DiskVerifyResult {
  const diffOutput = changedFiles.length > 0 ? gitOut(["diff", "--stat", "HEAD", "--", ...changedFiles], repoRoot) : "";
  const isAncestor = isBranchAncestor(repoRoot, branch, base);
  return { clean: diffOutput.trim() === "" && isAncestor, diffOutput, isAncestor };
}
