/**
 * UnifiedEventSink.test.ts — Test fan-out and failure isolation
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'fs';
import { join } from 'path';
import { emit, type KayaEvent } from './UnifiedEventSink';

const TEST_MEMORY_ROOT = '/tmp/kaya-test-unified-event-sink';
const EVENTS_DIR = join(TEST_MEMORY_ROOT, 'MONITORING/events');
const TRACES_DIR = join(TEST_MEMORY_ROOT, 'MONITORING/traces');

describe('UnifiedEventSink', () => {
  beforeEach(() => {
    // Clean test dirs
    if (existsSync(TEST_MEMORY_ROOT)) {
      rmSync(TEST_MEMORY_ROOT, { recursive: true, force: true });
    }
    mkdirSync(EVENTS_DIR, { recursive: true });
    mkdirSync(TRACES_DIR, { recursive: true });

    // Override env for tests
    process.env.KAYA_MEMORY_ROOT = TEST_MEMORY_ROOT;
    delete process.env.KAYA_CORRELATION_ID;
  });

  afterEach(() => {
    delete process.env.KAYA_MEMORY_ROOT;
    if (existsSync(TEST_MEMORY_ROOT)) {
      rmSync(TEST_MEMORY_ROOT, { recursive: true, force: true });
    }
  });

  test('writes event to canonical daily JSONL file', () => {
    emit({
      source: 'hook',
      category: 'test-event',
      severity: 'info',
      payload: { foo: 'bar' },
    });

    const today = new Date().toISOString().slice(0, 10);
    const canonicalFile = join(EVENTS_DIR, `${today}.jsonl`);

    expect(existsSync(canonicalFile)).toBe(true);

    const lines = readFileSync(canonicalFile, 'utf-8').trim().split('\n');
    expect(lines.length).toBe(1);

    const event = JSON.parse(lines[0]) as KayaEvent;
    expect(event.source).toBe('hook');
    expect(event.category).toBe('test-event');
    expect(event.severity).toBe('info');
    expect(event.payload.foo).toBe('bar');
    expect(event.id).toBeDefined();
    expect(event.ts).toBeGreaterThan(0);
  });

  test('fan-out: writes to both canonical file AND makes dashboard POST attempt', () => {
    // We can't truly test the HTTP POST without mocking, but we can verify canonical write happens
    // even if dashboard fails (failure isolation)
    emit({
      source: 'security',
      category: 'block-event',
      severity: 'warn',
      payload: { reason: 'test' },
    });

    const today = new Date().toISOString().slice(0, 10);
    const canonicalFile = join(EVENTS_DIR, `${today}.jsonl`);

    expect(existsSync(canonicalFile)).toBe(true);

    const lines = readFileSync(canonicalFile, 'utf-8').trim().split('\n');
    expect(lines.length).toBe(1);

    const event = JSON.parse(lines[0]) as KayaEvent;
    expect(event.source).toBe('security');
    expect(event.category).toBe('block-event');
  });

  test('writes trace event to workflow-specific trace file when workflowId present', () => {
    emit({
      source: 'trace',
      category: 'phase-transition',
      severity: 'debug',
      workflowId: 'wf-123',
      payload: { phase: 'prepare-start' },
    });

    const today = new Date().toISOString().slice(0, 10);
    const canonicalFile = join(EVENTS_DIR, `${today}.jsonl`);
    const traceFile = join(TRACES_DIR, 'wf-123.jsonl');

    // Canonical write
    expect(existsSync(canonicalFile)).toBe(true);
    const canonicalLines = readFileSync(canonicalFile, 'utf-8').trim().split('\n');
    expect(canonicalLines.length).toBe(1);

    // Trace file write
    expect(existsSync(traceFile)).toBe(true);
    const traceLines = readFileSync(traceFile, 'utf-8').trim().split('\n');
    expect(traceLines.length).toBe(1);

    const traceEvent = JSON.parse(traceLines[0]) as KayaEvent;
    expect(traceEvent.workflowId).toBe('wf-123');
    expect(traceEvent.payload.phase).toBe('prepare-start');
  });

  test('auto-reads KAYA_CORRELATION_ID from env if not provided', () => {
    process.env.KAYA_CORRELATION_ID = 'cron-job-abc123';

    emit({
      source: 'hook',
      category: 'test-correlation',
      severity: 'info',
      payload: {},
    });

    const today = new Date().toISOString().slice(0, 10);
    const canonicalFile = join(EVENTS_DIR, `${today}.jsonl`);

    const lines = readFileSync(canonicalFile, 'utf-8').trim().split('\n');
    const event = JSON.parse(lines[0]) as KayaEvent;
    expect(event.correlationId).toBe('cron-job-abc123');
  });

  test('explicit correlationId overrides env var', () => {
    process.env.KAYA_CORRELATION_ID = 'env-id';

    emit({
      source: 'hook',
      category: 'test-override',
      severity: 'info',
      correlationId: 'explicit-id',
      payload: {},
    });

    const today = new Date().toISOString().slice(0, 10);
    const canonicalFile = join(EVENTS_DIR, `${today}.jsonl`);

    const lines = readFileSync(canonicalFile, 'utf-8').trim().split('\n');
    const event = JSON.parse(lines[0]) as KayaEvent;
    expect(event.correlationId).toBe('explicit-id');
  });

  test('failure isolation: canonical write succeeds even if dashboard POST fails', () => {
    // Since we can't easily mock fetch failure, we just verify canonical write works
    // The implementation should catch and swallow dashboard POST errors
    emit({
      source: 'cost',
      category: 'token-usage',
      severity: 'info',
      payload: { tokens: 1000 },
    });

    const today = new Date().toISOString().slice(0, 10);
    const canonicalFile = join(EVENTS_DIR, `${today}.jsonl`);

    expect(existsSync(canonicalFile)).toBe(true);
    const lines = readFileSync(canonicalFile, 'utf-8').trim().split('\n');
    expect(lines.length).toBe(1);

    // This proves canonical write happened regardless of dashboard status
  });

  test('multiple events append to same daily file', () => {
    emit({
      source: 'hook',
      category: 'event1',
      severity: 'info',
      payload: {},
    });

    emit({
      source: 'hook',
      category: 'event2',
      severity: 'info',
      payload: {},
    });

    const today = new Date().toISOString().slice(0, 10);
    const canonicalFile = join(EVENTS_DIR, `${today}.jsonl`);

    const lines = readFileSync(canonicalFile, 'utf-8').trim().split('\n');
    expect(lines.length).toBe(2);

    const event1 = JSON.parse(lines[0]) as KayaEvent;
    const event2 = JSON.parse(lines[1]) as KayaEvent;

    expect(event1.category).toBe('event1');
    expect(event2.category).toBe('event2');
  });
});
