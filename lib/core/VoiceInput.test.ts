/**
 * VoiceInput.test.ts - Smoke tests for VoiceInput CLI
 *
 * VoiceInput requires sox and faster-whisper. Tests verify graceful failure
 * when these dependencies are missing or in CI environments.
 */
import { describe, it, expect } from 'bun:test';
import { spawnSync } from 'child_process';
import { join } from 'path';
import { existsSync } from 'fs';

const VOICE_INPUT_PATH = join(import.meta.dir, 'VoiceInput.ts');

describe('VoiceInput', () => {
  it('file exists', () => {
    expect(existsSync(VOICE_INPUT_PATH)).toBe(true);
  });

  it('help command exits cleanly', () => {
    const result = spawnSync('bun', [VOICE_INPUT_PATH, 'help'], {
      encoding: 'utf-8',
      timeout: 10000,
      env: { ...process.env },
    });
    expect(result.signal).toBeNull();
    const combined = (result.stdout || '') + (result.stderr || '');
    expect(combined).not.toContain('SyntaxError');
    expect(combined).not.toContain('Cannot find module');
  });

  it('status command exits without unhandled error', () => {
    const result = spawnSync('bun', [VOICE_INPUT_PATH, 'status'], {
      encoding: 'utf-8',
      timeout: 10000,
      env: { ...process.env },
    });
    expect(result.signal).toBeNull();
    const combined = (result.stdout || '') + (result.stderr || '');
    expect(combined).not.toContain('SyntaxError');
    // Status should indicate not running or running - not a crash
    expect(combined).not.toContain('Uncaught');
  });

  it('help output mentions VoiceInput', () => {
    const result = spawnSync('bun', [VOICE_INPUT_PATH, 'help'], {
      encoding: 'utf-8',
      timeout: 10000,
      env: { ...process.env },
    });
    const combined = (result.stdout || '') + (result.stderr || '');
    expect(combined.toLowerCase()).toContain('voice');
  });
});
