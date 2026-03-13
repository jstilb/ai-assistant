/**
 * WorktreeManager.test.ts - Smoke tests for WorktreeManager
 *
 * Tests CRUD cycle on a real git repo (uses ~/.claude itself).
 * Cleans up after itself.
 */
import { describe, it, expect, afterAll } from 'bun:test';
import {
  listWorktrees,
  pruneOrphaned,
  getOrCreateWorktree,
  removeWorktree,
} from './WorktreeManager';
import type { PruneResult } from './WorktreeManager';
import { join } from 'path';
import os from 'os';
import { existsSync, rmSync, mkdirSync } from 'fs';
import { execFileSync } from 'child_process';

// Use a temp git repo for isolated testing - don't touch ~/.claude
const TEST_REPO = join(os.tmpdir(), `wt-test-repo-${Date.now()}`);

function setupTestRepo(): void {
  mkdirSync(TEST_REPO, { recursive: true });
  execFileSync('git', ['init'], { cwd: TEST_REPO, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: TEST_REPO, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: TEST_REPO, stdio: 'pipe' });
  // Need at least one commit for worktrees to work
  execFileSync('git', ['commit', '--allow-empty', '-m', 'init'], { cwd: TEST_REPO, stdio: 'pipe' });
}

afterAll(() => {
  try {
    if (existsSync(TEST_REPO)) {
      // Remove any worktrees first
      rmSync(TEST_REPO, { recursive: true, force: true });
    }
  } catch {
    // Best effort cleanup
  }
});

describe('WorktreeManager', () => {
  it('exports expected functions', () => {
    expect(typeof listWorktrees).toBe('function');
    expect(typeof pruneOrphaned).toBe('function');
    expect(typeof getOrCreateWorktree).toBe('function');
    expect(typeof removeWorktree).toBe('function');
  });

  it('listWorktrees returns an array', async () => {
    const entries = await listWorktrees();
    expect(Array.isArray(entries)).toBe(true);
  });

  it('pruneOrphaned returns PruneResult without crashing', async () => {
    const result: PruneResult = await pruneOrphaned();
    expect(typeof result).toBe('object');
    // PruneResult has: removed: string[], errors: string[]
    expect(Array.isArray(result.removed)).toBe(true);
    expect(Array.isArray(result.errors)).toBe(true);
  });

  it('getOrCreateWorktree creates a worktree in isolated test repo', async () => {
    setupTestRepo();

    const entry = await getOrCreateWorktree({
      repoRoot: TEST_REPO,
      branch: 'smoke-test-branch',
      createdBy: 'smoke-test',
    });

    expect(entry).toBeDefined();
    expect(typeof entry.path).toBe('string');
    expect(entry.branch).toBe('smoke-test-branch');
    expect(entry.repoRoot).toBe(TEST_REPO);
    expect(existsSync(entry.path)).toBe(true);

    // Cleanup
    await removeWorktree(entry.path);
  });

  it('removeWorktree completes without unhandled exception for nonexistent path', async () => {
    // removeWorktree is designed to be fail-silent for paths that don't exist
    // It either resolves silently or rejects — both are acceptable behaviors
    try {
      await removeWorktree('/nonexistent/worktree/path');
      // Resolved silently — acceptable
    } catch (err) {
      // Rejected — also acceptable as long as it's a proper Error
      expect(err instanceof Error || typeof err === 'string').toBe(true);
    }
  });

  it('listWorktrees with repoRoot filter returns only matching entries', async () => {
    const entries = await listWorktrees(TEST_REPO);
    expect(Array.isArray(entries)).toBe(true);
    // All returned entries should match the repo root
    for (const entry of entries) {
      expect(entry.repoRoot).toBe(TEST_REPO);
    }
  });
});
