/**
 * YouTubeApi.test.ts - Smoke tests for YouTubeApi CLI
 *
 * YouTubeApi.ts calls process.exit(1) at module load when API key is missing.
 * We verify graceful failure behavior via CLI invocation.
 */
import { describe, it, expect, afterAll } from 'bun:test';
import { execSync } from 'child_process';
import { readFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { existsSync } from 'fs';

const YOUTUBE_API_PATH = join(import.meta.dir, 'YouTubeApi.ts');

const TMP_DIR = join('/tmp', 'test-cli-youtubeapi-' + Math.random().toString(36).slice(2));

function runCli(args: string[], env?: Record<string, string | undefined>): { stdout: string; stderr: string; exitCode: number } {
  mkdirSync(TMP_DIR, { recursive: true });
  const stdoutFile = join(TMP_DIR, 'stdout.txt');
  const stderrFile = join(TMP_DIR, 'stderr.txt');
  const cmdArgs = ['bun', YOUTUBE_API_PATH, ...args].map(a => `"${a}"`).join(' ');
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

describe('YouTubeApi', () => {
  it('file exists', () => {
    expect(existsSync(YOUTUBE_API_PATH)).toBe(true);
  });

  it('exits with error code 1 when YOUTUBE_API_KEY is missing (graceful failure)', () => {
    const result = runCli(['channel'], {
      HOME: process.env.HOME,
      PATH: process.env.PATH,
      // Deliberately omit YOUTUBE_API_KEY
    });
    expect(result.exitCode).toBe(1);
    const combined = result.stdout + result.stderr;
    // Should show a clean error, not a stack trace
    expect(combined).toContain('YOUTUBE_API_KEY');
    expect(combined).not.toContain('SyntaxError');
    expect(combined).not.toContain('Uncaught TypeError');
  });

  it('does not crash with unhandled exception when key missing', () => {
    const result = runCli([], {
      HOME: process.env.HOME,
      PATH: process.env.PATH,
    });
    const combined = result.stdout + result.stderr;
    expect(combined).not.toContain('Uncaught');
  });
});
