import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir, homedir } from 'os';
import { join } from 'path';
import { z } from 'zod';
import {
  MEMORY,
  memPath,
  defineFileAccessor,
  type FileAccessor,
} from './MemoryPaths.ts';

describe('MemoryPaths', () => {
  const originalKayaHome = process.env.KAYA_HOME;

  beforeEach(() => {
    delete process.env.KAYA_HOME;
    delete process.env.KAYA_DIR;
  });

  afterEach(() => {
    if (originalKayaHome !== undefined) {
      process.env.KAYA_HOME = originalKayaHome;
    } else {
      delete process.env.KAYA_HOME;
    }
  });

  const expectedBase = () => `${homedir()}/.claude/MEMORY`;

  describe('MEMORY.* getters', () => {
    it('ROOT() returns MEMORY root under getKayaHome()', () => {
      expect(MEMORY.ROOT()).toBe(expectedBase());
    });

    it('STATE() returns MEMORY/State under getKayaHome()', () => {
      expect(MEMORY.STATE()).toBe(`${expectedBase()}/State`);
    });

    it('state file helpers use the same case-sensitive State directory', () => {
      expect(MEMORY.PROGRESS()).toBe(`${expectedBase()}/State/progress`);
      expect(MEMORY.AGENT_SESSIONS_JSON()).toBe(`${expectedBase()}/State/agent-sessions.json`);
    });

    it('NOTIFICATIONS() returns correct path', () => {
      expect(MEMORY.NOTIFICATIONS()).toBe(`${expectedBase()}/NOTIFICATIONS`);
    });

    it('WORK() returns correct path', () => {
      expect(MEMORY.WORK()).toBe(`${expectedBase()}/WORK`);
    });

    it('DAEMON() returns correct path', () => {
      expect(MEMORY.DAEMON()).toBe(`${expectedBase()}/daemon`);
    });

    it('NOTIFICATIONS_JSONL() returns correct file path', () => {
      expect(MEMORY.NOTIFICATIONS_JSONL()).toBe(
        `${expectedBase()}/NOTIFICATIONS/notifications.jsonl`
      );
    });

    it('WORK_QUEUE_JSON() returns correct file path', () => {
      expect(MEMORY.WORK_QUEUE_JSON()).toBe(`${expectedBase()}/WORK/work-queue.json`);
    });

    it('CONTEXT_CLASSIFICATION() returns correct file path', () => {
      expect(MEMORY.CONTEXT_CLASSIFICATION()).toBe(
        `${expectedBase()}/State/context-classification.json`
      );
    });

    it('ALERTS_JSONL() returns correct nested path', () => {
      expect(MEMORY.ALERTS_JSONL()).toBe(
        `${expectedBase()}/MONITORING/audit/alerts.jsonl`
      );
    });

    it('RATE_LIMITS() returns correct file path', () => {
      expect(MEMORY.RATE_LIMITS()).toBe(`${expectedBase()}/State/rate-limits.json`);
    });
  });

  describe('KAYA_HOME override propagates to all paths', () => {
    it('all getters reflect KAYA_HOME override', () => {
      process.env.KAYA_HOME = '/custom/home';
      const base = '/custom/home/MEMORY';
      expect(MEMORY.ROOT()).toBe(base);
      expect(MEMORY.STATE()).toBe(`${base}/State`);
      expect(MEMORY.NOTIFICATIONS_JSONL()).toBe(`${base}/NOTIFICATIONS/notifications.jsonl`);
      expect(MEMORY.WORK_QUEUE_JSON()).toBe(`${base}/WORK/work-queue.json`);
      expect(MEMORY.RATE_LIMITS()).toBe(`${base}/State/rate-limits.json`);
    });
  });

  describe('memPath()', () => {
    it('joins segments under MEMORY/', () => {
      const result = memPath('LEARNING', 'SIGNALS', 'foo.jsonl');
      expect(result).toBe(`${expectedBase()}/LEARNING/SIGNALS/foo.jsonl`);
    });

    it('returns MEMORY root when called with no args', () => {
      const result = memPath();
      expect(result).toBe(expectedBase());
    });

    it('respects KAYA_HOME override', () => {
      process.env.KAYA_HOME = '/test-override';
      const result = memPath('QUEUES', 'approved-work.jsonl');
      expect(result).toBe('/test-override/MEMORY/QUEUES/approved-work.jsonl');
    });
  });

  describe('typed accessor namespaces', () => {
    it('exposes empty MEMORY.state and MEMORY.work as objects', () => {
      expect(typeof MEMORY.state).toBe('object');
      expect(typeof MEMORY.work).toBe('object');
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Factory tests — exercise defineFileAccessor against a real temp filesystem
// using mkdtempSync + KAYA_HOME override (Slice 0 of candidate #2).
// ─────────────────────────────────────────────────────────────────────────────

const SyntheticSchema = z.object({
  name: z.string(),
  version: z.number(),
  optional: z.string().optional(),
});
type Synthetic = z.infer<typeof SyntheticSchema>;

describe('defineFileAccessor()', () => {
  let tempDir: string;
  const originalKayaHome = process.env.KAYA_HOME;

  function makeAccessor(): FileAccessor<Synthetic> {
    return defineFileAccessor(
      'synthetic',
      () => memPath('TestSynthetic', 'value.json'),
      SyntheticSchema,
    );
  }

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'memorypaths-test-'));
    process.env.KAYA_HOME = tempDir;
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
    if (originalKayaHome !== undefined) {
      process.env.KAYA_HOME = originalKayaHome;
    } else {
      delete process.env.KAYA_HOME;
    }
  });

  describe('path()', () => {
    it('resolves under KAYA_HOME override at call time', () => {
      const accessor = makeAccessor();
      expect(accessor.path()).toBe(`${tempDir}/MEMORY/TestSynthetic/value.json`);
    });
  });

  describe('read() — three error modes', () => {
    it('returns null silently when the file is missing', () => {
      const warn = spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const accessor = makeAccessor();
        expect(accessor.read()).toBe(null);
        expect(warn).not.toHaveBeenCalled();
      } finally {
        warn.mockRestore();
      }
    });

    it('returns null + warns on JSON parse failure', () => {
      const warn = spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const accessor = makeAccessor();
        accessor.write({ name: 'a', version: 1 });
        writeFileSync(accessor.path(), '{not valid json', 'utf-8');
        expect(accessor.read()).toBe(null);
        expect(warn).toHaveBeenCalled();
        const msg = warn.mock.calls[0][0] as string;
        expect(msg).toContain('[MemoryPaths:synthetic]');
        expect(msg).toContain('JSON parse failed');
      } finally {
        warn.mockRestore();
      }
    });

    it('returns null + warns on schema validation failure', () => {
      const warn = spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const accessor = makeAccessor();
        accessor.write({ name: 'a', version: 1 });
        writeFileSync(accessor.path(), JSON.stringify({ name: 'a', version: 'wrong' }), 'utf-8');
        expect(accessor.read()).toBe(null);
        expect(warn).toHaveBeenCalled();
        const msg = warn.mock.calls[0][0] as string;
        expect(msg).toContain('[MemoryPaths:synthetic]');
        expect(msg).toContain('validation failed');
      } finally {
        warn.mockRestore();
      }
    });

    it('returns the typed value on happy path', () => {
      const accessor = makeAccessor();
      accessor.write({ name: 'kaya', version: 7 });
      const got = accessor.read();
      expect(got).toEqual({ name: 'kaya', version: 7 });
    });
  });

  describe('readStrict()', () => {
    it('throws when the file is missing', () => {
      const accessor = makeAccessor();
      expect(() => accessor.readStrict()).toThrow(/missing file/);
    });

    it('throws on JSON parse failure', () => {
      const accessor = makeAccessor();
      accessor.write({ name: 'a', version: 1 });
      writeFileSync(accessor.path(), 'not json', 'utf-8');
      expect(() => accessor.readStrict()).toThrow();
    });

    it('throws on schema validation failure', () => {
      const accessor = makeAccessor();
      accessor.write({ name: 'a', version: 1 });
      writeFileSync(accessor.path(), JSON.stringify({ name: 'a' }), 'utf-8');
      expect(() => accessor.readStrict()).toThrow();
    });

    it('returns the typed value on happy path', () => {
      const accessor = makeAccessor();
      accessor.write({ name: 'kaya', version: 1, optional: 'x' });
      expect(accessor.readStrict()).toEqual({ name: 'kaya', version: 1, optional: 'x' });
    });
  });

  describe('write()', () => {
    it('creates the parent directory if missing', () => {
      const accessor = makeAccessor();
      const filepath = accessor.path();
      expect(existsSync(filepath)).toBe(false);
      accessor.write({ name: 'fresh', version: 1 });
      expect(existsSync(filepath)).toBe(true);
      const raw = readFileSync(filepath, 'utf-8');
      expect(JSON.parse(raw)).toEqual({ name: 'fresh', version: 1 });
    });

    it('writes atomically (no .tmp file lingers on success)', () => {
      const accessor = makeAccessor();
      accessor.write({ name: 'a', version: 1 });
      accessor.write({ name: 'b', version: 2 });
      const dir = accessor.path().replace(/\/[^/]+$/, '');
      const { readdirSync } = require('fs') as typeof import('fs');
      const entries = readdirSync(dir);
      const tmpFiles = entries.filter((f) => f.includes('.tmp.'));
      expect(tmpFiles).toEqual([]);
    });
  });

  describe('update()', () => {
    it('reads, mutates, and writes atomically', () => {
      const accessor = makeAccessor();
      accessor.write({ name: 'a', version: 1 });
      const result = accessor.update((current) => ({ ...current, version: current.version + 1 }));
      expect(result).toEqual({ name: 'a', version: 2 });
      expect(accessor.read()).toEqual({ name: 'a', version: 2 });
    });

    it('throws when the file is missing (callers compose read() ?? default + write() for tolerant variants)', () => {
      const accessor = makeAccessor();
      expect(() => accessor.update((c) => c)).toThrow(/missing file/);
    });
  });

  describe('schema property', () => {
    it('exposes the underlying Zod schema for caller-side validation', () => {
      const accessor = makeAccessor();
      expect(accessor.schema).toBe(SyntheticSchema);
      const parsed = accessor.schema.safeParse({ name: 'x', version: 5 });
      expect(parsed.success).toBe(true);
    });
  });
});

