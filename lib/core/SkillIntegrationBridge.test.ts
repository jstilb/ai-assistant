/**
 * SkillIntegrationBridge.test.ts - Smoke tests for SkillIntegrationBridge
 */
import { describe, it, expect } from 'bun:test';
import {
  emitInsight,
  emitNotification,
  emitEvalSignal,
  getActiveISCRows,
  findISCRowByDescription,
  emitBatch,
} from './SkillIntegrationBridge';
import type { InsightPayload, EvalSignalPayload } from './SkillIntegrationBridge';

describe('SkillIntegrationBridge', () => {
  it('exports expected functions', () => {
    expect(typeof emitInsight).toBe('function');
    expect(typeof emitNotification).toBe('function');
    expect(typeof emitEvalSignal).toBe('function');
    expect(typeof getActiveISCRows).toBe('function');
    expect(typeof findISCRowByDescription).toBe('function');
    expect(typeof emitBatch).toBe('function');
  });

  it('emitInsight completes without throwing', async () => {
    const payload: InsightPayload = {
      source: 'SmokeTest',
      type: 'learning',
      title: 'Smoke test insight',
      content: 'This is a smoke test',
      tags: ['test', 'smoke'],
    };
    // Should not throw - fail-silent design
    const result = await emitInsight(payload);
    expect(typeof result).toBe('string');
  });

  it('emitNotification does not throw (fail-silent)', () => {
    expect(() => {
      emitNotification('Smoke test notification', { priority: 'low' });
    }).not.toThrow();
  });

  it('emitEvalSignal completes without throwing', async () => {
    const payload: EvalSignalPayload = {
      source: 'SmokeTest',
      signalType: 'success',
      description: 'Smoke test eval signal',
      category: 'test',
      severity: 'low',
    };
    await expect(emitEvalSignal(payload)).resolves.toBeUndefined();
  });

  it('getActiveISCRows returns null or array', () => {
    const rows = getActiveISCRows();
    expect(rows === null || Array.isArray(rows)).toBe(true);
  });

  it('findISCRowByDescription returns null or number', () => {
    const result = findISCRowByDescription('smoke-test-keyword-xyz');
    expect(result === null || typeof result === 'number').toBe(true);
  });

  it('emitBatch with empty array resolves without throwing', async () => {
    await expect(emitBatch([])).resolves.toBeUndefined();
  });
});
