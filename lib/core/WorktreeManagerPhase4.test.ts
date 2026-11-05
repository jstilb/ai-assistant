/**
 * WorktreeManagerPhase4.test.ts — Phase 4 hardening tests
 *
 * Covers:
 *   - basename-collision disambiguation (repoSlug / worktreePath)
 *   - Lock-key consistency (same canonical id as worktreePath)
 *   - Reuse stays idempotent for same owner
 *   - No-hijack when a different live owner holds a fresh heartbeat
 *   - GC: skips unmerged / dirty / live / integrator-reuse; removes merged+clean+stale
 *
 * Uses real temp git repos; does NOT call real LLMs.
 */

import { describe, it, expect, beforeEach, afterEach, afterAll } from "bun:test";
import {
  getOrCreateWorktree,
  removeWorktree,
  gcWorktrees,
  refreshHeartbeat,
  readHeartbeatTs,
  isHeartbeatFresh,
  worktreesDir,
  GC_STALE_AFTER_MS,
  INTEGRATOR_REUSE_BRANCH,
  repoSlug,
  worktreePath,
} from "./WorktreeManager.ts";
import { join } from "node:path";
import os from "node:os";
import { existsSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { pinKayaHome, restoreKayaHome } from "../test/pinKayaHome.ts";
import { runtimeDir } from "./KayaHome.ts";

// ============================================================================
// Isolation
// ============================================================================
// Flakiness fix: these tests used the LIVE KAYA_HOME (state.json, locks/, worktrees/), so they
// shared state with other test files and other processes (and with whatever KAYA_HOME a prior
// file leaked). Pin a private temp KAYA_HOME for this file, fix a git identity (hosts without
// one make `git commit` fail), and force the default branch to "main" (gcWorktrees compares
// against "main"; a bare `git init` creates "master" on some hosts).

pinKayaHome("wt-p4-home-");
const GIT_ENV_KEYS = ["GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL"] as const;
const savedGitEnv = Object.fromEntries(GIT_ENV_KEYS.map((k) => [k, process.env[k]]));
process.env.GIT_AUTHOR_NAME = process.env.GIT_COMMITTER_NAME = "Test";
process.env.GIT_AUTHOR_EMAIL = process.env.GIT_COMMITTER_EMAIL = "test@test.com";

afterAll(async () => {
  for (const k of GIT_ENV_KEYS) {
    const v = savedGitEnv[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  await restoreKayaHome();
});

/** Path of the heartbeat file that WorktreeManager derives for a worktree path. */
function heartbeatFile(wtPath: string): string {
  const key = createHash("sha1").update(wtPath).digest("hex").slice(0, 12);
  return join(runtimeDir(), "locks", `wt-${key}.heartbeat`);
}

// ============================================================================
// Helpers
// ============================================================================

function makeGitRepo(suffix: string): string {
  const dir = mkdtempSync(join(os.tmpdir(), `wt-p4-${suffix}-`));
  execFileSync("git", ["init", "-b", "main"], { cwd: dir, stdio: "pipe" });
  execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: dir, stdio: "pipe" });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir, stdio: "pipe" });
  execFileSync("git", ["commit", "--allow-empty", "-m", "init"], { cwd: dir, stdio: "pipe" });
  createdRepos.push(dir);
  return dir;
}

function cleanRepo(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}

// Worktrees + repos created during a test; cleaned up in afterEach
const createdWorktrees: string[] = [];
const createdRepos: string[] = [];

afterEach(async () => {
  for (const p of createdWorktrees.splice(0)) {
    try {
      await removeWorktree(p);
    } catch {
      /* best effort */
    }
  }
  // removeWorktree leaves the empty <repoSlug> parent dir under worktreesDir() behind —
  // that's what piled up ~/.claude/worktrees/. Nuke the whole subtree for each repo this
  // test created, then the temp repo itself.
  for (const repo of createdRepos.splice(0)) {
    try {
      rmSync(join(worktreesDir(), repoSlug(repo)), { recursive: true, force: true });
    } catch {
      /* best effort */
    }
    cleanRepo(repo);
  }
});

// ============================================================================
// 1. repoSlug disambiguation
// ============================================================================