describe('MEMORY.state.rateLimits', () => {
  let tempDir: string;
  const originalKayaHome = process.env.KAYA_HOME;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'memorypaths-rl-'));
    process.env.KAYA_HOME = tempDir;
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
    if (originalKayaHome !== undefined) {
      process.env.KAYA_HOME = originalKayaHome;
    } else {
      delete process.env.KAYA_HOME;
    }
  });

  it('path() resolves under KAYA_HOME at call time', () => {
    expect(MEMORY.state.rateLimits.path()).toBe(`${tempDir}/MEMORY/State/rate-limits.json`);
  });

  it('read() returns null when the file is missing', () => {
    expect(MEMORY.state.rateLimits.read()).toBe(null);
  });

  it('read() returns the typed value for the canonical shape (both windows null)', () => {
    MEMORY.state.rateLimits.write({
      fiveHour: null,
      sevenDay: null,
      updatedAt: '2026-05-06T23:20:35Z',
    });
    expect(MEMORY.state.rateLimits.read()).toEqual({
      fiveHour: null,
      sevenDay: null,
      updatedAt: '2026-05-06T23:20:35Z',
    });
  });

  it('read() returns the typed value with populated windows', () => {
    MEMORY.state.rateLimits.write({
      fiveHour: { usedPercentage: 42, resetsAt: '2026-05-07T00:00:00Z' },
      sevenDay: { usedPercentage: 17, resetsAt: '2026-05-13T00:00:00Z' },
      updatedAt: '2026-05-06T23:20:35Z',
    });
    const got = MEMORY.state.rateLimits.read();
    expect(got?.fiveHour?.usedPercentage).toBe(42);
    expect(got?.sevenDay?.usedPercentage).toBe(17);
  });

  it('read() returns null + warns on schema mismatch', () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      MEMORY.state.rateLimits.write({ fiveHour: null, sevenDay: null });
      writeFileSync(MEMORY.state.rateLimits.path(), JSON.stringify({ fiveHour: 'oops' }), 'utf-8');
      expect(MEMORY.state.rateLimits.read()).toBe(null);
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});

