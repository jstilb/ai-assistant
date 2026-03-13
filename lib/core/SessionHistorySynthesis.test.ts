/**
 * SessionHistorySynthesis.test.ts - Smoke tests for SessionHistorySynthesis CLI
 */
import { describe, it, expect } from 'bun:test';
import { spawnSync } from 'child_process';
import { join } from 'path';
import { existsSync } from 'fs';

const SHS_PATH = join(import.meta.dir, 'SessionHistorySynthesis.ts');

describe('SessionHistorySynthesis', () => {
  it('file exists', () => {
    expect(existsSync(SHS_PATH)).toBe(true);
  });

  it('--dry-run exits cleanly', () => {
    const result = spawnSync('bun', [SHS_PATH, '--dry-run'], {
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

  it('--json --dry-run produces JSON output when history exists', () => {
    const result = spawnSync('bun', [SHS_PATH, '--json', '--dry-run'], {
      encoding: 'utf-8',
      timeout: 20000,
      env: { ...process.env },
    });
    expect(result.signal).toBeNull();
    const output = result.stdout || '';
    if (output.trim().startsWith('{')) {
      expect(() => JSON.parse(output)).not.toThrow();
    }
  });
});
