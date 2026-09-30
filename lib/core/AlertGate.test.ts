/**
 * AlertGate.test.ts — Policy gate for outbound alerts.
 *
 * All paths injected (state, spool, sender, clock) — no live files, no network.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  AlertGate,
  findSuspectPath,
  isSandboxedSendContext,
  isWithinQuietHours,
  localHourIn,
  resolveQuietHours,
  DEFAULT_QUIET_HOURS,
  type AlertGateOptions,
} from './AlertGate.ts';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

let dir: string;
let sent: Array<{ message: string; channel: string }>;
let clock: { now: number };

/**
 * quietHours disabled (2026-07-31): these tests exercise the cooldown /
 * fingerprint / suppression decision table, and several pin `clock` to a
 * timestamp that happens to fall inside the default 22:00-07:00 window (the
 * shared default here, 08:00Z, is 01:00 America/Los_Angeles). Leaving quiet
 * hours on would make them assert two policies at once and fail for a reason
 * unrelated to what they name. Quiet-hours behaviour has its own dedicated
 * describe block below, with an explicit config and clock.
 */
function makeGate(overrides: Partial<AlertGateOptions> = {}): AlertGate {
  return new AlertGate({
    statePath: join(dir, 'alert-gate.json'),
    spoolPath: join(dir, 'digest-spool.jsonl'),
    archivePath: join(dir, 'digest-spool-archive.jsonl'),
    send: async (message, channel) => { sent.push({ message, channel }); return true; },
    now: () => clock.now,
    quietHours: { ...DEFAULT_QUIET_HOURS, enabled: false },
    ...overrides,
  });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'alert-gate-'));
  sent = [];
  clock = { now: new Date('2026-06-12T08:00:00Z').getTime() };
  delete process.env.KAYA_ALERT_DRY_RUN;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.KAYA_ALERT_DRY_RUN;
});

describe('page tier', () => {
  test('first page for a key sends immediately', async () => {
    const gate = makeGate();
    const result = await gate.send('alert one', { key: 'k1', tier: 'page' });
    expect(result).toBe('paged');
    expect(sent).toEqual([{ message: 'alert one', channel: 'telegram' }]);
  });

  test('page within cooldown is suppressed and spooled instead', async () => {
    const gate = makeGate();
    await gate.send('alert one', { key: 'k1', tier: 'page' });
    clock.now += HOUR;
    const result = await gate.send('alert two', { key: 'k1', tier: 'page' });
    expect(result).toBe('suppressed');
    expect(sent).toHaveLength(1);
    const spool = gate.consumeSpool();
    expect(spool).toHaveLength(1);
    expect(spool[0]!.message).toBe('alert two');
    expect(spool[0]!.key).toBe('k1');
  });

  test('page after cooldown without fingerprint sends', async () => {
    const gate = makeGate();
    await gate.send('alert one', { key: 'k1', tier: 'page' });
    clock.now += DAY + 1;
    const result = await gate.send('alert two', { key: 'k1', tier: 'page' });
    expect(result).toBe('paged');
    expect(sent).toHaveLength(2);
  });

  test('unchanged fingerprint suppresses after cooldown (while within the fingerprint TTL)', async () => {
    const gate = makeGate();
    await gate.send('76 parked', { key: 'grill', tier: 'page', fingerprint: '76' });
    clock.now += DAY + 1; // past the 24h cooldown, well inside the 7d fingerprint TTL
    const result = await gate.send('76 parked', { key: 'grill', tier: 'page', fingerprint: '76' });
    expect(result).toBe('suppressed');
    expect(sent).toHaveLength(1);
  });

  test('changed fingerprint after cooldown sends', async () => {
    const gate = makeGate();
    await gate.send('76 parked', { key: 'grill', tier: 'page', fingerprint: '76' });
    clock.now += DAY + 1;
    const result = await gate.send('80 parked', { key: 'grill', tier: 'page', fingerprint: '80' });
    expect(result).toBe('paged');
    expect(sent).toHaveLength(2);
  });

  test('changed fingerprint within cooldown still suppresses (max 1/cooldown)', async () => {
    const gate = makeGate();
    await gate.send('76 parked', { key: 'grill', tier: 'page', fingerprint: '76' });
    clock.now += HOUR;
    const result = await gate.send('80 parked', { key: 'grill', tier: 'page', fingerprint: '80' });
    expect(result).toBe('suppressed');
    expect(sent).toHaveLength(1);
  });

  test('fingerprint only updates on actual page — change is measured against last sent', async () => {
    const gate = makeGate();
    await gate.send('75 parked', { key: 'grill', tier: 'page', fingerprint: '75' });
    clock.now += HOUR;
    await gate.send('76 parked', { key: 'grill', tier: 'page', fingerprint: '76' }); // suppressed
    clock.now += DAY;
    // 76 differs from the last PAGED fingerprint (75) → sends
    const result = await gate.send('76 parked', { key: 'grill', tier: 'page', fingerprint: '76' });
    expect(result).toBe('paged');
  });

  test('custom cooldown is honored', async () => {
    const gate = makeGate();
    await gate.send('a', { key: 'k', tier: 'page', cooldownMs: HOUR });
    clock.now += HOUR + 1;
    expect(await gate.send('b', { key: 'k', tier: 'page', cooldownMs: HOUR })).toBe('paged');
  });

  test('custom channel is passed through', async () => {
    const gate = makeGate();
    await gate.send('a', { key: 'k', tier: 'page', channel: 'discord' });
    expect(sent[0]!.channel).toBe('discord');
  });

  test('independent keys do not share cooldown', async () => {
    const gate = makeGate();
    expect(await gate.send('a', { key: 'k1', tier: 'page' })).toBe('paged');
    expect(await gate.send('b', { key: 'k2', tier: 'page' })).toBe('paged');
  });
});

