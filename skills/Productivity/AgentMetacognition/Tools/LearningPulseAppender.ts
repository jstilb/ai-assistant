#!/usr/bin/env bun
/**
 * LearningPulseAppender — Append Learning Pulse section to a DailyBriefing
 *
 * ISC-23: Learning Pulse section must be present in daily briefing output.
 * Called by SynthesisOrchestrator after synthesis run.
 *
 * This is deterministic, pure code: no LLM calls, no I/O, no side effects.
 * Extracted from InsightGenerator.ts (removed in T3-ContinualLearning-InsightGenerator
 * remediation) so that the LLM-free appendLearningPulse utility is not lost when
 * InsightGenerator.ts is deleted.
 */

// ============================================================================
// Types
// ============================================================================

export interface LearningPulse {
  activeFrameCount: number;
  candidateFrameCount: number;
  lastSynthesisDate: string | null;
  signalQualityRatio: number;
  topPatterns: string[];
}

export interface DailyBriefing {
  date: string;
  greeting: string;
  quickStats: {
    sessionsYesterday: number;
    avgRating: number;
    topPattern: string;
    activeGoals: number;
  };
  highlights: string[];
  actionItems: string[];
  focusRecommendation: string;
  goalProgress: Array<{
    goalId: string;
    goalTitle: string;
    recentActivity: string;
  }>;
  learningPulse?: LearningPulse;
}

// ============================================================================
// appendLearningPulse
// ============================================================================

/**
 * Returns a new DailyBriefing with the learningPulse field populated.
 * Pure function — does not mutate the input briefing.
 */
export function appendLearningPulse(
  briefing: DailyBriefing,
  synthesisResult: {
    activeFrameCount: number;
    candidateFrameCount: number;
    lastRun: string | null;
    qualityRatio: number;
    topPatterns: string[];
  }
): DailyBriefing {
  return {
    ...briefing,
    learningPulse: {
      activeFrameCount: synthesisResult.activeFrameCount,
      candidateFrameCount: synthesisResult.candidateFrameCount,
      lastSynthesisDate: synthesisResult.lastRun,
      signalQualityRatio: synthesisResult.qualityRatio,
      topPatterns: synthesisResult.topPatterns,
    },
  };
}
