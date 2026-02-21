#!/usr/bin/env bun
/**
 * DigitalMaestro CLI
 *
 * Thin CLI wrapper over the adaptive learning engine library.
 * Supports: learn, review, practice, progress, topics
 *
 * Usage:
 *   bun index.ts learn <topic>       Start a new learning session
 *   bun index.ts review              Quick SRS card review
 *   bun index.ts practice <topic>    Practice exercises on a topic
 *   bun index.ts progress            Show progress across all topics
 *   bun index.ts topics              List all tracked topics
 *
 * Flags:
 *   --json                           Machine-readable JSON output
 */

import {
  createSession,
  getWarmUpCards,
  recordCardReview,
  advanceToNewContent,
  createCardsForConcept,
  advanceToPractice,
  submitAnswer,
  advanceToReflection,
  formatSessionSummary,
} from './src/core/session-orchestrator.ts';
import {
  loadState,
  getAllTopics,
  getAllDueCards,
  getStreaks,
  getSessionHistory,
} from './src/state/state-manager.ts';
import { scheduleCard, sortByPriority, getDueCards } from './src/algorithms/fsrs.ts';
import { upsertCard } from './src/state/state-manager.ts';
import type { FSRSCard, FSRSRating, Session, TopicProgress, SessionConfig } from './src/types/index.ts';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';

// ============================================
// CONSTANTS
// ============================================

const STATE_DIR = join(process.env.HOME!, '.claude', 'skills', 'DigitalMaestro', 'state');
const STATE_FILE = join(STATE_DIR, 'maestro-state.json');

// ============================================
// STATE INITIALIZATION
// ============================================