// ============================================================================
// Fingerprint TTL — the fix for static fingerprints suppressing FOREVER.
//
// Regression this pins: the executor paged 'executor-credit-pool' with the
// STATIC fingerprint 'credit-pool-paused' on 2026-07-09; every later genuine
// failure (Aug 18-24) matched that fingerprint and was suppressed with no
// expiry, so six days of executor failures never reached Jm. Unchanged
// fingerprints now suppress only up to fingerprintTtlMs (default 7 days) —
// the effective refire interval for a still-live, unchanged condition is
// max(cooldownMs, fingerprintTtlMs), never infinity.
// ============================================================================

describe('page tier: fingerprint TTL (static fingerprints must refire eventually)', () => {
  test('unchanged fingerprint RE-PAGES once the default 7d TTL elapses — the 07-09→08-18 executor silence shape', async () => {
    const gate = makeGate();
    await gate.send('credit pool paused', { key: 'executor-credit-pool', tier: 'page', fingerprint: 'credit-pool-paused' });
    expect(sent).toHaveLength(1);

    clock.now += 6 * DAY; // e.g. daily retries during the outage — still within TTL
    expect(await gate.send('credit pool paused', { key: 'executor-credit-pool', tier: 'page', fingerprint: 'credit-pool-paused' }))
      .toBe('suppressed');

    clock.now += DAY + 1; // 7d+ since the last delivered page
    expect(await gate.send('credit pool paused', { key: 'executor-credit-pool', tier: 'page', fingerprint: 'credit-pool-paused' }))
      .toBe('paged');
    expect(sent).toHaveLength(2);
  });

  test('custom fingerprintTtlMs is honored — the executor shape (4h cooldown, 24h fingerprint refire)', async () => {
    const gate = makeGate();
    const opts = {
      key: 'executor-credit-pool',
      tier: 'page' as const,
      fingerprint: 'credit-pool-paused',
      cooldownMs: 4 * HOUR,
      fingerprintTtlMs: 24 * HOUR,
    };
    await gate.send('paused', opts);
    clock.now += 5 * HOUR; // past cooldown, inside fingerprint TTL
    expect(await gate.send('paused', opts)).toBe('suppressed');
    clock.now += 20 * HOUR; // 25h since the delivered page — past the 24h TTL
    expect(await gate.send('paused', opts)).toBe('paged');
    expect(sent).toHaveLength(2);
  });

  test('fingerprintTtlMs <= cooldownMs makes the fingerprint a no-op — suppression is cooldown-only', async () => {
    const gate = makeGate();
    const opts = { key: 'k', tier: 'page' as const, fingerprint: 'static', cooldownMs: DAY, fingerprintTtlMs: HOUR };
    await gate.send('a', opts);
    clock.now += HOUR + 1; // past the TTL but inside the cooldown → still suppressed
    expect(await gate.send('a', opts)).toBe('suppressed');
    clock.now += DAY; // past the cooldown → pages, TTL long expired
    expect(await gate.send('a', opts)).toBe('paged');
  });

  test('a TTL refire restamps lastSentAt — the next unchanged refire is a full TTL later, not immediate', async () => {
    const gate = makeGate();
    const opts = { key: 'k', tier: 'page' as const, fingerprint: 'static', cooldownMs: HOUR, fingerprintTtlMs: 24 * HOUR };
    await gate.send('a', opts);
    clock.now += 25 * HOUR;
    expect(await gate.send('a', opts)).toBe('paged'); // TTL refire
    clock.now += 2 * HOUR; // past cooldown, but only 2h since the refire
    expect(await gate.send('a', opts)).toBe('suppressed');
    clock.now += 23 * HOUR; // 25h since the refire
    expect(await gate.send('a', opts)).toBe('paged');
    expect(sent).toHaveLength(3);
  });

  test('changed fingerprint still pages right after cooldown — the TTL only governs UNCHANGED content', async () => {
    const gate = makeGate();
    await gate.send('76 parked', { key: 'grill', tier: 'page', fingerprint: '76', fingerprintTtlMs: 7 * DAY });
    clock.now += DAY + 1;
    expect(await gate.send('80 parked', { key: 'grill', tier: 'page', fingerprint: '80', fingerprintTtlMs: 7 * DAY }))
      .toBe('paged');
  });

  test('shouldPage() (gate-only API) honors fingerprintTtlMs the same way', async () => {
    const gate = makeGate();
    gate.recordPaged('k', 'static');
    clock.now += 2 * DAY; // past default cooldown, inside default TTL
    expect(gate.shouldPage('k', { fingerprint: 'static' })).toBe(false);
    expect(gate.shouldPage('k', { fingerprint: 'static', fingerprintTtlMs: DAY })).toBe(true);
    clock.now += 6 * DAY; // 8d total — past the 7d default TTL
    expect(gate.shouldPage('k', { fingerprint: 'static' })).toBe(true);
  });
});

describe('digest and log tiers', () => {
  test('digest tier spools without sending', async () => {
    const gate = makeGate();
    const result = await gate.send('warning thing', { key: 'w1' }); // default tier digest
    expect(result).toBe('spooled');
    expect(sent).toHaveLength(0);
    const spool = gate.consumeSpool();
    expect(spool).toHaveLength(1);
    expect(spool[0]!.tier).toBe('digest');
  });

  test('log tier records without sending', async () => {
    const gate = makeGate();
    const result = await gate.send('info thing', { key: 'i1', tier: 'log' });
    expect(result).toBe('logged');
    expect(sent).toHaveLength(0);
    expect(gate.consumeSpool()[0]!.tier).toBe('log');
  });
});

