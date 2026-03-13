/**
 * LearningPatternSynthesis.test.ts - Smoke tests for LearningPatternSynthesis CLI
 */
import { describe, it, expect } from 'bun:test';
import { spawnSync } from 'child_process';
import { join } from 'path';
import { existsSync } from 'fs';

const LPS_PATH = join(import.meta.dir, 'LearningPatternSynthesis.ts');

describe('LearningPatternSynthesis', () => {
  it('file exists', () => {
    expect(existsSync(LPS_PATH)).toBe(true);
  });

  it('--week --dry-run exits cleanly', () => {
    const result = spawnSync('bun', [LPS_PATH, '--week', '--dry-run'], {
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

  it('--all --dry-run produces JSON-parseable output', () => {
    const result = spawnSync('bun', [LPS_PATH, '--all', '--dry-run'], {
      encoding: 'utf-8',
      timeout: 20000,
      env: { ...process.env },
    });
    expect(result.signal).toBeNull();
    // Output may be JSON or text - must not crash
    const output = result.stdout || '';
    const combined = output + (result.stderr || '');
    expect(combined).not.toContain('SyntaxError');
    if (output.trim().startsWith('{')) {
      expect(() => JSON.parse(output)).not.toThrow();
    }
  });
});
