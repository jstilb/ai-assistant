import { describe, it, expect } from 'bun:test';
import { parseRating, isExplicitRating } from './RatingUtils.ts';

describe('RatingUtils', () => {
  describe('parseRating()', () => {
    it('parses plain number rating', () => {
      const result = parseRating('8');
      expect(result).not.toBeNull();
      expect(result!.rating).toBe(8);
      expect(result!.comment).toBeUndefined();
    });

    it('parses fraction form 8/10', () => {
      const result = parseRating('8/10');
      expect(result).not.toBeNull();
      expect(result!.rating).toBe(8);
    });

    it('parses 10/10', () => {
      const result = parseRating('10/10');
      expect(result).not.toBeNull();
      expect(result!.rating).toBe(10);
    });

    it('parses rating with dash comment', () => {
      const result = parseRating('8 - great response');
      expect(result).not.toBeNull();
      expect(result!.rating).toBe(8);
      expect(result!.comment).toBe('great response');
    });

    it('parses rating with colon comment', () => {
      const result = parseRating('8: great response');
      expect(result).not.toBeNull();
      expect(result!.rating).toBe(8);
      expect(result!.comment).toBe('great response');
    });

    it('parses "10" as valid maximum rating', () => {
      const result = parseRating('10');
      expect(result).not.toBeNull();
      expect(result!.rating).toBe(10);
    });

    it('parses "1" as valid minimum rating', () => {
      const result = parseRating('1');
      expect(result).not.toBeNull();
      expect(result!.rating).toBe(1);
    });

    it('returns null for plain sentence (not a rating)', () => {
      const result = parseRating('not a rating');
      expect(result).toBeNull();
    });

    it('returns null for sentence starting with ordinal', () => {
      const result = parseRating('7 items to fix');
      expect(result).toBeNull();
    });

    it('returns null for sentence starting with article "the"', () => {
      const result = parseRating('5 the problem');
      expect(result).toBeNull();
    });

    it('returns null for sentence starting with "in"', () => {
      const result = parseRating('5 in total');
      expect(result).toBeNull();
    });

    it('returns null for empty string', () => {
      expect(parseRating('')).toBeNull();
    });

    it('returns null for a regular message', () => {
      expect(parseRating('please fix the authentication bug')).toBeNull();
    });

    it('trims whitespace before parsing', () => {
      const result = parseRating('  9  ');
      expect(result).not.toBeNull();
      expect(result!.rating).toBe(9);
    });

    it('parses /10 fraction with trailing comment', () => {
      const result = parseRating('8/10 great response');
      expect(result).not.toBeNull();
      expect(result!.rating).toBe(8);
      expect(result!.comment).toBe('great response');
    });

    // Regression: digit-prefixed task continuations must NOT be captured as ratings
    // (these were the false-positive `rating: 1` rows that corrupted ratings.jsonl).
    it('returns null for digit-prefixed prose without a separator ("1 and then 3")', () => {
      expect(parseRating('1 and then 3')).toBeNull();
    });

    it('returns null for "8 are complete" (no separator)', () => {
      expect(parseRating('8 are complete')).toBeNull();
    });

    it('returns null for a numbered-list continuation ("1 do this then that")', () => {
      expect(parseRating('1 do this then that')).toBeNull();
    });

    it('returns null for a bare word after the digit ("8 good") — separator required', () => {
      expect(parseRating('8 good')).toBeNull();
    });
  });

  describe('isExplicitRating()', () => {
    it('returns true for a plain number rating', () => {
      expect(isExplicitRating('8')).toBe(true);
    });

    it('returns true for rating with comment', () => {
      expect(isExplicitRating('9 - excellent work')).toBe(true);
    });

    it('returns true for fraction form', () => {
      expect(isExplicitRating('7/10')).toBe(true);
    });

    it('returns false for non-rating input', () => {
      expect(isExplicitRating('not a rating')).toBe(false);
    });

    it('returns false for empty string', () => {
      expect(isExplicitRating('')).toBe(false);
    });

    it('returns true iff parseRating returns non-null', () => {
      const testCases = ['7', '10/10', '3 - ok', 'fix the bug', '7 items', ''];
      for (const tc of testCases) {
        const expected = parseRating(tc) !== null;
        expect(isExplicitRating(tc)).toBe(expected);
      }
    });
  });
});
