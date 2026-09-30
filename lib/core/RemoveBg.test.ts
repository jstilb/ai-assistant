/**
 * RemoveBg.test.ts - Smoke tests for RemoveBg CLI
 *
 * RemoveBg requires remove.bg API key. Tests verify graceful failure behavior.
 */
import { describe, it, expect, afterAll } from 'bun:test';
import { execSync } from 'child_process';
import { readFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { existsSync } from 'fs';

const REMOVE_BG_PATH = join(import.meta.dir, 'RemoveBg.ts');

const TMP_DIR = join('/tmp', 'test-cli-removebg-' + Math.random().toString(36).slice(2));

function runCli(args: string[], env?: Record<string, string | undefined>): { stdout: string; stderr: string; exitCode: number } {
  mkdirSync(TMP_DIR, { recursive: true });
  const stdoutFile = join(TMP_DIR, 'stdout.txt');
  const stderrFile = join(TMP_DIR, 'stderr.txt');
  const cmdArgs = ['bun', REMOVE_BG_PATH, ...args].map(a => `"${a}"`).join(' ');
  let exitCode = 0;
  try {
    execSync(`${cmdArgs} 1>"${stdoutFile}" 2>"${stderrFile}"`, {
      timeout: 10000,
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

describe('RemoveBg', () => {
  it('file exists', () => {
    expect(existsSync(REMOVE_BG_PATH)).toBe(true);
  });

  it('--help exits 0 with usage info', () => {
    const result = runCli(['--help']);
    expect(result.exitCode).toBe(0);
    const output = result.stdout;
    expect(output).toContain('remove-bg');
  });

  it('missing API key results in graceful error (no stack trace)', () => {
    const result = runCli(['/nonexistent/file.png'], {
      ...process.env,
      REMOVE_BG_API_KEY: '',
      HOME: process.env.HOME,
    });
    const combined = result.stdout + result.stderr;
    // Should not be an unhandled JS crash
    expect(combined).not.toContain('SyntaxError');
    expect(combined).not.toContain('Uncaught');
  });

  it('does not crash with SyntaxError on import', () => {
    const result = runCli(['--help']);
    const combined = result.stdout + result.stderr;
    expect(combined).not.toContain('SyntaxError');
    expect(combined).not.toContain('Cannot find module');
  });
});
