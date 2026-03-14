/**
 * AddBg.test.ts - Smoke tests for AddBg CLI
 *
 * AddBg requires ImageMagick. Tests verify graceful failure behavior.
 */
import { describe, it, expect, afterAll } from 'bun:test';
import { execSync } from 'child_process';
import { readFileSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { existsSync } from 'fs';

const ADD_BG_PATH = join(import.meta.dir, 'AddBg.ts');

const TMP_DIR = join('/tmp', 'test-cli-addbg-' + Math.random().toString(36).slice(2));

function runCli(args: string[], env?: Record<string, string | undefined>): { stdout: string; stderr: string; exitCode: number } {
  mkdirSync(TMP_DIR, { recursive: true });
  const stdoutFile = join(TMP_DIR, 'stdout.txt');
  const stderrFile = join(TMP_DIR, 'stderr.txt');
  const cmdArgs = ['bun', ADD_BG_PATH, ...args].map(a => `"${a}"`).join(' ');
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

describe('AddBg', () => {
  it('file exists', () => {
    expect(existsSync(ADD_BG_PATH)).toBe(true);
  });

  it('--help exits 0 with usage info', () => {
    const result = runCli(['--help']);
    expect(result.exitCode).toBe(0);
    const output = result.stdout;
    expect(output).toContain('add-bg');
    expect(output).toContain('USAGE');
  });

  it('no args exits 0 (shows help)', () => {
    const result = runCli([]);
    // No args triggers help, exits 0
    expect(result.exitCode).toBe(0);
  });

  it('missing input file exits 1 with clear error message', () => {
    const result = runCli(['/nonexistent/file.png', '#FFFFFF', '/tmp/out.png']);
    expect(result.exitCode).toBe(1);
    const combined = result.stdout + result.stderr;
    expect(combined).toContain('File not found');
  });

  it('invalid hex color exits 1 with clear error', () => {
    // Create a fake PNG file to pass the file exists check
    mkdirSync(TMP_DIR, { recursive: true });
    const fakeInput = join(TMP_DIR, 'test.png');
    writeFileSync(fakeInput, Buffer.from([0x89, 0x50, 0x4e, 0x47])); // Fake PNG header

    const result = runCli([fakeInput, 'notahexcolor', '/tmp/out.png']);
    expect(result.exitCode).toBe(1);
    const combined = result.stdout + result.stderr;
    expect(combined).toContain('Invalid hex color');
  });

  it('does not crash with SyntaxError', () => {
    const result = runCli(['--help']);
    const combined = result.stdout + result.stderr;
    expect(combined).not.toContain('SyntaxError');
    expect(combined).not.toContain('Cannot find module');
  });
});