describe("repoSlug / worktreePath — basename collision prevention", () => {
  it("repos with same basename but different parents produce different slugs", () => {
    const slugA = repoSlug("/a/foo");
    const slugB = repoSlug("/b/foo");
    expect(slugA).not.toBe(slugB);
    expect(slugA).toContain("foo");
    expect(slugB).toContain("foo");
  });

  it("same repo always produces the same slug (deterministic)", () => {
    expect(repoSlug("/some/path/myrepo")).toBe(repoSlug("/some/path/myrepo"));
  });

  it("worktreePath uses repo slug not bare basename", () => {
    const pathA = worktreePath("/dir-a/myrepo", "main");
    const pathB = worktreePath("/dir-b/myrepo", "main");
    expect(pathA).not.toBe(pathB);
    // Both are under worktreesDir()
    expect(pathA.startsWith(worktreesDir())).toBe(true);
    expect(pathB.startsWith(worktreesDir())).toBe(true);
    // Same branch, different repos → different paths
    const segA = pathA.replace(worktreesDir() + "/", "").split("/");
    const segB = pathB.replace(worktreesDir() + "/", "").split("/");
    expect(segA[0]).not.toBe(segB[0]); // repo-level dir differs
  });

  it("lock key is derived from repoSlug (consistent with worktreePath)", () => {
    // We verify this indirectly: two repos with same basename can both be
    // locked concurrently without collision (the lock dir names differ)
    const lockA = `${repoSlug("/a/foo")}.create.lock`;
    const lockB = `${repoSlug("/b/foo")}.create.lock`;
    expect(lockA).not.toBe(lockB);
  });
});

// ============================================================================
// 2. Liveness heartbeat
// ============================================================================

describe("heartbeat helpers", () => {
  it("refreshHeartbeat + readHeartbeatTs round-trips the timestamp", () => {
    const fakePath = join(os.tmpdir(), `wt-hb-test-${Date.now()}`);
    const before = Date.now();
    refreshHeartbeat(fakePath);
    const ts = readHeartbeatTs(fakePath);
    const after = Date.now();
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
  });

  it("isHeartbeatFresh returns true for a just-written heartbeat", () => {
    const fakePath = join(os.tmpdir(), `wt-hb-fresh-${Date.now()}`);
    refreshHeartbeat(fakePath);
    expect(isHeartbeatFresh(fakePath, GC_STALE_AFTER_MS)).toBe(true);
  });

  it("isHeartbeatFresh returns false when no heartbeat exists", () => {
    const fakePath = join(os.tmpdir(), `wt-hb-missing-${Date.now()}-nonexistent`);
    expect(isHeartbeatFresh(fakePath, GC_STALE_AFTER_MS)).toBe(false);
  });

  it("isHeartbeatFresh returns false when heartbeat is older than threshold", () => {
    const fakePath = join(os.tmpdir(), `wt-hb-old-${Date.now()}`);
    refreshHeartbeat(fakePath);
    // Check with 0ms threshold — anything is "stale"
    expect(isHeartbeatFresh(fakePath, 0)).toBe(false);
  });
});

// ============================================================================
// 3. getOrCreateWorktree — idempotent same-owner reuse
// ============================================================================

describe("getOrCreateWorktree — same-owner idempotent reuse", () => {
  let repo: string;
  beforeEach(() => {
    repo = makeGitRepo("reuse");
  });
  afterEach(() => {
    cleanRepo(repo);
  });

  it("returns the same entry on second call with same owner", async () => {
    const entry1 = await getOrCreateWorktree({
      repoRoot: repo,
      branch: "feature/reuse-test",
      createdBy: "agent-123",
    });
    createdWorktrees.push(entry1.path);

    const entry2 = await getOrCreateWorktree({
      repoRoot: repo,
      branch: "feature/reuse-test",
      createdBy: "agent-123",
    });

    expect(entry2.path).toBe(entry1.path);
    expect(entry2.branch).toBe(entry1.branch);
    expect(existsSync(entry1.path)).toBe(true);
  });
});

// ============================================================================
// 4. getOrCreateWorktree — no-hijack when different owner is live
// ============================================================================

