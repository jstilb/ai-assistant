/**
 * SessionHarvester.test.ts - Smoke tests for SessionHarvester CLI
 *
 * S8 (let-the-model-speak): `--recent 1 --dry-run` now makes a REAL
 * inference call per matched session (see SessionHarvester.ts's docblock —
 * this is a manually-invoked batch CLI that makes its own per-session
 * judgment call, not a DI-stubbable per-turn hook). That's an intentional
 * integration test per Article IX (real service, not a stub) rather than a
 * regression — the timeout below is bumped from 20s to 75s to give the
 * standard-level inference call (45s timeout inside the tool itself) room
 * to complete, and the assertions stay limited to "didn't crash" rather
 * than asserting on model output content.
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

  it('--recent 1 --dry-run exits cleanly (real inference call, S8)', () => {
    const result = spawnSync('bun', [HARVESTER_PATH, '--recent', '1', '--dry-run'], {
      encoding: 'utf-8',
      timeout: 75000,
      env: { ...process.env },
    });
    expect(result.signal).toBeNull();
    const combined = (result.stdout || '') + (result.stderr || '');
    expect(combined).not.toContain('SyntaxError');
    expect(combined).not.toContain('Uncaught');
    expect(combined).not.toContain('Cannot find module');
  }, 80000); // bun:test's own per-test timeout, separate from spawnSync's — must exceed it

  it('--session nonexistent-id --dry-run exits cleanly (no session match, no inference call)', () => {
    const result = spawnSync('bun', [HARVESTER_PATH, '--session', 'nonexistent-fake-session-id', '--dry-run'], {
      encoding: 'utf-8',
      timeout: 15000,
      env: { ...process.env },
    });
    expect(result.signal).toBeNull();
    const combined = (result.stdout || '') + (result.stderr || '');
    expect(combined).not.toContain('SyntaxError');
    expect(combined).toContain('No sessions found to harvest');
  });
});
