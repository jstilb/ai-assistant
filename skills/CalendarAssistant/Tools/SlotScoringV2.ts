#!/usr/bin/env bun
/**
 * SlotScoringV2.ts - Feedback-Weighted Slot Scoring
 *
 * Enhanced slot scoring that incorporates:
 * 1. User feedback history (positive/negative per hour)
 * 2. Time-of-day preference learning from feedback patterns
 * 3. Calendar density scoring
 * 4. Category-specific preferences
 *
 * Builds on SchedulingOptimizer with a feedback loop.
 *
 * @module SlotScoringV2
 */

import { z } from "zod";
import { createStateManager } from "../../CORE/Tools/StateManager";
import type { CalendarEvent, Result, CalendarError } from "./types";

// ============================================
// TYPES
// ============================================

export interface FeedbackEntry {
  hour: number;
  feedback: "positive" | "negative";
  eventCategory: string;
  timestamp: string;
}

interface FeedbackStore {
  entries: FeedbackEntry[];
  lastUpdated: string;
}

export interface SlotScoreV2 {
  composite: number; // 0-1 weighted total
  feedbackBoost: number; // -0.2 to +0.2 adjustment from feedback
  densityScore: number; // 0-1 calendar density
  timePreferenceScore: number; // 0-1 time-of-day match
}

// ============================================
// SCHEMA
// ============================================

const FeedbackEntrySchema = z.object({
  hour: z.number(),
  feedback: z.enum(["positive", "negative"]),
  eventCategory: z.string(),
  timestamp: z.string(),
});

const FeedbackStoreSchema = z.object({
  entries: z.array(FeedbackEntrySchema),
  lastUpdated: z.string(),
});

// ============================================
// STATE MANAGER
// ============================================

const KAYA_DIR = process.env.KAYA_DIR || `${process.env.HOME}/.claude`;
const FEEDBACK_PATH = `${KAYA_DIR}/skills/CalendarAssistant/data/slot-feedback.json`;

const feedbackManager = createStateManager<FeedbackStore>({
  path: FEEDBACK_PATH,
  schema: FeedbackStoreSchema,
  defaults: {
    entries: [],
    lastUpdated: new Date().toISOString(),
  },
  version: 1,
});

// ============================================
// FEEDBACK RECORDING
// ============================================

/**
 * Record user feedback for a time slot.
 */
export async function recordSlotFeedback(params: {
  hour: number;
  feedback: "positive" | "negative";
  eventCategory: string;
}): Promise<Result<{ recorded: true }, CalendarError>> {
  try {
    await feedbackManager.update((store) => ({
      entries: [
        ...store.entries,
        {
          hour: params.hour,
          feedback: params.feedback,
          eventCategory: params.eventCategory,
          timestamp: new Date().toISOString(),
        },
      ],
      lastUpdated: new Date().toISOString(),
    }));
    return { success: true, data: { recorded: true } };
  } catch (err) {
    return {
      success: false,
      error: {
        code: "UNKNOWN",
        message: `Failed to record feedback: ${err instanceof Error ? err.message : String(err)}`,
        retryable: false,
      },
    };
  }
}

/**
 * Clear all feedback (primarily for testing).
 */
export async function clearFeedback(): Promise<void> {
  await feedbackManager.save({
    entries: [],
    lastUpdated: new Date().toISOString(),
  });
}

// ============================================
// PREFERENCE LEARNING
// ============================================

/**
 * Determine time-of-day preference from feedback history.
 * Looks at net positive feedback per time bucket.
 */
export async function getTimePreferenceFromFeedback(): Promise<
  "morning" | "afternoon" | "evening"
> {
  const store = await feedbackManager.load();

  if (store.entries.length === 0) return "morning"; // default

  // Compute net scores per bucket
  const buckets = { morning: 0, afternoon: 0, evening: 0 };

  for (const entry of store.entries) {
    const value = entry.feedback === "positive" ? 1 : -1;

    if (entry.hour >= 6 && entry.hour < 12) {
      buckets.morning += value;
    } else if (entry.hour >= 12 && entry.hour < 17) {
      buckets.afternoon += value;
    } else if (entry.hour >= 17) {
      buckets.evening += value;
    }
  }

  // Find bucket with highest net score
  if (buckets.afternoon > buckets.morning && buckets.afternoon > buckets.evening) {
    return "afternoon";
  }
  if (buckets.evening > buckets.morning && buckets.evening > buckets.afternoon) {
    return "evening";
  }
  return "morning";
}