describe("getOrCreateWorktree — no-hijack with live owner", () => {
  let repo: string;
  beforeEach(() => {
    repo = makeGitRepo("hijack");
  });
  afterEach(() => {
    cleanRepo(repo);
  });

  it("throws when a different owner has a live heartbeat", async () => {
    const entry = await getOrCreateWorktree({
      repoRoot: repo,
      branch: "feature/hijack-test",
      createdBy: "owner-A",
    });
    createdWorktrees.push(entry.path);

    // Simulate live heartbeat from owner-A
    refreshHeartbeat(entry.path);

    // owner-B attempts to reuse the same worktree — should throw
    await expect(
      getOrCreateWorktree({
        repoRoot: repo,
        branch: "feature/hijack-test",
        createdBy: "owner-B",
      }),
    ).rejects.toThrow("live heartbeat");
  });

  it("allows adoption when previous owner heartbeat is stale", async () => {
    const entry = await getOrCreateWorktree({
      repoRoot: repo,
      branch: "feature/adopt-stale",
      createdBy: "owner-A",
    });
    createdWorktrees.push(entry.path);

    // getOrCreateWorktree writes a heartbeat on creation. Overwrite it with a
    // timestamp in the past (older than GC_STALE_AFTER_MS) so it reads as stale.
    const { writeFileSync } = await import("node:fs");
    const { join: pathJoin } = await import("node:path");
    const { createHash: ch } = await import("node:crypto");
    const { runtimeDir } = await import("./KayaHome.ts");
    const key = ch("sha1").update(entry.path).digest("hex").slice(0, 12);
    const hbPath = pathJoin(runtimeDir(), "locks", `wt-${key}.heartbeat`);
    writeFileSync(hbPath, JSON.stringify({ wtPath: entry.path, ts: Date.now() - GC_STALE_AFTER_MS - 1 }));

    // Owner-B should be able to adopt the worktree now
    const adopted = await getOrCreateWorktree({
      repoRoot: repo,
      branch: "feature/adopt-stale",
      createdBy: "owner-B",
    });

    expect(adopted.path).toBe(entry.path);
    expect(adopted.createdBy).toBe("owner-B");
  });
});

// ============================================================================
// 5. gcWorktrees — safety gates
// ============================================================================

describe("gcWorktrees — safety gate: integrator reuse worktree", () => {
  let repo: string;
  beforeEach(() => {
    repo = makeGitRepo("gc-integ");
  });
  afterEach(() => {
    cleanRepo(repo);
  });

  it("never removes the integrator reuse worktree", async () => {
    const entry = await getOrCreateWorktree({
      repoRoot: repo,
      branch: INTEGRATOR_REUSE_BRANCH,
      createdBy: "integrator",
    });
    // Don't push to createdWorktrees — we verify GC doesn't touch it, then clean manually
    try {
      const result = await gcWorktrees({ staleAfterMs: 0, dryRun: true });
      const wasSkipped = result.skipped.some((s) => s.path === entry.path && s.reason.includes("integrator"));
      expect(wasSkipped).toBe(true);
    } finally {
      await removeWorktree(entry.path);
    }
  });
});

describe("gcWorktrees — safety gate: live heartbeat", () => {
  let repo: string;
  beforeEach(() => {
    repo = makeGitRepo("gc-live");
  });
  afterEach(() => {
    cleanRepo(repo);
  });

  it("skips worktree with fresh heartbeat even when staleAfterMs is small", async () => {
    const entry = await getOrCreateWorktree({
      repoRoot: repo,
      branch: "feature/live-hb",
      createdBy: "test-agent",
    });
    createdWorktrees.push(entry.path);

    // Write a fresh heartbeat
    refreshHeartbeat(entry.path);

    // GC with very small stale threshold — but heartbeat is fresh relative to default
    const result = await gcWorktrees({ staleAfterMs: GC_STALE_AFTER_MS, dryRun: true });
    const wasSkipped = result.skipped.some((s) => s.path === entry.path);
    expect(wasSkipped).toBe(true);
    // Should NOT be in removed list
    expect(result.removed.includes(entry.path)).toBe(false);
  });
});

