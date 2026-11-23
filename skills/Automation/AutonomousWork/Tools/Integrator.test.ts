/**
 * Integrator.test.ts — Tests for Integrator (replaces MergeOrchestrator)
 *
 * Sections:
 *  1. New Integrator-specific tests (instantiation, mergeItem, approve/drain, pending)
 *  2. Migrated compat suite from MergeOrchestrator.test.ts
 *  3. Migrated compat suite from MergeOrchestrator.approval.test.ts
 *  4. Migrated compat suite from MergeOrchestrator.headguard.test.ts
 *
 * NOTE: mergeCompleted(), mergeItem(), drainApproved(), and approveAndMerge()
 * are now async (they acquire the integrator lock via IntegratorFileLock).
 * Tests that call these methods must be async and use await.
 */

import { describe, it, expect, afterAll } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, unlinkSync, existsSync, utimesSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Integrator } from "./Integrator.ts";
import { WorkQueue, type WorkItem, type WorkItemVerification, type WorkItemMetadata } from "./WorkQueue.ts";
import type { DiskVerifyResult } from "../../../../lib/core/MergeSafety.ts";
import { pinKayaHome, restoreKayaHome } from "../../../../lib/test/pinKayaHome.ts";
import { getKayaHome } from "../../../../lib/core/KayaHome.ts";

// Hermetic: WorkQueue seeding and Integrator write failure logs under KAYA_HOME.
pinKayaHome("integrator-test-");
afterAll(async () => {
  await restoreKayaHome();
});

// ============================================================================
// Shared helpers
// ============================================================================

