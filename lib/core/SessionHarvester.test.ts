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
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'fs';
import { tmpdir, userInfo } from 'os';

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

  // Phone sessions (Remote Control server, bin/claude-remote-server) run under the
  // claude-browser config dir and write transcripts there, in per-worktree project
  // dirs (--spawn worktree). The fixture transcripts have no readable turns, so the
  // harvester skips them before any inference call.
  describe('claude-browser (phone) sessions', () => {
    const slug = `-Users-${process.env.USER || userInfo().username}--claude`;
    const makeBrowserHome = () => {
      const home = mkdtempSync(join(tmpdir(), 'harvester-browser-'));
      const write = (dir: string, id: string) => {
        mkdirSync(join(home, 'projects', dir), { recursive: true });
        const file = join(home, 'projects', dir, `${id}.jsonl`);
        writeFileSync(file, JSON.stringify({ type: 'summary', sessionId: id }) + '\n');
        const future = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000); // newest of all sessions
        utimesSync(file, future, future);
      };
      write(`${slug}--claude-worktrees-bridge-cse-test`, 'phone-session-fixture-0001');
      write('-Users-someone-else', 'unrelated-project-fixture-0002');
      return home;
    };
    const run = (home: string, args: string[]) => {
      const result = spawnSync('bun', [HARVESTER_PATH, ...args, '--dry-run'], {
        encoding: 'utf-8',
        timeout: 15000,
        env: { ...process.env, CLAUDE_BROWSER_HOME: home },
      });
      return (result.stdout || '') + (result.stderr || '');
    };

    it('--recent picks up a phone session from a browser worktree project dir', () => {
      const home = makeBrowserHome();
      try {
        const out = run(home, ['--recent', '1']);
        expect(out).toContain('Scanning 1 session(s) (1 from phone/claude-browser sessions)');
        expect(out).toContain('No new learnings found');
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    });

    it('--session finds a phone session by id, and ignores other projects in the browser dir', () => {
      const home = makeBrowserHome();
      try {
        expect(run(home, ['--session', 'phone-session-fixture-0001'])).toContain('(1 from phone/claude-browser sessions)');
        expect(run(home, ['--session', 'unrelated-project-fixture-0002'])).toContain('No sessions found to harvest');
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    });
  });
});
