/**
 * FailureRecord.test.ts - Smoke tests for FailureRecord
 */
import { describe, it, expect } from 'bun:test';
import { recordFailure, recordFailureDump } from './FailureRecord';
import type { FailureRecordInput, FailureDumpInput } from './FailureRecord';
import { existsSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import os from 'os';

const TMP_DIR = join(os.tmpdir(), `test-kaya-${Date.now()}`);

describe('FailureRecord', () => {
  it('exports recordFailure and recordFailureDump functions', () => {
    expect(typeof recordFailure).toBe('function');
    expect(typeof recordFailureDump).toBe('function');
  });

  it('recordFailure creates a failure file and returns path', async () => {
    const input: FailureRecordInput = {
      transcriptPath: '/nonexistent/transcript.jsonl',
      rating: 2,
      sentimentSummary: 'Test failure for smoke test',
      detailedContext: 'Test context',
      sessionId: 'test-session-smoke',
    };

    // Override KAYA_DIR to use temp dir
    const origKayaDir = process.env.KAYA_DIR;
    process.env.KAYA_DIR = TMP_DIR;
    mkdirSync(join(TMP_DIR, 'MEMORY', 'LEARNING', 'FAILURES'), { recursive: true });

    try {
      const resultPath = await recordFailure(input);
      expect(typeof resultPath).toBe('string');
      expect(resultPath.length).toBeGreaterThan(0);
    } finally {
      process.env.KAYA_DIR = origKayaDir;
    }
  });

  it('recordFailureDump creates a structured dump and returns path', async () => {
    const input: FailureDumpInput = {
      sessionId: 'test-session-dump',
      transcriptPath: '/nonexistent/transcript.jsonl',
      rating: 1,
      comment: 'Smoke test failure dump',
    };

    const origKayaDir = process.env.KAYA_DIR;
    process.env.KAYA_DIR = TMP_DIR;
    mkdirSync(join(TMP_DIR, 'MEMORY', 'LEARNING', 'FAILURES'), { recursive: true });

    try {
      const resultPath = await recordFailureDump(input);
      expect(typeof resultPath).toBe('string');
      expect(resultPath.length).toBeGreaterThan(0);
    } finally {
      process.env.KAYA_DIR = origKayaDir;
    }
  });
});
