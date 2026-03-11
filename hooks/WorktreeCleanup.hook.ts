#!/usr/bin/env bun
/**
 * WorktreeCleanup.hook.ts - SubagentStop hook for eager worktree cleanup
 *
 * When a subagent finishes, this hook unlocks any worktrees that are no longer
 * actively held by an agent and removes unlocked worktrees. Runs alongside
 * the existing AgentOutputCapture.hook.ts.
 *
 * Registered in settings.json under SubagentStop.
 */

import { listWorktrees, removeWorktree, unlockWorktree, removeStaleGitLock } from "../lib/core/WorktreeManager.ts";
import { homedir } from "os";
import { join } from "path";

async function main(): Promise<void> {
  // Read stdin (hook input) but we don't need it for cleanup
  const input = await Bun.stdin.text();
  if (!input) {
    process.exit(0);
  }

  try {
    // Pre-clean any stale git locks before doing worktree operations.
    // This prevents cascading failures when multiple SubagentStop hooks fire.
    const kayaDir = process.env.KAYA_DIR || join(homedir(), ".claude");
    removeStaleGitLock(kayaDir);

    const entries = await listWorktrees();
    if (entries.length === 0) {
      process.exit(0);
    }

    // Also clean stale locks in each repo root tracked by worktrees
    const repoRoots = [...new Set(entries.map(e => e.repoRoot))];
    for (const repo of repoRoots) {
      removeStaleGitLock(repo);
    }

    // Unlock all entries first (the agent that owned them has stopped)
    for (const entry of entries.filter(e => e.locked)) {
      try {
        await unlockWorktree(entry.path);
      } catch {
        // Ignore unlock errors
      }
    }

    // Re-read to get updated state, then remove unlocked worktrees
    const updatedEntries = await listWorktrees();
    for (const entry of updatedEntries.filter(e => !e.locked)) {
      try {
        await removeWorktree(entry.path);
      } catch {
        // Prune catches orphans later
      }
    }
  } catch {
    // Non-fatal: hook errors shouldn't block agent completion
  }

  process.exit(0);
}

main().catch(() => process.exit(0));