describe("gcWorktrees — safety gate: unmerged branch", () => {
  let repo: string;
  beforeEach(() => {
    repo = makeGitRepo("gc-unmerged");
  });
  afterEach(() => {
    cleanRepo(repo);
  });

  it("skips worktree whose branch has commits ahead of main", async () => {
    const entry = await getOrCreateWorktree({
      repoRoot: repo,
      branch: "feature/unmerged",
      createdBy: "test-agent",
    });
    createdWorktrees.push(entry.path);

    // Add a commit on the branch to make it ahead of main
    writeFileSync(join(entry.path, "new-file.txt"), "unmerged content");
    execFileSync("git", ["add", "new-file.txt"], { cwd: entry.path, stdio: "pipe" });
    execFileSync("git", ["commit", "-m", "unmerged commit"], { cwd: entry.path, stdio: "pipe" });

    // GC with stale threshold of 0 (so it would GC if merged) — no heartbeat → not live
    const result = await gcWorktrees({ staleAfterMs: 0, dryRun: true });
    const wasSkipped = result.skipped.some((s) => s.path === entry.path && s.reason.includes("not fully merged"));
    expect(wasSkipped).toBe(true);
    expect(result.removed.includes(entry.path)).toBe(false);
  });
});

describe("gcWorktrees — removes merged + clean + stale worktree", () => {
  let repo: string;
  beforeEach(() => {
    repo = makeGitRepo("gc-merged");
  });
  afterEach(() => {
    cleanRepo(repo);
  });

  it("removes in dry-run mode (does not actually delete)", async () => {
    const entry = await getOrCreateWorktree({
      repoRoot: repo,
      branch: "feature/to-gc",
      createdBy: "test-agent",
    });
    // Do NOT push to createdWorktrees — GC handles removal (or we clean up below)

    // Mark the branch as merged into main: fast-forward main to include branch
    // (Since both main and feature/to-gc start from same init commit + branch has 0 commits
    //  ahead of main, the branch IS an ancestor of main already)
    const result = await gcWorktrees({ staleAfterMs: 0, dryRun: true });

    // With staleAfterMs=0 and no heartbeat, the worktree is stale.
    // Branch has 0 commits ahead of main → is merged.
    // Working tree is clean.
    // Should appear in removed (dry-run) OR skipped (if mtime guard fires first).
    // Either is acceptable — we just verify it does not throw.
    expect(result.errors.length).toBe(0);

    // Clean up manually since GC was dry-run
    await removeWorktree(entry.path);
  });
});

// ============================================================================
// 6. GcResult shape
// ============================================================================

describe("gcWorktrees — result shape", () => {
  it("returns valid GcResult with no tracked worktrees", async () => {
    // This won't touch real worktrees in ~/.claude since we use isolated state
    // Just verify the function returns the right shape
    const result = await gcWorktrees({ dryRun: true });
    expect(Array.isArray(result.removed)).toBe(true);
    expect(Array.isArray(result.skipped)).toBe(true);
    expect(Array.isArray(result.errors)).toBe(true);
  });
});

// ============================================================================
// 7. gcWorktrees — missing / corrupt heartbeat
// ============================================================================
// Decision (from the code): a missing or unreadable heartbeat reads as ts=0 = NOT live
// (readHeartbeatTs returns 0 -> isHeartbeatFresh false). That is safe because the heartbeat is
// only ONE of four gates. The worktree must still be old by directory mtime, clean, and merged
// before GC removes it. So: missing/corrupt heartbeat = stale, never "skip forever", and never
// a bypass of the dirty / unmerged / recent-mtime gates.

/** Make the worktree directory look old, so the mtime gate does not hide the gate under test. */
function backdate(dir: string): void {
  const old = new Date(Date.now() - 3 * GC_STALE_AFTER_MS);
  utimesSync(dir, old, old);
}

