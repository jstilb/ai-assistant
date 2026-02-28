/**
 * WorkValidator.hook.ts — Integration Tests
 * ==========================================
 * Tests for the SessionEnd work validation hook.
 * Runs the hook as a subprocess and validates exit behavior and logging.
 */

import { describe, test, expect } from 'bun:test';
import { join } from 'path';
import {
  writeFileSync,
  unlinkSync,
  existsSync,
  readFileSync,
  mkdirSync,
  rmSync,
} from 'fs';
import { execSync } from 'child_process';

const HOOK_PATH = join(import.meta.dir, '../../hooks/WorkValidator.hook.ts');
const KAYA_DIR = join(import.meta.dir, '../..');

function runHook(
  input: Record<string, unknown>,
  envOverrides: Record<string, string> = {},
): { stdout: string; stderr: string; exitCode: number } {
  const ts = Date.now() + '_' + Math.random().toString(36).slice(2);
  const tmpInput = `/tmp/wv_in_${ts}.json`;
  const tmpStdout = `/tmp/wv_out_${ts}.txt`;
  const tmpStderr = `/tmp/wv_err_${ts}.txt`;

  writeFileSync(tmpInput, JSON.stringify(input));

  let exitCode = 0;
  try {
    execSync(
      `cat ${tmpInput} | bun run ${HOOK_PATH} 1>${tmpStdout} 2>${tmpStderr}`,
      {
        timeout: 15000,
        env: { ...process.env, KAYA_DIR, ...envOverrides },
      },
    );
  } catch (err: unknown) {
    const e = err as { status?: number };
    exitCode = e.status ?? 1;
  }

  const stdout = existsSync(tmpStdout) ? readFileSync(tmpStdout, 'utf-8') : '';
  const stderr = existsSync(tmpStderr) ? readFileSync(tmpStderr, 'utf-8') : '';

  for (const f of [tmpInput, tmpStdout, tmpStderr]) {
    if (existsSync(f)) unlinkSync(f);
  }

  return { stdout, stderr, exitCode };
}

describe('WorkValidator — exit behavior', () => {
  test('always exits 0 (non-blocking — fail-open by design)', () => {
    const result = runHook({ conversation_id: 'test-wv-1' });
    expect(result.exitCode).toBe(0);
  });

  test('exits 0 even with no current work state (graceful no-op)', () => {
    // Run with a non-existent KAYA_DIR so no state file is found
    const result = runHook(
      { conversation_id: 'test-wv-missing-state' },
      { KAYA_DIR: '/tmp/nonexistent-kaya-dir-wv-test' },
    );
    expect(result.exitCode).toBe(0);
  });

  test('exits 0 with invalid JSON stdin (fail-open)', () => {
    const ts = Date.now() + '_' + Math.random().toString(36).slice(2);
    const tmpInput = `/tmp/wv_bad_${ts}.json`;
    const tmpStdout = `/tmp/wv_bad_out_${ts}.txt`;
    const tmpStderr = `/tmp/wv_bad_err_${ts}.txt`;

    writeFileSync(tmpInput, 'not valid json');
    let exitCode = 0;
    try {
      execSync(
        `cat ${tmpInput} | bun run ${HOOK_PATH} 1>${tmpStdout} 2>${tmpStderr}`,
        { timeout: 15000, env: { ...process.env, KAYA_DIR } },
      );
    } catch (err: unknown) {
      const e = err as { status?: number };
      exitCode = e.status ?? 1;
    }

    for (const f of [tmpInput, tmpStdout, tmpStderr]) {
      if (existsSync(f)) unlinkSync(f);
    }

    expect(exitCode).toBe(0);
  });
});

describe('WorkValidator — work directory validation', () => {
  test('validates correctly when work dir has complete structure', () => {
    // Create a fake work directory with all required files
    const ts = Date.now().toString();
    const fakeKayaDir = `/tmp/kaya-wv-test-${ts}`;
    const fakeWorkDir = `${fakeKayaDir}/MEMORY/WORK/20260228-${ts}_test-task`;
    const fakeStateDir = `${fakeKayaDir}/MEMORY/State`;

    mkdirSync(fakeWorkDir, { recursive: true });
    mkdirSync(fakeStateDir, { recursive: true });
    mkdirSync(`${fakeKayaDir}/MEMORY/VALIDATION/2026/02`, { recursive: true });

    // Write IDEAL.md with meaningful content
    writeFileSync(
      `${fakeWorkDir}/IDEAL.md`,
      '# Ideal State\n\nThis task should:\n1. Do thing A\n2. Do thing B\n3. Do thing C\n\n## Success Criteria\n\nAll items done.',
    );

    // Write META.yaml with required fields
    writeFileSync(
      `${fakeWorkDir}/META.yaml`,
      `created: "2026-02-28T12:00:00.000Z"\nstatus: in_progress\nprompt: "Test task"\n`,
    );

    // Write current-work.json pointing to the fake work dir
    writeFileSync(
      `${fakeStateDir}/current-work.json`,
      JSON.stringify({ session_id: `sess-${ts}`, work_dir: fakeWorkDir }),
    );

    const result = runHook(
      { conversation_id: `conv-${ts}` },
      { KAYA_DIR: fakeKayaDir },
    );

    // Clean up
    rmSync(fakeKayaDir, { recursive: true, force: true });

    // WorkValidator always exits 0 (non-blocking)
    expect(result.exitCode).toBe(0);
    // Should not have critical error messages for a valid work dir
    expect(result.stderr).not.toContain('CRITICAL');
  });

  test('exits 0 even when META.yaml is missing (logs warning, does not block)', () => {
    const ts = Date.now().toString();
    const fakeKayaDir = `/tmp/kaya-wv-missing-${ts}`;
    const fakeWorkDir = `${fakeKayaDir}/MEMORY/WORK/20260228-${ts}_incomplete`;
    const fakeStateDir = `${fakeKayaDir}/MEMORY/State`;

    mkdirSync(fakeWorkDir, { recursive: true });
    mkdirSync(fakeStateDir, { recursive: true });
    mkdirSync(`${fakeKayaDir}/MEMORY/VALIDATION/2026/02`, { recursive: true });

    // Only write IDEAL.md — no META.yaml
    writeFileSync(
      `${fakeWorkDir}/IDEAL.md`,
      '# Ideal State\n\nSome content here.\n\nMore content.\n\nAnd more.',
    );

    writeFileSync(
      `${fakeStateDir}/current-work.json`,
      JSON.stringify({ session_id: `sess-${ts}`, work_dir: fakeWorkDir }),
    );

    const result = runHook(
      { conversation_id: `conv-${ts}` },
      { KAYA_DIR: fakeKayaDir },
    );

    rmSync(fakeKayaDir, { recursive: true, force: true });

    // Still exits 0 — WorkValidator never blocks session end
    expect(result.exitCode).toBe(0);
  });
});

describe('WorkValidator — session ID handling', () => {
  test('handles missing conversation_id gracefully', () => {
    const result = runHook({});
    expect(result.exitCode).toBe(0);
  });

  test('handles timestamp field in input', () => {
    const result = runHook({
      conversation_id: 'test-wv-ts',
      timestamp: new Date().toISOString(),
    });
    expect(result.exitCode).toBe(0);
  });
});