function ensureState(): void {
  if (!existsSync(STATE_DIR)) {
    mkdirSync(STATE_DIR, { recursive: true });
  }
  if (!existsSync(STATE_FILE)) {
    const defaultState = {
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
    writeFileSync(STATE_FILE, JSON.stringify(defaultState, null, 2));
  }
}

// ============================================
// INPUT HELPERS
// ============================================

function promptUser(message: string): string | null {
  // Bun's built-in prompt() for interactive input
  return prompt(message);
}

function parseRating(input: string): FSRSRating | null {
  const num = parseInt(input.trim(), 10);
  if (num >= 1 && num <= 4) return num as FSRSRating;
  return null;
}

// ============================================
// OUTPUT HELPERS
// ============================================

const jsonMode = process.argv.includes('--json');

function output(data: Record<string, unknown>): void {
  if (jsonMode) {
    console.log(JSON.stringify(data, null, 2));
  }
}

function print(text: string): void {
  if (!jsonMode) {
    console.log(text);
  }
}

function printHeader(title: string): void {
  if (!jsonMode) {
    console.log('');
    console.log(`=== ${title} ===`);
    console.log('');
  }
}

function printSection(title: string): void {
  if (!jsonMode) {
    console.log(`--- ${title} ---`);
  }
}

function formatDate(iso: string): string {
  if (!iso) return 'Never';
  const d = new Date(iso);
  return d.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatRelativeDate(iso: string): string {
  if (!iso) return 'N/A';
  const now = new Date();
  const date = new Date(iso);
  const diffMs = date.getTime() - now.getTime();
  const diffDays = Math.round(diffMs / (1000 * 60 * 60 * 24));

  if (diffDays < 0) return `${Math.abs(diffDays)}d overdue`;
  if (diffDays === 0) return 'Today';
  if (diffDays === 1) return 'Tomorrow';
  return `In ${diffDays}d`;
}

// ============================================
// COMMANDS
// ============================================

async function cmdLearn(topic: string): Promise<void> {
  printHeader(`Learning Session: ${topic}`);

  const config: SessionConfig = {
    topic,
    maxDurationMinutes: 30,
    targetNewConcepts: 3,
    reviewLimit: 20,
  };

  print('Initializing session...');
  print('  - Classifying domain');
  print('  - Loading/creating topic state');
  print('  - Generating concept graph');
  print('');

  let session: Session;
  try {
    session = await createSession(config);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (jsonMode) {
      output({ error: true, message: `Failed to create session: ${msg}` });
    } else {
      console.error(`Error creating session: ${msg}`);
    }
    process.exit(1);
  }

  print(`Domain: ${session.domain}`);
  print(`Difficulty: ${session.difficulty.tier}`);
  print('');

  // Phase 1: Warm-Up (SRS Review)
  const warmUpCards = getWarmUpCards(session);
  if (warmUpCards.length > 0) {
    printSection(`Warm-Up: ${warmUpCards.length} cards due`);
    print('');

    for (const card of warmUpCards) {
      print(`  Q: ${card.front}`);
      const userAnswer = promptUser('  Your answer (press Enter to reveal): ');
      print(`  A: ${card.back}`);
      print('');

      let rating: FSRSRating | null = null;
      while (!rating) {
        const ratingInput = promptUser('  Rate: 1=Again 2=Hard 3=Good 4=Easy > ');
        if (!ratingInput) {
          rating = 3; // default to Good
          break;
        }
        rating = parseRating(ratingInput);
        if (!rating) print('  Please enter 1, 2, 3, or 4');
      }

      session = await recordCardReview(session, card.id, rating);
      print('');
    }
  } else {
    print('No cards due for review. Skipping warm-up.');
    print('');
  }

  // Phase 2: New Content
  session = advanceToNewContent(session);
  if (session.newConcepts.length > 0) {
    printSection(`New Concepts: ${session.newConcepts.length}`);
    print('');

    for (const concept of session.newConcepts) {
      print(`  [${concept.difficulty.toUpperCase()}] ${concept.name}`);
      print(`  ${concept.description}`);
      print('');

      // Create SRS cards for this concept
      await createCardsForConcept(session, concept);
    }

    promptUser('Press Enter to continue to practice...');
    print('');
  }

  // Phase 3: Practice
  session = await advanceToPractice(session);
  if (session.exercises.length > 0) {
    printSection(`Practice: ${session.exercises.length} exercises`);
    print('');

    for (const exercise of session.exercises) {
      print(`  [${exercise.type}] ${exercise.prompt}`);
      if (exercise.options) {
        exercise.options.forEach((opt, i) => {
          print(`    ${String.fromCharCode(65 + i)}) ${opt}`);
        });
      }
      print('');

      const answer = promptUser('  Your answer: ') || '';
      const result = await submitAnswer(session, exercise.id, answer);
      session = result.session;

      print('');
      print(`  Score: ${result.evaluation.score}/100 ${result.evaluation.correct ? '[CORRECT]' : '[INCORRECT]'}`);
      print(`  ${result.evaluation.feedback}`);
      if (result.evaluation.strengths.length > 0) {
        print(`  Strengths: ${result.evaluation.strengths.join(', ')}`);
      }
      if (result.evaluation.weaknesses.length > 0) {
        print(`  Improve: ${result.evaluation.weaknesses.join(', ')}`);
      }
      print('');
    }
  }

  // Phase 4: Reflection
  session = await advanceToReflection(session);
  printSection('Session Summary');
  print('');
  print(formatSessionSummary(session));

  if (jsonMode) {
    output({
      command: 'learn',
      topic,
      domain: session.domain,
      difficulty: session.difficulty,
      stats: session.stats,
      sessionId: session.id,
    });
  }
}

async function cmdReview(): Promise<void> {
  printHeader('SRS Card Review');

  const dueCards = await getAllDueCards();
  const sorted = sortByPriority(dueCards);

  if (sorted.length === 0) {
    print('No cards due for review. Come back later!');
    if (jsonMode) {
      output({ command: 'review', cardsDue: 0, cardsReviewed: 0 });
    }
    return;
  }

  print(`${sorted.length} cards due for review`);
  print('');

  let reviewed = 0;
  let correct = 0;

  for (const card of sorted) {
    print(`  [${reviewed + 1}/${sorted.length}] Topic: ${card.topicId}`);
    print(`  Q: ${card.front}`);
    promptUser('  (Press Enter to reveal answer)');
    print(`  A: ${card.back}`);
    print('');

    let rating: FSRSRating | null = null;
    while (!rating) {
      const ratingInput = promptUser('  Rate: 1=Again 2=Hard 3=Good 4=Easy > ');
      if (!ratingInput) {
        rating = 3;
        break;
      }
      rating = parseRating(ratingInput);
      if (!rating) print('  Please enter 1, 2, 3, or 4');
    }

    const result = scheduleCard(card, rating);
    await upsertCard(result.card);

    if (rating >= 3) correct++;
    reviewed++;

    print(`  Next review: ${formatRelativeDate(result.nextReviewDate)}`);
    print('');
  }

  printSection('Review Complete');
  print(`  Reviewed: ${reviewed}`);
  print(`  Correct: ${correct}/${reviewed} (${reviewed > 0 ? Math.round((correct / reviewed) * 100) : 0}%)`);

  if (jsonMode) {
    output({
      command: 'review',
      cardsDue: sorted.length,
      cardsReviewed: reviewed,
      cardsCorrect: correct,
      accuracy: reviewed > 0 ? Math.round((correct / reviewed) * 100) : 0,
    });
  }
}

async function cmdPractice(topic: string): Promise<void> {
  printHeader(`Practice: ${topic}`);

  // Use a session in practice-focused mode (skip warm-up, focus on exercises)
  const config: SessionConfig = {
    topic,
    maxDurationMinutes: 15,
    targetNewConcepts: 2,
    reviewLimit: 0, // Skip warm-up
  };

  let session: Session;
  try {
    session = await createSession(config);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (jsonMode) {
      output({ error: true, message: `Failed to start practice: ${msg}` });
    } else {
      console.error(`Error starting practice: ${msg}`);
    }
    process.exit(1);
  }

  print(`Domain: ${session.domain}`);
  print(`Difficulty: ${session.difficulty.tier}`);
  print('');

  // Jump straight to practice
  session = await advanceToPractice(session);

  if (session.exercises.length === 0) {
    print('No exercises generated. The topic may need more concepts.');
    if (jsonMode) {
      output({ command: 'practice', topic, exercisesCompleted: 0 });
    }
    return;
  }

  printSection(`${session.exercises.length} Exercises`);
  print('');

  for (let i = 0; i < session.exercises.length; i++) {
    const exercise = session.exercises[i];
    print(`  [${i + 1}/${session.exercises.length}] ${exercise.type.toUpperCase()}`);
    print(`  ${exercise.prompt}`);
    if (exercise.options) {
      exercise.options.forEach((opt, j) => {
        print(`    ${String.fromCharCode(65 + j)}) ${opt}`);
      });
    }
    if (exercise.hints.length > 0) {
      print(`  Hint: ${exercise.hints[0]}`);
    }
    print('');

    const answer = promptUser('  Your answer: ') || '';
    const result = await submitAnswer(session, exercise.id, answer);
    session = result.session;

    print('');
    print(`  Score: ${result.evaluation.score}/100 ${result.evaluation.correct ? '[CORRECT]' : '[INCORRECT]'}`);
    print(`  ${result.evaluation.feedback}`);
    if (result.evaluation.explanation) {
      print(`  Explanation: ${result.evaluation.explanation}`);
    }
    print('');
  }

  // Finalize
  session = await advanceToReflection(session);

  printSection('Practice Summary');
  print(`  Exercises: ${session.stats.exercisesCompleted}`);
  print(`  Correct: ${session.stats.exercisesCorrect}/${session.stats.exercisesCompleted}`);
  print(`  Average Score: ${Math.round(session.stats.averageScore)}%`);
  print(`  Difficulty: ${session.difficulty.tier}`);

  if (jsonMode) {
    output({
      command: 'practice',
      topic,
      domain: session.domain,
      difficulty: session.difficulty,
      stats: session.stats,
    });
  }
}

async function cmdProgress(): Promise<void> {
  printHeader('Learning Progress');

  const topics = await getAllTopics();
  const streaks = await getStreaks();
  const sessions = await getSessionHistory(10);
  const dueCards = await getAllDueCards();

  if (topics.length === 0 && sessions.length === 0) {
    print('No learning data yet. Start with: bun index.ts learn <topic>');
    if (jsonMode) {
      output({ command: 'progress', topics: [], streaks, totalDueCards: 0, recentSessions: [] });
    }
    return;
  }

  // Streaks
  printSection('Streaks');
  print(`  Current: ${streaks.currentStreak} day${streaks.currentStreak !== 1 ? 's' : ''}`);
  print(`  Longest: ${streaks.longestStreak} day${streaks.longestStreak !== 1 ? 's' : ''}`);
  print(`  Last Study: ${streaks.lastStudyDate || 'Never'}`);
  print('');

  // Overall stats
  printSection('Overview');
  print(`  Topics: ${topics.length}`);
  print(`  Cards Due: ${dueCards.length}`);
  print(`  Total Sessions: ${sessions.length}`);
  print('');

  // Per-topic progress
  if (topics.length > 0) {
    printSection('Topics');
    for (const topic of topics) {
      const mastery = topic.totalConcepts > 0
        ? Math.round((topic.masteredConcepts / topic.totalConcepts) * 100)
        : 0;
      print(`  ${topic.topic} (${topic.domain})`);
      print(`    Mastery: ${mastery}% (${topic.masteredConcepts}/${topic.totalConcepts} concepts)`);
      print(`    Difficulty: ${topic.difficulty.tier}`);
      print(`    Cards: ${topic.totalCards} total, ${topic.cardsDue} due`);
      print(`    Sessions: ${topic.totalSessions} (${Math.round(topic.totalTimeMinutes)}min total)`);
      print(`    Last Studied: ${formatDate(topic.lastStudied)}`);
      print('');
    }
  }

  // Recent sessions
  if (sessions.length > 0) {
    printSection('Recent Sessions');
    for (const s of sessions.slice(-5)) {
      print(`  ${formatDate(s.date)} - ${s.topic} (${s.domain})`);
      print(`    Cards: ${s.stats.cardsCorrect}/${s.stats.cardsReviewed} | Exercises: ${s.stats.exercisesCorrect}/${s.stats.exercisesCompleted} | Score: ${Math.round(s.stats.averageScore)}%`);
    }
  }

  if (jsonMode) {
    output({
      command: 'progress',
      streaks,
      totalDueCards: dueCards.length,
      topics: topics.map(t => ({
        topicId: t.topicId,
        topic: t.topic,
        domain: t.domain,
        difficulty: t.difficulty.tier,
        mastery: t.totalConcepts > 0 ? Math.round((t.masteredConcepts / t.totalConcepts) * 100) : 0,
        totalCards: t.totalCards,
        cardsDue: t.cardsDue,
        totalSessions: t.totalSessions,
        totalTimeMinutes: Math.round(t.totalTimeMinutes),
        lastStudied: t.lastStudied,
      })),
      recentSessions: sessions.slice(-5),
    });
  }
}

async function cmdTopics(): Promise<void> {
  printHeader('Tracked Topics');

  const topics = await getAllTopics();
  const state = await loadState();

  if (topics.length === 0) {
    print('No topics tracked yet. Start with: bun index.ts learn <topic>');
    if (jsonMode) {
      output({ command: 'topics', topics: [] });
    }
    return;
  }

  const now = new Date();
  const topicSummaries: Array<Record<string, unknown>> = [];

  for (const topic of topics) {
    // Count due cards for this topic
    const topicCards = Object.values(state.cards).filter(
      (c) => (c as FSRSCard).topicId === topic.topicId
    ) as FSRSCard[];
    const dueCount = topicCards.filter(c => new Date(c.nextReview) <= now).length;

    // Find next review date
    const futureCards = topicCards
      .filter(c => new Date(c.nextReview) > now)
      .sort((a, b) => new Date(a.nextReview).getTime() - new Date(b.nextReview).getTime());
    const nextReview = futureCards.length > 0 ? futureCards[0].nextReview : null;

    print(`  ${topic.topic}`);
    print(`    Domain: ${topic.domain} | Difficulty: ${topic.difficulty.tier}`);
    print(`    Cards: ${topicCards.length} total, ${dueCount} due now`);
    print(`    Concepts: ${topic.masteredConcepts}/${topic.totalConcepts} mastered`);
    print(`    Next Review: ${nextReview ? formatRelativeDate(nextReview) : 'N/A'}`);
    print(`    Last Studied: ${formatDate(topic.lastStudied)}`);
    print('');

    topicSummaries.push({
      topicId: topic.topicId,
      topic: topic.topic,
      domain: topic.domain,
      difficulty: topic.difficulty.tier,
      totalCards: topicCards.length,
      cardsDue: dueCount,
      masteredConcepts: topic.masteredConcepts,
      totalConcepts: topic.totalConcepts,
      nextReview: nextReview || null,
      lastStudied: topic.lastStudied,
    });
  }

  if (jsonMode) {
    output({ command: 'topics', topics: topicSummaries });
  }
}

// ============================================
// USAGE
// ============================================

function printUsage(): void {
  console.log(`
DigitalMaestro - Adaptive Learning Engine

Usage:
  bun index.ts learn <topic>       Start a new learning session
  bun index.ts review              Quick SRS card review
  bun index.ts practice <topic>    Practice exercises on a topic
  bun index.ts progress            Show progress across all topics
  bun index.ts topics              List all tracked topics

Flags:
  --json                           Machine-readable JSON output

Examples:
  bun index.ts learn "TypeScript generics"
  bun index.ts review
  bun index.ts practice "organic chemistry"
  bun index.ts progress --json
  bun index.ts topics
`);
}

// ============================================
// MAIN
// ============================================

async function main(): Promise<void> {
  // Ensure state file exists
  ensureState();

  // Parse arguments (skip 'bun' and script path)
  const args = process.argv.slice(2).filter(a => a !== '--json');
  const command = args[0];

  if (!command) {
    printUsage();
    process.exit(0);
  }

  switch (command) {
    case 'learn': {
      const topic = args.slice(1).join(' ');
      if (!topic) {
        console.error('Error: Please provide a topic. Usage: bun index.ts learn <topic>');
        process.exit(1);
      }
      await cmdLearn(topic);
      break;
    }
    case 'review':
      await cmdReview();
      break;
    case 'practice': {
      const topic = args.slice(1).join(' ');
      if (!topic) {
        console.error('Error: Please provide a topic. Usage: bun index.ts practice <topic>');
        process.exit(1);
      }
      await cmdPractice(topic);
      break;
    }
    case 'progress':
      await cmdProgress();
      break;
    case 'topics':
      await cmdTopics();
      break;
    default:
      console.error(`Unknown command: ${command}`);
      printUsage();
      process.exit(1);
  }
}

main().catch((err) => {
  console.error('Fatal error:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
