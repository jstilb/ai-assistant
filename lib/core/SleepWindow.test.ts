#!/usr/bin/env bun
/**
 * SleepWindow.test.ts — parses `sysctl -n kern.sleeptime kern.waketime`
 * output into the most-recent sleep/wake timestamps.
 * Injectable execFn so no real `sysctl` process is required.
 * Run: bun test <ABSOLUTE PATH to this file>
 */

import { describe, test, expect } from 'bun:test';
import { getLastSleepWake, sleptDuringWindow, sleptSince, stableAwakeFor } from './SleepWindow';

// Real-shaped sample from the machine that slept through cron on 2026-07-11
// (sleep at sec=1783886881, wake at sec=1783886899 — 18s later).
const REAL_SAMPLE =
  '{ sec = 1783886881, usec = 544220 } Sun Jul 12 13:08:01 2026\n' +
  '{ sec = 1783886899, usec = 985436 } Sun Jul 12 13:08:19 2026\n';
const SLEEP_MS = 1783886881000;
const WAKE_MS = 1783886899000;

describe('getLastSleepWake', () => {
  test('parses real-shaped sysctl output', () => {
    const result = getLastSleepWake(() => REAL_SAMPLE);
    expect(result.lastSleepAtMs).toBe(SLEEP_MS);
    expect(result.lastWakeAtMs).toBe(WAKE_MS);
  });

  test('sec = 0 (never slept/woken since boot) is treated as null, not epoch-0', () => {
    const result = getLastSleepWake(
      () => '{ sec = 0, usec = 0 } Thu Jan  1 00:00:00 1970\n{ sec = 0, usec = 0 } Thu Jan  1 00:00:00 1970\n',
    );
    expect(result.lastSleepAtMs).toBeNull();
    expect(result.lastWakeAtMs).toBeNull();
  });

  test('never throws and returns nulls if execFn throws', () => {
    const result = getLastSleepWake(() => {
      throw new Error('sysctl: command not found');
    });
    expect(result.lastSleepAtMs).toBeNull();
    expect(result.lastWakeAtMs).toBeNull();
  });

  test('never throws and returns nulls on garbage output', () => {
    const result = getLastSleepWake(() => 'garbage output\n');
    expect(result.lastSleepAtMs).toBeNull();
    expect(result.lastWakeAtMs).toBeNull();
  });

  test('default exec is PATH-independent (launchd cron PATH omits /usr/sbin)', () => {
    // Regression for 2026-07-21/27/31: the cron plists' PATH omits /usr/sbin,
    // so a bare 'sysctl' spawn threw ENOENT and every launchd run silently
    // degraded to "no sleep evidence" — sleep-wedged briefing runs burned 3
    // timeout attempts instead of deferring. SYSCTL_BIN must be absolute so
    // PATH never matters. Must run in a SUBPROCESS whose PATH is restricted
    // from startup: mutating process.env.PATH in-process does NOT affect
    // Bun's executable resolution (verified while writing this test), so an
    // in-process version passes even against the broken bare-name code.
    const modPath = new URL('./SleepWindow.ts', import.meta.url).pathname;
    const script =
      `import { getLastSleepWake } from ${JSON.stringify(modPath)};` +
      `console.log(JSON.stringify(getLastSleepWake()));`;
    const run = (path: string) => {
      const proc = Bun.spawnSync([process.execPath, '-e', script], {
        env: { ...process.env, PATH: path },
      });
      return JSON.parse(proc.stdout.toString());
    };
    const full = run(process.env.PATH ?? '/usr/sbin:/usr/bin:/bin');
    const restricted = run('/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin');
    expect(restricted).toEqual(full);
  });
});

describe('sleptDuringWindow', () => {
  test('true when the window overlaps the closed sleep interval', () => {
    const result = sleptDuringWindow(SLEEP_MS - 60_000, WAKE_MS + 60_000, () => REAL_SAMPLE);
    expect(result).toBe(true);
  });

  test('false when the window does not overlap the sleep interval', () => {
    const result = sleptDuringWindow(WAKE_MS + 60_000, WAKE_MS + 120_000, () => REAL_SAMPLE);
    expect(result).toBe(false);
  });

  test('true when still-asleep (open interval) and window starts before now', () => {
    // wake line missing entirely -> open interval [SLEEP_MS, +Infinity)
    const stillAsleep = () => `{ sec = ${SLEEP_MS / 1000}, usec = 0 } Sun Jul 12 13:08:01 2026\n`;
    const result = sleptDuringWindow(SLEEP_MS + 60_000, SLEEP_MS + 120_000, stillAsleep);
    expect(result).toBe(true);
  });

  test('false with no sleep evidence at all', () => {
    const result = sleptDuringWindow(0, Date.now(), () => 'garbage\n');
    expect(result).toBe(false);
  });
});

describe('sleptSince', () => {
  test('true when lastSleepAtMs >= sinceMs', () => {
    expect(sleptSince(SLEEP_MS - 1000, () => REAL_SAMPLE)).toBe(true);
  });

  test('false when lastSleepAtMs < sinceMs', () => {
    expect(sleptSince(SLEEP_MS + 1000, () => REAL_SAMPLE)).toBe(false);
  });

  test('false with no sleep evidence', () => {
    expect(sleptSince(0, () => 'garbage\n')).toBe(false);
  });

  test('true when sleep is present but wake is null (still counts as slept since)', () => {
    const noWake = () => `{ sec = ${SLEEP_MS / 1000}, usec = 0 } Sun Jul 12 13:08:01 2026\n`;
    expect(sleptSince(SLEEP_MS - 1000, noWake)).toBe(true);
  });
});

describe('stableAwakeFor', () => {
  test('false for a recent wake (not yet stable)', () => {
    const nowMs = WAKE_MS + 5_000; // 5s after waking
    expect(stableAwakeFor(10 * 60_000, nowMs, () => REAL_SAMPLE)).toBe(false);
  });

  test('true once enough time has passed since the last wake', () => {
    const nowMs = WAKE_MS + 15 * 60_000; // 15 minutes after waking
    expect(stableAwakeFor(10 * 60_000, nowMs, () => REAL_SAMPLE)).toBe(true);
  });

  test('false while still asleep (open interval / missing wake)', () => {
    const stillAsleep = () => `{ sec = ${SLEEP_MS / 1000}, usec = 0 } Sun Jul 12 13:08:01 2026\n`;
    expect(stableAwakeFor(10 * 60_000, SLEEP_MS + 60 * 60_000, stillAsleep)).toBe(false);
  });

  test('true with no sleep evidence at all (awake since boot, as far as we can measure)', () => {
    expect(stableAwakeFor(10 * 60_000, Date.now(), () => 'garbage\n')).toBe(true);
  });

  test('true on exec failure (fail-open)', () => {
    const throws = () => {
      throw new Error('sysctl: command not found');
    };
    expect(stableAwakeFor(10 * 60_000, Date.now(), throws)).toBe(true);
  });
});
