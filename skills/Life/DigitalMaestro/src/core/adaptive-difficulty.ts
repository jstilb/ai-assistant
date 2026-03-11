/**
 * Adaptive Difficulty System
 *
 * Five-tier difficulty system that adjusts based on learner performance.
 * Uses a rolling window of recent evaluations to determine appropriate
 * difficulty level.
 */

import type {
  DifficultyTier,
  DifficultyAssessment,
  EvaluationResult,
  SessionStats,
} from '../types/index.ts';

// ============================================
// CONSTANTS
// ============================================

/** Difficulty tier progression order */
const TIER_ORDER: DifficultyTier[] = ['novice', 'beginner', 'intermediate', 'advanced', 'expert'];

/** Score thresholds for each tier */
const TIER_THRESHOLDS: Record<DifficultyTier, { min: number; max: number }> = {
  novice:       { min: 0,  max: 20 },
  beginner:     { min: 20, max: 40 },
  intermediate: { min: 40, max: 60 },
  advanced:     { min: 60, max: 80 },
  expert:       { min: 80, max: 100 },
};

/** Window of recent evaluations to consider */
const EVALUATION_WINDOW = 10;

/** Thresholds for tier adjustment */
const PROMOTION_THRESHOLD = 0.8;   // 80% correct to move up
const DEMOTION_THRESHOLD = 0.4;    // Below 40% to move down
const MIN_EVALUATIONS_FOR_CHANGE = 3;

// ============================================
// DIFFICULTY ASSESSMENT
// ============================================

/**
 * Create an initial difficulty assessment for a new topic
 */
export function createInitialAssessment(tier?: DifficultyTier): DifficultyAssessment {
  const startTier = tier || 'beginner';
  return {
    tier: startTier,
    score: TIER_THRESHOLDS[startTier].min + 10,
    rationale: 'Initial assessment for new topic',
    adjustedAt: new Date().toISOString(),
  };
}

/**
 * Adjust difficulty based on recent evaluation results
 */
export function adjustDifficulty(
  current: DifficultyAssessment,
  recentEvaluations: EvaluationResult[]
): DifficultyAssessment {
  if (recentEvaluations.length < MIN_EVALUATIONS_FOR_CHANGE) {
    return current;
  }

  // Take only the most recent evaluations within our window
  const window = recentEvaluations.slice(-EVALUATION_WINDOW);

  // Calculate performance metrics
  const correctRate = window.filter(e => e.correct).length / window.length;
  const averageScore = window.reduce((sum, e) => sum + e.score, 0) / window.length;

  // Determine new tier
  const currentIndex = TIER_ORDER.indexOf(current.tier);
  let newIndex = currentIndex;
  let rationale = '';

  if (correctRate >= PROMOTION_THRESHOLD && averageScore >= 75) {
    // Promote if not already at max
    if (currentIndex < TIER_ORDER.length - 1) {
      newIndex = currentIndex + 1;
      rationale = `Promoted: ${(correctRate * 100).toFixed(0)}% correct rate, ${averageScore.toFixed(0)} avg score over ${window.length} exercises`;
    } else {
      rationale = `Maintaining expert level: ${(correctRate * 100).toFixed(0)}% correct rate`;
    }
  } else if (correctRate <= DEMOTION_THRESHOLD && averageScore < 50) {
    // Demote if not already at min
    if (currentIndex > 0) {
      newIndex = currentIndex - 1;
      rationale = `Demoted: ${(correctRate * 100).toFixed(0)}% correct rate, ${averageScore.toFixed(0)} avg score over ${window.length} exercises`;
    } else {
      rationale = `Maintaining novice level: additional practice needed`;
    }
  } else {
    rationale = `Stable: ${(correctRate * 100).toFixed(0)}% correct rate, ${averageScore.toFixed(0)} avg score`;
  }

  const newTier = TIER_ORDER[newIndex];

  // Calculate numeric score within the tier
  const tierRange = TIER_THRESHOLDS[newTier];
  const score = tierRange.min + (averageScore / 100) * (tierRange.max - tierRange.min);

  return {
    tier: newTier,
    score: Math.round(score),
    rationale,
    adjustedAt: new Date().toISOString(),
  };
}

/**
 * Quick difficulty adjustment based on session stats (less granular)
 */
export function adjustFromSession(
  current: DifficultyAssessment,
  stats: SessionStats
): DifficultyAssessment {
  const totalAttempts = stats.cardsReviewed + stats.exercisesCompleted;
  if (totalAttempts < MIN_EVALUATIONS_FOR_CHANGE) return current;

  const totalCorrect = stats.cardsCorrect + stats.exercisesCorrect;
  const correctRate = totalCorrect / totalAttempts;

  // Create synthetic evaluations for the adjustment function
  const syntheticEvals: EvaluationResult[] = [];
  for (let i = 0; i < totalAttempts; i++) {
    syntheticEvals.push({
      exerciseId: `session-${i}`,
      correct: i < totalCorrect,
      score: i < totalCorrect ? stats.averageScore : stats.averageScore * 0.3,
      feedback: '',
      explanation: '',
      strengths: [],
      weaknesses: [],
      suggestedReview: [],
      evaluatedAt: new Date().toISOString(),
    });
  }

  return adjustDifficulty(current, syntheticEvals);
}

/**
 * Get the numeric score range for a difficulty tier
 */
export function getTierRange(tier: DifficultyTier): { min: number; max: number } {
  return TIER_THRESHOLDS[tier];
}

/**
 * Get the tier index (0-4) for ordering
 */
export function getTierIndex(tier: DifficultyTier): number {
  return TIER_ORDER.indexOf(tier);
}

/**
 * Get the tier for a numeric score
 */
export function scoreToTier(score: number): DifficultyTier {
  const clamped = Math.min(Math.max(score, 0), 100);
  for (const tier of [...TIER_ORDER].reverse()) {
    if (clamped >= TIER_THRESHOLDS[tier].min) {
      return tier;
    }
  }
  return 'novice';
}

/**
 * Get all tiers in order
 */
export function getAllTiers(): DifficultyTier[] {
  return [...TIER_ORDER];
}
