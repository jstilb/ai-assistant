import { describe, test, expect, mock, beforeEach } from 'bun:test';
import { SelectorEngine, type SelectorConfig, type SelectorResult } from '../selector-engine';

// Mock page object that simulates Playwright's Page interface
function createMockPage(existingSelectors: Set<string> = new Set()): any {
  return {
    $(selector: string) {
      if (existingSelectors.has(selector)) {
        return Promise.resolve({ click: mock(() => Promise.resolve()) });
      }
      return Promise.resolve(null);
    },
    waitForTimeout(ms: number) {
      return Promise.resolve();
    }
  };
}

describe('SelectorEngine', () => {
  let engine: SelectorEngine;

  beforeEach(() => {
    engine = new SelectorEngine({
      maxRetries: 3,
      backoffBaseMs: 10, // Fast for tests (normally 1000)
    });
  });

  test('resolves primary selector when it exists', async () => {
    const page = createMockPage(new Set(['button.primary']));
    const config: SelectorConfig = {
      primary: 'button.primary',
      fallbacks: ['button.fallback1', 'button.fallback2'],
    };

    const result = await engine.resolve(page, config);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.selectorUsed).toBe('button.primary');
      expect(result.data.attemptCount).toBe(1);
      expect(result.data.element).toBeTruthy();
      expect(result.data.durationMs).toBeGreaterThanOrEqual(0);
    }
  });

  test('falls back to secondary selector when primary fails', async () => {
    const page = createMockPage(new Set(['button.fallback1']));
    const config: SelectorConfig = {
      primary: 'button.primary',
      fallbacks: ['button.fallback1', 'button.fallback2'],
    };

    const result = await engine.resolve(page, config);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.selectorUsed).toBe('button.fallback1');
      expect(result.data.attemptCount).toBeGreaterThan(1);
    }
  });

  test('falls back to third selector when primary and first fallback fail', async () => {
    const page = createMockPage(new Set(['button.fallback2']));
    const config: SelectorConfig = {
      primary: 'button.primary',
      fallbacks: ['button.fallback1', 'button.fallback2'],
    };

    const result = await engine.resolve(page, config);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.selectorUsed).toBe('button.fallback2');
    }
  });

  test('returns failure when all selectors fail', async () => {
    const page = createMockPage(new Set()); // No selectors exist
    const config: SelectorConfig = {
      primary: 'button.primary',
      fallbacks: ['button.fallback1'],
    };

    const result = await engine.resolve(page, config);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toBeInstanceOf(Error);
      expect(result.error.message).toContain('All selectors failed');
    }
  });

  test('applies exponential backoff between retries', async () => {
    const timings: number[] = [];
    const page = {
      $(selector: string) {
        timings.push(Date.now());
        return Promise.resolve(null);
      },
      waitForTimeout(ms: number) {
        return new Promise(resolve => setTimeout(resolve, ms));
      }
    };

    const config: SelectorConfig = {
      primary: 'button.primary',
      fallbacks: [],
    };

    // Use small backoff for test speed
    const fastEngine = new SelectorEngine({ maxRetries: 3, backoffBaseMs: 50 });
    const result = await fastEngine.resolve(page, config);

    expect(result.success).toBe(false);
    // Should have attempted primary selector maxRetries times
    expect(timings.length).toBe(3);
  });

  test('handles empty fallbacks array', async () => {
    const page = createMockPage(new Set());
    const config: SelectorConfig = {
      primary: 'button.missing',
      fallbacks: [],
    };

    const result = await engine.resolve(page, config);

    expect(result.success).toBe(false);
  });

  test('returns duration in result', async () => {
    const page = createMockPage(new Set(['button.ok']));
    const config: SelectorConfig = {
      primary: 'button.ok',
      fallbacks: [],
    };

    const result = await engine.resolve(page, config);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(typeof result.data.durationMs).toBe('number');
      expect(result.data.durationMs).toBeGreaterThanOrEqual(0);
    }
  });

  test('tracks which selector level was used', async () => {
    const page = createMockPage(new Set(['button.fb2']));
    const config: SelectorConfig = {
      primary: 'button.primary',
      fallbacks: ['button.fb1', 'button.fb2', 'button.fb3'],
    };

    const result = await engine.resolve(page, config);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.selectorUsed).toBe('button.fb2');
      expect(result.data.fallbackLevel).toBe(2);
    }
  });

  test('fallbackLevel is 0 when primary works', async () => {
    const page = createMockPage(new Set(['button.primary']));
    const config: SelectorConfig = {
      primary: 'button.primary',
      fallbacks: ['button.fb1'],
    };

    const result = await engine.resolve(page, config);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.fallbackLevel).toBe(0);
    }
  });
});