describe('MEMORY.work.queue', () => {
  let tempDir: string;
  const originalKayaHome = process.env.KAYA_HOME;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'memorypaths-wq-'));
    process.env.KAYA_HOME = tempDir;
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
    if (originalKayaHome !== undefined) {
      process.env.KAYA_HOME = originalKayaHome;
    } else {
      delete process.env.KAYA_HOME;
    }
  });

  it('path() resolves under KAYA_HOME at call time', () => {
    expect(MEMORY.work.queue.path()).toBe(`${tempDir}/MEMORY/WORK/work-queue.json`);
  });

  it('read() returns null when the file is missing', () => {
    expect(MEMORY.work.queue.read()).toBe(null);
  });

  it('read() returns the typed value with empty items', () => {
    MEMORY.work.queue.write({
      items: [],
      lastUpdated: '2026-05-06T23:30:00Z',
      totalProcessed: 0,
      totalFailed: 0,
    });
    const got = MEMORY.work.queue.read();
    expect(got?.items).toEqual([]);
    expect(got?.lastUpdated).toBe('2026-05-06T23:30:00Z');
  });

  it('read() preserves arbitrary item fields (passthrough)', () => {
    MEMORY.work.queue.write({
      items: [
        { id: 'abc', title: 'Foo', status: 'in_progress', extra: { nested: 1 } },
      ],
      lastUpdated: '2026-05-06T23:30:00Z',
    });
    const got = MEMORY.work.queue.read();
    expect(got?.items.length).toBe(1);
    expect(got?.items[0]).toEqual({ id: 'abc', title: 'Foo', status: 'in_progress', extra: { nested: 1 } });
  });

  it('read() rejects a bare-array shape (writer always emits {items: [...]})', () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      MEMORY.work.queue.write({ items: [] });
      writeFileSync(MEMORY.work.queue.path(), JSON.stringify([{ id: 'x' }]), 'utf-8');
      expect(MEMORY.work.queue.read()).toBe(null);
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('update() round-trips through read+mutator+write', () => {
    MEMORY.work.queue.write({ items: [{ id: 'a', status: 'pending' }] });
    MEMORY.work.queue.update((current) => ({
      ...current,
      items: [...current.items, { id: 'b', status: 'pending' }],
    }));
    const got = MEMORY.work.queue.read();
    expect(got?.items.map((i) => i.id)).toEqual(['a', 'b']);
  });
});

