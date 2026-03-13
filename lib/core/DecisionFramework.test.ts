/**
 * DecisionFramework.test.ts - Smoke tests for DecisionFramework
 */
import { describe, it, expect } from 'bun:test';
import { DecisionFramework, evaluate } from './DecisionFramework';

describe('DecisionFramework', () => {
  it('is importable and exports expected symbols', () => {
    expect(typeof DecisionFramework).toBe('function');
    expect(typeof evaluate).toBe('function');
  });

  it('instantiates without throwing', () => {
    const fw = new DecisionFramework();
    expect(fw).toBeDefined();
  });

  it('evaluate() calendar GREEN - valid hours, no conflict', () => {
    const fw = new DecisionFramework();
    const result = fw.evaluate('calendar', 'Standup', {
      hour: 10,
      hasConflict: false,
      backToBack: false,
      isDoubleBooked: false,
    });
    expect(result.signal).toBe('GREEN');
    expect(result.domain).toBe('calendar');
    expect(result.label).toBe('Standup');
    expect(Array.isArray(result.reasons)).toBe(true);
    expect(typeof result.action).toBe('string');
  });

  it('evaluate() calendar RED - double booked', () => {
    const fw = new DecisionFramework();
    const result = fw.evaluate('calendar', 'Conflict', {
      hour: 10,
      hasConflict: false,
      backToBack: false,
      isDoubleBooked: true,
    });
    expect(result.signal).toBe('RED');
  });

  it('evaluate() shopping GREEN - within budget, highly rated, in stock', () => {
    const fw = new DecisionFramework();
    const result = fw.evaluate('shopping', 'Headphones', {
      price: 80,
      budget: 100,
      rating: 4.5,
      inStock: true,
      hasRedFlags: false,
    });
    expect(result.signal).toBe('GREEN');
  });

  it('evaluate() shopping RED - low rating', () => {
    const fw = new DecisionFramework();
    const result = fw.evaluate('shopping', 'Cheap item', {
      price: 10,
      budget: 50,
      rating: 2.9,
      inStock: true,
      hasRedFlags: false,
    });
    expect(result.signal).toBe('RED');
  });

  it('evaluate() task GREEN - WIG aligned', () => {
    const fw = new DecisionFramework();
    const result = fw.evaluate('task', 'Ship feature', {
      isWIGAligned: true,
      hasMissionAlignment: true,
      daysUntilDeadline: 5,
      isOverdue: false,
    });
    expect(result.signal).toBe('GREEN');
  });

  it('evaluate() health GREEN - completed today', () => {
    const fw = new DecisionFramework();
    const result = fw.evaluate('health', 'PT Exercises', {
      completedToday: true,
      consecutiveSkipDays: 0,
    });
    expect(result.signal).toBe('GREEN');
  });

  it('evaluate() health RED - 3+ consecutive skips', () => {
    const fw = new DecisionFramework();
    const result = fw.evaluate('health', 'PT Exercises', {
      completedToday: false,
      consecutiveSkipDays: 4,
    });
    expect(result.signal).toBe('RED');
  });

  it('evaluate() unknown domain returns YELLOW', () => {
    const fw = new DecisionFramework();
    const result = fw.evaluate('nonexistent', 'Test', { foo: 'bar' });
    expect(result.signal).toBe('YELLOW');
    expect(result.reasons[0]).toContain('Unknown domain');
  });

  it('evaluate() empty input returns YELLOW', () => {
    const fw = new DecisionFramework();
    const result = fw.evaluate('calendar', 'Empty', {});
    expect(result.signal).toBe('YELLOW');
  });

  it('registerDomain() allows custom rules', () => {
    const fw = new DecisionFramework();
    fw.registerDomain('custom', [
      {
        check: (i) => i.score === 100,
        signal: 'GREEN',
        reason: 'Perfect score',
        action: 'Celebrate',
      },
    ]);
    const result = fw.evaluate('custom', 'Test', { score: 100 });
    expect(result.signal).toBe('GREEN');
  });

  it('badge() returns string for all signals', () => {
    expect(typeof DecisionFramework.badge('GREEN')).toBe('string');
    expect(typeof DecisionFramework.badge('YELLOW')).toBe('string');
    expect(typeof DecisionFramework.badge('RED')).toBe('string');
  });

  it('formatLine() returns string', () => {
    const fw = new DecisionFramework();
    const result = fw.evaluate('shopping', 'Item', {
      price: 50, budget: 100, rating: 4.5, inStock: true, hasRedFlags: false,
    });
    const line = DecisionFramework.formatLine(result);
    expect(typeof line).toBe('string');
    expect(line.length).toBeGreaterThan(0);
  });

  it('singleton evaluate() works', () => {
    const result = evaluate('health', 'PT', { completedToday: true, consecutiveSkipDays: 0 });
    expect(result.signal).toBe('GREEN');
  });
});