function makeItem(overrides: Partial<WorkItem> & { id: string }): WorkItem {
  return {
    title: `Item ${overrides.id}`,
    description: "",
    status: "pending",
    priority: "normal",
    dependencies: [],
    source: "manual",
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

const passedVerification: WorkItemVerification = {
  status: "verified",
  verifiedAt: new Date().toISOString(),
  verdict: "PASS",
  concerns: [],
  iscRowsVerified: 3,
  iscRowsTotal: 3,
  verificationCost: 0.05,
  verifiedBy: "skeptical_verifier",
  tiersExecuted: [1, 2],
};

const verified: WorkItemVerification = {
  status: "verified",
  verifiedAt: new Date().toISOString(),
  verdict: "PASS",
  concerns: [],
  iscRowsVerified: 1,
  iscRowsTotal: 1,
  verificationCost: 0,
  verifiedBy: "skeptical_verifier",
  tiersExecuted: [1, 2],
};

function deployItem(id: string, extra: Partial<WorkItemMetadata> = {}): WorkItem {
  return makeItem({
    id,
    status: "completed",
    verification: verified,
    workType: "deploy",
    metadata: { worktreeBranch: `feature/${id}`, ...extra },
  });
}

// ============================================================================
// 1. New: Integrator-specific tests
// ============================================================================

describe("Integrator instantiation", () => {
  it("instantiates without arguments", () => {
    const integrator = new Integrator();
    expect(integrator).toBeDefined();
    expect(typeof integrator.mergeCompleted).toBe("function");
    expect(typeof integrator.mergeItem).toBe("function");
    expect(typeof integrator.approve).toBe("function");
    expect(typeof integrator.approveAndMerge).toBe("function");
    expect(typeof integrator.listPendingApproval).toBe("function");
    expect(typeof integrator.drainApproved).toBe("function");
    expect(typeof integrator.checkInteractiveSessionLock).toBe("function");
  });

  it("instantiates with a WorkQueue argument", () => {
    const wq = WorkQueue._createForTesting([]);
    const integrator = new Integrator(wq);
    expect(integrator).toBeDefined();
  });
});

describe("Integrator mergeCompleted empty queue", () => {
  it("returns zero counts on empty queue", async () => {
    const wq = WorkQueue._createForTesting([]);
    const integrator = new Integrator(wq);
    const result = await integrator.mergeCompleted("direct");
    expect(result.merged).toBe(0);
    expect(result.conflicts).toBe(0);
    expect(result.skipped).toBe(0);
  });
});

describe("Integrator mergeItem", () => {
  it("returns not found for missing item", async () => {
    const wq = WorkQueue._createForTesting([]);
    const integrator = new Integrator(wq);
    const result = await integrator.mergeItem("nonexistent-id");
    expect(result.merged).toBe(false);
    expect(result.reason).toContain("not found");
  });

  it("returns already merged for item with mergeStatus=merged", async () => {
    const wq = WorkQueue._createForTesting([
      makeItem({
        id: "x",
        status: "completed",
        verification: passedVerification,
        metadata: { worktreeBranch: "feature/x", mergeStatus: "merged" },
      }),
    ]);
    const integrator = new Integrator(wq);
    const result = await integrator.mergeItem("x");
    expect(result.merged).toBe(false);
    expect(result.reason).toBe("Already merged");
  });
});

describe("Integrator approve + drain", () => {
  it("approve sets metadata correctly", () => {
    const wq = WorkQueue._createForTesting([deployItem("a")]);
    const integrator = new Integrator(wq);
    const res = integrator.approve("a", "Jm");
    expect(res.approved).toBe(true);
    const meta = wq.getItem("a")!.metadata as WorkItemMetadata;
    expect(meta.mergeApproved).toBe(true);
    expect(meta.mergeApprovedBy).toBe("Jm");
    expect(meta.mergeStatus).toBe("approved");
  });

  it("drainApproved returns zeros when no items approved", async () => {
    const wq = WorkQueue._createForTesting([deployItem("a")]);
    const integrator = new Integrator(wq);
    const res = await integrator.drainApproved("direct");
    expect(res.merged).toBe(0);
    expect(res.conflicts).toBe(0);
    expect(res.skipped).toBe(0);
  });
});

describe("Integrator listPendingApproval", () => {
  it("surfaces approval-required items before approval", () => {
    const wq = WorkQueue._createForTesting([deployItem("a")]);
    const integrator = new Integrator(wq);
    const pending = integrator.listPendingApproval();
    expect(pending.map((p) => p.id)).toEqual(["a"]);
  });

  it("drops item from pending after approval", () => {
    const wq = WorkQueue._createForTesting([deployItem("a")]);
    const integrator = new Integrator(wq);
    integrator.approve("a");
    expect(integrator.listPendingApproval().length).toBe(0);
  });
});

// ============================================================================
// 2. Compat suite: migrated from MergeOrchestrator.test.ts
// ============================================================================

describe("Integrator (compat) — mergeCompleted", () => {
  it("instantiates without error", () => {
    const wq = WorkQueue._createForTesting([]);
    const mo = new Integrator(wq);
    expect(mo).toBeDefined();
  });

  it("mergeCompleted returns zero counts on empty queue", async () => {
    const wq = WorkQueue._createForTesting([]);
    const mo = new Integrator(wq);
    const result = await mo.mergeCompleted("direct");
    expect(result.merged).toBe(0);
    expect(result.conflicts).toBe(0);
    expect(result.skipped).toBe(0);
  });

  it("skips items without worktreeBranch metadata", async () => {
    const wq = WorkQueue._createForTesting([
      makeItem({
        id: "a",
        status: "completed",
        verification: passedVerification,
      }),
    ]);
    const mo = new Integrator(wq);
    const result = await mo.mergeCompleted("direct");
    expect(result.merged).toBe(0);
    expect(result.skipped).toBe(0);
  });

  it("skips non-completed items", async () => {
    const wq = WorkQueue._createForTesting([
      makeItem({
        id: "a",
        status: "in_progress",
        metadata: { worktreeBranch: "feature/test" },
      }),
    ]);
    const mo = new Integrator(wq);
    const result = await mo.mergeCompleted("direct");
    expect(result.merged).toBe(0);
  });

  it("skips items without verification", async () => {
    const wq = WorkQueue._createForTesting([
      makeItem({
        id: "a",
        status: "completed",
        metadata: { worktreeBranch: "feature/test" },
      }),
    ]);
    const mo = new Integrator(wq);
    const result = await mo.mergeCompleted("direct");
    expect(result.merged).toBe(0);
  });

  it("idempotency: already-merged items are skipped", async () => {
    const wq = WorkQueue._createForTesting([
      makeItem({
        id: "a",
        status: "completed",
        verification: passedVerification,
        metadata: { worktreeBranch: "feature/a", mergeStatus: "merged" },
      }),
    ]);
    const mo = new Integrator(wq);
    const result = await mo.mergeCompleted("direct");
    expect(result.merged).toBe(0);
    expect(result.skipped).toBe(1);
  });

  it("skipped count only includes already-merged items", async () => {
    const wq = WorkQueue._createForTesting([
      makeItem({
        id: "done1",
        status: "completed",
        verification: passedVerification,
        metadata: { worktreeBranch: "feature/done1", mergeStatus: "merged" },
      }),
      makeItem({
        id: "done2",
        status: "completed",
        verification: passedVerification,
        metadata: { worktreeBranch: "feature/done2", mergeStatus: "merged" },
      }),
      makeItem({ id: "pending1", status: "pending" }),
      makeItem({
        id: "inprog1",
        status: "in_progress",
        metadata: { worktreeBranch: "feature/inprog" },
      }),
    ]);
    const mo = new Integrator(wq);
    const result = await mo.mergeCompleted("direct");
    expect(result.skipped).toBe(2);
    expect(result.merged).toBe(0);
    expect(result.conflicts).toBe(0);
  });
});

// Interactive session lock compat tests

describe("Integrator (compat) — checkInteractiveSessionLock", () => {
  // Hermetic: resolve against the pinned test KAYA_HOME, never the live home.
  const lockDir = join(getKayaHome(), "MEMORY", "STATE");
  const lockPath = join(lockDir, "interactive-session.lock");

  let savedLock: string | null = null;
  const saveLock = () => {
    try {
      savedLock = require("node:fs").readFileSync(lockPath, "utf-8");
    } catch {
      savedLock = null;
    }
  };
  const restoreLock = () => {
    if (savedLock) writeFileSync(lockPath, savedLock, "utf-8");
    else if (existsSync(lockPath)) unlinkSync(lockPath);
  };

  it("returns null when lock file doesn't exist", () => {
    saveLock();
    try {
      if (existsSync(lockPath)) unlinkSync(lockPath);
      const mo = new Integrator(WorkQueue._createForTesting([]));
      expect(mo.checkInteractiveSessionLock()).toBeNull();
    } finally {
      restoreLock();
    }
  });

  it("returns lock info when lock file exists and is fresh", () => {
    saveLock();
    try {
      const lockData = { sessionId: "test-123", startedAt: new Date().toISOString(), pid: 99999 };
      if (!existsSync(lockDir)) mkdirSync(lockDir, { recursive: true });
      writeFileSync(lockPath, JSON.stringify(lockData), "utf-8");
      const mo = new Integrator(WorkQueue._createForTesting([]));
      const result = mo.checkInteractiveSessionLock();
      expect(result).not.toBeNull();
      expect(result!.sessionId).toBe("test-123");
    } finally {
      restoreLock();
    }
  });

  it("returns null when lock file is stale (> 2h old)", () => {
    saveLock();
    try {
      const lockData = { sessionId: "stale-456", startedAt: new Date().toISOString(), pid: 99999 };
      if (!existsSync(lockDir)) mkdirSync(lockDir, { recursive: true });
      writeFileSync(lockPath, JSON.stringify(lockData), "utf-8");
      const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000);
      utimesSync(lockPath, threeHoursAgo, threeHoursAgo);
      const mo = new Integrator(WorkQueue._createForTesting([]));
      expect(mo.checkInteractiveSessionLock()).toBeNull();
    } finally {
      restoreLock();
    }
  });

  it("returns null when lock file is corrupt JSON", () => {
    saveLock();
    try {
      if (!existsSync(lockDir)) mkdirSync(lockDir, { recursive: true });
      writeFileSync(lockPath, "not json {{{", "utf-8");
      const mo = new Integrator(WorkQueue._createForTesting([]));
      expect(mo.checkInteractiveSessionLock()).toBeNull();
    } finally {
      restoreLock();
    }
  });
});

// ============================================================================
// 3. Compat suite: migrated from MergeOrchestrator.approval.test.ts
// ============================================================================

describe("Integrator (compat) — approve()", () => {
  it("grants approval on a completed+verified item", () => {
    const wq = WorkQueue._createForTesting([deployItem("a")]);
    const mo = new Integrator(wq);
    const res = mo.approve("a", "Jm");
    expect(res.approved).toBe(true);
    const meta = wq.getItem("a")!.metadata as WorkItemMetadata;
    expect(meta.mergeApproved).toBe(true);
    expect(meta.mergeApprovedBy).toBe("Jm");
    expect(meta.mergeStatus).toBe("approved");
  });

  it("refuses to approve an item that is not completed+verified", () => {
    const wq = WorkQueue._createForTesting([makeItem({ id: "b", status: "in_progress" })]);
    const mo = new Integrator(wq);
    expect(mo.approve("b").approved).toBe(false);
  });

  it("refuses to approve an already-merged item", () => {
    const wq = WorkQueue._createForTesting([deployItem("c", { mergeStatus: "merged" })]);
    const mo = new Integrator(wq);
    expect(mo.approve("c").approved).toBe(false);
  });
});

describe("Integrator (compat) — pending-approval state (no git)", () => {
  it("mergeItem on an approval-required item records pending_approval and does NOT merge", async () => {
    const wq = WorkQueue._createForTesting([deployItem("a")]);
    const mo = new Integrator(wq);
    const res = await mo.mergeItem("a", "direct", { skipSessionLock: true });
    expect(res.merged).toBe(false);
    expect(res.reason).toContain("human approval");
    expect((wq.getItem("a")!.metadata as WorkItemMetadata).mergeStatus).toBe("pending_approval");
  });

  it("mergeCompleted skips approval-required items (never merges to main without approval)", async () => {
    const wq = WorkQueue._createForTesting([deployItem("a")]);
    const mo = new Integrator(wq);
    (mo as unknown as { checkInteractiveSessionLock: () => null }).checkInteractiveSessionLock = () => null;
    const result = await mo.mergeCompleted("direct");
    expect(result.merged).toBe(0);
    expect(result.skipped).toBe(1);
    expect((wq.getItem("a")!.metadata as WorkItemMetadata).mergeStatus).toBe("pending_approval");
  });

  it("listPendingApproval surfaces it before approval and drops it after", () => {
    const wq = WorkQueue._createForTesting([deployItem("a")]);
    const mo = new Integrator(wq);
    expect(mo.listPendingApproval().map((p) => p.id)).toEqual(["a"]);
    mo.approve("a");
    expect(mo.listPendingApproval().length).toBe(0);
  });
});

describe("Integrator (compat) — drainApproved selection", () => {
  it("returns zeros when no items are approved (no git run)", async () => {
    const wq = WorkQueue._createForTesting([deployItem("a")]);
    const mo = new Integrator(wq);
    const res = await mo.drainApproved("direct");
    expect(res.merged).toBe(0);
    expect(res.conflicts).toBe(0);
    expect(res.skipped).toBe(0);
  });
});

// ============================================================================
// 4. Compat suite: migrated from MergeOrchestrator.headguard.test.ts
// ============================================================================

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8", stdio: "pipe" });
}

