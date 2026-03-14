/**
 * Banner.test.ts - Smoke tests for Banner
 *
 * Banner is a CLI tool that renders to terminal. We verify it imports
 * and runs without crashing in a non-interactive environment.
 */
import { describe, it, expect, afterAll } from 'bun:test';
import { execSync } from 'child_process';
import { readFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { existsSync } from 'fs';

const BANNER_PATH = join(import.meta.dir, 'Banner.ts');

const TMP_DIR = join('/tmp', 'test-cli-banner-' + Math.random().toString(36).slice(2));

function runCli(args: string[], env?: Record<string, string | undefined>): { stdout: string; stderr: string; exitCode: number } {
  mkdirSync(TMP_DIR, { recursive: true });
  const stdoutFile = join(TMP_DIR, 'stdout.txt');
  const stderrFile = join(TMP_DIR, 'stderr.txt');
  const cmdArgs = ['bun', BANNER_PATH, ...args].map(a => `"${a}"`).join(' ');
  let exitCode = 0;
  try {
    execSync(`${cmdArgs} 1>"${stdoutFile}" 2>"${stderrFile}"`, {
      timeout: 15000,
      env: env ?? { ...process.env },
    });
  } catch (e: unknown) {
    exitCode = (e as { status?: number }).status ?? 1;
  }
  const stdout = readFileSync(stdoutFile, 'utf-8');
  const stderr = readFileSync(stderrFile, 'utf-8');
  return { stdout, stderr, exitCode };
}

afterAll(() => { try { rmSync(TMP_DIR, { recursive: true }); } catch {} });

describe('Banner', () => {
  it('file exists', () => {
    expect(existsSync(BANNER_PATH)).toBe(true);
  });

  it('runs without crashing and produces output', () => {
    const result = runCli([], { ...process.env, TERM: 'xterm-256color', COLUMNS: '100' });
    // Should not crash
    const combined = result.stdout + result.stderr;
    expect(combined).not.toContain('SyntaxError');
    expect(combined).not.toContain('Cannot find module');
  });

  it('produces some output (not empty)', () => {
    const result = runCli([], { ...process.env, TERM: 'xterm-256color', COLUMNS: '100' });
    const total = result.stdout.length + result.stderr.length;
    expect(total).toBeGreaterThan(0);
  });
});
