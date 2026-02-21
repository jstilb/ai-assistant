#!/usr/bin/env bun
/**
 * WorktreeManager.ts - Git Worktree Isolation for Parallel Agents
 *
 * Provides create/remove/list/prune operations for git worktrees, enabling
 * parallel agents to work on separate branches without checkout races.
 * Each worktree is a lightweight directory linked to the same .git database.
 *
 * State is persisted via StateManager with file locking for concurrent access.
 *
 * Usage:
 *   # Programmatic
 *   import { getOrCreateWorktree, removeWorktree, listWorktrees, pruneOrphaned } from './WorktreeManager.ts';
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
 */

import { z } from "zod";
import { execFileSync } from "child_process";
import { existsSync, mkdirSync, statSync, unlinkSync } from "fs";
import { join, basename } from "path";
import { homedir } from "os";
import { parseArgs } from "util";
import { createStateManager, type StateManager } from "./StateManager.ts";

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
}

export interface PruneResult {
  removed: string[];
  errors: string[];
}

// ============================================================================
// Constants
// ============================================================================

const KAYA_HOME = process.env.KAYA_HOME || join(homedir(), ".claude");
const WORKTREES_DIR = join(KAYA_HOME, "worktrees");
const STATE_PATH = join(WORKTREES_DIR, "state.json");

// ============================================================================
// State Manager
// ============================================================================

let _stateManager: StateManager<WorktreeState> | undefined;

function getStateManager(): StateManager<WorktreeState> {
  if (!_stateManager) {
    _stateManager = createStateManager<WorktreeState>({
      path: STATE_PATH,
      schema: WorktreeStateSchema,
      defaults: { entries: [], lastUpdated: "" },
      lockTimeout: 10000,
    });
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
 * Compute the worktree directory path for a given repo + branch.
 */
function worktreePath(repoRoot: string, branch: string): string {
  const repoSlug = slugify(basename(repoRoot));
  const branchSlug = slugify(branch);
  return join(WORKTREES_DIR, repoSlug, branchSlug);
}

// ============================================================================
// Core Functions
// ============================================================================

/**
 * Create a new git worktree for the given repo and branch.
 * If the branch doesn't exist yet, creates it from HEAD.
 */
export async function createWorktree(opts: CreateWorktreeOptions): Promise<WorktreeEntry> {
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
 */
export async function getOrCreateWorktree(opts: CreateWorktreeOptions): Promise<WorktreeEntry> {
  const sm = getStateManager();
  const state = await sm.load();

  const existing = state.entries.find(
    e => e.repoRoot === opts.repoRoot && e.branch === opts.branch
  );

  if (existing && existsSync(existing.path)) {
    // Re-lock and update createdBy if needed
    if (!existing.locked || existing.createdBy !== opts.createdBy) {
      await sm.update(s => ({
        ...s,
        entries: s.entries.map(e =>
          e.path === existing.path
            ? { ...e, locked: true, createdBy: opts.createdBy }
            : e
        ),
      }));
    }
    return { ...existing, locked: true, createdBy: opts.createdBy };
  }

  // Clean up stale state entry if directory doesn't exist
  if (existing && !existsSync(existing.path)) {
    await sm.update(s => ({
      ...s,
      entries: s.entries.filter(e => e.path !== existing.path),
    }));
  }

  return createWorktree(opts);
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
  prune     Clean up orphaned worktrees
  lock      Lock a worktree (mark active)
  unlock    Unlock a worktree (mark inactive)

Options:
  --repo <path>         Repository root path
  --branch <name>       Branch name
  --path <path>         Worktree path (for remove/lock/unlock)
  --created-by <id>     Creator identifier (e.g., "executive:abc")
  --json                Output as JSON
  -h, --help            Show this help

Examples:
  bun run WorktreeManager.ts create --repo /path/to/repo --branch feature/x --created-by executive:abc
  bun run WorktreeManager.ts remove --path ~/.claude/worktrees/repo/feature-x
  bun run WorktreeManager.ts list --repo /path/to/repo
  bun run WorktreeManager.ts prune
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

    default:
      console.error(`Unknown command: ${command}`);
      process.exit(1);
  }
}

if (import.meta.main) {
  main().catch(console.error);
}

export { WORKTREES_DIR, slugify, gitExec, removeStaleGitLock };