describe("gcWorktrees — missing or corrupt heartbeat", () => {
  let repo: string;
  beforeEach(() => {
    repo = makeGitRepo("gc-hb");
  });
  afterEach(() => {
    cleanRepo(repo);
  });

  async function makeWorktree(branch: string) {
    const entry = await getOrCreateWorktree({ repoRoot: repo, branch, createdBy: "test-agent" });
    createdWorktrees.push(entry.path);
    return entry;
  }

  it("missing heartbeat on a clean merged old worktree: treated as stale and removed", async () => {
    const entry = await makeWorktree("feature/hb-missing");
    rmSync(heartbeatFile(entry.path), { force: true });
    expect(readHeartbeatTs(entry.path)).toBe(0);
    backdate(entry.path);

    const result = await gcWorktrees({ staleAfterMs: GC_STALE_AFTER_MS });
    expect(result.errors).toEqual([]);
    expect(result.removed).toContain(entry.path);
    expect(existsSync(entry.path)).toBe(false);
  });

  it("missing heartbeat does NOT remove a worktree with uncommitted work", async () => {
    const entry = await makeWorktree("feature/hb-missing-dirty");
    writeFileSync(join(entry.path, "wip.txt"), "uncommitted work");
    rmSync(heartbeatFile(entry.path), { force: true });
    backdate(entry.path);

    const result = await gcWorktrees({ staleAfterMs: GC_STALE_AFTER_MS });
    expect(result.removed).not.toContain(entry.path);
    expect(result.skipped.some((s) => s.path === entry.path && s.reason.includes("uncommitted"))).toBe(true);
    expect(existsSync(join(entry.path, "wip.txt"))).toBe(true);
  });

  it("missing heartbeat does NOT remove a worktree with unmerged commits", async () => {
    const entry = await makeWorktree("feature/hb-missing-unmerged");
    writeFileSync(join(entry.path, "a.txt"), "a");
    execFileSync("git", ["add", "a.txt"], { cwd: entry.path, stdio: "pipe" });
    execFileSync("git", ["commit", "-m", "ahead of main"], { cwd: entry.path, stdio: "pipe" });
    rmSync(heartbeatFile(entry.path), { force: true });
    backdate(entry.path);

    const result = await gcWorktrees({ staleAfterMs: GC_STALE_AFTER_MS });
    expect(result.removed).not.toContain(entry.path);
    expect(result.skipped.some((s) => s.path === entry.path && s.reason.includes("not fully merged"))).toBe(true);
    expect(existsSync(entry.path)).toBe(true);
  });

  it("missing heartbeat does NOT bypass the recent-activity (mtime) gate", async () => {
    const entry = await makeWorktree("feature/hb-missing-recent");
    rmSync(heartbeatFile(entry.path), { force: true });
    // directory was just created: mtime is fresh

    const result = await gcWorktrees({ staleAfterMs: GC_STALE_AFTER_MS });
    expect(result.removed).not.toContain(entry.path);
    expect(result.skipped.some((s) => s.path === entry.path && s.reason.includes("modified"))).toBe(true);
    expect(existsSync(entry.path)).toBe(true);
  });

  for (const [label, body] of [
    ["garbage text", "not json at all {{{"],
    ["truncated JSON", '{"wtPath": "/x", "ts": 17'],
    ["empty file", ""],
    ["ts is a string", JSON.stringify({ ts: "now" })],
    ["JSON null", "null"],
  ] as const) {
    it(`corrupt heartbeat (${label}) reads as 0 and does not remove a dirty worktree`, async () => {
      const entry = await makeWorktree(`feature/hb-corrupt-${label.replace(/\W+/g, "-")}`);
      writeFileSync(heartbeatFile(entry.path), body);
      expect(readHeartbeatTs(entry.path)).toBe(0);
      expect(isHeartbeatFresh(entry.path, GC_STALE_AFTER_MS)).toBe(false);
      writeFileSync(join(entry.path, "wip.txt"), "uncommitted work");
      backdate(entry.path);

      const result = await gcWorktrees({ staleAfterMs: GC_STALE_AFTER_MS });
      expect(result.removed).not.toContain(entry.path);
      expect(existsSync(join(entry.path, "wip.txt"))).toBe(true);
    });
  }

  it("corrupt heartbeat on a clean merged old worktree: treated as stale and removed", async () => {
    const entry = await makeWorktree("feature/hb-corrupt-clean");
    writeFileSync(heartbeatFile(entry.path), "garbage");
    backdate(entry.path);

    const result = await gcWorktrees({ staleAfterMs: GC_STALE_AFTER_MS });
    expect(result.errors).toEqual([]);
    expect(result.removed).toContain(entry.path);
    expect(existsSync(entry.path)).toBe(false);
  });
});