function setupRepo(leaveHeadOn: "main" | "feature"): { repo: string; branch: string } {
  const repo = mkdtempSync(join(tmpdir(), "integrator-headguard-"));
  git(["init", "-q", "-b", "main"], repo);
  git(["config", "user.email", "t@t.local"], repo);
  git(["config", "user.name", "t"], repo);
  writeFileSync(join(repo, "README.md"), "# repo\n");
  git(["add", "-A"], repo);
  git(["commit", "-qm", "init"], repo);

  const branch = "feature/x";
  git(["checkout", "-q", "-b", branch], repo);
  mkdirSync(join(repo, "_canary"), { recursive: true });
  writeFileSync(join(repo, "_canary/greet.ts"), 'console.log("hi");\n');
  git(["add", "-A"], repo);
  git(["commit", "-qm", "feat: greet"], repo);

  if (leaveHeadOn === "main") git(["checkout", "-q", "main"], repo);
  return { repo, branch };
}

function itemForRepo(repo: string, branch: string): WorkItem {
  return {
    id: "hg-1",
    title: "headguard item",
    description: "",
    status: "completed",
    priority: "normal",
    dependencies: [],
    source: "manual",
    createdAt: new Date().toISOString(),
    verification: verified,
    projectPath: repo,
    metadata: { worktreeBranch: branch },
  };
}

