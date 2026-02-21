/**
 * Domain Classifier Tests
 *
 * Tests the heuristic domain classification (AI tests would require
 * live inference and are covered in integration tests).
 */

import { describe, it, expect } from 'vitest';
import { classifyWithHeuristics } from '../src/core/domain-classifier.ts';

describe('Domain Classifier - Heuristics', () => {
  it('should classify programming topics', () => {
    const result = classifyWithHeuristics('JavaScript async programming');
    expect(result.domain).toBe('programming');
    expect(result.confidence).toBeGreaterThan(0);
  });

  it('should classify language learning topics', () => {
    const result = classifyWithHeuristics('Spanish vocabulary conjugation');
    expect(result.domain).toBe('language');
  });

  it('should classify science topics', () => {
    const result = classifyWithHeuristics('organic chemistry molecular bonds');
    expect(result.domain).toBe('science');
  });

  it('should classify math topics', () => {
    const result = classifyWithHeuristics('linear algebra matrix eigenvalue');
    expect(result.domain).toBe('math');
  });

  it('should classify humanities topics', () => {
    const result = classifyWithHeuristics('Renaissance art history culture');
    expect(result.domain).toBe('humanities');
  });

  it('should default to humanities for unknown topics', () => {
    const result = classifyWithHeuristics('completely unrelated gibberish xyzzy');
    expect(result.domain).toBe('humanities');
    expect(result.confidence).toBeLessThanOrEqual(0.5);
  });

  it('should return keywords that matched', () => {
    const result = classifyWithHeuristics('python programming data structure');
    expect(result.keywords.length).toBeGreaterThan(0);
    expect(result.keywords).toContain('programming');
  });

  it('should handle multi-word keyword matches', () => {
    const result = classifyWithHeuristics('web development frontend backend');
    expect(result.domain).toBe('programming');
    // Multi-word matches like "web development" score higher
  });

  it('should handle case-insensitive matching', () => {
    const result = classifyWithHeuristics('PYTHON PROGRAMMING');
    expect(result.domain).toBe('programming');
  });
});
