/**
 * SecurityValidator.hook.ts — Integration Tests
 * ==============================================
 * Tests for the PreToolUse security validation hook.
 * Runs the hook as a subprocess and validates its exit behavior and stdout decisions.
 * Tests are self-contained — creates a temp KAYA_DIR with required patterns.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { join } from 'path';
import { writeFileSync, unlinkSync, existsSync, readFileSync, mkdirSync, rmSync, cpSync } from 'fs';
import { execSync } from 'child_process';

const HOOK_PATH = join(import.meta.dir, '../../hooks/SecurityValidator.hook.ts');
// Use worktree-relative paths for self-contained CI execution
const WORKTREE_ROOT = join(import.meta.dir, '../..');
const PATTERNS_EXAMPLE = join(WORKTREE_ROOT, 'KAYASECURITYSYSTEM/patterns.example.yaml');

// We need a KAYA_DIR with patterns installed.
// Strategy: use a temp dir with the patterns file copied to the expected path.
let TEMP_KAYA_DIR: string;

beforeAll(() => {
  // Create a temp KAYA_DIR with the required patterns file
  TEMP_KAYA_DIR = `/tmp/kaya_test_sv_${Date.now()}`;
  const userPatternsDir = join(TEMP_KAYA_DIR, 'USER', 'KAYASECURITYSYSTEM');
  mkdirSync(userPatternsDir, { recursive: true });
  // Also create MEMORY/SECURITY for logging
  mkdirSync(join(TEMP_KAYA_DIR, 'MEMORY', 'SECURITY'), { recursive: true });
  // Copy example patterns as user patterns
  if (existsSync(PATTERNS_EXAMPLE)) {
    const patternsContent = readFileSync(PATTERNS_EXAMPLE, 'utf-8');
    writeFileSync(join(userPatternsDir, 'patterns.yaml'), patternsContent);
  }
});

afterAll(() => {
  if (TEMP_KAYA_DIR && existsSync(TEMP_KAYA_DIR)) {
    rmSync(TEMP_KAYA_DIR, { recursive: true, force: true });
  }
});

function runHook(
  input: Record<string, unknown>,
  envOverrides: Record<string, string> = {},
): { stdout: string; stderr: string; exitCode: number } {
  const ts = Date.now() + '_' + Math.random().toString(36).slice(2);
  const tmpInput = `/tmp/sv_in_${ts}.json`;
  const tmpStdout = `/tmp/sv_out_${ts}.txt`;
  const tmpStderr = `/tmp/sv_err_${ts}.txt`;

  writeFileSync(tmpInput, JSON.stringify(input));

  let exitCode = 0;
  try {
    execSync(
      `cat ${tmpInput} | bun run ${HOOK_PATH} 1>${tmpStdout} 2>${tmpStderr}`,
      {
        timeout: 15000,
        env: { ...process.env, KAYA_DIR: TEMP_KAYA_DIR, ...envOverrides },
      },
    );
  } catch (err: unknown) {
    const execErr = err as { status?: number };
    exitCode = execErr.status ?? 1;
  }

  const stdout = existsSync(tmpStdout) ? readFileSync(tmpStdout, 'utf-8') : '';
  const stderr = existsSync(tmpStderr) ? readFileSync(tmpStderr, 'utf-8') : '';

  for (const f of [tmpInput, tmpStdout, tmpStderr]) {
    if (existsSync(f)) unlinkSync(f);
  }

  return { stdout, stderr, exitCode };
}

describe('SecurityValidator — exit behavior', () => {
  test('exits 0 for safe Read tool call', () => {
    const result = runHook({
      session_id: 'test-sv-1',
      tool_name: 'Read',
      tool_input: { file_path: '/tmp/test-safe-file.txt' },
    });
    expect(result.exitCode).toBe(0);
  });

  test('exits 0 for safe Bash command', () => {
    const result = runHook({
      session_id: 'test-sv-2',
      tool_name: 'Bash',
      tool_input: { command: 'echo hello world' },
    });
    expect(result.exitCode).toBe(0);
  });

  test('exits 0 with invalid JSON stdin (fail-open)', () => {
    const ts = Date.now() + '_' + Math.random().toString(36).slice(2);
    const tmpInput = `/tmp/sv_bad_${ts}.json`;
    const tmpStdout = `/tmp/sv_bad_out_${ts}.txt`;
    const tmpStderr = `/tmp/sv_bad_err_${ts}.txt`;

    writeFileSync(tmpInput, 'not valid json at all');
    let exitCode = 0;
    try {
      execSync(
        `cat ${tmpInput} | bun run ${HOOK_PATH} 1>${tmpStdout} 2>${tmpStderr}`,
        { timeout: 15000, env: { ...process.env, KAYA_DIR: TEMP_KAYA_DIR } },
      );
    } catch (err: unknown) {
      const e = err as { status?: number };
      exitCode = e.status ?? 1;
    }

    for (const f of [tmpInput, tmpStdout, tmpStderr]) {
      if (existsSync(f)) unlinkSync(f);
    }

    // Fail-open: invalid JSON should not hard-block
    expect(exitCode).toBe(0);
  });

  test('exits 2 for catastrophic rm -rf command', () => {
    const result = runHook({
      session_id: 'test-sv-3',
      tool_name: 'Bash',
      tool_input: { command: 'rm -rf /' },
    });
    // Hard block for catastrophic destructive commands
    expect(result.exitCode).toBe(2);
  });

  test('exits 2 when accessing zero-access path ~/.ssh/', () => {
    const result = runHook({
      session_id: 'test-sv-4',
      tool_name: 'Read',
      tool_input: { file_path: `${process.env.HOME}/.ssh/id_rsa` },
    });
    // ~/.ssh/ is in zeroAccess category — hard block
    expect(result.exitCode).toBe(2);
  });
});

describe('SecurityValidator — allow decisions', () => {
  test('outputs continue:true for safe git status command', () => {
    const result = runHook({
      session_id: 'test-sv-5',
      tool_name: 'Bash',
      tool_input: { command: 'git status' },
    });
    expect(result.exitCode).toBe(0);
    // Safe commands output {"continue": true}
    const parsed = JSON.parse(result.stdout.trim()) as { continue: boolean };
    expect(parsed.continue).toBe(true);
  });

  test('outputs continue:true for npm install command', () => {
    const result = runHook({
      session_id: 'test-sv-6',
      tool_name: 'Bash',
      tool_input: { command: 'npm install --dry-run' },
    });
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout.trim()) as { continue: boolean };
    expect(parsed.continue).toBe(true);
  });
});

describe('SecurityValidator — confirm decisions', () => {
  test('requests confirmation for git push --force (decision:ask)', () => {
    const result = runHook({
      session_id: 'test-sv-7',
      tool_name: 'Bash',
      tool_input: { command: 'git push --force origin main' },
    });
    // Force push is a confirm-level operation: exit 0 with decision:ask
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim().length).toBeGreaterThan(0);
    const parsed = JSON.parse(result.stdout.trim()) as { decision: string; message: string };
    expect(parsed.decision).toBe('ask');
    expect(parsed.message).toContain('Force push');
  });

  test('requests confirmation for git reset --hard (decision:ask)', () => {
    const result = runHook({
      session_id: 'test-sv-8',
      tool_name: 'Bash',
      tool_input: { command: 'git reset --hard HEAD~1' },
    });
    // Hard reset is a confirm-level operation: exit 0 with decision:ask
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim().length).toBeGreaterThan(0);
    const parsed = JSON.parse(result.stdout.trim()) as { decision: string; message: string };
    expect(parsed.decision).toBe('ask');
    expect(typeof parsed.message).toBe('string');
  });
});