function fileOnMain(repo: string): boolean {
  try {
    git(["cat-file", "-e", "main:_canary/greet.ts"], repo);
    return true;
  } catch {
    return false;
  }
}

describe("Integrator (compat) — HEAD guard (mergeItem direct)", () => {
  it("merges into main even when repo HEAD is on the feature branch (the bug)", async () => {
    const { repo, branch } = setupRepo("feature");
    expect(fileOnMain(repo)).toBe(false);

    const wq = WorkQueue._createForTesting([itemForRepo(repo, branch)]);
    const mo = new Integrator(wq);
    const res = await mo.mergeItem("hg-1", "direct", { skipSessionLock: true });

    expect(res.merged).toBe(true);
    expect(fileOnMain(repo)).toBe(true);
    expect(git(["rev-parse", "--abbrev-ref", "HEAD"], repo).trim()).toBe("main");
    expect((wq.getItem("hg-1")!.metadata as WorkItemMetadata).mergeStatus).toBe("merged");
  });

  it("normal case (repo already on main) still merges and reports merged", async () => {
    const { repo, branch } = setupRepo("main");
    const wq = WorkQueue._createForTesting([itemForRepo(repo, branch)]);
    const mo = new Integrator(wq);
    const res = await mo.mergeItem("hg-1", "direct", { skipSessionLock: true });
    expect(res.merged).toBe(true);
    expect(fileOnMain(repo)).toBe(true);
  });

  it("does NOT falsely report merged when the base branch cannot be checked out", async () => {
    const { repo, branch } = setupRepo("feature");
    writeFileSync(join(repo, "_canary/greet.ts"), 'console.log("uncommitted divergent change");\n');
    const wq = WorkQueue._createForTesting([itemForRepo(repo, branch)]);
    const mo = new Integrator(wq);
    const res = await mo.mergeItem("hg-1", "direct", { skipSessionLock: true });

    expect(res.merged).toBe(false);
    expect(fileOnMain(repo)).toBe(false);
    expect((wq.getItem("hg-1")!.metadata as WorkItemMetadata).mergeStatus).toBe("conflict");
  });
});

