#!/usr/bin/env bun
/**
 * FeedbackCollector.ts - Post-session effectiveness capture
 *
 * Captures context loading effectiveness data to MEMORY/LEARNING/SIGNALS/
 * for use by ContextLearner to improve profile selection over time.
 *
 * CLI: bun FeedbackCollector.ts --capture
 * API: import { captureSessionFeedback } from "./FeedbackCollector"
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync } from 'fs';
import { join } from 'path';
import { getSessionState } from './ContextManagerState';
import { emitEvalSignal } from '../../../lib/core/SkillIntegrationBridge';

const KAYA_DIR = process.env.KAYA_DIR || join(process.env.HOME!, '.claude');
const FEEDBACK_DIR = join(KAYA_DIR, 'MEMORY', 'LEARNING', 'SIGNALS');
const FEEDBACK_FILE = join(FEEDBACK_DIR, 'context-feedback.jsonl');

export interface ContextFeedback {
  timestamp: string;
  sessionId: string;
  profile: string;
  classificationStage: 'keyword' | 'inference';
  classificationConfidence: number;
  filesLoaded: string[];
  totalTokensUsed: number;
  tokenBudget: number;
  profileChanges: number;
  sessionRating?: number;
  manualContextLoads: number;
  sessionDurationMinutes?: number;
}

export interface MisclassificationFeedback {
  timestamp: string;
  sessionId: string;
  predictedProfile: string;
  actualProfile: string;
  prompt: string;
  classificationMethod: 'keyword' | 'inference';
  confidence: number;
}

/**
 * Capture current session's context feedback
 */
export async function captureSessionFeedback(
  options?: { rating?: number; durationMinutes?: number }
): Promise<ContextFeedback | null> {
  const state = await getSessionState();

  if (!state.sessionId) {
    console.error('[FeedbackCollector] No active session state found');
    return null;
  }

  // Count on-demand loads (manual context requests)
  const manualLoads = state.loadedFiles.filter(f => f.tier === 'on-demand').length;

  const feedback: ContextFeedback = {
    timestamp: new Date().toISOString(),
    sessionId: state.sessionId,
    profile: state.currentProfile,
    classificationStage: state.classification?.stage || 'keyword',
    classificationConfidence: state.classification?.confidence || 0,
    filesLoaded: state.loadedFiles.map(f => f.path),
    totalTokensUsed: state.totalTokensUsed,
    tokenBudget: state.tokenBudget,
    profileChanges: state.profileChanges,
    sessionRating: options?.rating,
    manualContextLoads: manualLoads,
    sessionDurationMinutes: options?.durationMinutes,
  };

  // Append to JSONL file
  if (!existsSync(FEEDBACK_DIR)) mkdirSync(FEEDBACK_DIR, { recursive: true });
  appendFileSync(FEEDBACK_FILE, JSON.stringify(feedback) + '\n');

  // Window: keep last 500 entries to bound file growth
  const MAX_FEEDBACK_ENTRIES = 500;
  const allLines = readFileSync(FEEDBACK_FILE, 'utf-8').trim().split('\n').filter(Boolean);
  if (allLines.length > MAX_FEEDBACK_ENTRIES) {
    writeFileSync(FEEDBACK_FILE, allLines.slice(-MAX_FEEDBACK_ENTRIES).join('\n') + '\n');
    console.error(`[FeedbackCollector] Windowed feedback from ${allLines.length} to ${MAX_FEEDBACK_ENTRIES} entries`);
  }

  console.error(`[FeedbackCollector] Captured feedback for session ${state.sessionId}`);
  return feedback;
}

/**
 * Read all feedback entries
 */
export function readFeedback(): ContextFeedback[] {
  if (!existsSync(FEEDBACK_FILE)) return [];

  return readFileSync(FEEDBACK_FILE, 'utf-8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map(line => {
      try {
        return JSON.parse(line) as ContextFeedback;
      } catch {
        return null;
      }
    })
    .filter((f): f is ContextFeedback => f !== null);
}

/**
 * Get feedback summary
 */
