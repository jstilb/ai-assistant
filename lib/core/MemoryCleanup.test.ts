/**
 * MemoryCleanup.test.ts - Smoke tests for MemoryCleanup CLI
 */
import { describe, it, expect } from 'bun:test';
import { spawnSync } from 'child_process';
import { join } from 'path';
import { existsSync } from 'fs';

const MEMORY_CLEANUP_PATH = join(import.meta.dir, 'MemoryCleanup.ts');

describe('MemoryCleanup', () => {
  it('file exists', () => {
    expect(existsSync(MEMORY_CLEANUP_PATH)).toBe(true);
  });

  it('all --dry-run exits cleanly without crashing', () => {
    const result = spawnSync('bun', [MEMORY_CLEANUP_PATH, 'all', '--dry-run'], {
      encoding: 'utf-8',
      timeout: 20000,
      env: { ...process.env },
    });
    expect(result.signal).toBeNull();
    const combined = (result.stdout || '') + (result.stderr || '');
    expect(combined).not.toContain('SyntaxError');
    expect(combined).not.toContain('Uncaught');
    expect(combined).not.toContain('Cannot find module');
  });

  it('all --dry-run --json produces JSON output', () => {
    const result = spawnSync('bun', [MEMORY_CLEANUP_PATH, 'all', '--dry-run', '--json'], {
      encoding: 'utf-8',
      timeout: 20000,
      env: { ...process.env },
    });
    expect(result.signal).toBeNull();
    const output = result.stdout || '';
    if (output.trim()) {
      // Should be valid JSON
      expect(() => JSON.parse(output)).not.toThrow();
      const parsed = JSON.parse(output);
      expect(typeof parsed.dryRun).toBe('boolean');
      expect(parsed.dryRun).toBe(true);
    }
  });

  it('debug --dry-run exits cleanly', () => {
    const result = spawnSync('bun', [MEMORY_CLEANUP_PATH, 'debug', '--dry-run'], {
      encoding: 'utf-8',
      timeout: 15000,
      env: { ...process.env },
    });
    expect(result.signal).toBeNull();
    const combined = (result.stdout || '') + (result.stderr || '');
    expect(combined).not.toContain('SyntaxError');
  });
});
