/**
 * FSRS v4 Algorithm Tests
 *
 * Tests the spaced repetition scheduling algorithm for correctness
 * of difficulty, stability, retrievability, and scheduling calculations.
 */

import { describe, it, expect } from 'vitest';
import {
  initDifficulty,
  initStability,
  nextDifficulty,
  retrievability,
  nextRecallStability,
  nextForgetStability,
  stabilityToInterval,
  createCard,
  scheduleCard,
  getDueCards,
  sortByPriority,
} from '../src/algorithms/fsrs.ts';
import type { FSRSCard, FSRSRating } from '../src/types/index.ts';

describe('FSRS v4 Algorithm', () => {
  describe('initDifficulty', () => {
    it('should return higher difficulty for rating 1 (Again)', () => {
      const d1 = initDifficulty(1);
      const d4 = initDifficulty(4);
      expect(d1).toBeGreaterThan(d4);
    });

    it('should return values between 1 and 10', () => {
      for (const rating of [1, 2, 3, 4] as FSRSRating[]) {
        const d = initDifficulty(rating);
        expect(d).toBeGreaterThanOrEqual(1);
        expect(d).toBeLessThanOrEqual(10);
      }
    });
  });

  describe('initStability', () => {
    it('should return positive values for all ratings', () => {
      for (const rating of [1, 2, 3, 4] as FSRSRating[]) {
        const s = initStability(rating);
        expect(s).toBeGreaterThan(0);
      }
    });

    it('should return increasing stability for higher ratings', () => {
      const s1 = initStability(1);
      const s4 = initStability(4);
      expect(s4).toBeGreaterThan(s1);
    });
  });

  describe('nextDifficulty', () => {
    it('should decrease difficulty after Easy rating', () => {
      const current = 5;
      const next = nextDifficulty(current, 4); // Easy
      expect(next).toBeLessThan(current);
    });

    it('should increase difficulty after Again rating', () => {
      const current = 5;
      const next = nextDifficulty(current, 1); // Again
      expect(next).toBeGreaterThan(current);
    });

    it('should keep difficulty in 1-10 range', () => {
      // Test extreme cases
      const lowD = nextDifficulty(1, 4);
      const highD = nextDifficulty(10, 1);
      expect(lowD).toBeGreaterThanOrEqual(1);
      expect(highD).toBeLessThanOrEqual(10);
    });
  });

  describe('retrievability', () => {
    it('should return 1.0 at elapsed time 0', () => {
      const r = retrievability(10, 0);
      expect(r).toBeCloseTo(1.0, 5);
    });

    it('should decrease over time', () => {
      const r1 = retrievability(10, 1);
      const r10 = retrievability(10, 10);
      const r100 = retrievability(10, 100);
      expect(r1).toBeGreaterThan(r10);
      expect(r10).toBeGreaterThan(r100);
    });

    it('should decrease slower with higher stability', () => {
      const rLow = retrievability(5, 10);
      const rHigh = retrievability(50, 10);
      expect(rHigh).toBeGreaterThan(rLow);
    });

    it('should return values between 0 and 1', () => {
      const r = retrievability(1, 365);
      expect(r).toBeGreaterThan(0);
      expect(r).toBeLessThanOrEqual(1);
    });
  });

  describe('nextRecallStability', () => {
    it('should increase stability after successful recall', () => {
      const d = 5;
      const s = 10;
      const r = 0.9;
      const newS = nextRecallStability(d, s, r, 3); // Good
      expect(newS).toBeGreaterThan(s);
    });

    it('should give higher stability for Easy than Hard', () => {
      const d = 5;
      const s = 10;
      const r = 0.9;
      const sHard = nextRecallStability(d, s, r, 2);
      const sEasy = nextRecallStability(d, s, r, 4);
      expect(sEasy).toBeGreaterThan(sHard);
    });
  });

  describe('nextForgetStability', () => {
    it('should return lower stability than current', () => {
      const d = 5;
      const s = 10;
      const r = 0.5;
      const newS = nextForgetStability(d, s, r);
      expect(newS).toBeLessThan(s);
    });

    it('should return positive stability', () => {
      const newS = nextForgetStability(5, 10, 0.3);
      expect(newS).toBeGreaterThan(0);
    });
  });

  describe('stabilityToInterval', () => {
    it('should return positive integer intervals', () => {
      const interval = stabilityToInterval(10);
      expect(interval).toBeGreaterThan(0);
      expect(Number.isInteger(interval)).toBe(true);
    });

    it('should return longer intervals for higher stability', () => {
      const i1 = stabilityToInterval(1);
      const i10 = stabilityToInterval(10);
      const i100 = stabilityToInterval(100);
      expect(i10).toBeGreaterThan(i1);
      expect(i100).toBeGreaterThan(i10);
    });

    it('should not exceed maximum interval', () => {
      const interval = stabilityToInterval(999999);
      expect(interval).toBeLessThanOrEqual(36500);
    });
  });

  describe('createCard', () => {
    it('should create a card with new state', () => {
      const card = createCard({
        id: 'test-1',
        topicId: 'topic-1',
        front: 'What is TypeScript?',
        back: 'A typed superset of JavaScript',
      });

      expect(card.id).toBe('test-1');
      expect(card.state).toBe('new');
      expect(card.reps).toBe(0);
      expect(card.lapses).toBe(0);
      expect(card.difficulty).toBe(0);
      expect(card.stability).toBe(0);
    });
  });

  describe('scheduleCard', () => {
    it('should transition new card to review on Good rating', () => {
      const card = createCard({
        id: 'test-2',
        topicId: 'topic-1',
        front: 'Q',
        back: 'A',
      });

      const result = scheduleCard(card, 3); // Good
      expect(result.card.state).toBe('review');
      expect(result.card.reps).toBe(1);
      expect(result.intervalDays).toBeGreaterThan(0);
    });

    it('should transition new card to learning on Again rating', () => {
      const card = createCard({
        id: 'test-3',
        topicId: 'topic-1',
        front: 'Q',
        back: 'A',
      });

      const result = scheduleCard(card, 1); // Again
      expect(result.card.state).toBe('learning');
      expect(result.card.lapses).toBe(1);
    });

    it('should set card to relearning state on lapse', () => {
      const card: FSRSCard = {
        id: 'test-4',
        topicId: 'topic-1',
        front: 'Q',
        back: 'A',
        state: 'review',
        difficulty: 5,
        stability: 10,
        retrievability: 0.9,
        lastReview: new Date(Date.now() - 86400000).toISOString(), // 1 day ago
        nextReview: new Date(Date.now() - 3600000).toISOString(), // 1 hour ago
        reps: 5,
        lapses: 0,
        createdAt: new Date().toISOString(),
      };

      const result = scheduleCard(card, 1); // Again
      expect(result.card.state).toBe('relearning');
      expect(result.card.lapses).toBe(1);
    });
  });

  describe('getDueCards', () => {
    it('should return cards that are past their next review date', () => {
      const pastCard: FSRSCard = {
        id: 'past',
        topicId: 't',
        front: 'Q',
        back: 'A',
        state: 'review',
        difficulty: 5,
        stability: 10,
        retrievability: 0.9,
        lastReview: new Date().toISOString(),
        nextReview: new Date(Date.now() - 86400000).toISOString(), // Past
        reps: 1,
        lapses: 0,
        createdAt: new Date().toISOString(),
      };

      const futureCard: FSRSCard = {
        ...pastCard,
        id: 'future',
        nextReview: new Date(Date.now() + 86400000).toISOString(), // Future
      };

      const due = getDueCards([pastCard, futureCard]);
      expect(due).toHaveLength(1);
      expect(due[0].id).toBe('past');
    });
  });

  describe('sortByPriority', () => {
    it('should sort most overdue cards first', () => {
      const veryOverdue: FSRSCard = {
        id: 'very-overdue',
        topicId: 't',
        front: 'Q',
        back: 'A',
        state: 'review',
        difficulty: 5,
        stability: 10,
        retrievability: 0.5,
        lastReview: new Date().toISOString(),
        nextReview: new Date(Date.now() - 7 * 86400000).toISOString(), // 7 days ago
        reps: 1,
        lapses: 0,
        createdAt: new Date().toISOString(),
      };

      const slightlyOverdue: FSRSCard = {
        ...veryOverdue,
        id: 'slightly-overdue',
        nextReview: new Date(Date.now() - 1 * 86400000).toISOString(), // 1 day ago
      };

      const sorted = sortByPriority([slightlyOverdue, veryOverdue]);
      expect(sorted[0].id).toBe('very-overdue');
    });
  });
});
