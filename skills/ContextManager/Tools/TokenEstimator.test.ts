import { describe, test, expect } from 'bun:test';
import { estimateTokens, estimateFileTokens } from './TokenEstimator';
import { join } from 'path';

describe('TokenEstimator', () => {
  describe('estimateTokens', () => {
    test('returns 0 for empty string', () => {
      expect(estimateTokens('')).toBe(0);
    });

    test('estimates reasonable count for short text', () => {
      // "hello world" = 11 chars, ~3.1 tokens at 3.5 chars/token
      const tokens = estimateTokens('hello world');
      expect(tokens).toBeGreaterThan(0);
      expect(tokens).toBeLessThan(10);
    });

    test('estimates reasonable count for code', () => {
      const code = `function fibonacci(n: number): number {
  if (n <= 1) return n;
  return fibonacci(n - 1) + fibonacci(n - 2);
}`;
      const tokens = estimateTokens(code);
      // ~120 chars / 3.5 ≈ 34 tokens
      expect(tokens).toBeGreaterThan(20);
      expect(tokens).toBeLessThan(60);
    });

    test('scales linearly with content length', () => {
      const short = estimateTokens('a'.repeat(100));
      const long = estimateTokens('a'.repeat(1000));
      // Long should be ~10x short
      expect(long / short).toBeCloseTo(10, 0);
    });

    test('returns ceiling (never fractional)', () => {
      const result = estimateTokens('hello');
      expect(Number.isInteger(result)).toBe(true);
    });

    test('uses chars/3.5 formula', () => {
      const text = 'a'.repeat(350);
      const tokens = estimateTokens(text);
      expect(tokens).toBe(100); // 350/3.5 = 100
    });

    test('handles large content (100KB+)', () => {
      const large = 'x'.repeat(100_000);
      const tokens = estimateTokens(large);
      expect(tokens).toBeGreaterThan(20_000);
      expect(tokens).toBeLessThan(40_000);
    });

    test('handles special characters', () => {
      const result = estimateTokens('🎉🚀✨ emoji text');
      expect(result).toBeGreaterThan(0);
    });

    test('handles newlines and whitespace', () => {
      const result = estimateTokens('\n\n\n   \t\t\n');
      expect(result).toBeGreaterThan(0);
    });
  });

  describe('estimateFileTokens', () => {
    test('returns null for nonexistent file', () => {
      const result = estimateFileTokens('/nonexistent/path/file.txt');
      expect(result).toBeNull();
    });

    test('returns token count for existing file', () => {
      // Use this test file itself as input
      const thisFile = join(import.meta.dir, 'TokenEstimator.test.ts');
      const result = estimateFileTokens(thisFile);
      expect(result).not.toBeNull();
      expect(result!.tokens).toBeGreaterThan(0);
      expect(result!.chars).toBeGreaterThan(0);
      expect(result!.lines).toBeGreaterThan(0);
    });

    test('chars matches actual file length', () => {
      const thisFile = join(import.meta.dir, 'TokenEstimator.ts');
      const result = estimateFileTokens(thisFile);
      expect(result).not.toBeNull();
      // TokenEstimator.ts is a small file
      expect(result!.chars).toBeGreaterThan(100);
      expect(result!.chars).toBeLessThan(5000);
    });

    test('tokens consistent with estimateTokens', () => {
      const thisFile = join(import.meta.dir, 'TokenEstimator.ts');
      const result = estimateFileTokens(thisFile);
      expect(result).not.toBeNull();
      // tokens should equal ceil(chars / 3.5)
      expect(result!.tokens).toBe(Math.ceil(result!.chars / 3.5));
    });
  });
});
