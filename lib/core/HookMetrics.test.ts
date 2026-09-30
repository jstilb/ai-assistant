/**
 * HookMetrics.test.ts — Test hook execution metrics recording
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { recordHookStart } from './HookMetrics';

const TEST_MEMORY_ROOT = '/tmp/kaya-test-hook-metrics';
const METRICS_FILE = join(TEST_MEMORY_ROOT, 'MONITORING/hook-metrics.jsonl');

describe('HookMetrics', () => {
  beforeEach(() => {
    // Clean test dirs
    if (existsSync(TEST_MEMORY_ROOT)) {
      rmSync(TEST_MEMORY_ROOT, { recursive: true, force: true });
    }
    mkdirSync(join(TEST_MEMORY_ROOT, 'MONITORING'), { recursive: true });

    // Override env for tests
    process.env.KAYA_MEMORY_ROOT = TEST_MEMORY_ROOT;
  });

  afterEach(() => {
    delete process.env.KAYA_MEMORY_ROOT;
    if (existsSync(TEST_MEMORY_ROOT)) {
      rmSync(TEST_MEMORY_ROOT, { recursive: true, force: true });
    }
  });

  test('recordHookStart returns done() callback that writes metric with durationMs', () => {
    const done = recordHookStart('PreToolUse');

    // Simulate some work
    const startTime = Date.now();
    while (Date.now() - startTime < 10) {
      // wait ~10ms
    }

    done();

    expect(existsSync(METRICS_FILE)).toBe(true);

    const lines = readFileSync(METRICS_FILE, 'utf-8').trim().split('\n');
    expect(lines.length).toBe(1);

    const metric = JSON.parse(lines[0]);
    expect(metric.hookName).toBe('PreToolUse');
    expect(metric.durationMs).toBeGreaterThanOrEqual(10);
    expect(metric.ts).toBeGreaterThan(0);
  });

  test('records multiple hook executions to same file', () => {
    const done1 = recordHookStart('PreToolUse');
    done1();

    const done2 = recordHookStart('PostToolUse');
    done2();

    const lines = readFileSync(METRICS_FILE, 'utf-8').trim().split('\n');
    expect(lines.length).toBe(2);

    const metric1 = JSON.parse(lines[0]);
    const metric2 = JSON.parse(lines[1]);

    expect(metric1.hookName).toBe('PreToolUse');
    expect(metric2.hookName).toBe('PostToolUse');
  });

  test('accepts optional metadata', () => {
    const done = recordHookStart('UserPromptSubmit', {
      sessionId: 'test-session',
      toolName: 'Bash',
    });
    done();

    const lines = readFileSync(METRICS_FILE, 'utf-8').trim().split('\n');
    const metric = JSON.parse(lines[0]);

    expect(metric.hookName).toBe('UserPromptSubmit');
    expect(metric.sessionId).toBe('test-session');
    expect(metric.toolName).toBe('Bash');
  });

  test('never throws on write failure', () => {
    // Set invalid memory root to trigger write failure
    process.env.KAYA_MEMORY_ROOT = '/invalid-readonly-path-12345';

    expect(() => {
      const done = recordHookStart('PreToolUse');
      done();
    }).not.toThrow();
  });

  test('durationMs is accurate', () => {
    const done = recordHookStart('SessionStart');
    const startTime = Date.now();

    // Wait at least 50ms
    while (Date.now() - startTime < 50) {
      // spin
    }

    done();

    const lines = readFileSync(METRICS_FILE, 'utf-8').trim().split('\n');
    const metric = JSON.parse(lines[0]);

    expect(metric.durationMs).toBeGreaterThanOrEqual(50);
    expect(metric.durationMs).toBeLessThan(200); // reasonable upper bound
  });
});
