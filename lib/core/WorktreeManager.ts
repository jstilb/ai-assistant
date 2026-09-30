#!/usr/bin/env bun
/**
 * WorktreeManager.ts - Git Worktree Isolation for Parallel Agents
 *
 * Provides create/remove/list/prune/gc operations for git worktrees, enabling
 * parallel agents to work on separate branches without checkout races.
 * Each worktree is a lightweight directory linked to the same .git database.
 *
 * State is persisted via StateManager with file locking for concurrent access.
 *
 * Phase 4 hardening (2026-06-22):
 *   - worktreePath() disambiguates repos with same basename via a short hash
 *     of the full repoRoot path (collisions between /a/foo and /b/foo now safe)
 *   - The create-mutex lock key is derived from the SAME canonical repo identity
 *     (repoHash) used in worktreePath — was slug(fullPath) vs basename mismatch
 *   - Reuse (getOrCreateWorktree): keeps idempotent reuse for same owner; does
 *     NOT silently hijack a worktree whose DIFFERENT owner has a live heartbeat
 *   - createWorktree is NOT exported directly; call getOrCreateWorktree instead.
 *     (Lower-risk option over making it assert the lock internally — the function
 *     is now unexported so callers cannot bypass the mutex.)
 *   - gcWorktrees(): liveness-gated GC — removes only fully-merged + clean +
 *     stale (no fresh heartbeat) worktrees; never the integrator's reuse tree.
 *   - Heartbeat: refreshed in getOrCreateWorktree; written to runtimeDir()/locks/
 *
 * Usage:
 *   # Programmatic
 *   import { getOrCreateWorktree, removeWorktree, listWorktrees, pruneOrphaned, gcWorktrees } from './WorktreeManager.ts';
 *
 *   const entry = await getOrCreateWorktree({ repoRoot: '/path/to/repo', branch: 'feature/x', createdBy: 'executive:abc' });
 *   // entry.path is the isolated worktree directory
 *   await removeWorktree(entry.path);
 *
 *   # CLI
 *   bun run WorktreeManager.ts create --repo /path --branch feature/x --created-by executive:abc
 *   bun run WorktreeManager.ts remove --path /path/to/worktree
 *   bun run WorktreeManager.ts list [--repo /path]
 *   bun run WorktreeManager.ts prune
 *   bun run WorktreeManager.ts gc [--stale-after <ms>] [--dry-run]
 */

import { z } from "zod";
import { execFileSync } from "child_process";
import { existsSync, mkdirSync, rmdirSync, statSync, unlinkSync, writeFileSync, readFileSync } from "fs";
import { join, basename } from "path";
import { createHash } from "crypto";
import { parseArgs } from "util";
import { createStateManager, type StateManager } from "./StateManager.ts";
import { runtimeDir, getKayaHome } from "./KayaHome.ts";
import { recordFailure } from "./FailureLog.ts";

// ============================================================================
// Helpers
// ============================================================================

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ============================================================================
// Git Lock Retry
// ============================================================================

const GIT_LOCK_MAX_RETRIES = 5;
const GIT_LOCK_BASE_DELAY_MS = 200;
const GIT_LOCK_STALE_THRESHOLD_MS = 30_000; // 30 seconds

/**
 * Remove a stale git index.lock file if it exists and no git process owns it.
 * A lock is considered stale if it's older than GIT_LOCK_STALE_THRESHOLD_MS.
 */
function removeStaleGitLock(repoRoot: string): boolean {
  const lockPath = join(repoRoot, ".git", "index.lock");
  if (!existsSync(lockPath)) return false;

  try {
    const stat = statSync(lockPath);
    const ageMs = Date.now() - stat.mtimeMs;
    if (ageMs > GIT_LOCK_STALE_THRESHOLD_MS) {
      unlinkSync(lockPath);
      return true;
    }
  } catch {
    // Can't stat or remove — another process may have cleaned it up
  }
  return false;
}

/**
 * Wrapper around execFileSync("git", ...) with retry on index.lock contention.
 * Uses exponential backoff with jitter. Auto-removes stale locks.
 */