describe('MEMORY.state.integrity', () => {
  let tempDir: string;
  const originalKayaHome = process.env.KAYA_HOME;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'memorypaths-int-'));
    process.env.KAYA_HOME = tempDir;
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
    if (originalKayaHome !== undefined) {
      process.env.KAYA_HOME = originalKayaHome;
    } else {
      delete process.env.KAYA_HOME;
    }
  });

  it('path() resolves to State/integrity-state.json under KAYA_HOME', () => {
    expect(MEMORY.state.integrity.path()).toBe(`${tempDir}/MEMORY/State/integrity-state.json`);
  });

  it('read() returns null when the file is missing', () => {
    expect(MEMORY.state.integrity.read()).toBe(null);
  });

  it('write+read round-trip preserves the canonical shape', () => {
    MEMORY.state.integrity.write({
      last_run: '2026-05-06T23:30:00Z',
      last_changes_hash: 'abc123',
      cooldown_until: null,
    });
    expect(MEMORY.state.integrity.read()).toEqual({
      last_run: '2026-05-06T23:30:00Z',
      last_changes_hash: 'abc123',
      cooldown_until: null,
    });
  });

  it('rejects shape with wrong field types', () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      MEMORY.state.integrity.write({ last_run: 'x', last_changes_hash: 'y', cooldown_until: null });
      writeFileSync(
        MEMORY.state.integrity.path(),
        JSON.stringify({ last_run: 1, last_changes_hash: 2, cooldown_until: null }),
        'utf-8',
      );
      expect(MEMORY.state.integrity.read()).toBe(null);
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});
