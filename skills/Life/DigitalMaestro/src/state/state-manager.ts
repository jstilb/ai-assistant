/**
 * DigitalMaestro State Persistence
 *
 * Wraps Kaya's core StateManager with DigitalMaestro-specific schema and
 * operations. Manages topics, concept graphs, SRS cards, progress, and streaks.
 */

import { z } from 'zod';
import { createStateManager } from '../../../../../lib/core/StateManager.ts';
import type {
  DigitalMaestroState,
  FSRSCard,
  ConceptGraph,
  TopicProgress,
  StreakData,
  SessionSummary,
  SessionStats,
  DomainType,
  DifficultyAssessment,
} from '../types/index.ts';

// ============================================
// ZOD SCHEMAS
// ============================================

const SessionStatsSchema = z.object({
  cardsReviewed: z.number(),
  cardsCorrect: z.number(),
  exercisesCompleted: z.number(),
  exercisesCorrect: z.number(),
  averageScore: z.number(),
  conceptsIntroduced: z.number(),
  conceptsMastered: z.number(),
  totalTimeMinutes: z.number(),
});

const SessionSummarySchema = z.object({
  id: z.string(),
  topic: z.string(),
  domain: z.string(),
  date: z.string(),
  stats: SessionStatsSchema,
});

const DifficultyAssessmentSchema = z.object({
  tier: z.string(),
  score: z.number(),
  rationale: z.string(),
  adjustedAt: z.string(),
});

const ConceptNodeSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  domain: z.string(),
  difficulty: z.string(),
  prerequisites: z.array(z.string()),
  mastery: z.number(),
});

const ConceptEdgeSchema = z.object({
  from: z.string(),
  to: z.string(),
  relationship: z.string(),
  weight: z.number(),
});

const ConceptGraphSchema = z.object({
  topicId: z.string(),
  topic: z.string(),
  domain: z.string(),
  nodes: z.array(ConceptNodeSchema),
  edges: z.array(ConceptEdgeSchema),
  generatedAt: z.string(),
});

const FSRSCardSchema = z.object({
  id: z.string(),
  topicId: z.string(),
  front: z.string(),
  back: z.string(),
  state: z.string(),
  difficulty: z.number(),
  stability: z.number(),
  retrievability: z.number(),
  lastReview: z.string(),
  nextReview: z.string(),
  reps: z.number(),
  lapses: z.number(),
  createdAt: z.string(),
});

const TopicProgressSchema = z.object({
  topicId: z.string(),
  topic: z.string(),
  domain: z.string(),
  difficulty: DifficultyAssessmentSchema,
  conceptGraph: ConceptGraphSchema,
  totalCards: z.number(),
  cardsDue: z.number(),
  masteredConcepts: z.number(),
  totalConcepts: z.number(),
  currentStreak: z.number(),
  longestStreak: z.number(),
  lastStudied: z.string(),
  totalSessions: z.number(),
  totalTimeMinutes: z.number(),
});

const StreakDataSchema = z.object({
  currentStreak: z.number(),
  longestStreak: z.number(),
  lastStudyDate: z.string(),
  studyDates: z.array(z.string()),
});

const DigitalMaestroStateSchema = z.object({
  topics: z.record(z.string(), TopicProgressSchema),
  cards: z.record(z.string(), FSRSCardSchema),
  graphs: z.record(z.string(), ConceptGraphSchema),
  streaks: StreakDataSchema,
  sessions: z.array(SessionSummarySchema),
  lastUpdated: z.string(),
});

// ============================================
// STATE MANAGER INSTANCE
// ============================================

const STATE_PATH = `${process.env.HOME}/.claude/skills/Life/DigitalMaestro/state/maestro-state.json`;

const DEFAULT_STATE: DigitalMaestroState = {
  topics: {},
  cards: {},
  graphs: {},
  streaks: {
    currentStreak: 0,
    longestStreak: 0,
    lastStudyDate: '',
    studyDates: [],
  },
  sessions: [],
  lastUpdated: new Date().toISOString(),
};

const stateManager = createStateManager({
  path: STATE_PATH,
  schema: DigitalMaestroStateSchema,
  defaults: DEFAULT_STATE,
  version: 1,
  backupOnWrite: true,
});

