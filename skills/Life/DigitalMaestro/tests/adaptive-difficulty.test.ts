/**
 * Adaptive Difficulty Tests
 *
 * Tests the five-tier difficulty system and its adjustment logic.
 */

import { describe, it, expect } from 'vitest';
import {
  createInitialAssessment,
  adjustDifficulty,
  adjustFromSession,
  getTierRange,
  getTierIndex,
  scoreToTier,
  getAllTiers,
} from '../src/core/adaptive-difficulty.ts';
import type { EvaluationResult, SessionStats } from '../src/types/index.ts';

function makeEval(correct: boolean, score: number): EvaluationResult {
  return {
    exerciseId: `ex-${Math.random()}`,
    correct,
    score,
    feedback: '',
    explanation: '',
    strengths: [],
    weaknesses: [],
    suggestedReview: [],
    evaluatedAt: new Date().toISOString(),
  };
}

describe('Adaptive Difficulty', () => {
  describe('createInitialAssessment', () => {
    it('should default to beginner tier', () => {
      const assessment = createInitialAssessment();
      expect(assessment.tier).toBe('beginner');
      expect(assessment.score).toBeGreaterThan(0);
    });

    it('should accept a custom starting tier', () => {
      const assessment = createInitialAssessment('advanced');
      expect(assessment.tier).toBe('advanced');
    });

    it('should set an adjustedAt timestamp', () => {
      const assessment = createInitialAssessment();
      expect(assessment.adjustedAt).toBeTruthy();
      expect(new Date(assessment.adjustedAt).getTime()).toBeGreaterThan(0);
    });
  });

  describe('adjustDifficulty', () => {
    it('should not change with fewer than 3 evaluations', () => {
      const current = createInitialAssessment('beginner');
      const evals = [makeEval(true, 100), makeEval(true, 90)];
      const result = adjustDifficulty(current, evals);
      expect(result.tier).toBe('beginner');
    });

    it('should promote after consistent high performance', () => {
      const current = createInitialAssessment('beginner');
      const evals = Array.from({ length: 5 }, () => makeEval(true, 90));
      const result = adjustDifficulty(current, evals);
      expect(result.tier).toBe('intermediate');
    });

    it('should demote after consistent poor performance', () => {
      const current = createInitialAssessment('intermediate');
      const evals = Array.from({ length: 5 }, () => makeEval(false, 20));
      const result = adjustDifficulty(current, evals);
      expect(result.tier).toBe('beginner');
    });

    it('should stay stable with mixed performance', () => {
      const current = createInitialAssessment('intermediate');
      const evals = [
        makeEval(true, 80),
        makeEval(false, 40),
        makeEval(true, 70),
        makeEval(false, 50),
        makeEval(true, 65),
      ];
      const result = adjustDifficulty(current, evals);
      expect(result.tier).toBe('intermediate');
    });

    it('should not promote beyond expert', () => {
      const current = createInitialAssessment('expert');
      const evals = Array.from({ length: 5 }, () => makeEval(true, 95));
      const result = adjustDifficulty(current, evals);
      expect(result.tier).toBe('expert');
    });

    it('should not demote below novice', () => {
      const current = createInitialAssessment('novice');
      const evals = Array.from({ length: 5 }, () => makeEval(false, 10));
      const result = adjustDifficulty(current, evals);
      expect(result.tier).toBe('novice');
    });

    it('should include rationale in the assessment', () => {
      const current = createInitialAssessment('beginner');
      const evals = Array.from({ length: 5 }, () => makeEval(true, 90));
      const result = adjustDifficulty(current, evals);
      expect(result.rationale).toBeTruthy();
      expect(result.rationale.length).toBeGreaterThan(0);
    });
  });

  describe('adjustFromSession', () => {
    it('should not change with too few attempts', () => {
      const current = createInitialAssessment('beginner');
      const stats: SessionStats = {
        cardsReviewed: 1,
        cardsCorrect: 1,
        exercisesCompleted: 1,
        exercisesCorrect: 1,
        averageScore: 90,
        conceptsIntroduced: 0,
        conceptsMastered: 0,
        totalTimeMinutes: 5,
      };
      const result = adjustFromSession(current, stats);
      expect(result.tier).toBe('beginner');
    });
  });

  describe('getTierRange', () => {
    it('should return valid ranges for all tiers', () => {
      for (const tier of getAllTiers()) {
        const range = getTierRange(tier);
        expect(range.min).toBeLessThan(range.max);
        expect(range.min).toBeGreaterThanOrEqual(0);
        expect(range.max).toBeLessThanOrEqual(100);
      }
    });
  });

  describe('getTierIndex', () => {
    it('should return increasing indices', () => {
      expect(getTierIndex('novice')).toBe(0);
      expect(getTierIndex('beginner')).toBe(1);
      expect(getTierIndex('intermediate')).toBe(2);
      expect(getTierIndex('advanced')).toBe(3);
      expect(getTierIndex('expert')).toBe(4);
    });
  });

  describe('scoreToTier', () => {
    it('should map scores to correct tiers', () => {
      expect(scoreToTier(5)).toBe('novice');
      expect(scoreToTier(25)).toBe('beginner');
      expect(scoreToTier(50)).toBe('intermediate');
      expect(scoreToTier(70)).toBe('advanced');
      expect(scoreToTier(90)).toBe('expert');
    });

    it('should clamp extreme values', () => {
      expect(scoreToTier(-10)).toBe('novice');
      expect(scoreToTier(150)).toBe('expert');
    });
  });

  describe('getAllTiers', () => {
    it('should return 5 tiers in order', () => {
      const tiers = getAllTiers();
      expect(tiers).toHaveLength(5);
      expect(tiers[0]).toBe('novice');
      expect(tiers[4]).toBe('expert');
    });
  });
});