describe('spool lifecycle', () => {
  test('consumeSpool returns entries then truncates', async () => {
    const gate = makeGate();
    await gate.send('one', { key: 'a' });
    await gate.send('two', { key: 'b' });
    const first = gate.consumeSpool();
    expect(first.map(e => e.message)).toEqual(['one', 'two']);
    expect(gate.consumeSpool()).toEqual([]);
  });

  test('readSpool does not truncate', async () => {
    const gate = makeGate();
    await gate.send('one', { key: 'a' });
    expect(gate.readSpool()).toHaveLength(1);
    expect(gate.readSpool()).toHaveLength(1);
  });

  test('spool survives malformed lines', async () => {
    const gate = makeGate();
    await gate.send('good', { key: 'a' });
    // simulate a torn write
    const { appendFileSync } = require('fs') as typeof import('fs');
    appendFileSync(join(dir, 'digest-spool.jsonl'), 'not json\n');
    await gate.send('also good', { key: 'b' });
    expect(gate.consumeSpool().map(e => e.message)).toEqual(['good', 'also good']);
  });

  // B6 (S4d): consumeSpool() archives every consumed entry verbatim to
  // digest-spool-archive.jsonl BEFORE wiping the live spool — the live wipe
  // behavior (SystemHealthDigest's delivery contract) stays byte-identical.
  test('consumeSpool archives entries verbatim AND still wipes the live spool', async () => {
    const gate = makeGate();
    await gate.send('one', { key: 'a' });
    await gate.send('two', { key: 'b', tier: 'log' });

    const beforeConsume = gate.readSpool();
    expect(beforeConsume.map(e => e.message)).toEqual(['one', 'two']);

    const consumed = gate.consumeSpool();
    expect(consumed.map(e => e.message)).toEqual(['one', 'two']);

    // Live spool still wipes exactly as before.
    expect(gate.readSpool()).toEqual([]);
    expect(readFileSync(join(dir, 'digest-spool.jsonl'), 'utf-8')).toBe('');

    // Archive holds the SAME entries, verbatim (same shape/fields/order).
    const archivePath = join(dir, 'digest-spool-archive.jsonl');
    expect(existsSync(archivePath)).toBe(true);
    const archived = readFileSync(archivePath, 'utf-8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
    expect(archived).toEqual(consumed);
  });

  test('consumeSpool on an empty spool does not create an archive file', async () => {
    const gate = makeGate();
    expect(gate.consumeSpool()).toEqual([]);
    expect(existsSync(join(dir, 'digest-spool-archive.jsonl'))).toBe(false);
  });

  test('a second consumeSpool call APPENDS to the archive rather than overwriting it', async () => {
    const gate = makeGate();
    await gate.send('first batch', { key: 'a' });
    gate.consumeSpool();
    await gate.send('second batch', { key: 'b' });
    gate.consumeSpool();

    const archivePath = join(dir, 'digest-spool-archive.jsonl');
    const archived = readFileSync(archivePath, 'utf-8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
    expect(archived.map((e: { message: string }) => e.message)).toEqual(['first batch', 'second batch']);
  });
});

describe('robustness', () => {
  test('corrupted state file resets gracefully', async () => {
    const gate = makeGate();
    await gate.send('a', { key: 'k', tier: 'page' });
    const { writeFileSync } = require('fs') as typeof import('fs');
    writeFileSync(join(dir, 'alert-gate.json'), '{corrupt');
    const gate2 = makeGate();
    expect(await gate2.send('b', { key: 'k', tier: 'page' })).toBe('paged');
  });

  test('state persists across instances', async () => {
    await makeGate().send('a', { key: 'k', tier: 'page' });
    clock.now += HOUR;
    expect(await makeGate().send('b', { key: 'k', tier: 'page' })).toBe('suppressed');
  });

  test('KAYA_ALERT_DRY_RUN suppresses sends and does not stamp state', async () => {
    process.env.KAYA_ALERT_DRY_RUN = '1';
    const gate = makeGate();
    expect(await gate.send('a', { key: 'k', tier: 'page' })).toBe('dry-run');
    expect(sent).toHaveLength(0);
    delete process.env.KAYA_ALERT_DRY_RUN;
    // not stamped — a real page still goes through
    expect(await gate.send('b', { key: 'k', tier: 'page' })).toBe('paged');
  });
});

describe('shouldPage / recordPaged (gate-only API for custom senders)', () => {
  test('mirrors page-tier gating without sending', async () => {
    const gate = makeGate();
    expect(gate.shouldPage('appr-1', { cooldownMs: 72 * HOUR })).toBe(true);
    gate.recordPaged('appr-1');
    clock.now += 24 * HOUR;
    expect(gate.shouldPage('appr-1', { cooldownMs: 72 * HOUR })).toBe(false);
    clock.now += 49 * HOUR;
    expect(gate.shouldPage('appr-1', { cooldownMs: 72 * HOUR })).toBe(true);
    expect(sent).toHaveLength(0);
  });
});

// ============================================================================
// findSuspectPath() — pure heuristic, no I/O.
// ============================================================================

describe('findSuspectPath (pure marker matcher)', () => {
  test('flags a macOS mkdtemp tmpdir path', async () => {
    expect(findSuspectPath('Token at /var/folders/t2/xyz/T/oauth-fixtures-eCklfU/token-0.1.json expired'))
      .toBe('/var/folders/');
  });

  test('flags the Claude agent scratchpad root', async () => {
    expect(findSuspectPath('Token at /private/tmp/claude-501/-Users-[user]--claude/abc/scratchpad/broken-fixture/sheets-token.json'))
      .toBe('/private/tmp/');
  });

  test('flags the literal oauth-fixtures marker', async () => {
    expect(findSuspectPath('reused oauth-fixtures-BTm6wO dir')).toBe('oauth-fixtures');
  });

  test('flags a bare scratchpad reference', async () => {
    expect(findSuspectPath('wrote to my scratchpad/broken-fixture dir')).toBe('scratchpad');
  });

  test('returns null for a clean, real production message', async () => {
    expect(findSuspectPath('Token at /Users/[user]/.config/google/sheets-token.json is expired')).toBeNull();
  });
});

// ============================================================================
// Suspect-path content guard — the S1.9 fix for the 2026-07-01/07-02 leak.
//
// These tests intentionally run WITHOUT KAYA_ALERT_DRY_RUN=1 (that's the
// exact non-dry-run suppression path being verified) but stay hermetic via
// AlertGate's full dependency injection: statePath/spoolPath point at a
// mkdtemp dir and `send` is a recording stub — no live file or network is
// ever touched, matching this file's existing convention.
// ============================================================================

describe('suspect-path content guard (test/tmp-path leak prevention)', () => {
  const leakedMessage =
    '[sheets] Token at /var/folders/t2/_d_3np7j0y90mfqpk9kcxwx00000gn/T/oauth-fixtures-eCklfU/token-0.1.json is expired';

  test('digest-tier alert referencing a tmp fixture path is suppressed, not spooled to digest', async () => {
    const gate = makeGate();
    const result = await gate.send(leakedMessage, { key: 'token-health-sheets', tier: 'digest' });
    expect(result).toBe('suppressed');
    const spool = gate.consumeSpool();
    expect(spool).toHaveLength(1);
    expect(spool[0]!.tier).toBe('log'); // demoted, not lost — recoverable, but not in the digest a human reads
    expect(spool[0]!.message).toBe(leakedMessage);
  });

  test('page-tier alert referencing a tmp fixture path is suppressed, not sent, and does not stamp cooldown state', async () => {
    const gate = makeGate();
    const result = await gate.send(leakedMessage, { key: 'token-health-sheets', tier: 'page' });
    expect(result).toBe('suppressed');
    expect(sent).toHaveLength(0);
    // Cooldown state must NOT be stamped — a real page for this key later still fires.
    expect(gate.shouldPage('token-health-sheets')).toBe(true);
  });

  test('scratchpad-path alert (the second 07-01 leak shape) is also suppressed', async () => {
    const gate = makeGate();
    const scratchpadMessage =
      '[sheets] Token at /private/tmp/claude-501/-Users-[user]--claude/2c0b9076/scratchpad/broken-fixture/sheets-token.json is expired';
    const result = await gate.send(scratchpadMessage, { key: 'token-health-sheets', tier: 'page' });
    expect(result).toBe('suppressed');
    expect(sent).toHaveLength(0);
  });

  test('a clean production message for the same key is NOT suppressed', async () => {
    const gate = makeGate();
    const result = await gate.send('[sheets] Token at /Users/[user]/.config/google/sheets-token.json is expired', {
      key: 'token-health-sheets',
      tier: 'page',
    });
    expect(result).toBe('paged');
    expect(sent).toHaveLength(1);
  });

  test('allowSuspectContext:true bypasses the content guard for a confirmed-legitimate alert', async () => {
    const gate = makeGate();
    const result = await gate.send(leakedMessage, { key: 'k', tier: 'digest', allowSuspectContext: true });
    expect(result).toBe('spooled');
    const spool = gate.consumeSpool();
    expect(spool[0]!.tier).toBe('digest');
  });

  test('KAYA_ALERT_DRY_RUN=1 still short-circuits before the guard even runs (existing behavior preserved)', async () => {
    process.env.KAYA_ALERT_DRY_RUN = '1';
    const gate = makeGate();
    expect(await gate.send(leakedMessage, { key: 'k', tier: 'page' })).toBe('dry-run');
    expect(sent).toHaveLength(0);
  });
});

// ============================================================================
// KAYA_HOME-mismatch guard — second layer, page-tier delivery only.
//
// Precedent: PipelineDB.ts's defaultPipelineDbPath() treats a KAYA_HOME that
// equals defaultKayaHome() as "no real override" (every cron plist sets it
// to the repo root just so tools can find the repo). This guard uses the
// same defaultKayaHome() comparison to detect a MEANINGFUL override — the
// shape a test/sandbox session has, not a routine cron invocation.
//
// isSandboxedSendContext() is exported as a pure function specifically so
// this decision table is unit-testable WITHOUT ever constructing a
// network-capable AlertGate (one that uses the real defaultSend) — doing
// that in a test would risk an actual Telegram send if the guard had a bug,
// which is exactly the outcome these tests exist to rule out.
// ============================================================================

describe('isSandboxedSendContext (pure decision function)', () => {
  let sandboxHome: string;

  beforeEach(() => {
    sandboxHome = mkdtempSync(join(tmpdir(), 'kaya-home-mismatch-'));
  });

  afterEach(() => {
    rmSync(sandboxHome, { recursive: true, force: true });
    delete process.env.KAYA_HOME;
  });

  test('true when usesDefaultSend and KAYA_HOME points at a non-default sandbox', async () => {
    process.env.KAYA_HOME = sandboxHome;
    expect(isSandboxedSendContext(true)).toBe(true);
  });

  test('false when a custom send was injected, even with a non-default KAYA_HOME (hermetic tests are exempt)', async () => {
    process.env.KAYA_HOME = sandboxHome;
    expect(isSandboxedSendContext(false)).toBe(false);
  });

  test('false when KAYA_HOME is unset/default, even with usesDefaultSend', async () => {
    // No override — getKayaHome() resolves to defaultKayaHome(), matching.
    expect(isSandboxedSendContext(true)).toBe(false);
  });
});

// ============================================================================
// State TTL — the A2 fix for alert-gate.json's unbounded key accumulation
// (99/120 keys in the live file were dead `incident:*` entries from the
// now-fixed page storm; see cron-health-monitor.ts's own PRUNE_OLDER_THAN_MS
// for the sibling convention this mirrors).
// ============================================================================

describe('state TTL pruning (saveState is the single write path)', () => {
  const NINETY_DAYS = 90 * DAY;

  function readRawState(): { version: 1; keys: Record<string, unknown> } {
    return JSON.parse(readFileSync(join(dir, 'alert-gate.json'), 'utf-8'));
  }

  test('a key older than 90 days is pruned on the next save-triggering send; a key younger than 90 days survives', async () => {
    const gate = makeGate();
    await gate.send('stale', { key: 'stale-key', tier: 'page' }); // lastSentAt = clock.now (T0)
    clock.now += 2 * DAY;
    await gate.send('fresh', { key: 'fresh-key', tier: 'page' }); // lastSentAt = T0 + 2d

    // Advance 89 more days from here (T0+2d), landing at T0+91d: stale-key
    // (stamped at T0) is now exactly 91 days old, fresh-key exactly 89 days old.
    clock.now += 89 * DAY;
    await gate.send('trigger', { key: 'trigger-key', tier: 'page' }); // any save-triggering send prunes

    const raw = readRawState();
    expect(raw.keys['stale-key']).toBeUndefined();
    expect(raw.keys['fresh-key']).toBeDefined();
    expect(raw.keys['trigger-key']).toBeDefined();
  });

  test('a key exactly at the TTL boundary (just under 90 days) survives', async () => {
    const gate = makeGate();
    await gate.send('boundary', { key: 'boundary-key', tier: 'page' });
    clock.now += NINETY_DAYS - 1;
    await gate.send('trigger', { key: 'trigger-key', tier: 'page' });

    expect(readRawState().keys['boundary-key']).toBeDefined();
  });

  test("a key's own send always refreshes lastSentAt, so an active key never expires even after 100+ days of prior inactivity", async () => {
    const gate = makeGate();
    await gate.send('a', { key: 'k', tier: 'page' }); // T0
    clock.now += 100 * DAY; // far past TTL
    const result = await gate.send('b', { key: 'k', tier: 'page' }); // re-pages k itself
    expect(result).toBe('paged');

    const raw = readRawState();
    expect(raw.keys['k']).toBeDefined();
    expect((raw.keys['k'] as { lastSentAt: string }).lastSentAt).toBe(new Date(clock.now).toISOString());
  });

  test('shouldPage()/recordPaged() (gate-only API) also prunes via the shared saveState() path', async () => {
    const gate = makeGate();
    gate.recordPaged('stale-key'); // T0
    clock.now += NINETY_DAYS + DAY;
    gate.recordPaged('trigger-key'); // triggers saveState()

    const raw = readRawState();
    expect(raw.keys['stale-key']).toBeUndefined();
    expect(raw.keys['trigger-key']).toBeDefined();
  });

  test('an entry with a missing lastSentAt is kept, not pruned — unknown age is not evidence of staleness', async () => {
    const gate = makeGate();
    await gate.send('seed', { key: 'seed-key', tier: 'page' }); // creates the state file
    // Simulate hand-edited/legacy state missing the only timestamp field.
    const raw = readRawState();
    raw.keys['legacy-no-timestamp'] = {};
    const { writeFileSync: write } = require('fs') as typeof import('fs');
    write(join(dir, 'alert-gate.json'), JSON.stringify(raw, null, 2));

    clock.now += NINETY_DAYS + DAY;
    await gate.send('trigger', { key: 'trigger-key', tier: 'page' }); // save-triggering send

    expect(readRawState().keys['legacy-no-timestamp']).toBeDefined();
  });

  test('an entry with an unparseable lastSentAt string is kept, not pruned', async () => {
    const gate = makeGate();
    await gate.send('seed', { key: 'seed-key', tier: 'page' });
    const raw = readRawState();
    raw.keys['legacy-bad-timestamp'] = { lastSentAt: 'not-a-date' };
    const { writeFileSync: write } = require('fs') as typeof import('fs');
    write(join(dir, 'alert-gate.json'), JSON.stringify(raw, null, 2));

    clock.now += NINETY_DAYS + DAY;
    await gate.send('trigger', { key: 'trigger-key', tier: 'page' });

    expect(readRawState().keys['legacy-bad-timestamp']).toBeDefined();
  });
});

// ============================================================================
// fable-audit batch2, Finding A — send()'s outer catch used to be
// `catch { return 'suppressed'; }`: a genuine unexpected internal exception
// (not an ordinary cooldown/suppression decision) was swallowed with ZERO
// trace, indistinguishable from working-as-intended. This is the eval
// fixture for "the alert system itself fails silently" — it forces the
// internal-error path via an injected `send` that throws (the same
// dependency-injection idiom every other test in this file already uses)
// and asserts BOTH that the return contract is unchanged (never throws,
// still returns 'suppressed') AND that a loud trace happened (console.error
// + a durable 'log'-tier spool entry), never that it silently vanished.
// ============================================================================
describe("send()'s outer catch — internal errors are traced loudly, never silently swallowed", () => {
  test('an unexpected throw from the send function is caught, logged to console.error, and durably traced — result is still "suppressed", never thrown', async () => {
    const originalConsoleError = console.error;
    const errorLines: string[] = [];
    console.error = (...args: unknown[]) => {
      errorLines.push(args.map((a) => String(a)).join(' '));
    };

    const gate = new AlertGate({
      statePath: join(dir, 'broken-send-gate.json'),
      spoolPath: join(dir, 'broken-send-spool.jsonl'),
      send: async () => {
        throw new Error('simulated internal AlertGate failure (e.g. a future bug, ENOSPC)');
      },
      now: () => clock.now,
      // Not a quiet-hours test — see makeGate()'s note.
      quietHours: { ...DEFAULT_QUIET_HOURS, enabled: false },
    });

    let result: Awaited<ReturnType<AlertGate['send']>> | undefined;
    let threw = false;
    try {
      result = await gate.send('an urgent thing Jm must see', { key: 'k-broken', tier: 'page' });
    } catch {
      threw = true;
    } finally {
      console.error = originalConsoleError;
    }

    // (a) return contract unchanged — never throws/rejects, still 'suppressed'.
    expect(threw).toBe(false);
    expect(result).toBe('suppressed');

    // (b) loud trace happened — console.error fired with the real exception.
    expect(errorLines.some((line) => line.includes('INTERNAL ERROR'))).toBe(true);
    expect(errorLines.some((line) => line.includes('simulated internal AlertGate failure'))).toBe(true);

    // (b, durable) — a 'log'-tier spool entry was also written (best-effort
    // trace, mirrors the existing suspect-suppression pattern), so a future
    // investigation can find this even without having captured stderr live.
    const traceEntries = gate.readSpool().filter((e) => e.key === 'alert-gate-internal-error');
    expect(traceEntries).toHaveLength(1);
    expect(traceEntries[0]!.tier).toBe('log');
    expect(traceEntries[0]!.message).toContain('simulated internal AlertGate failure');
  });
});

// ============================================================================
// T2-01 — page-tier delivery guarantee: cooldown stamped ONLY on CONFIRMED
// delivery. §7's forced-failure fixture — proves the failure path is real,
// not just a happy-path re-assertion: an injected `send` that resolves
// `false` (simulating sendWithRetry() exhausting every retry+fallback
// channel) must NOT stamp the cooldown, must re-spool to digest, and must
// trace loudly. The mirror case (delivery success) proves recordPaged() IS
// still called on confirmed delivery — the existing 'first page for a key
// sends immediately' test above already covers that shape, so this describe
// block adds the one shape that test suite never had: real forced failure.
// ============================================================================
describe('page tier: delivery-confirmed cooldown gating (T2-01)', () => {
  test('failed delivery does NOT stamp cooldown, re-spools to digest, and traces loudly', async () => {
    const originalConsoleError = console.error;
    const errorLines: string[] = [];
    console.error = (...args: unknown[]) => {
      errorLines.push(args.map((a) => String(a)).join(' '));
    };

    const gate = new AlertGate({
      statePath: join(dir, 'delivery-fail-gate.json'),
      spoolPath: join(dir, 'delivery-fail-spool.jsonl'),
      send: async () => false, // simulates sendWithRetry() exhausting every retry/fallback
      now: () => clock.now,
      // Not a quiet-hours test — see makeGate()'s note.
      quietHours: { ...DEFAULT_QUIET_HOURS, enabled: false },
    });

    let result: Awaited<ReturnType<AlertGate['send']>>;
    try {
      result = await gate.send('bot needs healing', { key: 'k', tier: 'page' });
    } finally {
      console.error = originalConsoleError;
    }

    // Result is 'suppressed', not 'paged' — delivery was never confirmed.
    expect(result).toBe('suppressed');

    // Cooldown was NOT stamped — the very next attempt for this key can
    // still retry (shouldPage() is the same gate-only API recordPaged()
    // writes to; if the cooldown had been stamped this would be false).
    expect(gate.shouldPage('k')).toBe(true);

    // Re-spooled to digest so the alert isn't silently lost even if every
    // page attempt fails.
    const spooled = gate.readSpool();
    expect(spooled.some((e) => e.tier === 'digest' && e.message === 'bot needs healing' && e.key === 'k')).toBe(
      true,
    );

    // Loud trace: console.error fired, and a durable 'log'-tier spool entry
    // exists (mirrors the existing Finding-A internal-error trace pattern).
    expect(errorLines.some((line) => line.includes('DELIVERY FAILED'))).toBe(true);
    const traceEntries = spooled.filter((e) => e.key === 'alert-gate-delivery-failure');
    expect(traceEntries).toHaveLength(1);
    expect(traceEntries[0]!.tier).toBe('log');
  });

  test('confirmed delivery (send resolves true) DOES stamp cooldown and returns "paged"', async () => {
    const gate = new AlertGate({
      statePath: join(dir, 'delivery-ok-gate.json'),
      spoolPath: join(dir, 'delivery-ok-spool.jsonl'),
      send: async () => true,
      now: () => clock.now,
      // Not a quiet-hours test — see makeGate()'s note.
      quietHours: { ...DEFAULT_QUIET_HOURS, enabled: false },
    });

    const result = await gate.send('all good', { key: 'k', tier: 'page' });
    expect(result).toBe('paged');
    // Cooldown WAS stamped — an immediate re-send for the same key is now suppressed.
    expect(gate.shouldPage('k')).toBe(false);
  });

  test('a key that fails delivery, then succeeds, pages successfully on the retry (retry-not-permanent-suppression)', async () => {
    let shouldDeliver = false;
    const gate = new AlertGate({
      statePath: join(dir, 'delivery-retry-gate.json'),
      spoolPath: join(dir, 'delivery-retry-spool.jsonl'),
      send: async () => shouldDeliver,
      now: () => clock.now,
      // Not a quiet-hours test — see makeGate()'s note.
      quietHours: { ...DEFAULT_QUIET_HOURS, enabled: false },
    });

    const firstResult = await gate.send('flaky page', { key: 'flaky-key', tier: 'page' });
    expect(firstResult).toBe('suppressed');
    expect(gate.shouldPage('flaky-key')).toBe(true); // still retryable

    shouldDeliver = true;
    const secondResult = await gate.send('flaky page', { key: 'flaky-key', tier: 'page' });
    expect(secondResult).toBe('paged');
    expect(gate.shouldPage('flaky-key')).toBe(false); // now stamped
  });
});

describe('AlertGate.send() page-tier delivery respects the KAYA_HOME-mismatch guard only for the real send path', () => {
  let sandboxHome: string;

  beforeEach(() => {
    sandboxHome = mkdtempSync(join(tmpdir(), 'kaya-home-mismatch-'));
  });

  afterEach(() => {
    rmSync(sandboxHome, { recursive: true, force: true });
    delete process.env.KAYA_HOME;
  });

  test('a gate with an injected send (the hermetic-test norm) is NOT suppressed by a non-default KAYA_HOME', async () => {
    process.env.KAYA_HOME = sandboxHome;
    // makeGate() always injects `send` — this is the exact IntakeRunner.test.ts /
    // ApprovalNudge.test.ts / SystemHealthDigest.test.ts shape (construct AlertGate
    // with an overridden KAYA_HOME sandbox + a recording send stub to verify
    // page-tier escalation). Regression-guard: this must keep paging.
    const gate = makeGate();
    const result = await gate.send('a perfectly clean message, no tmp paths at all', { key: 'k', tier: 'page' });
    expect(result).toBe('paged');
    expect(sent).toHaveLength(1);
  });

  test('digest/log tiers never consult the KAYA_HOME-mismatch guard at all (only page-tier delivery does)', async () => {
    process.env.KAYA_HOME = sandboxHome;
    const gate = makeGate();
    expect(await gate.send('clean message', { key: 'k1', tier: 'digest' })).toBe('spooled');
    expect(await gate.send('clean message', { key: 'k2', tier: 'log' })).toBe('logged');
  });
});

// ============================================================================
// Quiet hours (2026-07-31)
// ============================================================================
//
// Context: quiet hours were previously a documented no-op — lib/cron/
// RouteOutput.ts records that `settings.daemon?.quietHours` was never set and
// the downgrade never fired, and the layer owning it was deleted in ADR-019.
// AlertGate had no time-of-day concept at all. 30% of page-tier Telegram sends
// (35 of 117 in the 14 days to 2026-07-31) landed between 22:00 and 07:00.
//
// All clocks below are explicit UTC instants converted against a fixed
// America/Los_Angeles window, so these never depend on the machine's clock.
// ============================================================================

describe('quiet hours — pure decision table', () => {
  const cfg = { ...DEFAULT_QUIET_HOURS }; // 22 -> 7, America/Los_Angeles

  // PDT is UTC-7, so 09:00Z = 02:00 local, 15:00Z = 08:00 local.
  const at = (utc: string) => new Date(utc).getTime();

  test('localHourIn converts to the configured zone, not the host zone', () => {
    expect(localHourIn(at('2026-07-31T09:00:00Z'), 'America/Los_Angeles')).toBe(2);
    expect(localHourIn(at('2026-07-31T15:00:00Z'), 'America/Los_Angeles')).toBe(8);
    // Same instant, different zone — proves the zone argument is load-bearing.
    expect(localHourIn(at('2026-07-31T09:00:00Z'), 'UTC')).toBe(9);
  });

  test('midnight is hour 0, not 24 (ICU hour12:false quirk)', () => {
    expect(localHourIn(at('2026-07-31T07:00:00Z'), 'America/Los_Angeles')).toBe(0);
  });

  test('the 22->07 window wraps midnight in both halves', () => {
    expect(isWithinQuietHours(at('2026-07-31T06:00:00Z'), cfg)).toBe(true);  // 23:00 local
    expect(isWithinQuietHours(at('2026-07-31T08:00:00Z'), cfg)).toBe(true);  // 01:00 local
    expect(isWithinQuietHours(at('2026-07-31T09:20:00Z'), cfg)).toBe(true);  // 02:20 — the real 07-31 send
    expect(isWithinQuietHours(at('2026-07-31T13:59:00Z'), cfg)).toBe(true);  // 06:59 local
  });

  test('daytime is not quiet, including the exact boundaries', () => {
    expect(isWithinQuietHours(at('2026-07-31T14:00:00Z'), cfg)).toBe(false); // 07:00 — end is exclusive
    expect(isWithinQuietHours(at('2026-07-31T15:00:00Z'), cfg)).toBe(false); // 08:00 local
    expect(isWithinQuietHours(at('2026-08-01T04:59:00Z'), cfg)).toBe(false); // 21:59 local
    expect(isWithinQuietHours(at('2026-08-01T05:00:00Z'), cfg)).toBe(true);  // 22:00 — start is inclusive
  });

  test('a same-day (non-wrapping) window works too', () => {
    const daytime = { ...cfg, startHour: 1, endHour: 5 };
    expect(isWithinQuietHours(at('2026-07-31T10:00:00Z'), daytime)).toBe(true);  // 03:00
    expect(isWithinQuietHours(at('2026-07-31T13:00:00Z'), daytime)).toBe(false); // 06:00
  });

  test('disabled or degenerate config is never quiet', () => {
    expect(isWithinQuietHours(at('2026-07-31T09:00:00Z'), { ...cfg, enabled: false })).toBe(false);
    expect(isWithinQuietHours(at('2026-07-31T09:00:00Z'), { ...cfg, startHour: 3, endHour: 3 })).toBe(false);
  });

  test('DST: the window tracks local time across the transition', () => {
    // 2026-11-01 PDT->PST. 09:00Z is 02:00 PDT before, 01:00 PST after.
    // Both are inside 22->07, which is the point: no fixed-offset drift.
    expect(isWithinQuietHours(at('2026-10-31T09:00:00Z'), cfg)).toBe(true);
    expect(isWithinQuietHours(at('2026-11-02T09:00:00Z'), cfg)).toBe(true);
    // 14:30Z is 07:30 PDT (awake) but 06:30 PST (quiet) — a fixed -7 offset
    // would get one of these wrong.
    expect(isWithinQuietHours(at('2026-10-31T14:30:00Z'), cfg)).toBe(false);
    expect(isWithinQuietHours(at('2026-11-02T14:30:00Z'), cfg)).toBe(true);
  });
});

describe('quiet hours — resolveQuietHours config merge', () => {
  test('missing/!object config falls back to the defaults', () => {
    expect(resolveQuietHours(null)).toEqual(DEFAULT_QUIET_HOURS);
    expect(resolveQuietHours({})).toEqual(DEFAULT_QUIET_HOURS);
    expect(resolveQuietHours({ notifications: {} })).toEqual(DEFAULT_QUIET_HOURS);
    expect(resolveQuietHours({ notifications: { quietHours: 'nope' } })).toEqual(DEFAULT_QUIET_HOURS);
  });

  test('partial config overrides only what it sets', () => {
    const r = resolveQuietHours({ notifications: { quietHours: { startHour: 23 } } });
    expect(r.startHour).toBe(23);
    expect(r.endHour).toBe(DEFAULT_QUIET_HOURS.endHour);
    expect(r.timeZone).toBe(DEFAULT_QUIET_HOURS.timeZone);
  });

  test('out-of-range or wrong-typed hours fall back rather than corrupt the window', () => {
    const r = resolveQuietHours({
      notifications: { quietHours: { startHour: 99, endHour: -1, timeZone: '', enabled: 'yes' } },
    });
    expect(r.startHour).toBe(DEFAULT_QUIET_HOURS.startHour);
    expect(r.endHour).toBe(DEFAULT_QUIET_HOURS.endHour);
    expect(r.timeZone).toBe(DEFAULT_QUIET_HOURS.timeZone);
    expect(r.enabled).toBe(DEFAULT_QUIET_HOURS.enabled);
  });
});

describe('quiet hours — send() routing', () => {
  const QUIET = new Date('2026-07-31T09:20:00Z').getTime(); // 02:20 local
  const AWAKE = new Date('2026-07-31T15:20:00Z').getTime(); // 08:20 local
  const onCfg = { ...DEFAULT_QUIET_HOURS };

  test('a page inside the window is demoted to digest, not delivered', async () => {
    clock = { now: QUIET };
    const gate = makeGate({ quietHours: onCfg });

    const result = await gate.send('🌙 Overnight: 1 job(s) slept through 1 run(s)', {
      key: 'cron-health', tier: 'page',
    });

    expect(result).toBe('suppressed');
    expect(sent).toHaveLength(0);
    const spool = gate.readSpool();
    expect(spool).toHaveLength(1);
    expect(spool[0]!.tier).toBe('digest'); // surfaces in the morning digest
  });

  test('the same page outside the window delivers normally', async () => {
    clock = { now: AWAKE };
    const gate = makeGate({ quietHours: onCfg });

    expect(await gate.send('same alert', { key: 'cron-health', tier: 'page' })).toBe('paged');
    expect(sent).toHaveLength(1);
  });

  test('a quiet-hours demotion does NOT spend the cooldown — it pages once awake', async () => {
    // The regression this guards: if the demotion stamped the cooldown, a
    // condition first seen at 02:00 would be silently self-suppressed for the
    // next 24h and never page at all.
    clock = { now: QUIET };
    const gate = makeGate({ quietHours: onCfg });
    expect(await gate.send('still broken', { key: 'k', tier: 'page' })).toBe('suppressed');
    expect(gate.shouldPage('k')).toBe(true);

    clock.now = AWAKE;
    expect(await gate.send('still broken', { key: 'k', tier: 'page' })).toBe('paged');
    expect(sent).toHaveLength(1);
  });

  test('critical: true pages through the window when the override is allowed', async () => {
    clock = { now: QUIET };
    const gate = makeGate({ quietHours: onCfg });
    expect(await gate.send('house on fire', { key: 'k', tier: 'page', critical: true })).toBe('paged');
    expect(sent).toHaveLength(1);
  });

  test('critical: true is ignored when allowCriticalOverride is false', async () => {
    clock = { now: QUIET };
    const gate = makeGate({ quietHours: { ...onCfg, allowCriticalOverride: false } });
    expect(await gate.send('house on fire', { key: 'k', tier: 'page', critical: true })).toBe('suppressed');
    expect(sent).toHaveLength(0);
  });

  test('digest/log tiers are unaffected — they never paged in the first place', async () => {
    clock = { now: QUIET };
    const gate = makeGate({ quietHours: onCfg });
    expect(await gate.send('a', { key: 'k1', tier: 'digest' })).toBe('spooled');
    expect(await gate.send('b', { key: 'k2', tier: 'log' })).toBe('logged');
  });
});
