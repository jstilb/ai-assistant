/**
 * RemoveBg.test.ts - Smoke tests for RemoveBg CLI
 *
 * RemoveBg requires remove.bg API key. Tests verify graceful failure behavior.
 */
import { describe, it, expect } from 'bun:test';
import { spawnSync } from 'child_process';
import { join } from 'path';
import { existsSync } from 'fs';

const REMOVE_BG_PATH = join(import.meta.dir, 'RemoveBg.ts');

describe('RemoveBg', () => {
  it('file exists', () => {
    expect(existsSync(REMOVE_BG_PATH)).toBe(true);
  });

  it('--help exits 0 with usage info', () => {
    const result = spawnSync('bun', [REMOVE_BG_PATH, '--help'], {
      encoding: 'utf-8',
      timeout: 10000,
      env: { ...process.env },
    });
    expect(result.signal).toBeNull();
    expect(result.status).toBe(0);
    const output = result.stdout || '';
    expect(output).toContain('remove-bg');
  });

  it('missing API key results in graceful error (no stack trace)', () => {
    const result = spawnSync('bun', [REMOVE_BG_PATH, '/nonexistent/file.png'], {
      encoding: 'utf-8',
      timeout: 10000,
      env: {
        ...process.env,
        REMOVE_BG_API_KEY: '',
        HOME: process.env.HOME,
      },
    });
    expect(result.signal).toBeNull();
    const combined = (result.stdout || '') + (result.stderr || '');
    // Should not be an unhandled JS crash
    expect(combined).not.toContain('SyntaxError');
    expect(combined).not.toContain('Uncaught');
  });

  it('does not crash with SyntaxError on import', () => {
    const result = spawnSync('bun', [REMOVE_BG_PATH, '--help'], {
      encoding: 'utf-8',
      timeout: 10000,
      env: { ...process.env },
    });
    const combined = (result.stdout || '') + (result.stderr || '');
    expect(combined).not.toContain('SyntaxError');
    expect(combined).not.toContain('Cannot find module');
  });
});