// ============================================================================
// 5. S13 — merge-safety wiring (lib/core/MergeSafety.ts) for both "direct" and "pr" strategies
//
// Goal: a merge-safety VERDICT produced in the shared module must be assertable from
// Integrator's own path, with executorMerge.ts-style loud-fail semantics (a merge whose
// verification fails must never be reported as "merged"). Two different techniques, matched to
// what's actually fakeable per strategy:
//
//  - "direct": the git merge is fully local and instantaneous — there is no way to make a
//    genuinely successful `git merge --no-ff` produce a false ancestor/disk-diff result (that's
//    the whole point of the check). So the MergeSafety verdict itself is overridden on the
//    instance, the SAME idiom this file already uses for checkInteractiveSessionLock overrides
//    (see the approval-gated tests above) — no git is faked, only the judgment on top of a real
//    merge that already happened for real.
//  - "pr": the actual external dependency is the `gh` CLI (unavailable/unauthenticated in a
//    test environment) — so `gh` itself is faked via a throwaway PATH-shadowing script, while
//    every git command (push/fetch/ancestor-check) runs for real against a real bare "origin"
//    repo. This reproduces the exact bug being fixed: gh exits 0 ("success") without anything
//    actually landing on origin/main, and Integrator must still refuse to report "merged".
// ============================================================================

