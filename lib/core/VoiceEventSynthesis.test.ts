/**
 * VoiceEventSynthesis.test.ts - Smoke tests for VoiceEventSynthesis CLI
 */
import { describe, it, expect } from 'bun:test';
import { spawnSync } from 'child_process';
import { join } from 'path';
import { existsSync } from 'fs';

const VES_PATH = join(import.meta.dir, 'VoiceEventSynthesis.ts');

describe('VoiceEventSynthesis', () => {
  it('file exists', () => {
    expect(existsSync(VES_PATH)).toBe(true);
  });

  it('--dry-run exits cleanly', () => {
    const result = spawnSync('bun', [VES_PATH, '--dry-run'], {
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

  it('--json --dry-run produces valid JSON when events exist', () => {
    const result = spawnSync('bun', [VES_PATH, '--json', '--dry-run'], {
      encoding: 'utf-8',
      timeout: 20000,
      env: { ...process.env },
    });
    expect(result.signal).toBeNull();
    const output = result.stdout || '';
    if (output.trim().startsWith('{')) {
      expect(() => JSON.parse(output)).not.toThrow();
      const parsed = JSON.parse(output);
      expect(typeof parsed.totalEvents).toBe('number');
    }
  });
});
