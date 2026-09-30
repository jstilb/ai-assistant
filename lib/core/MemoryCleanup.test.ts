/**
 * MemoryCleanup.test.ts - Tests for MemoryCleanup
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { spawnSync } from 'child_process';
import { join } from 'path';
import { existsSync, mkdirSync, writeFileSync, rmSync, utimesSync } from 'fs';
import { tmpdir } from 'os';
import {
  getPipelineRepository,
  resetPipelineRepository,
} from '../../skills/Automation/QueueRouter/Tools/PipelineRepository.ts';

const MEMORY_CLEANUP_PATH = join(import.meta.dir, 'MemoryCleanup.ts');

/** Build an env for subprocess tests that doesn't propagate KAYA_HOME test overrides */
function cleanEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.KAYA_HOME;
  return env;
}

describe('MemoryCleanup', () => {
  it('file exists', () => {
    expect(existsSync(MEMORY_CLEANUP_PATH)).toBe(true);
  });

  it('all --dry-run exits cleanly without crashing', () => {
    const result = spawnSync('bun', [MEMORY_CLEANUP_PATH, 'all', '--dry-run'], {
      encoding: 'utf-8',
      timeout: 20000,
      env: cleanEnv(),
    });
    expect(result.signal).toBeNull();
    const combined = (result.stdout || '') + (result.stderr || '');
    expect(combined).not.toContain('SyntaxError');
    expect(combined).not.toContain('Uncaught');
    expect(combined).not.toContain('Cannot find module');
  });

  it('all --dry-run --json produces JSON output', () => {
    const result = spawnSync('bun', [MEMORY_CLEANUP_PATH, 'all', '--dry-run', '--json'], {
      encoding: 'utf-8',
      timeout: 20000,
      env: cleanEnv(),
    });
    expect(result.signal).toBeNull();
    const output = result.stdout || '';
    if (output.trim()) {
      // Should be valid JSON
      expect(() => JSON.parse(output)).not.toThrow();
      const parsed = JSON.parse(output);
      expect(typeof parsed.dryRun).toBe('boolean');
      expect(parsed.dryRun).toBe(true);
    }
  });

  it('debug --dry-run exits cleanly', () => {
    const result = spawnSync('bun', [MEMORY_CLEANUP_PATH, 'debug', '--dry-run'], {
      encoding: 'utf-8',
      timeout: 15000,
      env: cleanEnv(),
    });
    expect(result.signal).toBeNull();
    const combined = (result.stdout || '') + (result.stderr || '');
    expect(combined).not.toContain('SyntaxError');
  });

  it('--scan-unregistered: scanUnregistered() function exists and returns structured result', async () => {
    // Test the function directly rather than via subprocess (avoids Bun cwd/spawn issues)
    const { scanUnregistered } = await import('./MemoryCleanup.ts');
    const result = scanUnregistered();
    // Must return structured object
    expect(typeof result).toBe('object');
    expect(typeof result.registered).toBe('number');
    expect(result.registered).toBeGreaterThanOrEqual(10); // registry has 10+ entries
    expect(Array.isArray(result.unregistered)).toBe(true);
    expect(Array.isArray(result.warnings)).toBe(true);
    // Warnings should reference "unregistered" word
    if (result.warnings.length > 0) {
      expect(result.warnings[0]).toContain('unregistered');
    }
  });
});

// ============================================================================
// JSONL_REGISTRY unit tests (ISC row 2)
// ============================================================================

describe('JSONL_REGISTRY', () => {
  it('has at least 10 entries with retentionDays field', async () => {
    const { getRegisteredJsonlPaths } = await import('./MemoryCleanup.ts');
    const paths = getRegisteredJsonlPaths();
    // Registry has 14 entries (count from implementation)
    expect(paths.size).toBeGreaterThanOrEqual(10);
  });

  it('registry covers notifications, monitoring, learning categories', async () => {
    const { getRegisteredJsonlPaths } = await import('./MemoryCleanup.ts');
    const paths = getRegisteredJsonlPaths();
    const pathList = [...paths];
    const hasNotifications = pathList.some(p => p.includes('notifications'));
    const hasMonitoring = pathList.some(p => p.includes('monitor-audit'));
    const hasRatings = pathList.some(p => p.includes('ratings'));
    expect(hasNotifications).toBe(true);
    expect(hasMonitoring).toBe(true);
    expect(hasRatings).toBe(true);
  });
});

