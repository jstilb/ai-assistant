/**
 * VoiceInput.test.ts - Smoke tests for VoiceInput CLI
 *
 * VoiceInput requires sox and faster-whisper. Tests verify graceful failure
 * when these dependencies are missing or in CI environments.
 */
import { describe, it, expect, afterAll } from 'bun:test';
import { execSync } from 'child_process';
import { readFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { existsSync } from 'fs';

const VOICE_INPUT_PATH = join(import.meta.dir, 'VoiceInput.ts');

const TMP_DIR = join('/tmp', 'test-cli-voiceinput-' + Math.random().toString(36).slice(2));

function runCli(args: string[], env?: Record<string, string | undefined>): { stdout: string; stderr: string; exitCode: number } {
  mkdirSync(TMP_DIR, { recursive: true });
  const stdoutFile = join(TMP_DIR, 'stdout.txt');
  const stderrFile = join(TMP_DIR, 'stderr.txt');
  const cmdArgs = ['bun', VOICE_INPUT_PATH, ...args].map(a => `"${a}"`).join(' ');
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

describe('VoiceInput', () => {
  it('file exists', () => {
    expect(existsSync(VOICE_INPUT_PATH)).toBe(true);
  });

  it('help command exits cleanly', () => {
    const result = runCli(['help']);
    const combined = result.stdout + result.stderr;
    expect(combined).not.toContain('SyntaxError');
    expect(combined).not.toContain('Cannot find module');
  });

  it('status command exits without unhandled error', () => {
    const result = runCli(['status']);
    const combined = result.stdout + result.stderr;
    expect(combined).not.toContain('SyntaxError');
    // Status should indicate not running or running - not a crash
    expect(combined).not.toContain('Uncaught');
  });

  it('help output mentions VoiceInput', () => {
    const result = runCli(['help']);
    const combined = result.stdout + result.stderr;
    expect(combined.toLowerCase()).toContain('voice');
  });
});
