/**
 * FSRS v4 Spaced Repetition Algorithm
 *
 * Implementation of the Free Spaced Repetition Scheduler (FSRS) v4 algorithm.
 * Based on the DSR model (Difficulty, Stability, Retrievability) for optimal
 * memory retention scheduling.
 *
 * Reference: https://github.com/open-spaced-repetition/fsrs4anki
 */

import type { FSRSCard, FSRSRating, FSRSScheduleResult, CardState } from '../types/index.ts';

// ============================================
// FSRS v4 PARAMETERS (optimized defaults)
// ============================================

/** Default FSRS v4 parameters (w[0..18]) */
const DEFAULT_PARAMS = {
  w: [
    0.4072, 1.1829, 3.1262, 15.4722,  // w0-w3: initial stability for each rating
    7.2102, 0.5316, 1.0651,             // w4-w6: difficulty parameters
    0.0589, 1.5413, 0.1176, 0.9906,    // w7-w10: stability parameters
    1.9395, 0.1100, 0.2955,             // w11-w13: recall parameters
    2.2042, 0.2478, 2.9466,             // w14-w16: forget parameters
    0.5034, 0.6567,                      // w17-w18: hard/easy multipliers
  ],
  requestRetention: 0.9,  // Target 90% retention
  maximumInterval: 36500,  // Max 100 years
  decay: -0.5,
  factor: 19 / 81,        // 0.9^(1/decay) - 1
};

// ============================================
// CORE FSRS FUNCTIONS
// ============================================

/**
 * Calculate initial difficulty based on first rating
 */
export function initDifficulty(rating: FSRSRating): number {
  const w = DEFAULT_PARAMS.w;
  return clamp(w[4] - Math.exp(w[5] * (rating - 1)) + 1, 1, 10);
}

/**
 * Calculate initial stability based on first rating
 */
export function initStability(rating: FSRSRating): number {
  return Math.max(DEFAULT_PARAMS.w[rating - 1], 0.1);
}

/**
 * Update difficulty after a review
 */
export function nextDifficulty(currentDifficulty: number, rating: FSRSRating): number {
  const w = DEFAULT_PARAMS.w;
  const newD = currentDifficulty - w[6] * (rating - 3);
  // Mean reversion to initial difficulty
  const meanReverted = w[7] * initDifficulty(3) + (1 - w[7]) * newD;
  return clamp(meanReverted, 1, 10);
}

/**
 * Calculate retrievability (probability of recall) at a given elapsed time
 */
export function retrievability(stability: number, elapsedDays: number): number {
  const { factor, decay } = DEFAULT_PARAMS;
  return Math.pow(1 + factor * elapsedDays / stability, decay);
}

/**
 * Calculate next stability after a successful recall
 */
export function nextRecallStability(
  difficulty: number,
  stability: number,
  retrievability: number,
  rating: FSRSRating
): number {
  const w = DEFAULT_PARAMS.w;
  const hardPenalty = rating === 2 ? w[15] : 1;
  const easyBonus = rating === 4 ? w[16] : 1;

  return stability * (
    1 +
    Math.exp(w[8]) *
    (11 - difficulty) *
    Math.pow(stability, -w[9]) *
    (Math.exp((1 - retrievability) * w[10]) - 1) *
    hardPenalty *
    easyBonus
  );
}

/**
 * Calculate next stability after a lapse (forgotten)
 */
export function nextForgetStability(
  difficulty: number,
  stability: number,
  retrievability: number
): number {
  const w = DEFAULT_PARAMS.w;
  return (
    w[11] *
    Math.pow(difficulty, -w[12]) *
    (Math.pow(stability + 1, w[13]) - 1) *
    Math.exp((1 - retrievability) * w[14])
  );
}

/**
 * Convert stability to an interval in days based on target retention
 */
export function stabilityToInterval(stability: number): number {
  const { requestRetention, maximumInterval, factor, decay } = DEFAULT_PARAMS;
  const interval = stability / factor * (Math.pow(requestRetention, 1 / decay) - 1);
  return Math.min(Math.max(Math.round(interval), 1), maximumInterval);
}

// ============================================
// HIGH-LEVEL SCHEDULING
// ============================================

