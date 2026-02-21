/**
 * Exercise Evaluator Tests
 *
 * Tests the heuristic evaluation fallback (AI evaluation tests
 * require live inference and are covered in integration tests).
 */

import { describe, it, expect } from 'vitest';
import { evaluateWithHeuristics } from '../src/evaluators/exercise-evaluator.ts';
import type { Exercise } from '../src/types/index.ts';

function makeExercise(overrides?: Partial<Exercise>): Exercise {
  return {
    id: 'test-ex-1',
    type: 'short-answer',
    domain: 'programming',
    difficulty: 'beginner',
    conceptId: 'concept-1',
    prompt: 'What is TypeScript?',
    referenceAnswer: 'TypeScript is a typed superset of JavaScript that compiles to plain JavaScript',
    hints: ['Think about types'],
    timeLimit: 60,
    tags: ['typescript'],
    ...overrides,
  };
}

describe('Exercise Evaluator - Heuristics', () => {
  describe('empty answer', () => {
    it('should score 0 for empty answer', () => {
      const exercise = makeExercise();
      const result = evaluateWithHeuristics(exercise, '');
      expect(result.correct).toBe(false);
      expect(result.score).toBe(0);
    });

    it('should score 0 for very short answer', () => {
      const exercise = makeExercise();
      const result = evaluateWithHeuristics(exercise, 'a');
      expect(result.correct).toBe(false);
      expect(result.score).toBe(0);
    });
  });

  describe('multiple choice', () => {
    it('should match correct answer letter', () => {
      const exercise = makeExercise({
        type: 'multiple-choice',
        options: ['A typed language', 'A database', 'A CSS framework', 'An OS'],
        referenceAnswer: 'A) A typed language',
      });

      const result = evaluateWithHeuristics(exercise, 'A');
      expect(result.correct).toBe(true);
      expect(result.score).toBe(100);
    });

    it('should mark wrong answer as incorrect', () => {
      const exercise = makeExercise({
        type: 'multiple-choice',
        options: ['A typed language', 'A database', 'A CSS framework', 'An OS'],
        referenceAnswer: 'A) A typed language',
      });

      const result = evaluateWithHeuristics(exercise, 'C');
      expect(result.correct).toBe(false);
      expect(result.score).toBe(0);
    });
  });

  describe('keyword overlap scoring', () => {
    it('should give high score for answer matching reference keywords', () => {
      const exercise = makeExercise();
      const answer = 'TypeScript is a typed superset of JavaScript that compiles to plain JavaScript code';
      const result = evaluateWithHeuristics(exercise, answer);
      expect(result.score).toBeGreaterThan(60);
      expect(result.correct).toBe(true);
    });

    it('should give low score for unrelated answer', () => {
      const exercise = makeExercise();
      const answer = 'It is a color used in painting and art';
      const result = evaluateWithHeuristics(exercise, answer);
      expect(result.score).toBeLessThan(30);
      expect(result.correct).toBe(false);
    });

    it('should give partial credit for partially correct answer', () => {
      const exercise = makeExercise();
      const answer = 'TypeScript is a language related to JavaScript';
      const result = evaluateWithHeuristics(exercise, answer);
      expect(result.score).toBeGreaterThan(20);
      expect(result.score).toBeLessThan(90);
    });
  });

  describe('feedback quality', () => {
    it('should include exercise ID in result', () => {
      const exercise = makeExercise({ id: 'my-exercise' });
      const result = evaluateWithHeuristics(exercise, 'some answer here');
      expect(result.exerciseId).toBe('my-exercise');
    });

    it('should include timestamp', () => {
      const exercise = makeExercise();
      const result = evaluateWithHeuristics(exercise, 'some answer');
      expect(result.evaluatedAt).toBeTruthy();
      expect(new Date(result.evaluatedAt).getTime()).toBeGreaterThan(0);
    });

    it('should suggest review for incorrect answers', () => {
      const exercise = makeExercise();
      const result = evaluateWithHeuristics(exercise, 'completely wrong answer here');
      if (!result.correct) {
        expect(result.suggestedReview.length).toBeGreaterThan(0);
      }
    });

    it('should include strengths for good answers', () => {
      const exercise = makeExercise();
      const answer = 'TypeScript is a typed superset of JavaScript that compiles to plain JavaScript';
      const result = evaluateWithHeuristics(exercise, answer);
      expect(result.strengths.length).toBeGreaterThan(0);
    });
  });
});
