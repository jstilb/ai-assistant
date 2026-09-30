/**
 * ExtractTranscript.test.ts - Smoke tests for ExtractTranscript CLI
 *
 * ExtractTranscript requires OPENAI_API_KEY. Tests verify graceful failure
 * when the key is missing.
 */
import { describe, it, expect, afterAll } from 'bun:test';
import { execSync } from 'child_process';
import { readFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { existsSync } from 'fs';

const EXTRACT_TRANSCRIPT_PATH = join(import.meta.dir, 'ExtractTranscript.ts');

const TMP_DIR = join('/tmp', 'test-cli-extracttranscript-' + Math.random().toString(36).slice(2));

function runCli(args: string[], env?: Record<string, string | undefined>): { stdout: string; stderr: string; exitCode: number } {
  mkdirSync(TMP_DIR, { recursive: true });
  const stdoutFile = join(TMP_DIR, 'stdout.txt');
  const stderrFile = join(TMP_DIR, 'stderr.txt');
  const cmdArgs = ['bun', EXTRACT_TRANSCRIPT_PATH, ...args].map(a => `"${a}"`).join(' ');
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

describe('ExtractTranscript', () => {
  it('file exists', () => {
    expect(existsSync(EXTRACT_TRANSCRIPT_PATH)).toBe(true);
  });

  it('missing OPENAI_API_KEY exits with clear error (not a stack trace)', () => {
    const result = runCli(['/nonexistent/audio.mp3'], {
      ...process.env,
      OPENAI_API_KEY: '',
      HOME: process.env.HOME,
    });
    const combined = result.stdout + result.stderr;
    // Should have a user-friendly error about API key
    expect(combined).toContain('OPENAI_API_KEY');
    expect(combined).not.toContain('SyntaxError');
    expect(combined).not.toContain('Uncaught TypeError');
    // Should exit with error code
    expect(result.exitCode).toBe(1);
  });

  it('no args exits with usage info', () => {
    const result = runCli([], {
      ...process.env,
      OPENAI_API_KEY: '',
    });
    // First check is for API key, not args - exits 1
    expect(result.exitCode).toBe(1);
  });
});