// ============================================
// FEEDBACK BOOST CALCULATION
// ============================================

/**
 * Compute a feedback boost for a specific hour.
 * Returns -0.2 to +0.2 based on historical feedback.
 */
async function computeFeedbackBoost(hour: number): Promise<number> {
  const store = await feedbackManager.load();

  const relevantEntries = store.entries.filter((e) => e.hour === hour);
  if (relevantEntries.length === 0) return 0;

  const positiveCount = relevantEntries.filter((e) => e.feedback === "positive").length;
  const negativeCount = relevantEntries.filter((e) => e.feedback === "negative").length;
  const total = relevantEntries.length;

  // Net sentiment: -1 to +1
  const netSentiment = (positiveCount - negativeCount) / total;

  // Scale to -0.2 to +0.2
  return netSentiment * 0.2;
}

// ============================================
// DENSITY SCORING
// ============================================

function computeDensityScore(
  existingEvents: CalendarEvent[],
  targetDate: string
): number {
  const dayEvents = existingEvents.filter((e) => {
    const eventDate = new Date(e.start).toDateString();
    const proposedDate = new Date(targetDate).toDateString();
    return eventDate === proposedDate;
  });

  const totalScheduledMinutes = dayEvents.reduce((sum, event) => {
    const start = new Date(event.start).getTime();
    const end = new Date(event.end || event.start).getTime();
    return sum + Math.max(0, (end - start) / (1000 * 60));
  }, 0);

  const workingDayMinutes = 480; // 8 hours
  const densityRatio = totalScheduledMinutes / workingDayMinutes;

  return Math.max(0, 1 - densityRatio);
}

// ============================================
// TIME PREFERENCE SCORING
// ============================================

function computeTimePreferenceScore(
  hour: number,
  preference: "morning" | "afternoon" | "evening"
): number {
  const preferenceMap: Record<string, Record<number, number>> = {
    morning: { 6: 0.85, 7: 0.9, 8: 0.95, 9: 1.0, 10: 0.9, 11: 0.85, 12: 0.6, 13: 0.55, 14: 0.5, 15: 0.45, 16: 0.4, 17: 0.3, 18: 0.2 },
    afternoon: { 6: 0.2, 7: 0.3, 8: 0.4, 9: 0.5, 10: 0.6, 11: 0.7, 12: 0.8, 13: 0.9, 14: 1.0, 15: 0.95, 16: 0.85, 17: 0.7, 18: 0.5 },
    evening: { 6: 0.1, 7: 0.15, 8: 0.2, 9: 0.3, 10: 0.4, 11: 0.5, 12: 0.55, 13: 0.6, 14: 0.65, 15: 0.7, 16: 0.8, 17: 0.9, 18: 1.0 },
  };

  return preferenceMap[preference]?.[hour] ?? 0.5;
}

// ============================================
// PUBLIC API
// ============================================

/**
 * Score a slot with feedback-weighted scoring.
 * Combines time preference, density, and feedback history.
 */
export async function scoreSlotWithFeedback(params: {
  start: string;
  end: string;
  title: string;
  existingEvents: CalendarEvent[];
}): Promise<SlotScoreV2> {
  const hour = new Date(params.start).getHours();

  // Get learned preference from feedback
  const preference = await getTimePreferenceFromFeedback();

  // Compute individual scores
  const timePreferenceScore = computeTimePreferenceScore(hour, preference);
  const densityScore = computeDensityScore(params.existingEvents, params.start);
  const feedbackBoost = await computeFeedbackBoost(hour);

  // Weighted composite: base score + feedback adjustment
  const baseComposite = timePreferenceScore * 0.5 + densityScore * 0.5;
  const composite = Math.max(0, Math.min(1, baseComposite + feedbackBoost));

  return {
    composite,
    feedbackBoost,
    densityScore,
    timePreferenceScore,
  };
}

// ============================================
// CLI INTERFACE
// ============================================

if (import.meta.main) {
  const args = process.argv.slice(2);
  const command = args[0];

  if (command === "preference") {
    const pref = await getTimePreferenceFromFeedback();
    console.log(`Learned time preference: ${pref}`);
  } else {
    console.log(`SlotScoringV2 - Feedback-Weighted Slot Scoring

Usage:
  bun run SlotScoringV2.ts preference     Show learned preference

Exports:
  recordSlotFeedback(params)            Record feedback
  getTimePreferenceFromFeedback()       Get learned preference
  scoreSlotWithFeedback(params)         Score with feedback weighting
  clearFeedback()                       Clear all feedback
`);
  }
}
