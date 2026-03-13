/**
 * YouTubeApi.test.ts - Smoke tests for YouTubeApi CLI
 *
 * YouTubeApi.ts calls process.exit(1) at module load when API key is missing.
 * We verify graceful failure behavior via CLI invocation.
 */
import { describe, it, expect } from 'bun:test';
import { spawnSync } from 'child_process';
import { join } from 'path';
import { existsSync } from 'fs';

const YOUTUBE_API_PATH = join(import.meta.dir, 'YouTubeApi.ts');

describe('YouTubeApi', () => {
  it('file exists', () => {
    expect(existsSync(YOUTUBE_API_PATH)).toBe(true);
  });

  it('exits with error code 1 when YOUTUBE_API_KEY is missing (graceful failure)', () => {
    const result = spawnSync('bun', [YOUTUBE_API_PATH, 'channel'], {
      encoding: 'utf-8',
      timeout: 10000,
      env: {
        HOME: process.env.HOME,
        PATH: process.env.PATH,
        // Deliberately omit YOUTUBE_API_KEY
      },
    });
    expect(result.signal).toBeNull();
    expect(result.status).toBe(1);
    const combined = (result.stdout || '') + (result.stderr || '');
    // Should show a clean error, not a stack trace
    expect(combined).toContain('YOUTUBE_API_KEY');
    expect(combined).not.toContain('SyntaxError');
    expect(combined).not.toContain('Uncaught TypeError');
  });

  it('does not crash with unhandled exception when key missing', () => {
    const result = spawnSync('bun', [YOUTUBE_API_PATH], {
      encoding: 'utf-8',
      timeout: 10000,
      env: {
        HOME: process.env.HOME,
        PATH: process.env.PATH,
      },
    });
    expect(result.signal).toBeNull();
    const combined = (result.stdout || '') + (result.stderr || '');
    expect(combined).not.toContain('Uncaught');
  });
});
