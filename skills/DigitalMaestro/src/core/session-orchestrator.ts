/**
 * Session Orchestrator
 *
 * Orchestrates a complete learning session through four phases:
 * 1. Warm-up: Review due SRS cards
 * 2. New Content: Introduce new concepts from the concept graph
 * 3. Practice: Generate and evaluate exercises
 * 4. Reflection: Summarize session and update progress
 */

import { classifyDomain } from './domain-classifier.ts';
import { createInitialAssessment, adjustDifficulty } from './adaptive-difficulty.ts';
import { createCard, scheduleCard, getDueCards, sortByPriority } from '../algorithms/fsrs.ts';
import { generateConceptGraph, getNextConcepts, updateConceptMastery, calculateTopicMastery } from '../algorithms/concept-graph.ts';
import { generateExercises } from '../generators/exercise-generator.ts';
import { evaluateAnswer } from '../evaluators/exercise-evaluator.ts';
import {
  loadState,
  upsertTopic,
  upsertCard,
  upsertGraph,
  getCardsForTopic,
  getGraph,
  getTopicProgress,
  recordSession,
  updateStreak,
} from '../state/state-manager.ts';
import type {
  Session,
  SessionConfig,
  SessionPhase,
  SessionStats,
  SessionSummary,
  ConceptNode,
  FSRSCard,
  FSRSRating,
  Exercise,
  EvaluationResult,
  TopicProgress,
  DomainType,
  DifficultyAssessment,
  ConceptGraph,
} from '../types/index.ts';

// ============================================
// SESSION CREATION
// ============================================

/**
 * Create and initialize a new learning session
 */
