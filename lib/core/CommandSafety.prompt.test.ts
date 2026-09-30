/**
 * S12 — the prompt prose and code enforcement derive from ONE scope.
 * If someone edits SELF_VERIFY_SCOPE, the rendered instructions follow;
 * these tests pin the coupling and representative allow/deny agreement.
 */
import { describe, it, expect } from 'bun:test';
import {
  describeScopeForPrompt,
  SELF_VERIFY_SCOPE,
  BASE_SAFE_EXECUTABLES,
  isCommandSafe,
} from './CommandSafety.ts';

describe('describeScopeForPrompt(SELF_VERIFY_SCOPE)', () => {
  const prose = describeScopeForPrompt(SELF_VERIFY_SCOPE);

  it('mentions every allowlisted executable (base + extensions)', () => {
    for (const exe of [...BASE_SAFE_EXECUTABLES, ...SELF_VERIFY_SCOPE.additionalExecutables]) {
      expect(prose).toContain(exe);
    }
  });

  it('carries the universal prohibitions', () => {
    expect(prose).toContain('Never run `claude`');
    expect(prose).toContain('Never install packages');
    expect(prose).toContain('Never push');
  });

  it('states the git policy for the scope', () => {
    expect(prose.toLowerCase()).toContain('git is allowed');
  });
});

describe('lanes agree on representative allow/deny (shared scope)', () => {
  const allow = ['bun test lib/core/Foo.test.ts', 'bunx tsc --noEmit', 'git diff', 'ls -la', 'grep -rn foo lib/'];
  const deny = ['claude -p "do things"', 'brew install cowsay'];

  for (const cmd of allow) {
    it(`allows: ${cmd}`, () => {
      expect(isCommandSafe(cmd, SELF_VERIFY_SCOPE)).toBe(true);
    });
  }
  for (const cmd of deny) {
    it(`denies: ${cmd}`, () => {
      expect(isCommandSafe(cmd, SELF_VERIFY_SCOPE)).toBe(false);
    });
  }
});
