/**
 * ActivityParser.test.ts - Smoke tests for ActivityParser
 *
 * ActivityParser is a CLI-only tool (no library exports).
 * We test the pure helper functions by running the CLI with --help.
 */
import { describe, it, expect } from 'bun:test';
import { spawnSync } from 'child_process';
import { join } from 'path';
import { existsSync } from 'fs';

const ACTIVITY_PARSER_PATH = join(import.meta.dir, 'ActivityParser.ts');

describe('ActivityParser', () => {
  it('file exists', () => {
    expect(existsSync(ACTIVITY_PARSER_PATH)).toBe(true);
  });

  it('--help exits 0 and shows usage', () => {
    const result = spawnSync('bun', [ACTIVITY_PARSER_PATH, '--help'], {
      encoding: 'utf-8',
      timeout: 15000,
      env: { ...process.env },
    });
    expect(result.signal).toBeNull();
    expect(result.status).toBe(0);
    const output = result.stdout || '';
    expect(output).toContain('ActivityParser');
  });

  it('--today exits cleanly (no crash even if no sessions found)', () => {
    const result = spawnSync('bun', [ACTIVITY_PARSER_PATH, '--today'], {
      encoding: 'utf-8',
      timeout: 15000,
      env: { ...process.env },
    });
    expect(result.signal).toBeNull();
    const combined = (result.stdout || '') + (result.stderr || '');
    expect(combined).not.toContain('SyntaxError');
    expect(combined).not.toContain('Uncaught');
    // Output should be valid JSON
    if (result.stdout && result.stdout.trim()) {
      expect(() => JSON.parse(result.stdout)).not.toThrow();
    }
  });

  it('--today output is parseable JSON with expected shape', () => {
    const result = spawnSync('bun', [ACTIVITY_PARSER_PATH, '--today'], {
      encoding: 'utf-8',
      timeout: 15000,
      env: { ...process.env },
    });
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