export function getFeedbackSummary(): {
  totalSessions: number;
  profileDistribution: Record<string, number>;
  avgTokensUsed: number;
  avgManualLoads: number;
  avgConfidence: number;
  keywordVsInference: { keyword: number; inference: number };
} {
  const entries = readFeedback();
  if (entries.length === 0) {
    return {
      totalSessions: 0,
      profileDistribution: {},
      avgTokensUsed: 0,
      avgManualLoads: 0,
      avgConfidence: 0,
      keywordVsInference: { keyword: 0, inference: 0 },
    };
  }

  const profileDist: Record<string, number> = {};
  let totalTokens = 0;
  let totalManualLoads = 0;
  let totalConfidence = 0;
  let keywordCount = 0;
  let inferenceCount = 0;

  for (const entry of entries) {
    profileDist[entry.profile] = (profileDist[entry.profile] || 0) + 1;
    totalTokens += entry.totalTokensUsed;
    totalManualLoads += entry.manualContextLoads;
    totalConfidence += entry.classificationConfidence;
    if (entry.classificationStage === 'keyword') keywordCount++;
    else inferenceCount++;
  }

  return {
    totalSessions: entries.length,
    profileDistribution: profileDist,
    avgTokensUsed: Math.round(totalTokens / entries.length),
    avgManualLoads: Math.round((totalManualLoads / entries.length) * 10) / 10,
    avgConfidence: Math.round((totalConfidence / entries.length) * 100) / 100,
    keywordVsInference: { keyword: keywordCount, inference: inferenceCount },
  };
}

/**
 * Report misclassification for ContinualLearning
 * Phase 5: Integration Backbone - Emits eval signal on misclassification
 */
export async function reportMisclassification(
  predictedProfile: string,
  actualProfile: string,
  prompt: string
): Promise<void> {
  const state = await getSessionState();

  const feedback: MisclassificationFeedback = {
    timestamp: new Date().toISOString(),
    sessionId: state.sessionId || 'unknown',
    predictedProfile,
    actualProfile,
    prompt,
    classificationMethod: state.classification?.stage || 'keyword',
    confidence: state.classification?.confidence || 0,
  };

  // Log to JSONL
  const misclassificationFile = join(FEEDBACK_DIR, 'misclassifications.jsonl');
  if (!existsSync(FEEDBACK_DIR)) mkdirSync(FEEDBACK_DIR, { recursive: true });
  appendFileSync(misclassificationFile, JSON.stringify(feedback) + '\n');

  // Phase 5: Emit eval signal
  await emitEvalSignal({
    source: 'ContextManager',
    signalType: 'failure',
    description: `Misclassification: classified as "${predictedProfile}" but should have been "${actualProfile}"`,
    category: 'classification_accuracy',
    severity: 'medium',
    score: 1 - feedback.confidence, // Lower confidence = worse failure
    rawData: {
      predicted: predictedProfile,
      actual: actualProfile,
      prompt: prompt.slice(0, 200),
      method: feedback.classificationMethod,
      confidence: feedback.confidence,
    },
  }).catch(err => console.error('[FeedbackCollector] Failed to emit eval signal:', err));

  console.error(`[FeedbackCollector] Logged misclassification: ${predictedProfile} -> ${actualProfile}`);
}

// CLI
if (import.meta.main) {
  const cmd = process.argv[2];

  if (cmd === '--capture') {
    const rating = process.argv.includes('--rating')
      ? parseInt(process.argv[process.argv.indexOf('--rating') + 1])
      : undefined;

    const feedback = await captureSessionFeedback({ rating });
    if (feedback) {
      console.log(JSON.stringify(feedback, null, 2));
    }
  } else if (cmd === '--summary') {
    console.log(JSON.stringify(getFeedbackSummary(), null, 2));
  } else if (cmd === '--list') {
    const entries = readFeedback();
    console.log(JSON.stringify(entries, null, 2));
  } else {
    console.log('Usage:');
    console.log('  bun FeedbackCollector.ts --capture [--rating N]   Capture session feedback');
    console.log('  bun FeedbackCollector.ts --summary                Show feedback summary');
    console.log('  bun FeedbackCollector.ts --list                   List all feedback entries');
  }
}
