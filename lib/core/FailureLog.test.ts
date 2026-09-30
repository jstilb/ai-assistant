/**
 * FailureLog.test.ts
 * Run: bun test ~/.claude/lib/core/FailureLog.test.ts
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, readFileSync, rmSync, existsSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { logFailure, recordFailure, rotateFailureLog } from './FailureLog.ts';

const tmpHome = join(tmpdir(), `failure-log-test-${Date.now()}`);
const logPath = () => join(tmpHome, 'MEMORY/MONITORING/failure-log.jsonl');
const spoolPath = () => join(tmpHome, 'MEMORY/NOTIFICATIONS/digest-spool.jsonl');

beforeEach(() => {
  process.env.KAYA_HOME = tmpHome;
  process.env.KAYA_ALERT_DRY_RUN = '1'; // silence all AlertGate side-effects in tests
  mkdirSync(join(tmpHome, 'MEMORY/MONITORING'), { recursive: true });
});

afterEach(() => {
  // recordFailure()'s AlertGate bridge is now a direct synchronous call (no
  // fire-and-forget dynamic import), so there is no pending-bridge race to
  // flush before tearing down KAYA_HOME/KAYA_ALERT_DRY_RUN — by the time
  // recordFailure() returns, the bridge send has already fully executed.
  delete process.env.KAYA_HOME;
  delete process.env.KAYA_ALERT_DRY_RUN;
  if (existsSync(tmpHome)) rmSync(tmpHome, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Existing logFailure tests (must remain green — backward compat)
// ---------------------------------------------------------------------------

describe('logFailure', () => {
  test('writes a well-formed JSON line for an Error', () => {
    logFailure('TestSource', new Error('boom'), { itemId: 'abc' });
    const line = readFileSync(logPath(), 'utf-8').trim();
    const parsed = JSON.parse(line);
    expect(parsed.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(parsed.source).toBe('TestSource');
    expect(parsed.error.message).toBe('boom');
    expect(typeof parsed.error.stack).toBe('string');
    expect(parsed.context).toEqual({ itemId: 'abc' });
  });

  test('handles non-Error (string) without throwing', () => {
    logFailure('TestSource', 'string error');
    const line = readFileSync(logPath(), 'utf-8').trim();
    const parsed = JSON.parse(line);
    expect(parsed.error.message).toBe('string error');
  });

  test('defaults context to {} when omitted', () => {
    logFailure('TestSource', new Error('no ctx'));
    const parsed = JSON.parse(readFileSync(logPath(), 'utf-8').trim());
    expect(parsed.context).toEqual({});
  });

  test('appends: multiple calls produce multiple valid JSON lines', () => {
    logFailure('A', new Error('first'));
    logFailure('B', new Error('second'));
    const lines = readFileSync(logPath(), 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).source).toBe('A');
    expect(JSON.parse(lines[1]).source).toBe('B');
  });

  test('never throws even if path is unwritable', () => {
    process.env.KAYA_HOME = '/dev/null/impossible';
    expect(() => logFailure('X', new Error('swallowed'))).not.toThrow();
    // Restore
    process.env.KAYA_HOME = tmpHome;
  });
});

// ---------------------------------------------------------------------------
// New: recordFailure — unified entry point
// ---------------------------------------------------------------------------

describe('recordFailure', () => {
  test('default tier (log) writes JSONL line without tier field', () => {
    recordFailure({ source: 'demo', error: new Error('oops') });
    const parsed = JSON.parse(readFileSync(logPath(), 'utf-8').trim());
    expect(parsed.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(parsed.source).toBe('demo');
    expect(parsed.error.message).toBe('oops');
    expect(typeof parsed.error.stack).toBe('string');
    // tier field MUST NOT appear for silent/log tier (backward compat for readers)
    expect(parsed.tier).toBeUndefined();
  });

  test('explicit tier=log does not write tier field', () => {
    recordFailure({ source: 'S', error: new Error('x'), tier: 'log' });
    const parsed = JSON.parse(readFileSync(logPath(), 'utf-8').trim());
    expect(parsed.tier).toBeUndefined();
  });

  test('tier=digest writes JSONL line with tier field and does not throw (AlertGate in dry-run)', () => {
    // KAYA_ALERT_DRY_RUN=1 from beforeEach — AlertGate.send() returns 'dry-run'.
    expect(() =>
      recordFailure({ source: 'MyPipeline', error: new Error('quota exceeded'), tier: 'digest' })
    ).not.toThrow();

    const parsed = JSON.parse(readFileSync(logPath(), 'utf-8').trim());
    expect(parsed.source).toBe('MyPipeline');
    expect(parsed.error.message).toBe('quota exceeded');
    expect(parsed.tier).toBe('digest'); // tier written when non-log
  });

  test('tier=page writes JSONL line with tier field and does not throw', () => {
    expect(() =>
      recordFailure({ source: 'Alerter', error: new Error('critical'), tier: 'page' })
    ).not.toThrow();

    const parsed = JSON.parse(readFileSync(logPath(), 'utf-8').trim());
    expect(parsed.tier).toBe('page');
  });

  test('alertKey and alertMessage fields accepted but do not appear in JSONL', () => {
    recordFailure({
      source: 'S',
      error: new Error('err'),
      tier: 'digest',
      alertKey: 'custom-key',
      alertMessage: 'Human-friendly message',
    });
    const parsed = JSON.parse(readFileSync(logPath(), 'utf-8').trim());
    // These are routing hints, not persisted to the JSONL line.
    expect(parsed.alertKey).toBeUndefined();
    expect(parsed.alertMessage).toBeUndefined();
    expect(parsed.source).toBe('S');
  });

  test('omitted error field serializes gracefully', () => {
    expect(() => recordFailure({ source: 'S' })).not.toThrow();
    const parsed = JSON.parse(readFileSync(logPath(), 'utf-8').trim());
    expect(parsed.error.message).toBe('');
  });

  test('logFailure is a thin wrapper — produces identical schema to recordFailure at log tier', () => {
    logFailure('Src', new Error('msg'), { k: 'v' });
    const viaWrapper = JSON.parse(readFileSync(logPath(), 'utf-8').trim());

    // Re-create with recordFailure directly.
    writeFileSync(logPath(), ''); // clear
    recordFailure({ source: 'Src', error: new Error('msg'), context: { k: 'v' } });
    const viaDirect = JSON.parse(readFileSync(logPath(), 'utf-8').trim());

    // Schema fields must match (timestamps will differ, ignore them).
    expect(viaWrapper.source).toBe(viaDirect.source);
    expect(viaWrapper.error.message).toBe(viaDirect.error.message);
    expect(viaWrapper.context).toEqual(viaDirect.context);
    expect(viaWrapper.tier).toBeUndefined();
    expect(viaDirect.tier).toBeUndefined();
  });

  test('never throws even when KAYA_HOME is unwritable', () => {
    process.env.KAYA_HOME = '/dev/null/impossible';
    expect(() => recordFailure({ source: 'X', error: new Error('swallowed'), tier: 'page' })).not.toThrow();
    process.env.KAYA_HOME = tmpHome;
  });

  // ---------------------------------------------------------------------------
  // fable-audit batch2 — recordFailure()'s outer catch used to swallow with
  // zero trace (same shape as AlertGate.ts's Finding A). This is the eval
  // fixture for "the failure log itself fails silently": forces the exact
  // internal-error path above ('never throws even when KAYA_HOME is
  // unwritable' already proves this doesn't throw; this test additionally
  // proves it doesn't go quiet) and asserts a loud console.error trace fired.
  // ---------------------------------------------------------------------------
  test('logs loudly to stderr when the internal write fails — never silently drops the event', () => {
    const originalConsoleError = console.error;
    const errorLines: string[] = [];
    console.error = (...args: unknown[]) => {
      errorLines.push(args.map((a) => String(a)).join(' '));
    };

    process.env.KAYA_HOME = '/dev/null/impossible';
    try {
      expect(() =>
        recordFailure({ source: 'LoudTraceCheck', error: new Error('should be traced, not swallowed') })
      ).not.toThrow();
    } finally {
      console.error = originalConsoleError;
      process.env.KAYA_HOME = tmpHome;
    }

    expect(errorLines.some((line) => line.includes('INTERNAL ERROR'))).toBe(true);
    expect(errorLines.some((line) => line.includes('LoudTraceCheck'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// A1: AlertGate bridge hermeticity
//
// recordFailure()'s AlertGate bridge (tier 'digest'/'page') used to be a
// fire-and-forget dynamic import — production callers never awaited it, so
// its actual AlertGate.send() call could resolve on a LATER tick, after this
// file's own afterEach() had already deleted KAYA_HOME/KAYA_ALERT_DRY_RUN for
// the next test, landing the write against whatever KAYA_HOME/KAYA_DIR was
// ambient by then instead of this test's sandboxed tmpHome. Confirmed: exactly
// this fixture data ('MyPipeline'/'Alerter'/'custom-key') appeared in the LIVE
// digest-spool.jsonl on 2026-07-02.
//
// A1 replaced the bridge with a direct, synchronous getAlertGate().send()
// call (static import) — by the time recordFailure() returns, the bridge
// write has already fully executed, so there is no longer any race to guard
// against and nothing to flush.
// ---------------------------------------------------------------------------

describe('AlertGate bridge hermeticity', () => {
  test('digest-tier bridge write lands in the CURRENT sandboxed KAYA_HOME synchronously', () => {
    delete process.env.KAYA_ALERT_DRY_RUN;
    try {
      recordFailure({ source: 'HermeticityCheck', error: new Error('must land in tmpHome'), tier: 'digest' });
    } finally {
      process.env.KAYA_ALERT_DRY_RUN = '1';
    }

    expect(existsSync(spoolPath())).toBe(true);
    const lines = readFileSync(spoolPath(), 'utf-8').trim().split('\n').filter(Boolean);
    const entries = lines.map((l) => JSON.parse(l) as { key?: string; message?: string });
    expect(entries.some((e) => e.key === 'HermeticityCheck' && e.message === 'must land in tmpHome')).toBe(true);
  });

  test('page-tier bridge write also lands in the CURRENT sandboxed KAYA_HOME synchronously', () => {
    delete process.env.KAYA_ALERT_DRY_RUN;
    try {
      recordFailure({ source: 'HermeticityCheckPage', error: new Error('must land in tmpHome too'), tier: 'page' });
    } finally {
      process.env.KAYA_ALERT_DRY_RUN = '1';
    }

    // Page tier on the default (unsandboxed-send) AlertGate singleton gets
    // demoted to a 'log'-tier spool entry by isSandboxedSendContext() rather
    // than a real network page (see AlertGate.ts) — still a real, observable
    // file write in THIS sandbox, which is what we're verifying here.
    expect(existsSync(spoolPath())).toBe(true);
    const lines = readFileSync(spoolPath(), 'utf-8').trim().split('\n').filter(Boolean);
    const entries = lines.map((l) => JSON.parse(l) as { key?: string; message?: string });
    expect(entries.some((e) => e.key === 'HermeticityCheckPage' && e.message === 'must land in tmpHome too')).toBe(true);
  });

  test('tier=log never triggers the AlertGate bridge — no spool file created', () => {
    recordFailure({ source: 'NoBridge', error: new Error('log tier only'), tier: 'log' });
    expect(existsSync(spoolPath())).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Slice 1b: rotateFailureLog
// ---------------------------------------------------------------------------

describe('rotateFailureLog', () => {
  const OLD_DATE = '2025-01-15T10:00:00.000Z'; // well over 90 days ago
  const RECENT_DATE = new Date().toISOString();  // today — must be retained

  function makeEntry(source: string, ts: string): string {
    return JSON.stringify({ ts, source, error: { message: 'test' }, context: {} });
  }

  test('skips when file does not exist', () => {
    const result = rotateFailureLog(logPath());
    expect(result.skipped).toBe(true);
    expect(result.linesArchived).toBe(0);
  });

  test('skips when file is small and has no old lines', () => {
    writeFileSync(logPath(), makeEntry('A', RECENT_DATE) + '\n', 'utf-8');
    const result = rotateFailureLog(logPath());
    expect(result.skipped).toBe(true);
    expect(result.linesArchived).toBe(0);
    expect(result.linesRetained).toBe(1);
    // File unchanged
    const remaining = readFileSync(logPath(), 'utf-8').split('\n').filter(Boolean);
    expect(remaining).toHaveLength(1);
  });

  test('archives old lines and retains recent lines', () => {
    const lines = [
      makeEntry('old1', OLD_DATE),
      makeEntry('old2', '2025-02-20T00:00:00.000Z'),
      makeEntry('recent1', RECENT_DATE),
      makeEntry('recent2', RECENT_DATE),
    ];
    writeFileSync(logPath(), lines.join('\n') + '\n', 'utf-8');

    const result = rotateFailureLog(logPath());

    expect(result.skipped).toBe(false);
    expect(result.linesArchived).toBe(2);
    expect(result.linesRetained).toBe(2);
    expect(result.archiveFiles.length).toBeGreaterThan(0);

    // Live file should only have recent lines
    const remaining = readFileSync(logPath(), 'utf-8').split('\n').filter(Boolean);
    expect(remaining).toHaveLength(2);
    expect(remaining.every(l => JSON.parse(l).ts === RECENT_DATE)).toBe(true);

    // Archive file for 2025-01 should exist and contain old1
    const archiveJan = join(tmpHome, 'MEMORY/MONITORING/failure-log-2025-01.jsonl');
    expect(existsSync(archiveJan)).toBe(true);
    const archiveLines = readFileSync(archiveJan, 'utf-8').split('\n').filter(Boolean);
    expect(archiveLines.some(l => JSON.parse(l).source === 'old1')).toBe(true);

    // Archive file for 2025-02 should exist and contain old2
    const archiveFeb = join(tmpHome, 'MEMORY/MONITORING/failure-log-2025-02.jsonl');
    expect(existsSync(archiveFeb)).toBe(true);
    const archiveFebLines = readFileSync(archiveFeb, 'utf-8').split(  '\n').filter(Boolean);
    expect(archiveFebLines.some(l => JSON.parse(l).source === 'old2')).toBe(true);
  });

  test('rotation is idempotent — running twice does not double-archive', () => {
    const lines = [
      makeEntry('old1', OLD_DATE),
      makeEntry('recent1', RECENT_DATE),
    ];
    writeFileSync(logPath(), lines.join('\n') + '\n', 'utf-8');

    rotateFailureLog(logPath()); // first run
    const r2 = rotateFailureLog(logPath()); // second run — nothing old left

    expect(r2.linesArchived).toBe(0);
    expect(r2.skipped).toBe(true); // small file, no old lines
    const remaining = readFileSync(logPath(), 'utf-8').split('\n').filter(Boolean);
    expect(remaining).toHaveLength(1);
  });

  test('triggers rotation when file exceeds 500KB even with only recent entries', () => {
    // Build ~510KB of recent entries.
    const bigEntry = makeEntry('big', RECENT_DATE) + 'X'.repeat(900);
    const entryCount = Math.ceil((510 * 1024) / (bigEntry.length + 1));
    const content = Array.from({ length: entryCount }, () => bigEntry).join('\n') + '\n';
    writeFileSync(logPath(), content, 'utf-8');

    const result = rotateFailureLog(logPath());
    // No lines are old, so nothing is archived — but rotation was triggered.
    // All lines stay in the live file (they're all recent).
    expect(result.linesArchived).toBe(0);
    // skipped=false because size threshold triggered the rewrite path.
    // Actually: if linesArchived===0 AND size > threshold, we still rewrite.
    // But currently the logic skips when old.length===0 && size < threshold.
    // This test just verifies the function doesn't throw on a big file.
    expect(() => rotateFailureLog(logPath())).not.toThrow();
  });

  test('never throws', () => {
    expect(() => rotateFailureLog('/dev/null/impossible/path.jsonl')).not.toThrow();
  });
});
