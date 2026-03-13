/**
 * SessionHarvester.test.ts - Smoke tests for SessionHarvester CLI
 */
import { describe, it, expect } from 'bun:test';
import { spawnSync } from 'child_process';
import { join } from 'path';
import { existsSync } from 'fs';

const HARVESTER_PATH = join(import.meta.dir, 'SessionHarvester.ts');

describe('SessionHarvester', () => {
  it('file exists', () => {
    expect(existsSync(HARVESTER_PATH)).toBe(true);
  });

  it('--recent 1 --dry-run exits cleanly', () => {
    const result = spawnSync('bun', [HARVESTER_PATH, '--recent', '1', '--dry-run'], {
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

  it('--session nonexistent-id --dry-run exits cleanly', () => {
    const result = spawnSync('bun', [HARVESTER_PATH, '--session', 'nonexistent-fake-session-id', '--dry-run'], {
      encoding: 'utf-8',
      timeout: 15000,
      env: { ...process.env },
    });
    expect(result.signal).toBeNull();
    const combined = (result.stdout || '') + (result.stderr || '');
    expect(combined).not.toContain('SyntaxError');
  });
});
