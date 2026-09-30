/**
 * EvalSignals.test.ts — exercise appendEvalSignal against a real temp filesystem
 * using mkdtempSync + KAYA_HOME override (canonical pattern from MemoryPaths.test.ts).
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { appendEvalSignal, evalSignalsPath, type EvalSignalPayload } from './EvalSignals.ts';

describe('appendEvalSignal()', () => {
  let tempDir: string;
  const originalKayaHome = process.env.KAYA_HOME;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'evalsignals-test-'));
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

  it('evalSignalsPath() resolves under KAYA_HOME at call time', () => {
    expect(evalSignalsPath()).toBe(`${tempDir}/MEMORY/EVAL_SIGNALS/signals.jsonl`);
  });

  it('creates the EVAL_SIGNALS directory and writes a JSONL record', async () => {
    const payload: EvalSignalPayload = {
      source: 'TestSuite',
      signalType: 'failure',
      description: 'auth test failed',
      category: 'security',
      severity: 'high',
    };
    await appendEvalSignal(payload);

    const path = evalSignalsPath();
    expect(existsSync(path)).toBe(true);
    const content = readFileSync(path, 'utf-8');
    const lines = content.split('\n').filter(Boolean);
    expect(lines.length).toBe(1);
    const record = JSON.parse(lines[0]);
    expect(record.source).toBe('TestSuite');
    expect(record.signalType).toBe('failure');
    expect(record.description).toBe('auth test failed');
    expect(record.category).toBe('security');
    expect(record.severity).toBe('high');
    expect(typeof record.timestamp).toBe('string');
  });

  it('defaults severity to "medium" when omitted', async () => {
    await appendEvalSignal({
      source: 'TestSuite',
      signalType: 'success',
      description: 'd',
      category: 'c',
    });

    const record = JSON.parse(readFileSync(evalSignalsPath(), 'utf-8').trim());
    expect(record.severity).toBe('medium');
  });

  it('appends multiple JSONL lines without overwriting', async () => {
    await appendEvalSignal({ source: 'A', signalType: 'success', description: '1', category: 'x' });
    await appendEvalSignal({ source: 'B', signalType: 'failure', description: '2', category: 'y' });
    await appendEvalSignal({ source: 'C', signalType: 'regression', description: '3', category: 'z' });

    const lines = readFileSync(evalSignalsPath(), 'utf-8').split('\n').filter(Boolean);
    expect(lines.length).toBe(3);
    expect(JSON.parse(lines[0]).source).toBe('A');
    expect(JSON.parse(lines[1]).source).toBe('B');
    expect(JSON.parse(lines[2]).source).toBe('C');
  });
});
