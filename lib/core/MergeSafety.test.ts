#!/usr/bin/env bun
/**
 * MergeSafety.test.ts — Unit tests for the shared post-merge verification (slice S13).
 *
 * Real, disposable temp git repos throughout (Article IX — integration-first, no faked git).
 * Nothing here touches the live kaya checkout.
 */

import { describe, it, expect, afterEach } from "bun:test";
import { execFileSync } from "child_process";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { revParseRef, changedFilesBetween, isBranchAncestor, verifyMergeOnDisk } from "./MergeSafety.ts";

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8", stdio: "pipe" });
}

const repos: string[] = [];
function makeRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "merge-safety-test-"));
  repos.push(repo);
  git(["init", "-q", "-b", "main"], repo);
  git(["config", "user.email", "t@t.local"], repo);
  git(["config", "user.name", "t"], repo);
  writeFileSync(join(repo, "README.md"), "# repo\n");
  git(["add", "-A"], repo);
  git(["commit", "-qm", "init"], repo);
  return repo;
}

afterEach(() => {
  while (repos.length) {
    const r = repos.pop()!;
    try { rmSync(r, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});

// ============================================================================
// revParseRef / changedFilesBetween
// ============================================================================

describe("revParseRef", () => {
  it("resolves 'main' to the current tip sha", () => {
    const repo = makeRepo();
    const sha = revParseRef(repo, "main");
    expect(sha).toBe(git(["rev-parse", "main"], repo).trim());
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
  });

  it("defaults to 'main' when no ref is given", () => {
    const repo = makeRepo();
    expect(revParseRef(repo)).toBe(revParseRef(repo, "main"));
  });

  it("returns a non-throwing failure marker for a nonexistent ref", () => {
    const repo = makeRepo();
    expect(() => revParseRef(repo, "does-not-exist")).not.toThrow();
    expect(revParseRef(repo, "does-not-exist")).not.toMatch(/^[0-9a-f]{40}$/);
  });
});

describe("changedFilesBetween", () => {
  it("lists files touched between two commits", () => {
    const repo = makeRepo();
    const before = revParseRef(repo, "main");
    writeFileSync(join(repo, "feature.ts"), "export const x = 1;\n");
    git(["add", "-A"], repo);
    git(["commit", "-qm", "add feature"], repo);
    const after = revParseRef(repo, "main");
    expect(changedFilesBetween(repo, before, after)).toEqual(["feature.ts"]);
  });

  it("returns an empty array for identical shas", () => {
    const repo = makeRepo();
    const sha = revParseRef(repo, "main");
    expect(changedFilesBetween(repo, sha, sha)).toEqual([]);
  });
});

// ============================================================================
// isBranchAncestor
// ============================================================================

describe("isBranchAncestor", () => {
  it("returns true once a branch is merged into base", () => {
    const repo = makeRepo();
    git(["checkout", "-q", "-b", "feature/x"], repo);
    writeFileSync(join(repo, "feature.ts"), "export const x = 1;\n");
    git(["add", "-A"], repo);
    git(["commit", "-qm", "feat: x"], repo);
    git(["checkout", "-q", "main"], repo);
    git(["merge", "--no-ff", "feature/x", "-m", "merge feature/x"], repo);

    expect(isBranchAncestor(repo, "feature/x", "main")).toBe(true);
  });

  it("returns false for a genuinely unmerged branch", () => {
    const repo = makeRepo();
    git(["checkout", "-q", "-b", "feature/unmerged"], repo);
    writeFileSync(join(repo, "unmerged.ts"), "export const y = 2;\n");
    git(["add", "-A"], repo);
    git(["commit", "-qm", "feat: y"], repo);

    expect(isBranchAncestor(repo, "feature/unmerged", "main")).toBe(false);
  });

  it("defaults base to 'main'", () => {
    const repo = makeRepo();
    git(["checkout", "-q", "-b", "feature/z"], repo);
    writeFileSync(join(repo, "z.ts"), "export const z = 3;\n");
    git(["add", "-A"], repo);
    git(["commit", "-qm", "feat: z"], repo);
    git(["checkout", "-q", "main"], repo);
    git(["merge", "--no-ff", "feature/z", "-m", "merge feature/z"], repo);

    expect(isBranchAncestor(repo, "feature/z")).toBe(true);
  });

  it("(the F2 regression) an UNRELATED branch with its own unmerged commits does not affect the scoped check", () => {
    const repo = makeRepo();

    // Someone else's permanently in-flight, deliberately unmerged work.
    git(["checkout", "-q", "-b", "someone-elses-in-flight-work"], repo);
    writeFileSync(join(repo, "unrelated-wip.txt"), "wip\n");
    git(["add", "-A"], repo);
    git(["commit", "-qm", "wip: unrelated"], repo);
    git(["checkout", "-q", "main"], repo);

    // A clean, unrelated merge.
    git(["checkout", "-q", "-b", "feature/clean"], repo);
    writeFileSync(join(repo, "clean.ts"), "export const clean = true;\n");
    git(["add", "-A"], repo);
    git(["commit", "-qm", "feat: clean"], repo);
    git(["checkout", "-q", "main"], repo);
    git(["merge", "--no-ff", "feature/clean", "-m", "merge feature/clean"], repo);

    // The scoped check only asks about feature/clean — the unrelated dangling branch must
    // never poison the answer (this is exactly the bug a repo-global sweep produced).
    expect(isBranchAncestor(repo, "feature/clean", "main")).toBe(true);
    expect(isBranchAncestor(repo, "someone-elses-in-flight-work", "main")).toBe(false);
  });
});

// ============================================================================
// verifyMergeOnDisk
// ============================================================================

describe("verifyMergeOnDisk", () => {
  it("reports clean when the branch landed and the working tree matches HEAD", () => {
    const repo = makeRepo();
    const before = revParseRef(repo, "main");
    git(["checkout", "-q", "-b", "feature/clean"], repo);
    writeFileSync(join(repo, "clean.ts"), "export const clean = true;\n");
    git(["add", "-A"], repo);
    git(["commit", "-qm", "feat: clean"], repo);
    git(["checkout", "-q", "main"], repo);
    git(["merge", "--no-ff", "feature/clean", "-m", "merge feature/clean"], repo);
    const after = revParseRef(repo, "main");

    const changed = changedFilesBetween(repo, before, after);
    const result = verifyMergeOnDisk(repo, changed, "feature/clean", "main");
    expect(result.isAncestor).toBe(true);
    expect(result.diffOutput.trim()).toBe("");
    expect(result.clean).toBe(true);
  });

  it("reports not clean when the branch is not an ancestor of base", () => {
    const repo = makeRepo();
    git(["checkout", "-q", "-b", "feature/unmerged"], repo);
    writeFileSync(join(repo, "unmerged.ts"), "export const y = 2;\n");
    git(["add", "-A"], repo);
    git(["commit", "-qm", "feat: y"], repo);

    const result = verifyMergeOnDisk(repo, [], "feature/unmerged", "main");
    expect(result.isAncestor).toBe(false);
    expect(result.clean).toBe(false);
  });

  it("reports not clean when the named changed files have uncommitted drift from HEAD", () => {
    const repo = makeRepo();
    const before = revParseRef(repo, "main");
    git(["checkout", "-q", "-b", "feature/drift"], repo);
    writeFileSync(join(repo, "drift.ts"), "export const drift = 1;\n");
    git(["add", "-A"], repo);
    git(["commit", "-qm", "feat: drift"], repo);
    git(["checkout", "-q", "main"], repo);
    git(["merge", "--no-ff", "feature/drift", "-m", "merge feature/drift"], repo);
    const after = revParseRef(repo, "main");

    // Simulate a stale working tree: an uncommitted local edit to the just-merged file.
    writeFileSync(join(repo, "drift.ts"), "export const drift = 999; // uncommitted stray edit\n");

    const changed = changedFilesBetween(repo, before, after);
    const result = verifyMergeOnDisk(repo, changed, "feature/drift", "main");
    expect(result.isAncestor).toBe(true);
    expect(result.diffOutput.trim()).not.toBe("");
    expect(result.clean).toBe(false);
  });

  it("treats an empty changedFiles list as trivially clean on the disk-diff half (ancestor check still applies)", () => {
    const repo = makeRepo();
    git(["checkout", "-q", "-b", "feature/nofiles"], repo);
    writeFileSync(join(repo, "nofiles.ts"), "export const n = 1;\n");
    git(["add", "-A"], repo);
    git(["commit", "-qm", "feat: nofiles"], repo);
    git(["checkout", "-q", "main"], repo);
    git(["merge", "--no-ff", "feature/nofiles", "-m", "merge feature/nofiles"], repo);

    const result = verifyMergeOnDisk(repo, [], "feature/nofiles", "main");
    expect(result.diffOutput).toBe("");
    expect(result.isAncestor).toBe(true);
    expect(result.clean).toBe(true);
  });
});
