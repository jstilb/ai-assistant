/**
 * GetTranscript.test.ts - Smoke tests for GetTranscript CLI
 *
 * GetTranscript uses fabric CLI for YouTube transcripts.
 */
import { describe, it, expect, afterAll } from 'bun:test';
import { execSync } from 'child_process';
import { readFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { existsSync } from 'fs';

const GET_TRANSCRIPT_PATH = join(import.meta.dir, 'GetTranscript.ts');

const TMP_DIR = join('/tmp', 'test-cli-gettranscript-' + Math.random().toString(36).slice(2));

function runCli(args: string[], env?: Record<string, string | undefined>): { stdout: string; stderr: string; exitCode: number } {
  mkdirSync(TMP_DIR, { recursive: true });
  const stdoutFile = join(TMP_DIR, 'stdout.txt');
  const stderrFile = join(TMP_DIR, 'stderr.txt');
  const cmdArgs = ['bun', GET_TRANSCRIPT_PATH, ...args].map(a => `"${a}"`).join(' ');
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

describe('GetTranscript', () => {
  it('file exists', () => {
    expect(existsSync(GET_TRANSCRIPT_PATH)).toBe(true);
  });

  it('--help exits 0 with usage info', () => {
    const result = runCli(['--help']);
    expect(result.exitCode).toBe(0);
    const output = result.stdout;
    expect(output).toContain('GetTranscript');
    expect(output).toContain('youtube');
  });

  it('no args exits 0 (shows help)', () => {
    const result = runCli([]);
    expect(result.exitCode).toBe(0);
  });

  it('invalid URL exits 1 with error message', () => {
    const result = runCli(['notaurl']);
    expect(result.exitCode).toBe(1);
    const combined = result.stdout + result.stderr;
    expect(combined).toContain('YouTube URL');
  });

  it('does not crash with SyntaxError', () => {
    const result = runCli(['--help']);
    const combined = result.stdout + result.stderr;
    expect(combined).not.toContain('SyntaxError');
    expect(combined).not.toContain('Cannot find module');
  });
});
