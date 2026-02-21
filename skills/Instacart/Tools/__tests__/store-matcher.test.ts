import { describe, test, expect } from 'bun:test';
import { matchStore, type StoreMatchResult } from '../store-matcher';

describe('matchStore - store fuzzy matching', () => {
  const knownStores = [
    'Safeway',
    'Costco',
    'Whole Foods',
    'Trader Joes',
    'Sprouts',
    'Target',
    'Kroger',
    'Walmart',
    'Albertsons',
    'Ralphs',
  ];

  test('exact match returns the store name', () => {
    const result = matchStore('Safeway', knownStores);
    expect(result.matched).toBe(true);
    if (result.matched) {
      expect(result.store).toBe('Safeway');
    }
  });

  test('case-insensitive exact match', () => {
    const result = matchStore('safeway', knownStores);
    expect(result.matched).toBe(true);
    if (result.matched) {
      expect(result.store).toBe('Safeway');
    }
  });

  test('fuzzy match with typo: "safway" -> "Safeway"', () => {
    const result = matchStore('safway', knownStores);
    expect(result.matched).toBe(true);
    if (result.matched) {
      expect(result.store).toBe('Safeway');
    }
  });

  test('fuzzy match with typo: "costko" -> "Costco"', () => {
    const result = matchStore('costko', knownStores);
    expect(result.matched).toBe(true);
    if (result.matched) {
      expect(result.store).toBe('Costco');
    }
  });

  test('fuzzy match: "whole food" -> "Whole Foods"', () => {
    const result = matchStore('whole food', knownStores);
    expect(result.matched).toBe(true);
    if (result.matched) {
      expect(result.store).toBe('Whole Foods');
    }
  });

  test('no match returns suggestions', () => {
    const result = matchStore('Fake Store XYZ', knownStores);
    expect(result.matched).toBe(false);
    if (!result.matched) {
      expect(result.suggestions).toBeArray();
      expect(result.suggestions.length).toBeLessThanOrEqual(3);
      expect(result.suggestions.length).toBeGreaterThan(0);
    }
  });

  test('suggestions are sorted by similarity (closest first)', () => {
    const result = matchStore('Targe', knownStores);
    expect(result.matched).toBe(true);
    if (result.matched) {
      expect(result.store).toBe('Target');
    }
  });

  test('empty input returns no match', () => {
    const result = matchStore('', knownStores);
    expect(result.matched).toBe(false);
  });

  test('empty store list returns no match', () => {
    const result = matchStore('Safeway', []);
    expect(result.matched).toBe(false);
  });

  test('handles special characters in store name', () => {
    const result = matchStore("Trader Joe's", ['Trader Joes', 'Safeway']);
    expect(result.matched).toBe(true);
    if (result.matched) {
      expect(result.store).toBe('Trader Joes');
    }
  });
});
