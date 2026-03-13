/**
 * Banner.test.ts - Smoke tests for Banner
 *
 * Banner is a CLI tool that renders to terminal. We verify it imports
 * and runs without crashing in a non-interactive environment.
 */
import { describe, it, expect } from 'bun:test';
import { spawnSync } from 'child_process';
import { join } from 'path';
import { existsSync } from 'fs';

const BANNER_PATH = join(import.meta.dir, 'Banner.ts');

describe('Banner', () => {
  it('file exists', () => {
    expect(existsSync(BANNER_PATH)).toBe(true);
  });

  it('runs without crashing and produces output', () => {
    const result = spawnSync('bun', [BANNER_PATH], {
      encoding: 'utf-8',
      timeout: 15000,
      env: { ...process.env, TERM: 'xterm-256color', COLUMNS: '100' },
    });
    // Should not crash
    expect(result.signal).toBeNull();
    const combined = (result.stdout || '') + (result.stderr || '');
    expect(combined).not.toContain('SyntaxError');
    expect(combined).not.toContain('Cannot find module');
  });

  it('produces some output (not empty)', () => {
    const result = spawnSync('bun', [BANNER_PATH], {
      encoding: 'utf-8',
      timeout: 15000,
      env: { ...process.env, TERM: 'xterm-256color', COLUMNS: '100' },
    });
    const total = (result.stdout || '').length + (result.stderr || '').length;
    expect(total).toBeGreaterThan(0);
  });
});