export async function createSession(config: SessionConfig): Promise<Session> {
  const id = `session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const now = new Date().toISOString();

  // Classify domain if not provided
  let domain: DomainType;
  if (config.domain) {
    domain = config.domain;
  } else {
    const classification = await classifyDomain(config.topic);
    domain = classification.domain;
  }

  // Get or create topic progress
  const topicId = config.topic.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  let topicProgress = await getTopicProgress(topicId);

  let difficulty: DifficultyAssessment;
  let graph: ConceptGraph | null;

  if (topicProgress) {
    difficulty = topicProgress.difficulty as DifficultyAssessment;
    graph = await getGraph(topicId);
  } else {
    difficulty = createInitialAssessment();
    graph = null;
  }

  // Generate concept graph if we do not have one
  if (!graph) {
    graph = await generateConceptGraph(config.topic, domain);
    await upsertGraph(graph);
  }

  // Get due cards for warm-up
  const topicCards = await getCardsForTopic(topicId);
  const dueCards = sortByPriority(getDueCards(topicCards)).slice(0, config.reviewLimit);

  // Get next concepts to learn
  const newConcepts = getNextConcepts(graph, config.targetNewConcepts);

  return {
    id,
    config,
    domain,
    difficulty,
    currentPhase: 'warm-up',
    reviewCards: dueCards,
    newConcepts,
    exercises: [],
    evaluations: [],
    startedAt: now,
    endedAt: null,
    stats: createEmptyStats(),
  };
}

// ============================================
// SESSION PHASE EXECUTION
// ============================================

/**
 * Execute the warm-up phase: review due SRS cards
 * Returns the cards to review. Caller handles the actual review interaction.
 */
export function getWarmUpCards(session: Session): FSRSCard[] {
  return session.reviewCards;
}

/**
 * Record a card review result and schedule next review
 */
export async function recordCardReview(
  session: Session,
  cardId: string,
  rating: FSRSRating
): Promise<Session> {
  const card = session.reviewCards.find(c => c.id === cardId);
  if (!card) return session;

  const result = scheduleCard(card, rating);
  await upsertCard(result.card);

  const isCorrect = rating >= 3;

  return {
    ...session,
    stats: {
      ...session.stats,
      cardsReviewed: session.stats.cardsReviewed + 1,
      cardsCorrect: session.stats.cardsCorrect + (isCorrect ? 1 : 0),
    },
  };
}

/**
 * Advance to the new content phase.
 * Returns the new concepts to introduce.
 */
export function advanceToNewContent(session: Session): Session {
  return {
    ...session,
    currentPhase: 'new-content',
  };
}

/**
 * Create SRS cards for a newly learned concept
 */
export async function createCardsForConcept(
  session: Session,
  concept: ConceptNode
): Promise<FSRSCard[]> {
  const topicId = session.config.topic.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const cards: FSRSCard[] = [];

  // Create a basic card for the concept
  const card = createCard({
    id: `card-${concept.id}-${Date.now()}`,
    topicId,
    front: `What is ${concept.name}?`,
    back: concept.description,
  });

  await upsertCard(card);
  cards.push(card);

  return cards;
}

/**
 * Advance to the practice phase and generate exercises
 */
export async function advanceToPractice(session: Session): Promise<Session> {
  const exercises: Exercise[] = [];

  // Generate exercises for each new concept (and review concepts)
  for (const concept of session.newConcepts) {
    const conceptExercises = await generateExercises(concept, 2);
    exercises.push(...conceptExercises);
  }

  return {
    ...session,
    currentPhase: 'practice',
    exercises,
  };
}

/**
 * Submit an answer for evaluation
 */
export async function submitAnswer(
  session: Session,
  exerciseId: string,
  answer: string
): Promise<{ session: Session; evaluation: EvaluationResult }> {
  const exercise = session.exercises.find(e => e.id === exerciseId);
  if (!exercise) {
    throw new Error(`Exercise ${exerciseId} not found in session`);
  }

  const evaluation = await evaluateAnswer(exercise, answer);

  const updatedSession: Session = {
    ...session,
    evaluations: [...session.evaluations, evaluation],
    stats: {
      ...session.stats,
      exercisesCompleted: session.stats.exercisesCompleted + 1,
      exercisesCorrect: session.stats.exercisesCorrect + (evaluation.correct ? 1 : 0),
      averageScore: calculateAverageScore([...session.evaluations, evaluation]),
    },
  };

  return { session: updatedSession, evaluation };
}

/**
 * Advance to the reflection phase and complete the session
 */
export async function advanceToReflection(session: Session): Promise<Session> {
  const now = new Date();
  const startTime = new Date(session.startedAt);
  const totalMinutes = (now.getTime() - startTime.getTime()) / (1000 * 60);

  // Update concept mastery based on evaluations
  const topicId = session.config.topic.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  let graph = await getGraph(topicId);

  if (graph) {
    for (const concept of session.newConcepts) {
      const conceptEvals = session.evaluations.filter(e => {
        const ex = session.exercises.find(ex => ex.id === e.exerciseId);
        return ex?.conceptId === concept.id;
      });

      if (conceptEvals.length > 0) {
        const avgScore = conceptEvals.reduce((s, e) => s + e.score, 0) / conceptEvals.length;
        const mastery = avgScore / 100;
        graph = updateConceptMastery(graph, concept.id, mastery);
      }
    }

    await upsertGraph(graph);
  }

  // Update difficulty based on evaluations
  const newDifficulty = adjustDifficulty(session.difficulty, session.evaluations);

  // Calculate final stats
  const finalStats: SessionStats = {
    ...session.stats,
    conceptsIntroduced: session.newConcepts.length,
    conceptsMastered: graph
      ? graph.nodes.filter(n => n.mastery >= 0.7).length
      : 0,
    totalTimeMinutes: Math.round(totalMinutes * 10) / 10,
  };

  // Save session summary
  const summary: SessionSummary = {
    id: session.id,
    topic: session.config.topic,
    domain: session.domain,
    date: now.toISOString(),
    stats: finalStats,
  };
  await recordSession(summary);

  // Update topic progress
  const progress: TopicProgress = {
    topicId,
    topic: session.config.topic,
    domain: session.domain,
    difficulty: newDifficulty,
    conceptGraph: graph || {
      topicId,
      topic: session.config.topic,
      domain: session.domain,
      nodes: [],
      edges: [],
      generatedAt: now.toISOString(),
    },
    totalCards: (await getCardsForTopic(topicId)).length,
    cardsDue: 0, // Will be recalculated
    masteredConcepts: graph ? graph.nodes.filter(n => n.mastery >= 0.7).length : 0,
    totalConcepts: graph ? graph.nodes.length : 0,
    currentStreak: 0, // Updated via updateStreak
    longestStreak: 0,
    lastStudied: now.toISOString(),
    totalSessions: ((await getTopicProgress(topicId))?.totalSessions || 0) + 1,
    totalTimeMinutes: ((await getTopicProgress(topicId))?.totalTimeMinutes || 0) + totalMinutes,
  };

  await upsertTopic(progress);

  // Update streak
  await updateStreak();

  return {
    ...session,
    currentPhase: 'reflection',
    difficulty: newDifficulty,
    endedAt: now.toISOString(),
    stats: finalStats,
  };
}

/**
 * Get a formatted session summary for display
 */
export function formatSessionSummary(session: Session): string {
  const { stats } = session;
  const lines: string[] = [
    `Session: ${session.config.topic} (${session.domain})`,
    `Duration: ${stats.totalTimeMinutes} minutes`,
    '',
    'Review Phase:',
    `  Cards Reviewed: ${stats.cardsReviewed}`,
    `  Cards Correct: ${stats.cardsCorrect}/${stats.cardsReviewed}`,
    '',
    'Learning Phase:',
    `  New Concepts: ${stats.conceptsIntroduced}`,
    `  Concepts Mastered: ${stats.conceptsMastered}`,
    '',
    'Practice Phase:',
    `  Exercises Completed: ${stats.exercisesCompleted}`,
    `  Exercises Correct: ${stats.exercisesCorrect}/${stats.exercisesCompleted}`,
    `  Average Score: ${Math.round(stats.averageScore)}%`,
    '',
    `Difficulty: ${session.difficulty.tier}`,
    `${session.difficulty.rationale}`,
  ];

  return lines.join('\n');
}

// ============================================
// HELPERS
// ============================================

function createEmptyStats(): SessionStats {
  return {
    cardsReviewed: 0,
    cardsCorrect: 0,
    exercisesCompleted: 0,
    exercisesCorrect: 0,
    averageScore: 0,
    conceptsIntroduced: 0,
    conceptsMastered: 0,
    totalTimeMinutes: 0,
  };
}

function calculateAverageScore(evaluations: EvaluationResult[]): number {
  if (evaluations.length === 0) return 0;
  return evaluations.reduce((sum, e) => sum + e.score, 0) / evaluations.length;
}