describe("Integrator (S13) — direct-mode merge-safety wiring to MergeSafety", () => {
  it("does NOT report merged when the MergeSafety verdict is not-clean, even though the underlying git merge succeeded for real", async () => {
    const { repo, branch } = setupRepo("main");
    const wq = WorkQueue._createForTesting([itemForRepo(repo, branch)]);
    const mo = new Integrator(wq);

    // Override just the MergeSafety judgment — the real `git merge --no-ff` above it still runs.
    (mo as unknown as { verifyDirectMergeLanded: (...args: unknown[]) => DiskVerifyResult }).verifyDirectMergeLanded =
      () => ({ clean: false, diffOutput: "M some/file.ts | 1 +", isAncestor: true });

    const res = await mo.mergeItem("hg-1", "direct", { skipSessionLock: true });

    expect(res.merged).toBe(false);
    expect(res.reason).toMatch(/did not verify clean/i);
    expect((wq.getItem("hg-1")!.metadata as WorkItemMetadata).mergeStatus).toBe("conflict");
    expect((wq.getItem("hg-1")!.metadata as WorkItemMetadata).conflictReason).toMatch(/not recording 'merged'/i);
  });

  it("still reports merged when the MergeSafety verdict is clean (override seam is not itself the cause of a false negative)", async () => {
    const { repo, branch } = setupRepo("main");
    const wq = WorkQueue._createForTesting([itemForRepo(repo, branch)]);
    const mo = new Integrator(wq);

    (mo as unknown as { verifyDirectMergeLanded: (...args: unknown[]) => DiskVerifyResult }).verifyDirectMergeLanded =
      () => ({ clean: true, diffOutput: "", isAncestor: true });

    const res = await mo.mergeItem("hg-1", "direct", { skipSessionLock: true });

    expect(res.merged).toBe(true);
    expect(fileOnMain(repo)).toBe(true);
    expect((wq.getItem("hg-1")!.metadata as WorkItemMetadata).mergeStatus).toBe("merged");
  });
});

// ----------------------------------------------------------------------------
// "pr" strategy — real git throughout (real bare "origin", real push/fetch/ancestor-check via
// MergeSafety); only the external `gh` CLI itself is faked, via the SAME instance-override idiom
// as verifyDirectMergeLanded above (ghCreatePr/ghAttemptMerge are isolated private methods for
// exactly this reason — `gh` talks to real GitHub and has no hermetic equivalent in a test env).
// ----------------------------------------------------------------------------

/** A real bare repo standing in for "origin" (e.g. GitHub) — real git push/fetch against it. */
function setupPrRepo(): { repo: string; bareOrigin: string; branch: string } {
  const bareOrigin = mkdtempSync(join(tmpdir(), "integrator-pr-origin-"));
  git(["init", "-q", "--bare", "-b", "main"], bareOrigin);

  const repo = mkdtempSync(join(tmpdir(), "integrator-pr-repo-"));
  git(["init", "-q", "-b", "main"], repo);
  git(["config", "user.email", "t@t.local"], repo);
  git(["config", "user.name", "t"], repo);
  writeFileSync(join(repo, "README.md"), "# repo\n");
  git(["add", "-A"], repo);
  git(["commit", "-qm", "init"], repo);
  git(["remote", "add", "origin", bareOrigin], repo);
  git(["push", "-q", "-u", "origin", "main"], repo);

  const branch = "feature/pr-x";
  git(["checkout", "-q", "-b", branch], repo);
  writeFileSync(join(repo, "feature.ts"), "export const x = 1;\n");
  git(["add", "-A"], repo);
  git(["commit", "-qm", "feat: x"], repo);

  return { repo, bareOrigin, branch };
}

