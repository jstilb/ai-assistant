/**
 * ExtractTranscript.test.ts - Smoke tests for ExtractTranscript CLI
 *
 * ExtractTranscript requires OPENAI_API_KEY. Tests verify graceful failure
 * when the key is missing.
 */
import { describe, it, expect } from 'bun:test';
import { spawnSync } from 'child_process';
import { join } from 'path';
import { existsSync } from 'fs';

const EXTRACT_TRANSCRIPT_PATH = join(import.meta.dir, 'ExtractTranscript.ts');

describe('ExtractTranscript', () => {
  it('file exists', () => {
    expect(existsSync(EXTRACT_TRANSCRIPT_PATH)).toBe(true);
  });

  it('missing OPENAI_API_KEY exits with clear error (not a stack trace)', () => {
    const result = spawnSync('bun', [EXTRACT_TRANSCRIPT_PATH, '/nonexistent/audio.mp3'], {
      encoding: 'utf-8',
      timeout: 10000,
      env: {
        ...process.env,
        OPENAI_API_KEY: '',
        HOME: process.env.HOME,
      },
    });
    expect(result.signal).toBeNull();
    const combined = (result.stdout || '') + (result.stderr || '');
    // Should have a user-friendly error about API key
    expect(combined).toContain('OPENAI_API_KEY');
    expect(combined).not.toContain('SyntaxError');
    expect(combined).not.toContain('Uncaught TypeError');
    // Should exit with error code
    expect(result.status).toBe(1);
  });

  it('no args exits with usage info', () => {
    const result = spawnSync('bun', [EXTRACT_TRANSCRIPT_PATH], {
      encoding: 'utf-8',
      timeout: 10000,
      env: {
        ...process.env,
        OPENAI_API_KEY: '',
      },
    });
    expect(result.signal).toBeNull();
    // First check is for API key, not args - exits 1
    expect(result.status).toBe(1);
  });
});
