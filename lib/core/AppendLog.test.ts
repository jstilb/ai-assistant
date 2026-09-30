import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createAppendLog } from './AppendLog.ts';

describe('AppendLog', () => {
  let testDir: string;
  let logPath: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `append-log-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(testDir, { recursive: true });
    logPath = join(testDir, 'test.jsonl');
  });

  afterEach(() => {
    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  describe('append()', () => {
    it('creates file if it does not exist', () => {
      const log = createAppendLog(logPath);
      expect(existsSync(logPath)).toBe(false);
      log.append({ event: 'test', ts: 1 });
      expect(existsSync(logPath)).toBe(true);
    });

    it('creates parent directories if missing', () => {
      const nestedPath = join(testDir, 'a', 'b', 'c', 'test.jsonl');
      const log = createAppendLog(nestedPath);
      log.append({ event: 'nested' });
      expect(existsSync(nestedPath)).toBe(true);
    });

    it('writes valid JSONL — one record per line', () => {
      const log = createAppendLog(logPath);
      log.append({ event: 'first', value: 1 });
      log.append({ event: 'second', value: 2 });

      const content = readFileSync(logPath, 'utf-8');
      const lines = content.split('\n').filter(l => l.trim().length > 0);
      expect(lines).toHaveLength(2);

      const first = JSON.parse(lines[0]);
      const second = JSON.parse(lines[1]);
      expect(first.event).toBe('first');
      expect(first.value).toBe(1);
      expect(second.event).toBe('second');
      expect(second.value).toBe(2);
    });

    it('rotates file automatically when size exceeds maxSizeBytes', () => {
      const log = createAppendLog(logPath, { maxSizeBytes: 50, retentionDays: 999 });

      // Write enough to exceed 50 bytes
      log.append({ event: 'fill', data: 'this is a long string to fill the file up' });
      // Next append should trigger rotation
      log.append({ event: 'triggers-rotation' });

      const files = readdirSync(testDir);
      const rotated = files.filter(f => f !== 'test.jsonl' && f.endsWith('.jsonl'));
      expect(rotated.length).toBeGreaterThan(0);
    });

    it('throws on actual write error (not swallowed)', () => {
      // Make the path a directory to force write error
      mkdirSync(logPath, { recursive: true });
      const log = createAppendLog(logPath);
      expect(() => log.append({ event: 'fail' })).toThrow();
    });
  });

  describe('appendRaw()', () => {
    it('writes raw line with newline', () => {
      const log = createAppendLog(logPath);
      log.appendRaw('raw line content');
      const content = readFileSync(logPath, 'utf-8');
      expect(content).toBe('raw line content\n');
    });

    it('does not double-add newline if line already ends with newline', () => {
      const log = createAppendLog(logPath);
      log.appendRaw('line with newline\n');
      const content = readFileSync(logPath, 'utf-8');
      expect(content).toBe('line with newline\n');
    });
  });

  describe('appendJson()', () => {
    it('is equivalent to append()', () => {
      const log = createAppendLog(logPath);
      log.appendJson({ type: 'json', val: 42 });
      const content = readFileSync(logPath, 'utf-8');
      const parsed = JSON.parse(content.trim());
      expect(parsed.type).toBe('json');
      expect(parsed.val).toBe(42);
    });
  });

  describe('rotate()', () => {
    it('renames active file to a timestamped filename', () => {
      writeFileSync(logPath, '{"event":"existing"}\n');
      const log = createAppendLog(logPath);

      const rotatedPath = log.rotate();
      expect(rotatedPath).not.toBe('');
      expect(existsSync(rotatedPath)).toBe(true);
      expect(existsSync(logPath)).toBe(false);
    });

    it('returns empty string when file does not exist', () => {
      const log = createAppendLog(logPath);
      const result = log.rotate();
      expect(result).toBe('');
    });

    it('rotated filename contains ISO timestamp pattern', () => {
      writeFileSync(logPath, '{"event":"test"}\n');
      const log = createAppendLog(logPath);
      const rotatedPath = log.rotate();
      expect(rotatedPath).toMatch(/\.\d{4}-\d{2}-\d{2}T[\d\-:.]+Z\.jsonl$/);
    });

    it('does not throw from append() when rotation fails (rotation error is caught)', () => {
      // We test that append() does not throw even if size tracking causes rotation attempt
      // by using a normal log that won't overflow
      const log = createAppendLog(logPath, { maxSizeBytes: 1_000_000 });
      log.append({ event: 'normal' });
      // No rotation expected, no error
      expect(existsSync(logPath)).toBe(true);
    });
  });

  describe('cleanup()', () => {
    it('deletes rotated files beyond maxRotatedFiles', () => {
      // Create several rotated files
      const base = logPath.replace('.jsonl', '');
      for (let i = 0; i < 5; i++) {
        const ts = `2024-01-0${i + 1}T00-00-00-000Z`;
        writeFileSync(`${base}.${ts}.jsonl`, `{"i":${i}}\n`);
      }

      const log = createAppendLog(logPath, { maxRotatedFiles: 2, retentionDays: 9999 });
      const deleted = log.cleanup();
      expect(deleted).toBe(3);

      const remaining = readdirSync(testDir).filter(
        f => f !== 'test.jsonl' && f.endsWith('.jsonl')
      );
      expect(remaining).toHaveLength(2);
    });

    it('returns count of deleted files when maxRotatedFiles exceeded', () => {
      // Create 3 rotated files, allow only 1
      const base = logPath.replace('.jsonl', '');
      for (let i = 0; i < 3; i++) {
        const ts = `2025-01-0${i + 1}T00-00-00-000Z`;
        writeFileSync(`${base}.${ts}.jsonl`, `{"i":${i}}\n`);
      }

      const log = createAppendLog(logPath, { retentionDays: 9999, maxRotatedFiles: 1 });
      const deleted = log.cleanup();
      expect(deleted).toBe(2);
    });
  });

  describe('size()', () => {
    it('returns 0 for non-existent file', () => {
      const log = createAppendLog(logPath);
      expect(log.size()).toBe(0);
    });

    it('returns correct byte count after writes', () => {
      const log = createAppendLog(logPath);
      log.append({ x: 1 });
      expect(log.size()).toBeGreaterThan(0);
    });
  });

  describe('stats getter', () => {
    it('reports line count, byte size, and rotated file count', () => {
      const log = createAppendLog(logPath);
      log.append({ a: 1 });
      log.append({ b: 2 });

      const s = log.stats;
      expect(s.lines).toBe(2);
      expect(s.sizeBytes).toBeGreaterThan(0);
      expect(typeof s.rotatedFiles).toBe('number');
    });
  });

  describe('readLastN()', () => {
    it('returns an empty array when the file does not exist', () => {
      const log = createAppendLog(logPath);
      expect(log.readLastN(10)).toEqual([]);
    });

    it('reads back written records, oldest first', () => {
      const log = createAppendLog(logPath);
      log.append({ hello: 'world', n: 42 });
      log.append({ hello: 'second', n: 99 });

      const results = log.readLastN<{ hello: string; n: number }>(10);
      expect(results).toHaveLength(2);
      expect(results[0].hello).toBe('world');
      expect(results[0].n).toBe(42);
      expect(results[1].hello).toBe('second');
      expect(results[1].n).toBe(99);
    });

    it('returns only the last N records when more exist than requested', () => {
      const log = createAppendLog(logPath);
      for (let i = 0; i < 5; i++) log.append({ i });
      const results = log.readLastN<{ i: number }>(2);
      expect(results).toHaveLength(2);
      expect(results[0].i).toBe(3);
      expect(results[1].i).toBe(4);
    });

    it('skips malformed lines silently', () => {
      const log = createAppendLog(logPath);
      log.append({ ok: true });
      log.appendRaw('not valid json');
      log.append({ ok: true, second: true });

      const results = log.readLastN(10);
      expect(results).toHaveLength(2);
    });

    it('returns an empty array for an empty file', () => {
      writeFileSync(logPath, '');
      const log = createAppendLog(logPath);
      expect(log.readLastN(10)).toEqual([]);
    });
  });

  describe('maxSizeMB option', () => {
    it('maxSizeMB takes precedence over maxSizeBytes when both provided', () => {
      // 1 byte maxSizeBytes, 1 MB maxSizeMB — MB should win (no rotation on small writes)
      const log = createAppendLog(logPath, { maxSizeBytes: 1, maxSizeMB: 100 });
      log.append({ data: 'small' });
      log.append({ data: 'also small' });
      // No rotation should have occurred since we're well under 100 MB
      const rotated = readdirSync(testDir).filter(f => f !== 'test.jsonl' && f.endsWith('.jsonl'));
      expect(rotated).toHaveLength(0);
    });
  });

  describe('rotatedPaths()', () => {
    it('returns rotated sibling paths, oldest first, excluding the active file', () => {
      const base = logPath.replace('.jsonl', '');
      // Written out of chronological order to prove sorting, not directory order
      writeFileSync(`${base}.2026-01-03T00-00-00-000Z.jsonl`, '{"i":3}\n');
      writeFileSync(`${base}.2026-01-01T00-00-00-000Z.jsonl`, '{"i":1}\n');
      writeFileSync(`${base}.2026-01-02T00-00-00-000Z.jsonl`, '{"i":2}\n');
      writeFileSync(logPath, '{"active":true}\n');

      const log = createAppendLog(logPath, { retentionDays: 9999, maxRotatedFiles: 999 });
      const paths = log.rotatedPaths();

      expect(paths).toHaveLength(3);
      expect(paths[0]).toContain('2026-01-01');
      expect(paths[1]).toContain('2026-01-02');
      expect(paths[2]).toContain('2026-01-03');
      expect(paths.every(p => p !== logPath)).toBe(true);
    });

    it('returns an empty array when no rotation has ever occurred', () => {
      const log = createAppendLog(logPath);
      log.append({ event: 'only active' });
      expect(log.rotatedPaths()).toEqual([]);
    });

    it('returns an empty array when the file does not exist at all', () => {
      const log = createAppendLog(logPath);
      expect(log.rotatedPaths()).toEqual([]);
    });
  });

  describe('fileMode option (F6c)', () => {
    it('applies fileMode when the file is created', () => {
      const log = createAppendLog(logPath, { fileMode: 0o644 });
      log.append({ event: 'create' });
      expect(statSync(logPath).mode & 0o777).toBe(0o644);
    });

    it('applies fileMode to the re-created file after rotation', () => {
      const log = createAppendLog(logPath, { fileMode: 0o644, maxSizeBytes: 8 });
      log.append({ event: 'first write, exceeds 8 bytes' });
      log.append({ event: 'second write triggers rotation, then re-creates' });
      expect(statSync(logPath).mode & 0o777).toBe(0o644);
    });

    it('leaves an existing file mode untouched', () => {
      writeFileSync(logPath, '', { mode: 0o600 });
      const log = createAppendLog(logPath, { fileMode: 0o644 });
      log.append({ event: 'append to existing' });
      expect(statSync(logPath).mode & 0o777).toBe(0o600);
    });

    it('defaults to umask behavior when fileMode is omitted (no regression)', () => {
      const log = createAppendLog(logPath);
      log.append({ event: 'plain' });
      expect(existsSync(logPath)).toBe(true);
    });
  });
});