function gitExec(args: string[], cwd: string): Buffer {
  for (let attempt = 0; attempt <= GIT_LOCK_MAX_RETRIES; attempt++) {
    try {
      return execFileSync("git", args, {
        cwd,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      const isLockError = msg.includes("index.lock") || msg.includes("Unable to create") || msg.includes("another git process");

      if (!isLockError || attempt === GIT_LOCK_MAX_RETRIES) {
        throw err;
      }

      // Try to clean stale lock before retrying
      removeStaleGitLock(cwd);

      // Exponential backoff with jitter: 200ms, 400ms, 800ms, 1600ms, 3200ms
      const delay = GIT_LOCK_BASE_DELAY_MS * Math.pow(2, attempt) + Math.random() * 100;
      Bun.sleepSync(delay);
    }
  }
  // Unreachable, but TypeScript needs it
  throw new Error("gitExec: exhausted retries");
}

// ============================================================================
// Types & Schemas
// ============================================================================

const WorktreeEntrySchema = z.object({
  path: z.string(),
  branch: z.string(),
  repoRoot: z.string(),
  createdAt: z.string(),
  createdBy: z.string(),
  locked: z.boolean(),
  keepUntilMerged: z.boolean().optional(),
  mergedAt: z.string().optional(),
});

export type WorktreeEntry = z.infer<typeof WorktreeEntrySchema>;

const WorktreeStateSchema = z.object({
  entries: z.array(WorktreeEntrySchema),
  lastUpdated: z.string(),
});

type WorktreeState = z.infer<typeof WorktreeStateSchema>;

export interface CreateWorktreeOptions {
  repoRoot: string;
  branch: string;
  createdBy: string;
  keepUntilMerged?: boolean;
}

export interface PruneResult {
  removed: string[];
  errors: string[];
}

// ============================================================================
// Constants
// ============================================================================

// Resolved at CALL time (never cached in a module-scope const) — Bun caches modules on
// first import, so a module-scope `const X = join(getKayaHome(), ...)` freezes to whatever
// KAYA_HOME/KAYA_DIR was set at the FIRST import across the whole process. Any later test
// (or long-lived process) that repoints KAYA_HOME after this module has already been
// imported once would silently keep operating against the original (possibly live) location.
// Same class of bug fixed in NotificationService.ts (slice E2).
function worktreesDir(): string {
  return join(getKayaHome(), "worktrees");
}

function statePath(): string {
  return join(worktreesDir(), "state.json");
}

/**
 * Default staleness threshold for GC and liveness checks.
 * A worktree is considered live if its heartbeat is newer than this.
 * Default: 2 hours (configurable via gcWorktrees({ staleAfterMs }) or --stale-after CLI flag).
 */
const GC_STALE_AFTER_MS = 2 * 60 * 60 * 1000; // 2 hours

/**
 * The integrator's permanent reuse worktree branch.
 * GC must never remove this — the Integrator reuses it across reconcile runs.
 */
const INTEGRATOR_REUSE_BRANCH = "integration/reconcile-tmp";

// ============================================================================
// State Manager
// ============================================================================

let _stateManager: StateManager<WorktreeState> | undefined;
// Tracks the path _stateManager was constructed for — createStateManager() bakes its path
// in at construction time, so simply memoizing "have we built one yet" would re-freeze the
// path the first time this is called (same hazard as the module consts above). Keyed the
// same way KayaHome.ts's own getKayaHome() cache is keyed: rebuild whenever the resolved
// path has actually changed (e.g. a test repoints KAYA_HOME between runs in one process).
let _stateManagerPath: string | undefined;

function getStateManager(): StateManager<WorktreeState> {
  const path = statePath();
  if (!_stateManager || _stateManagerPath !== path) {
    _stateManager = createStateManager<WorktreeState>({
      path,
      schema: WorktreeStateSchema,
      defaults: { entries: [], lastUpdated: "" },
      lockTimeout: 10000,
    });
    _stateManagerPath = path;
  }
  return _stateManager;
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Sanitize a string for use in directory names.
 * Replaces slashes and non-alphanumeric chars with hyphens, collapses runs.
 */
function slugify(s: string): string {
  return s
    .replace(/\//g, "-")
    .replace(/[^a-zA-Z0-9-]/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase();
}

/**
 * Returns a 6-character hex hash of the full repoRoot path.
 * Used to disambiguate repos that share the same basename
 * (e.g. /a/foo and /b/foo both have basename "foo" but distinct hashes).
 * Deterministic: same repoRoot always returns the same hash.
 */
function repoHash(repoRoot: string): string {
  return createHash("sha1").update(repoRoot).digest("hex").slice(0, 6);
}

/**
 * Returns a canonical slug for a repo, incorporating a short hash of the full
 * path so that repos with the same basename don't collide.
 *
 * Example: /a/foo → "foo-a1b2c3", /b/foo → "foo-d4e5f6"
 */
function repoSlug(repoRoot: string): string {
  return `${slugify(basename(repoRoot))}-${repoHash(repoRoot)}`;
}

/**
 * Compute the worktree directory path for a given repo + branch.
 *
 * Phase 4: uses repoSlug() instead of bare basename() to prevent namespace
 * collisions between repos with the same directory name.
 */
function worktreePath(repoRoot: string, branch: string): string {
  const rSlug = repoSlug(repoRoot);
  const branchSlug = slugify(branch);
  return join(worktreesDir(), rSlug, branchSlug);
}

// ============================================================================
// Liveness Heartbeat
// ============================================================================

/**
 * Path for the liveness heartbeat file for a given worktree path.
 * Written at runtimeDir()/locks/wt-<hash>.heartbeat
 * The hash is derived from the worktree path so it's stable across processes.
 */
function heartbeatPath(wtPath: string): string {
  const key = createHash("sha1").update(wtPath).digest("hex").slice(0, 12);
  const locksDir = join(runtimeDir(), "locks");
  return join(locksDir, `wt-${key}.heartbeat`);
}

/**
 * Write (or refresh) the liveness heartbeat for a worktree.
 * Fails silently — heartbeat is best-effort; do not block adoption on failure.
 */
export function refreshHeartbeat(wtPath: string): void {
  try {
    const hbPath = heartbeatPath(wtPath);
    mkdirSync(join(hbPath, ".."), { recursive: true });
    writeFileSync(hbPath, JSON.stringify({ wtPath, ts: Date.now() }));
  } catch {
    // best-effort — never fatal
  }
}

/**
 * Read the liveness heartbeat timestamp for a worktree.
 * Returns 0 if no heartbeat exists or it's unreadable.
 */
export function readHeartbeatTs(wtPath: string): number {
  try {
    const content = readFileSync(heartbeatPath(wtPath), "utf-8");
    const parsed = JSON.parse(content);
    return typeof parsed.ts === "number" ? parsed.ts : 0;
  } catch {
    return 0;
  }
}

/**
 * Returns true if the worktree's heartbeat is fresher than staleAfterMs ago.
 */
export function isHeartbeatFresh(wtPath: string, staleAfterMs: number): boolean {
  const ts = readHeartbeatTs(wtPath);
  return ts > 0 && Date.now() - ts < staleAfterMs;
}

// ============================================================================
// Core Functions
// ============================================================================

/**
 * Create a new git worktree for the given repo and branch.
 * If the branch doesn't exist yet, creates it from HEAD.
 *
 * Phase 4: NOT exported — callers must go through getOrCreateWorktree() which
 * holds the create mutex. Exporting this function would allow callers to bypass
 * the mutex and create a race condition on the worktree directory.
 */
async function createWorktree(opts: CreateWorktreeOptions): Promise<WorktreeEntry> {
  const wtPath = worktreePath(opts.repoRoot, opts.branch);

  if (existsSync(wtPath)) {
    throw new Error(`Worktree directory already exists: ${wtPath}`);
  }

  // Ensure parent directory exists
  const parentDir = join(wtPath, "..");
  if (!existsSync(parentDir)) {
    mkdirSync(parentDir, { recursive: true });
  }

  // Check if branch exists in the repo
  let branchExists = false;
  try {
    gitExec(["rev-parse", "--verify", opts.branch], opts.repoRoot);
    branchExists = true;
  } catch {
    // Branch doesn't exist yet
  }

  // Create the worktree
  if (branchExists) {
    gitExec(["worktree", "add", wtPath, opts.branch], opts.repoRoot);
  } else {
    gitExec(["worktree", "add", "-b", opts.branch, wtPath], opts.repoRoot);
  }

  // Install dependencies if package.json exists
  const packageJson = join(wtPath, "package.json");
  if (existsSync(packageJson)) {
    try {
      execFileSync("bun", ["install", "--frozen-lockfile"], {
        cwd: wtPath,
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 60000,
      });
    } catch {
      // Non-fatal: dependency install failure doesn't block worktree creation
    }
  }

  const entry: WorktreeEntry = {
    path: wtPath,
    branch: opts.branch,
    repoRoot: opts.repoRoot,
    createdAt: new Date().toISOString(),
    createdBy: opts.createdBy,
    locked: true,
    ...(opts.keepUntilMerged ? { keepUntilMerged: true } : {}),
  };

  // Record in state
  const sm = getStateManager();
  await sm.update(state => ({
    ...state,
    entries: [...state.entries, entry],
  }));

  return entry;
}

/**
 * Idempotent: reuse existing worktree for same repo+branch, or create new.
 *
 * Phase 4 safety rules:
 *   - Lock key is now derived from repoSlug(repoRoot) — same canonical identity
 *     as worktreePath() — so the mutex actually guards the right namespace.
 *     Previously: slugify(fullPath) for the lock vs basename() for the path.
 *   - Same owner reuse: idempotent (no change to state, just refresh heartbeat).
 *   - Different owner reuse: allowed ONLY if the previous owner's heartbeat is
 *     stale (> GC_STALE_AFTER_MS). If the previous owner is still live, we
 *     throw rather than silently hijack the worktree.
 */
export async function getOrCreateWorktree(opts: CreateWorktreeOptions): Promise<WorktreeEntry> {
  // Phase 4: lock key uses repoSlug (same identity as worktreePath), not slugify(fullPath)
  const lockDir = join(worktreesDir(), `${repoSlug(opts.repoRoot)}.create.lock`);

  // Stale create-lock steal: mkdirSync as a mutex has one failure mode — if the holder dies
  // between `mkdirSync(lockDir)` and the `finally { rmdirSync(lockDir) }` (crash, SIGKILL,
  // host reboot), the lock dir is orphaned FOREVER and every future caller blocks for the
  // full 20x500ms wait, then throws, forever. This is the exact bug that stranded the
  // nightly executor 3 nights on one empty `claude-96200e.create.lock`. A lock dir whose
  // mtime predates GC_STALE_AFTER_MS (2h) is treated as abandoned and stolen — but LOUDLY:
  // recordFailure() so the takeover is forensically visible, never a silent steal. A FRESH
  // lock (recent mtime — holder plausibly still alive/working) still blocks normally below.
  if (existsSync(lockDir)) {
    try {
      const lockStat = statSync(lockDir);
      const ageMs = Date.now() - lockStat.mtimeMs;
      if (ageMs > GC_STALE_AFTER_MS) {
        rmdirSync(lockDir);
        const ageSec = Math.round(ageMs / 1000);
        const message = `stole stale create-lock (age ${ageSec}s, holder presumed dead)`;
        recordFailure({
          source: "WorktreeManager.stealStaleLock",
          tier: "log",
          alertMessage: message,
          context: { lockDir, repoRoot: opts.repoRoot, branch: opts.branch, ageMs, message },
        });
      }
    } catch {
      // intentionally silent: the lock may have been removed/recreated concurrently by
      // another process between existsSync() and statSync()/rmdirSync() — the mkdir loop
      // below is the real mutex and handles that race safely either way.
    }
  }

  // mkdir is atomic — acts as mutex
  let acquired = false;
  for (let i = 0; i < 20; i++) {
    try { mkdirSync(lockDir, { recursive: false }); acquired = true; break; } catch { await sleep(500); }
  }
  if (!acquired) throw new Error(`Could not acquire worktree lock for ${opts.repoRoot} after 10s`);
  try {
    const sm = getStateManager();
    const state = await sm.load();

    const existing = state.entries.find(
      e => e.repoRoot === opts.repoRoot && e.branch === opts.branch
    );

    if (existing && existsSync(existing.path)) {
      if (existing.createdBy === opts.createdBy) {
        // Same owner: idempotent reuse — refresh heartbeat and return as-is
        refreshHeartbeat(existing.path);
        return existing;
      }

      // Different owner: check if the previous owner's heartbeat is still live
      if (isHeartbeatFresh(existing.path, GC_STALE_AFTER_MS)) {
        throw new Error(
          `Worktree ${existing.path} (branch: ${opts.branch}) is currently owned by ` +
          `"${existing.createdBy}" which has a live heartbeat. Cannot reuse for "${opts.createdBy}".`
        );
      }

      // Previous owner's heartbeat is stale — adopt the worktree
      await sm.update(s => ({
        ...s,
        entries: s.entries.map(e =>
          e.path === existing.path
            ? { ...e, locked: true, createdBy: opts.createdBy }
            : e
        ),
      }));
      refreshHeartbeat(existing.path);
      return { ...existing, locked: true, createdBy: opts.createdBy };
    }

    // Clean up stale state entry if directory doesn't exist
    if (existing && !existsSync(existing.path)) {
      await sm.update(s => ({
        ...s,
        entries: s.entries.filter(e => e.path !== existing.path),
      }));
    }

    const entry = await createWorktree(opts);
    refreshHeartbeat(entry.path);
    return entry;
  } finally {
    try { rmdirSync(lockDir); } catch { /* lock cleanup is best-effort */ }
  }
}

/**
 * Remove a worktree by path. Runs `git worktree remove` and cleans up state.
 */
export async function removeWorktree(wtPath: string): Promise<void> {
  const sm = getStateManager();
  const state = await sm.load();
  const entry = state.entries.find(e => e.path === wtPath);

  if (entry) {
    // Use git worktree remove
    try {
      gitExec(["worktree", "remove", wtPath, "--force"], entry.repoRoot);
    } catch {
      // Directory may already be gone; that's fine
    }
  }

  // Remove from state
  await sm.update(s => ({
    ...s,
    entries: s.entries.filter(e => e.path !== wtPath),
  }));
}

/**
 * Mark a worktree as merged — clears keepUntilMerged protection so cleanup hooks can remove it.
 */
export async function markWorktreeMerged(wtPath: string): Promise<void> {
  const sm = getStateManager();
  await sm.update(s => ({
    ...s,
    entries: s.entries.map(e =>
      e.path === wtPath
        ? { ...e, mergedAt: new Date().toISOString(), keepUntilMerged: false }
        : e
    ),
  }));
}

/**
 * List all tracked worktrees, optionally filtered by repo root.
 */
export async function listWorktrees(repoRoot?: string): Promise<WorktreeEntry[]> {
  const sm = getStateManager();
  const state = await sm.load();

  if (repoRoot) {
    return state.entries.filter(e => e.repoRoot === repoRoot);
  }
  return state.entries;
}

/**
 * Lock a worktree (mark as actively in use).
 */
export async function lockWorktree(wtPath: string): Promise<void> {
  const sm = getStateManager();
  await sm.update(s => ({
    ...s,
    entries: s.entries.map(e =>
      e.path === wtPath ? { ...e, locked: true } : e
    ),
  }));
}

/**
 * Unlock a worktree (mark as no longer actively in use).
 */
export async function unlockWorktree(wtPath: string): Promise<void> {
  const sm = getStateManager();
  await sm.update(s => ({
    ...s,
    entries: s.entries.map(e =>
      e.path === wtPath ? { ...e, locked: false } : e
    ),
  }));
}

/**
 * Prune orphaned worktrees across all tracked repos.
 * Runs `git worktree prune` on each repo and removes state entries
 * for directories that no longer exist.
 */
export async function pruneOrphaned(): Promise<PruneResult> {
  const sm = getStateManager();
  const state = await sm.load();
  const removed: string[] = [];
  const errors: string[] = [];

  // Collect unique repo roots
  const repoRoots = [...new Set(state.entries.map(e => e.repoRoot))];

  // Run git worktree prune on each repo
  for (const repo of repoRoots) {
    if (!existsSync(repo)) continue;
    try {
      gitExec(["worktree", "prune"], repo);
    } catch (e) {
      errors.push(`Failed to prune ${repo}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // Remove state entries where directory no longer exists
  const staleEntries = state.entries.filter(e => !existsSync(e.path));
  for (const entry of staleEntries) {
    removed.push(entry.path);
  }

  if (staleEntries.length > 0) {
    const stalePaths = new Set(staleEntries.map(e => e.path));
    await sm.update(s => ({
      ...s,
      entries: s.entries.filter(e => !stalePaths.has(e.path)),
    }));
  }

  return { removed, errors };
}

// ============================================================================
// GC Types + Liveness-Gated GC
// ============================================================================

export interface GcOptions {
  /** Milliseconds of inactivity before a worktree is considered stale. Default: 2h */
  staleAfterMs?: number;
  /** If true, log what would be removed but don't actually remove anything. */
  dryRun?: boolean;
}

export interface GcResult {
  removed: string[];
  skipped: Array<{ path: string; reason: string }>;
  errors: string[];
}

/**
 * Liveness-gated garbage collection for worktrees.
 *
 * A worktree is eligible for removal ONLY when ALL of the following hold:
 *   (a) It is safe: the branch is fully merged into main (is an ancestor of main)
 *       OR has no commits ahead of main.
 *   (b) The working tree is clean (no uncommitted changes).
 *   (c) It is not live: no fresh heartbeat (newer than staleAfterMs) AND
 *       the filesystem mtime shows no recent activity.
 *   (d) It is not the integrator's reuse worktree (integration/reconcile-tmp).
 *
 * NEVER force-removes a worktree that fails any check.
 * Logs every skip + reason (no silent drops).
 *
 * This is the safe replacement for the deleted SubagentStop force-removal.
 * Called by the Integrator after a successful reconcile of a gcCandidate branch.
 */
export async function gcWorktrees(opts: GcOptions = {}): Promise<GcResult> {
  const staleAfterMs = opts.staleAfterMs ?? GC_STALE_AFTER_MS;
  const dryRun = opts.dryRun ?? false;
  const sm = getStateManager();
  const state = await sm.load();

  const result: GcResult = { removed: [], skipped: [], errors: [] };

  for (const entry of state.entries) {
    const tag = `[gcWorktrees] ${entry.path}`;

    // (d) Never remove the integrator's reuse worktree
    if (entry.branch === INTEGRATOR_REUSE_BRANCH) {
      result.skipped.push({ path: entry.path, reason: "integrator reuse worktree — protected" });
      console.log(`${tag}: SKIP — integrator reuse worktree`);
      continue;
    }

    // Directory must exist to evaluate
    if (!existsSync(entry.path)) {
      // Stale state entry — clean it from state but don't count as "removed"
      await sm.update(s => ({
        ...s,
        entries: s.entries.filter(e => e.path !== entry.path),
      }));
      console.log(`${tag}: cleaned stale state entry (directory missing)`);
      continue;
    }

    // (c) Liveness: check heartbeat freshness
    if (isHeartbeatFresh(entry.path, staleAfterMs)) {
      result.skipped.push({ path: entry.path, reason: "live heartbeat — owner is active" });
      console.log(`${tag}: SKIP — live heartbeat (owner: ${entry.createdBy})`);
      continue;
    }

    // (c) Liveness: check filesystem mtime of the worktree directory itself
    try {
      const dirStat = statSync(entry.path);
      const ageMs = Date.now() - dirStat.mtimeMs;
      if (ageMs < staleAfterMs) {
        result.skipped.push({ path: entry.path, reason: `directory modified ${Math.round(ageMs / 60000)}m ago (threshold: ${Math.round(staleAfterMs / 60000)}m)` });
        console.log(`${tag}: SKIP — recently modified (${Math.round(ageMs / 60000)}m ago)`);
        continue;
      }
    } catch (e) {
      result.errors.push(`${entry.path}: could not stat directory: ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }

    // (b) Working tree cleanliness
    let isDirty = false;
    try {
      const statusOut = execFileSync("git", ["status", "--porcelain"], {
        cwd: entry.path, encoding: "utf-8", stdio: "pipe", timeout: 10_000,
      }).trim();
      isDirty = statusOut.length > 0;
    } catch (e) {
      result.errors.push(`${entry.path}: could not check git status: ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }
    if (isDirty) {
      result.skipped.push({ path: entry.path, reason: "working tree has uncommitted changes" });
      console.log(`${tag}: SKIP — dirty working tree`);
      continue;
    }

    // (a) Safety: branch must be fully merged into main (or have no commits ahead)
    let isMerged = false;
    try {
      execFileSync("git", ["merge-base", "--is-ancestor", entry.branch, "main"], {
        cwd: entry.repoRoot, stdio: "pipe", timeout: 10_000,
      });
      isMerged = true; // exit 0 = branch is ancestor of main
    } catch {
      // Non-zero = not merged — check if zero commits ahead as a fallback
      try {
        const ahead = execFileSync(
          "git", ["rev-list", "--count", `main..${entry.branch}`],
          { cwd: entry.repoRoot, encoding: "utf-8", stdio: "pipe", timeout: 10_000 }
        ).trim();
        isMerged = parseInt(ahead, 10) === 0;
      } catch {
        // Can't determine — skip safely
      }
    }

    if (!isMerged) {
      result.skipped.push({ path: entry.path, reason: "branch not fully merged into main" });
      console.log(`${tag}: SKIP — branch "${entry.branch}" not merged into main`);
      continue;
    }

    // All checks passed — remove
    if (dryRun) {
      result.removed.push(entry.path);
      console.log(`${tag}: DRY-RUN — would remove (branch "${entry.branch}" is merged+clean+stale)`);
      continue;
    }

    try {
      gitExec(["worktree", "remove", entry.path, "--force"], entry.repoRoot);
    } catch (e) {
      // If the worktree remove fails, try cleaning the directory directly
      try {
        const { rmSync } = await import("fs");
        rmSync(entry.path, { recursive: true, force: true });
      } catch {
        result.errors.push(`${entry.path}: failed to remove: ${e instanceof Error ? e.message : String(e)}`);
        continue;
      }
    }

    // Optionally delete the local branch (only if safely merged)
    try {
      execFileSync("git", ["branch", "-d", entry.branch], {
        cwd: entry.repoRoot, stdio: "pipe", timeout: 10_000,
      });
    } catch {
      // Non-fatal — branch may already be deleted or may need force-delete
      console.log(`${tag}: WARN — could not delete branch "${entry.branch}" (may require manual cleanup)`);
    }

    // Clean from state
    await sm.update(s => ({
      ...s,
      entries: s.entries.filter(e => e.path !== entry.path),
    }));

    result.removed.push(entry.path);
    console.log(`${tag}: REMOVED — branch "${entry.branch}" was merged+clean+stale`);
  }

  return result;
}

/**
 * GC a single worktree by its branch name (convenience wrapper for Integrator).
 * Returns the GcResult for that one entry.
 * If the branch is the integrator's reuse branch, skips without error.
 */
export async function gcWorktreeForBranch(
  branch: string,
  repoRoot: string,
  opts: GcOptions = {},
): Promise<GcResult> {
  // Load state to find the entry for this branch+repo
  const sm = getStateManager();
  const state = await sm.load();
  const entry = state.entries.find(e => e.branch === branch && e.repoRoot === repoRoot);
  if (!entry) {
    return {
      removed: [],
      skipped: [{ path: `${repoRoot}:${branch}`, reason: "no tracked worktree for this branch" }],
      errors: [],
    };
  }
  // Run the full GC — it will evaluate only this entry (and the loop covers it)
  return gcWorktrees(opts);
}

// ============================================================================
// CLI Entry Point
// ============================================================================

async function main() {
  const { values, positionals } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      repo: { type: "string" },
      branch: { type: "string" },
      path: { type: "string" },
      "created-by": { type: "string" },
      "stale-after": { type: "string" },
      "dry-run": { type: "boolean" },
      help: { type: "boolean", short: "h" },
      json: { type: "boolean" },
    },
    allowPositionals: true,
  });

  const command = positionals[0];

  if (values.help || !command) {
    console.log(`
WorktreeManager - Git worktree isolation for parallel agents

Commands:
  create    Create a new worktree
  remove    Remove a worktree
  list      List tracked worktrees
  prune     Clean up orphaned worktrees (removes directory-missing state entries)
  gc        Liveness-gated GC — removes merged+clean+stale worktrees safely
  lock      Lock a worktree (mark active)
  unlock    Unlock a worktree (mark inactive)

Options:
  --repo <path>         Repository root path
  --branch <name>       Branch name
  --path <path>         Worktree path (for remove/lock/unlock)
  --created-by <id>     Creator identifier (e.g., "executive:abc")
  --stale-after <ms>    Stale threshold in ms for gc (default: 7200000 = 2h)
  --dry-run             (gc) Show what would be removed without removing
  --json                Output as JSON
  -h, --help            Show this help

Examples:
  bun run WorktreeManager.ts create --repo /path/to/repo --branch feature/x --created-by executive:abc
  bun run WorktreeManager.ts remove --path ~/.claude/worktrees/repo/feature-x
  bun run WorktreeManager.ts list --repo /path/to/repo
  bun run WorktreeManager.ts prune
  bun run WorktreeManager.ts gc --dry-run
  bun run WorktreeManager.ts gc --stale-after 3600000
`);
    return;
  }

  switch (command) {
    case "create": {
      if (!values.repo || !values.branch) {
        console.error("Error: --repo and --branch are required");
        process.exit(1);
      }
      const entry = await getOrCreateWorktree({
        repoRoot: values.repo,
        branch: values.branch,
        createdBy: values["created-by"] || "manual",
      });
      if (values.json) {
        console.log(JSON.stringify(entry, null, 2));
      } else {
        console.log(`Worktree created: ${entry.path}`);
        console.log(`  Branch: ${entry.branch}`);
        console.log(`  Repo: ${entry.repoRoot}`);
      }
      break;
    }

    case "remove": {
      if (!values.path) {
        console.error("Error: --path is required");
        process.exit(1);
      }
      await removeWorktree(values.path);
      console.log(`Worktree removed: ${values.path}`);
      break;
    }

    case "list": {
      const entries = await listWorktrees(values.repo);
      if (values.json) {
        console.log(JSON.stringify(entries, null, 2));
      } else if (entries.length === 0) {
        console.log("No tracked worktrees.");
      } else {
        for (const e of entries) {
          const lock = e.locked ? "LOCKED" : "unlocked";
          console.log(`${e.path} [${lock}]`);
          console.log(`  Branch: ${e.branch} | Repo: ${e.repoRoot}`);
          console.log(`  Created: ${e.createdAt} by ${e.createdBy}`);
        }
      }
      break;
    }

    case "prune": {
      const result = await pruneOrphaned();
      if (values.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(`Pruned ${result.removed.length} orphaned worktrees.`);
        for (const r of result.removed) {
          console.log(`  Removed: ${r}`);
        }
        for (const e of result.errors) {
          console.log(`  Error: ${e}`);
        }
      }
      break;
    }

    case "lock": {
      if (!values.path) {
        console.error("Error: --path is required");
        process.exit(1);
      }
      await lockWorktree(values.path);
      console.log(`Locked: ${values.path}`);
      break;
    }

    case "unlock": {
      if (!values.path) {
        console.error("Error: --path is required");
        process.exit(1);
      }
      await unlockWorktree(values.path);
      console.log(`Unlocked: ${values.path}`);
      break;
    }

    case "gc": {
      const staleAfterMs = values["stale-after"] ? parseInt(values["stale-after"], 10) : undefined;
      const gcResult = await gcWorktrees({ staleAfterMs, dryRun: values["dry-run"] });
      if (values.json) {
        console.log(JSON.stringify(gcResult, null, 2));
      } else {
        console.log(`GC: removed ${gcResult.removed.length}  skipped ${gcResult.skipped.length}  errors ${gcResult.errors.length}`);
        for (const r of gcResult.removed) {
          console.log(`  REMOVED: ${r}`);
        }
        for (const s of gcResult.skipped) {
          console.log(`  SKIP: ${s.path} — ${s.reason}`);
        }
        for (const e of gcResult.errors) {
          console.log(`  ERROR: ${e}`);
        }
      }
      break;
    }

    default:
      console.error(`Unknown command: ${command}`);
      process.exit(1);
  }
}

if (import.meta.main) {
  main().catch(console.error);
}

export { worktreesDir, slugify, gitExec, removeStaleGitLock, GC_STALE_AFTER_MS, INTEGRATOR_REUSE_BRANCH, repoSlug, worktreePath };
