/**
 * ActivityParser.test.ts - Smoke tests for ActivityParser
 *
 * ActivityParser is a CLI-only tool (no library exports).
 * We test the pure helper functions by running the CLI with --help.
 */
import { describe, it, expect, afterAll } from 'bun:test';
import { execSync } from 'child_process';
import { readFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { existsSync } from 'fs';

const ACTIVITY_PARSER_PATH = join(import.meta.dir, 'ActivityParser.ts');

const TMP_DIR = join('/tmp', 'test-cli-activityparser-' + Math.random().toString(36).slice(2));

function runCli(args: string[], env?: Record<string, string | undefined>): { stdout: string; stderr: string; exitCode: number } {
  mkdirSync(TMP_DIR, { recursive: true });
  const stdoutFile = join(TMP_DIR, 'stdout.txt');
  const stderrFile = join(TMP_DIR, 'stderr.txt');
  const cmdArgs = ['bun', ACTIVITY_PARSER_PATH, ...args].map(a => `"${a}"`).join(' ');
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

describe('ActivityParser', () => {
  it('file exists', () => {
    expect(existsSync(ACTIVITY_PARSER_PATH)).toBe(true);
  });

  it('--help exits 0 and shows usage', () => {
    const result = runCli(['--help']);
    expect(result.exitCode).toBe(0);
    const output = result.stdout;
    expect(output).toContain('ActivityParser');
  });

  it('--today exits cleanly (no crash even if no sessions found)', () => {
    const result = runCli(['--today']);
    const combined = result.stdout + result.stderr;
    expect(combined).not.toContain('SyntaxError');
    expect(combined).not.toContain('Uncaught');
    // Output should be valid JSON
    if (result.stdout && result.stdout.trim()) {
      expect(() => JSON.parse(result.stdout)).not.toThrow();
    }
  });

  it('--today output is parseable JSON with expected shape', () => {
    const result = runCli(['--today']);
    if (result.stdout && result.stdout.trim()) {
      const parsed = JSON.parse(result.stdout);
      expect(typeof parsed.date).toBe('string');
      expect(typeof parsed.summary).toBe('string');
      expect(Array.isArray(parsed.files_modified)).toBe(true);
      expect(Array.isArray(parsed.files_created)).toBe(true);
      expect(Array.isArray(parsed.skills_affected)).toBe(true);
      expect(typeof parsed.categories).toBe('object');
    }
  });
});
