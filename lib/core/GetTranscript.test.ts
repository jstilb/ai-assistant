/**
 * GetTranscript.test.ts - Smoke tests for GetTranscript CLI
 *
 * GetTranscript uses fabric CLI for YouTube transcripts.
 */
import { describe, it, expect } from 'bun:test';
import { spawnSync } from 'child_process';
import { join } from 'path';
import { existsSync } from 'fs';

const GET_TRANSCRIPT_PATH = join(import.meta.dir, 'GetTranscript.ts');

describe('GetTranscript', () => {
  it('file exists', () => {
    expect(existsSync(GET_TRANSCRIPT_PATH)).toBe(true);
  });

  it('--help exits 0 with usage info', () => {
    const result = spawnSync('bun', [GET_TRANSCRIPT_PATH, '--help'], {
      encoding: 'utf-8',
      timeout: 10000,
      env: { ...process.env },
    });
    expect(result.signal).toBeNull();
    expect(result.status).toBe(0);
    const output = result.stdout || '';
    expect(output).toContain('GetTranscript');
    expect(output).toContain('youtube');
  });

  it('no args exits 0 (shows help)', () => {
    const result = spawnSync('bun', [GET_TRANSCRIPT_PATH], {
      encoding: 'utf-8',
      timeout: 10000,
      env: { ...process.env },
    });
    expect(result.signal).toBeNull();
    expect(result.status).toBe(0);
  });

  it('invalid URL exits 1 with error message', () => {
    const result = spawnSync('bun', [GET_TRANSCRIPT_PATH, 'notaurl'], {
      encoding: 'utf-8',
      timeout: 10000,
      env: { ...process.env },
    });
    expect(result.signal).toBeNull();
    expect(result.status).toBe(1);
    const combined = (result.stdout || '') + (result.stderr || '');
    expect(combined).toContain('YouTube URL');
  });

  it('does not crash with SyntaxError', () => {
    const result = spawnSync('bun', [GET_TRANSCRIPT_PATH, '--help'], {
      encoding: 'utf-8',
      timeout: 10000,
      env: { ...process.env },
    });
    const combined = (result.stdout || '') + (result.stderr || '');
    expect(combined).not.toContain('SyntaxError');
    expect(combined).not.toContain('Cannot find module');
  });
});