/**
 * Create a new FSRS card
 */
export function createCard(params: {
  id: string;
  topicId: string;
  front: string;
  back: string;
}): FSRSCard {
  const now = new Date().toISOString();
  return {
    id: params.id,
    topicId: params.topicId,
    front: params.front,
    back: params.back,
    state: 'new',
    difficulty: 0,
    stability: 0,
    retrievability: 0,
    lastReview: now,
    nextReview: now, // Due immediately
    reps: 0,
    lapses: 0,
    createdAt: now,
  };
}

/**
 * Schedule a card after a review
 */
export function scheduleCard(card: FSRSCard, rating: FSRSRating): FSRSScheduleResult {
  const now = new Date();
  const lastReview = new Date(card.lastReview);
  const elapsedDays = Math.max((now.getTime() - lastReview.getTime()) / (1000 * 60 * 60 * 24), 0);

  let newCard: FSRSCard;

  if (card.state === 'new') {
    // First review
    const d = initDifficulty(rating);
    const s = initStability(rating);
    const interval = stabilityToInterval(s);
    const nextReview = new Date(now.getTime() + interval * 24 * 60 * 60 * 1000);

    newCard = {
      ...card,
      state: rating === 1 ? 'learning' : 'review',
      difficulty: d,
      stability: s,
      retrievability: 1,
      lastReview: now.toISOString(),
      nextReview: nextReview.toISOString(),
      reps: card.reps + 1,
      lapses: rating === 1 ? card.lapses + 1 : card.lapses,
    };

    return {
      card: newCard,
      intervalDays: interval,
      nextReviewDate: nextReview.toISOString(),
    };
  }

  // Existing card review
  const r = retrievability(card.stability, elapsedDays);

  if (rating === 1) {
    // Lapse (forgot)
    const s = nextForgetStability(card.difficulty, card.stability, r);
    const d = nextDifficulty(card.difficulty, rating);
    const interval = Math.min(stabilityToInterval(s), 1); // Cap at 1 day for lapses
    const nextReview = new Date(now.getTime() + interval * 24 * 60 * 60 * 1000);

    newCard = {
      ...card,
      state: 'relearning',
      difficulty: d,
      stability: s,
      retrievability: r,
      lastReview: now.toISOString(),
      nextReview: nextReview.toISOString(),
      reps: card.reps + 1,
      lapses: card.lapses + 1,
    };

    return {
      card: newCard,
      intervalDays: interval,
      nextReviewDate: nextReview.toISOString(),
    };
  }

  // Successful recall
  const s = nextRecallStability(card.difficulty, card.stability, r, rating);
  const d = nextDifficulty(card.difficulty, rating);
  const interval = stabilityToInterval(s);
  const nextReview = new Date(now.getTime() + interval * 24 * 60 * 60 * 1000);

  const newState: CardState =
    card.state === 'learning' || card.state === 'relearning' ? 'review' : card.state;

  newCard = {
    ...card,
    state: newState,
    difficulty: d,
    stability: s,
    retrievability: r,
    lastReview: now.toISOString(),
    nextReview: nextReview.toISOString(),
    reps: card.reps + 1,
  };

  return {
    card: newCard,
    intervalDays: interval,
    nextReviewDate: nextReview.toISOString(),
  };
}

/**
 * Get all cards that are due for review
 */
export function getDueCards(cards: FSRSCard[], now?: Date): FSRSCard[] {
  const currentTime = now || new Date();
  return cards.filter(card => {
    const nextReview = new Date(card.nextReview);
    return nextReview <= currentTime;
  });
}

/**
 * Sort cards by review priority (most overdue first)
 */
export function sortByPriority(cards: FSRSCard[]): FSRSCard[] {
  const now = new Date();
  return [...cards].sort((a, b) => {
    const overdueA = now.getTime() - new Date(a.nextReview).getTime();
    const overdueB = now.getTime() - new Date(b.nextReview).getTime();
    // Most overdue first, then lowest retrievability
    if (Math.abs(overdueA - overdueB) > 1000 * 60 * 60) {
      return overdueB - overdueA;
    }
    return a.retrievability - b.retrievability;
  });
}

// ============================================
// HELPERS
// ============================================

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
