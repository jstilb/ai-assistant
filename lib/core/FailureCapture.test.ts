/**
 * FailureCapture.test.ts - Smoke tests for FailureCapture
 */
import { describe, it, expect } from 'bun:test';
import { captureFailure, captureFailureDump } from './FailureCapture';
import type { FailureCaptureInput, FailureDumpInput } from './FailureCapture';
import { existsSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import os from 'os';

const TMP_DIR = join(os.tmpdir(), `test-kaya-${Date.now()}`);

describe('FailureCapture', () => {
  it('exports captureFailure and captureFailureDump functions', () => {
    expect(typeof captureFailure).toBe('function');
    expect(typeof captureFailureDump).toBe('function');
  });

  it('captureFailure creates a failure file and returns path', async () => {
    const input: FailureCaptureInput = {
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
      const resultPath = await captureFailure(input);
      expect(typeof resultPath).toBe('string');
      expect(resultPath.length).toBeGreaterThan(0);
    } finally {
      process.env.KAYA_DIR = origKayaDir;
    }
  });

  it('captureFailureDump creates a structured dump and returns path', async () => {
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
      const resultPath = await captureFailureDump(input);
      expect(typeof resultPath).toBe('string');
      expect(resultPath.length).toBeGreaterThan(0);
    } finally {
      process.env.KAYA_DIR = origKayaDir;
    }
  });
});