// ============================================
// PUBLIC API
// ============================================

/**
 * Load the complete DigitalMaestro state
 */
export async function loadState(): Promise<DigitalMaestroState> {
  return await stateManager.load() as DigitalMaestroState;
}

/**
 * Save the complete state
 */
export async function saveState(state: DigitalMaestroState): Promise<void> {
  await stateManager.save(state);
}

/**
 * Add or update a topic's progress
 */
export async function upsertTopic(progress: TopicProgress): Promise<void> {
  await stateManager.update((state: DigitalMaestroState) => ({
    ...state,
    topics: {
      ...state.topics,
      [progress.topicId]: progress,
    },
  }));
}

/**
 * Get progress for a specific topic
 */
export async function getTopicProgress(topicId: string): Promise<TopicProgress | null> {
  const state = await loadState();
  return state.topics[topicId] || null;
}

/**
 * Get all topics
 */
export async function getAllTopics(): Promise<TopicProgress[]> {
  const state = await loadState();
  return Object.values(state.topics);
}

/**
 * Add or update an SRS card
 */
export async function upsertCard(card: FSRSCard): Promise<void> {
  await stateManager.update((state: DigitalMaestroState) => ({
    ...state,
    cards: {
      ...state.cards,
      [card.id]: card,
    },
  }));
}

/**
 * Get all cards for a topic
 */
export async function getCardsForTopic(topicId: string): Promise<FSRSCard[]> {
  const state = await loadState();
  return Object.values(state.cards).filter(c => c.topicId === topicId) as FSRSCard[];
}

/**
 * Get all due cards across all topics
 */
export async function getAllDueCards(): Promise<FSRSCard[]> {
  const state = await loadState();
  const now = new Date();
  return (Object.values(state.cards) as FSRSCard[]).filter(card => {
    return new Date(card.nextReview) <= now;
  });
}

/**
 * Store or update a concept graph
 */
export async function upsertGraph(graph: ConceptGraph): Promise<void> {
  await stateManager.update((state: DigitalMaestroState) => ({
    ...state,
    graphs: {
      ...state.graphs,
      [graph.topicId]: graph,
    },
  }));
}

/**
 * Get the concept graph for a topic
 */
export async function getGraph(topicId: string): Promise<ConceptGraph | null> {
  const state = await loadState();
  return (state.graphs[topicId] as ConceptGraph) || null;
}

/**
 * Record a session summary
 */
export async function recordSession(summary: SessionSummary): Promise<void> {
  await stateManager.update((state: DigitalMaestroState) => ({
    ...state,
    sessions: [...state.sessions, summary],
  }));
}

/**
 * Update streak data after a study session
 */
export async function updateStreak(): Promise<StreakData> {
  const result = await stateManager.update((state: DigitalMaestroState) => {
    const today = new Date().toISOString().split('T')[0];
    const streaks = { ...state.streaks };

    // If already studied today, no change
    if (streaks.lastStudyDate === today) {
      return state;
    }

    // Check if yesterday was studied (streak continuation)
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const yesterdayStr = yesterday.toISOString().split('T')[0];

    if (streaks.lastStudyDate === yesterdayStr) {
      streaks.currentStreak += 1;
    } else if (streaks.lastStudyDate !== today) {
      streaks.currentStreak = 1; // Reset streak
    }

    streaks.longestStreak = Math.max(streaks.longestStreak, streaks.currentStreak);
    streaks.lastStudyDate = today;
    if (!streaks.studyDates.includes(today)) {
      streaks.studyDates = [...streaks.studyDates, today];
    }

    return { ...state, streaks };
  });

  return (result as DigitalMaestroState).streaks as StreakData;
}

/**
 * Get streak data
 */
export async function getStreaks(): Promise<StreakData> {
  const state = await loadState();
  return state.streaks as StreakData;
}

/**
 * Get session history
 */
export async function getSessionHistory(limit?: number): Promise<SessionSummary[]> {
  const state = await loadState();
  const sessions = state.sessions as SessionSummary[];
  return limit ? sessions.slice(-limit) : sessions;
}

/**
 * Get the raw state manager for advanced operations
 */
export function getStateManager() {
  return stateManager;
}