function itemForPrRepo(repo: string, branch: string): WorkItem {
  return {
    id: "pr-1",
    title: "pr-mode item",
    description: "",
    status: "completed",
    priority: "normal",
    dependencies: [],
    source: "manual",
    createdAt: new Date().toISOString(),
    verification: verified,
    projectPath: repo,
    metadata: { worktreeBranch: branch },
  };
}

/** Type-only view onto Integrator's private gh-calling seam, for instance overrides in tests. */
type GhOverridable = {
  ghCreatePr: (repoPath: string, title: string, branch: string, verifiedCount: number) => string;
  ghAttemptMerge: (repoPath: string, prUrl: string) => void;
};

describe("Integrator (S13) — pr-mode merge-safety wiring to MergeSafety (real git, fake gh)", () => {
  it("does NOT report merged when gh claims success but nothing actually landed on origin (the bug this closes)", async () => {
    const { repo, bareOrigin, branch } = setupPrRepo();
    const wq = WorkQueue._createForTesting([itemForPrRepo(repo, branch)]);
    const mo = new Integrator(wq);
    const overridable = mo as unknown as GhOverridable;
    // gh "succeeds" (real gh's exact failure mode this closes) but never touches origin at all.
    overridable.ghCreatePr = () => "https://example.invalid/fake/pull/1";
    overridable.ghAttemptMerge = () => {
      /* no-op: "merge succeeded" per gh, nothing pushed */
    };

    try {
      const res = await mo.mergeItem("pr-1", "pr", { skipSessionLock: true });

      expect(res.merged).toBe(false);
      expect(res.reason).toMatch(/not verified as landed/i);
      expect((wq.getItem("pr-1")!.metadata as WorkItemMetadata).mergeStatus).toBe("conflict");
      // origin/main genuinely never advanced — the false-success bug this closes.
      expect(git(["rev-parse", "main"], bareOrigin).trim()).toBe(git(["rev-parse", "main"], repo).trim());
    } finally {
      try {
        rmSync(repo, { recursive: true, force: true });
      } catch {}
      try {
        rmSync(bareOrigin, { recursive: true, force: true });
      } catch {}
    }
  });

  it("reports merged when the PR genuinely lands on origin/main", async () => {
    const { repo, bareOrigin, branch } = setupPrRepo();
    const wq = WorkQueue._createForTesting([itemForPrRepo(repo, branch)]);
    const mo = new Integrator(wq);
    const overridable = mo as unknown as GhOverridable;
    overridable.ghCreatePr = () => "https://example.invalid/fake/pull/1";
    // Simulate "GitHub actually merged it" with a real push of the real branch onto origin/main.
    overridable.ghAttemptMerge = (repoPath: string) => {
      git(["push", "origin", `${branch}:main`], repoPath);
    };

    try {
      const res = await mo.mergeItem("pr-1", "pr", { skipSessionLock: true });

      expect(res.merged).toBe(true);
      expect((wq.getItem("pr-1")!.metadata as WorkItemMetadata).mergeStatus).toBe("merged");
      const branchSha = git(["rev-parse", branch], repo).trim();
      expect(git(["rev-parse", "main"], bareOrigin).trim()).toBe(branchSha);
    } finally {
      try {
        rmSync(repo, { recursive: true, force: true });
      } catch {}
      try {
        rmSync(bareOrigin, { recursive: true, force: true });
      } catch {}
    }
  });
});