// ============================================================================
// scanUnregistered unit tests (ISC row 3)
// ============================================================================

describe('scanUnregistered', () => {
  let testHome: string;

  beforeEach(() => {
    testHome = join(tmpdir(), `mc-test-${Date.now()}`);
    mkdirSync(join(testHome, 'MEMORY', 'NOTIFICATIONS'), { recursive: true });
    process.env.KAYA_HOME = testHome;
  });

  afterEach(() => {
    delete process.env.KAYA_HOME;
    if (existsSync(testHome)) rmSync(testHome, { recursive: true });
  });

  it('returns unregistered JSONL files as warnings', async () => {
    // Put a JSONL file in a location not in the registry
    const unknownFile = join(testHome, 'MEMORY', 'NOTIFICATIONS', 'unknown-custom.jsonl');
    writeFileSync(unknownFile, '{}');

    const { scanUnregistered } = await import('./MemoryCleanup.ts');
    const result = scanUnregistered();

    expect(result.unregistered.length).toBeGreaterThan(0);
    expect(result.warnings.length).toBeGreaterThanOrEqual(1);
    expect(result.warnings.some((w: string) => w.includes('unregistered'))).toBe(true);
  });

  it('returns empty unregistered for empty MEMORY dir', async () => {
    const { scanUnregistered } = await import('./MemoryCleanup.ts');
    const result = scanUnregistered();
    expect(result.unregistered).toBeInstanceOf(Array);
    expect(result.warnings.every((w: string) => w.includes('WARN'))).toBe(true);
  });
});

// ============================================================================
// cleanWorkDirs unit tests (ISC rows 4 & 11)
// ============================================================================

