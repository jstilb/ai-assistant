/**
 * AddBg.test.ts - Smoke tests for AddBg CLI
 *
 * AddBg requires ImageMagick. Tests verify graceful failure behavior.
 */
import { describe, it, expect } from 'bun:test';
import { spawnSync } from 'child_process';
import { join } from 'path';
import { existsSync } from 'fs';

const ADD_BG_PATH = join(import.meta.dir, 'AddBg.ts');

describe('AddBg', () => {
  it('file exists', () => {
    expect(existsSync(ADD_BG_PATH)).toBe(true);
  });

  it('--help exits 0 with usage info', () => {
    const result = spawnSync('bun', [ADD_BG_PATH, '--help'], {
      encoding: 'utf-8',
      timeout: 10000,
      env: { ...process.env },
    });
    expect(result.signal).toBeNull();
    expect(result.status).toBe(0);
    const output = result.stdout || '';
    expect(output).toContain('add-bg');
    expect(output).toContain('USAGE');
  });

  it('no args exits 0 (shows help)', () => {
    const result = spawnSync('bun', [ADD_BG_PATH], {
      encoding: 'utf-8',
      timeout: 10000,
      env: { ...process.env },
    });
    expect(result.signal).toBeNull();
    // No args triggers help, exits 0
    expect(result.status).toBe(0);
  });

  it('missing input file exits 1 with clear error message', () => {
    const result = spawnSync('bun', [ADD_BG_PATH, '/nonexistent/file.png', '#FFFFFF', '/tmp/out.png'], {
      encoding: 'utf-8',
      timeout: 10000,
      env: { ...process.env },
    });
    expect(result.signal).toBeNull();
    expect(result.status).toBe(1);
    const combined = (result.stdout || '') + (result.stderr || '');
    expect(combined).toContain('File not found');
  });

  it('invalid hex color exits 1 with clear error', () => {
    // Create a fake PNG file to pass the file exists check
    const { mkdtempSync, writeFileSync } = require('fs');
    const tmpDir = mkdtempSync('/tmp/addbg-test-');
    const fakeInput = join(tmpDir, 'test.png');
    writeFileSync(fakeInput, Buffer.from([0x89, 0x50, 0x4e, 0x47])); // Fake PNG header

    const result = spawnSync('bun', [ADD_BG_PATH, fakeInput, 'notahexcolor', '/tmp/out.png'], {
      encoding: 'utf-8',
      timeout: 10000,
      env: { ...process.env },
    });
    expect(result.signal).toBeNull();
    expect(result.status).toBe(1);
    const combined = (result.stdout || '') + (result.stderr || '');
    expect(combined).toContain('Invalid hex color');
  });

  it('does not crash with SyntaxError', () => {
    const result = spawnSync('bun', [ADD_BG_PATH, '--help'], {
      encoding: 'utf-8',
      timeout: 10000,
      env: { ...process.env },
    });
    const combined = (result.stdout || '') + (result.stderr || '');
    expect(combined).not.toContain('SyntaxError');
    expect(combined).not.toContain('Cannot find module');
  });
});