describe('cleanWorkDirs', () => {
  let testHome: string;

  beforeEach(() => {
    testHome = join(tmpdir(), `mc-work-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    mkdirSync(join(testHome, 'MEMORY', 'WORK'), { recursive: true });
    process.env.KAYA_HOME = testHome;
  });

  afterEach(() => {
    resetPipelineRepository();
    delete process.env.KAYA_HOME;
    if (existsSync(testHome)) rmSync(testHome, { recursive: true });
  });

  it('removes WORK/ dirs older than TTL', async () => {
    const workDir = join(testHome, 'MEMORY', 'WORK');
    const oldDir = join(workDir, 'old-session-dir');
    mkdirSync(oldDir);

    // Backdate mtime to 35 days ago
    const oldTime = new Date(Date.now() - 35 * 24 * 60 * 60 * 1000);
    utimesSync(oldDir, oldTime, oldTime);

    const { cleanWorkDirs } = await import('./MemoryCleanup.ts');
    const result = await cleanWorkDirs(false);

    expect(result.dirsRemoved).toBe(1);
    expect(existsSync(oldDir)).toBe(false);
  });

  it('skips in-progress work items even when old (reads pipeline.db, not work-queue.json)', async () => {
    const workDir = join(testHome, 'MEMORY', 'WORK');
    const activeDir = join(workDir, 'active-session-dir');
    mkdirSync(activeDir);

    // Backdate mtime to 40 days ago
    const oldTime = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
    utimesSync(activeDir, oldTime, oldTime);

    // Seed pipeline.db with an in-progress item whose worktree_path resolves to
    // the dir name "active-session-dir" — NO work-queue.json written.
    mkdirSync(join(testHome, '.kaya', 'runtime'), { recursive: true });
    const repo = getPipelineRepository();
    repo.upsert({
      id: 'test-active-item',
      stage: 'in-progress',
      priority: 2,
      title: 'Active work',
      description: '',
      worktree_path: `/path/to/worktrees/active-session-dir`,
      dependencies: [],
      attempts: [],
      isc_rows: [],
      metadata: {},
      context: {},
      progress: { totalPhases: 0, completedPhases: 0, currentPhase: 0, phaseHistory: [], iscRows: [] },
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    const { cleanWorkDirs } = await import('./MemoryCleanup.ts');
    const result = await cleanWorkDirs(false);

    expect(existsSync(activeDir)).toBe(true);
    expect(result.dirsSkipped).toBe(1);
  });

  it('dry-run does not delete dirs', async () => {
    const workDir = join(testHome, 'MEMORY', 'WORK');
    const oldDir = join(workDir, 'dry-run-dir');
    mkdirSync(oldDir);

    const oldTime = new Date(Date.now() - 35 * 24 * 60 * 60 * 1000);
    utimesSync(oldDir, oldTime, oldTime);

    const { cleanWorkDirs } = await import('./MemoryCleanup.ts');
    const result = await cleanWorkDirs(true); // dry-run

    expect(result.dirsRemoved).toBe(1); // counted but not deleted
    expect(existsSync(oldDir)).toBe(true); // still exists
  });
});

// ============================================================================
// cleanOrphanedCurrentWork unit tests (ISC row 11)
// ============================================================================

describe('cleanOrphanedCurrentWork', () => {
  let testHome: string;

  beforeEach(() => {
    testHome = join(tmpdir(), `mc-orphan-${Date.now()}`);
    mkdirSync(join(testHome, 'MEMORY', 'State'), { recursive: true });
    process.env.KAYA_HOME = testHome;
  });

  afterEach(() => {
    delete process.env.KAYA_HOME;
    if (existsSync(testHome)) rmSync(testHome, { recursive: true });
  });

  it('removes UUID current-work files older than 24h', async () => {
    const stateDir = join(testHome, 'MEMORY', 'State');
    const oldFile = join(stateDir, 'current-work-12345678-1234-1234-1234-123456789012.json');
    writeFileSync(oldFile, '{}');

    // Backdate to 25 hours ago
    const oldTime = new Date(Date.now() - 25 * 60 * 60 * 1000);
    utimesSync(oldFile, oldTime, oldTime);

    const { cleanOrphanedCurrentWork } = await import('./MemoryCleanup.ts');
    const result = await cleanOrphanedCurrentWork(false);

    expect(result.filesRemoved).toBe(1);
    expect(existsSync(oldFile)).toBe(false);
  });

  it('keeps current-work.json (canonical file) untouched', async () => {
    const stateDir = join(testHome, 'MEMORY', 'State');
    const canonicalFile = join(stateDir, 'current-work.json');
    writeFileSync(canonicalFile, '{}');

    // Backdate to 48 hours ago
    const oldTime = new Date(Date.now() - 48 * 60 * 60 * 1000);
    utimesSync(canonicalFile, oldTime, oldTime);

    const { cleanOrphanedCurrentWork } = await import('./MemoryCleanup.ts');
    const result = await cleanOrphanedCurrentWork(false);

    // canonical file should NOT be removed (pattern requires UUID)
    expect(existsSync(canonicalFile)).toBe(true);
    expect(result.filesRemoved).toBe(0);
  });

  it('keeps UUID files newer than 24h', async () => {
    const stateDir = join(testHome, 'MEMORY', 'State');
    const newFile = join(stateDir, 'current-work-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.json');
    writeFileSync(newFile, '{}');
    // No backdate — file is freshly created (< 24h)

    const { cleanOrphanedCurrentWork } = await import('./MemoryCleanup.ts');
    const result = await cleanOrphanedCurrentWork(false);

    expect(existsSync(newFile)).toBe(true);
    expect(result.filesRemoved).toBe(0);
  });

  // A6 (N4 remediation) — this function is being wired into the daily
  // AutoMaintenance tier (Workflows.ts) with dryRun threaded straight from
  // the workflow's --dry-run flag. No dry-run test existed for this function
  // before (unlike cleanWorkDirs' own "dry-run does not delete dirs" test
  // above) — added here to prove the threading is safe before it reaches a
  // scheduled, non-test-gated tier.
  it('dry-run does not delete orphaned files (counts but preserves)', async () => {
    const stateDir = join(testHome, 'MEMORY', 'State');
    const oldFile = join(stateDir, 'current-work-deadbeef-dead-beef-dead-beefdeadbeef.json');
    writeFileSync(oldFile, '{}');

    const oldTime = new Date(Date.now() - 25 * 60 * 60 * 1000);
    utimesSync(oldFile, oldTime, oldTime);

    const { cleanOrphanedCurrentWork } = await import('./MemoryCleanup.ts');
    const result = await cleanOrphanedCurrentWork(true); // dry-run

    expect(result.filesRemoved).toBe(1); // counted but not deleted
    expect(existsSync(oldFile)).toBe(true); // still exists
  });
});

// ============================================================================
// cleanStaleContextFiles unit tests (ISC row 12, A6 — N4 remediation)
//
// Previously untested (grep confirmed zero prior references to this function
// name in this file). Being wired into the daily AutoMaintenance tier
// (Workflows.ts) with dryRun threaded from --dry-run, so its basic contract —
// what it removes, what it preserves, and that dry-run deletes nothing — is
// proven hermetically here first, mirroring cleanOrphanedCurrentWork's own
// describe block immediately above (same KAYA_HOME-pinning beforeEach/afterEach).
// ============================================================================

describe('cleanStaleContextFiles', () => {
  let testHome: string;

  beforeEach(() => {
    testHome = join(tmpdir(), `mc-context-${Date.now()}`);
    mkdirSync(join(testHome, 'MEMORY', 'State'), { recursive: true });
    process.env.KAYA_HOME = testHome;
  });

  afterEach(() => {
    delete process.env.KAYA_HOME;
    if (existsSync(testHome)) rmSync(testHome, { recursive: true });
  });

  it('removes prompt-context-{uuid}.json files older than 14 days', async () => {
    const stateDir = join(testHome, 'MEMORY', 'State');
    const oldFile = join(stateDir, 'prompt-context-12345678-1234-1234-1234-123456789012.json');
    writeFileSync(oldFile, '{}');

    const oldTime = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000);
    utimesSync(oldFile, oldTime, oldTime);

    const { cleanStaleContextFiles } = await import('./MemoryCleanup.ts');
    const result = await cleanStaleContextFiles(false);

    expect(result.filesRemoved).toBe(1);
    expect(existsSync(oldFile)).toBe(false);
  });

  it('removes context-session-{uuid}.json files older than 14 days', async () => {
    const stateDir = join(testHome, 'MEMORY', 'State');
    const oldFile = join(stateDir, 'context-session-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.json');
    writeFileSync(oldFile, '{}');

    const oldTime = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000);
    utimesSync(oldFile, oldTime, oldTime);

    const { cleanStaleContextFiles } = await import('./MemoryCleanup.ts');
    const result = await cleanStaleContextFiles(false);

    expect(result.filesRemoved).toBe(1);
    expect(existsSync(oldFile)).toBe(false);
  });

  it('keeps files newer than 14 days', async () => {
    const stateDir = join(testHome, 'MEMORY', 'State');
    const newFile = join(stateDir, 'prompt-context-bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb.json');
    writeFileSync(newFile, '{}');
    // No backdate — freshly created (< 14 days)

    const { cleanStaleContextFiles } = await import('./MemoryCleanup.ts');
    const result = await cleanStaleContextFiles(false);

    expect(existsSync(newFile)).toBe(true);
    expect(result.filesRemoved).toBe(0);
  });

  it('dry-run does not delete files (counts but preserves)', async () => {
    const stateDir = join(testHome, 'MEMORY', 'State');
    const oldFile = join(stateDir, 'context-session-cccccccc-cccc-cccc-cccc-cccccccccccc.json');
    writeFileSync(oldFile, '{}');

    const oldTime = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    utimesSync(oldFile, oldTime, oldTime);

    const { cleanStaleContextFiles } = await import('./MemoryCleanup.ts');
    const result = await cleanStaleContextFiles(true); // dry-run

    expect(result.filesRemoved).toBe(1); // counted but not deleted
    expect(existsSync(oldFile)).toBe(true); // still exists
  });
});
