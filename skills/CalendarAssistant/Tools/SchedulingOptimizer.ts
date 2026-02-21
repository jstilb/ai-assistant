#!/usr/bin/env bun
/**
 * SchedulingOptimizer.ts - Multi-Dimensional Slot Scoring
 *
 * When creating/moving events, scores candidate time slots on:
 * 1. Goal alignment (does this slot help achieve goals?)
 * 2. Time-of-day preference (user prefers mornings for focus work?)
 * 3. Break coverage impact (will this slot break a break pattern?)
 * 4. Calendar density (is the day already packed?)
 *
 * Weights are configurable in preferences.
 *
 * @module SchedulingOptimizer
 */

import type {
  CalendarEvent,
  GoalAlignment,
  SlotScore,
  ScoredSlot,
  OptimizationWeights,
  OptimizationSuggestion,
  Result,
  CalendarError,
} from "./types";
import { checkAlignment } from "./GoalAlignmentEngine";
import { analyzeBreaks, getFrameworkConfig } from "./BreakInsertionEngine";
import { detectConflicts } from "./ConflictDetector";
import { BreakFramework } from "./types";

// ============================================
// DEFAULT WEIGHTS
// ============================================

const DEFAULT_WEIGHTS: OptimizationWeights = {
  goalAlignment: 0.35,
  timeOfDayPreference: 0.25,
  breakCoverageImpact: 0.2,
  calendarDensity: 0.2,
};

// ============================================
// TIME-OF-DAY PREFERENCE SCORING
// ============================================

/**
 * Score a time slot based on time-of-day preference.
 * Morning focus work gets higher scores for "morning" preference.
 */
function scoreTimeOfDay(
  hour: number,
  preference: "morning" | "afternoon" | "evening"
): number {
  const preferenceMap: Record<string, Record<string, number>> = {
    morning: {
      // 6-9am: excellent, 9-12: good, 12-2pm: neutral, 2-5pm: fair, 5pm+: poor
      "6": 0.85, "7": 0.9, "8": 0.95, "9": 1.0, "10": 0.9, "11": 0.85,
      "12": 0.6, "13": 0.55, "14": 0.5, "15": 0.45, "16": 0.4,
      "17": 0.3, "18": 0.2, "19": 0.15, "20": 0.1,
    },
    afternoon: {
      "6": 0.2, "7": 0.3, "8": 0.4, "9": 0.5, "10": 0.6, "11": 0.7,
      "12": 0.8, "13": 0.9, "14": 1.0, "15": 0.95, "16": 0.85,
      "17": 0.7, "18": 0.5, "19": 0.3, "20": 0.2,
    },
    evening: {
      "6": 0.1, "7": 0.15, "8": 0.2, "9": 0.3, "10": 0.4, "11": 0.5,
      "12": 0.55, "13": 0.6, "14": 0.65, "15": 0.7, "16": 0.8,
      "17": 0.9, "18": 1.0, "19": 0.95, "20": 0.85,
    },
  };

  const map = preferenceMap[preference] || preferenceMap.morning;
  return map[String(hour)] || 0.3;
}

// ============================================
// CALENDAR DENSITY SCORING
// ============================================

/**
 * Score calendar density (fewer events = higher score).
 * Normalized to 0-1 range.
 */
function scoreDensity(
  eventsOnDay: CalendarEvent[],
  workingHoursMinutes: number = 480 // 8 hours
): number {
  const totalScheduled = eventsOnDay.reduce((sum, event) => {
    const start = new Date(event.start).getTime();
    const end = new Date(event.end || event.start).getTime();
    return sum + Math.max(0, (end - start) / (1000 * 60));
  }, 0);

  const densityRatio = totalScheduled / workingHoursMinutes;

  // 0% scheduled = 1.0, 50% = 0.5, 100% = 0.0
  return Math.max(0, 1 - densityRatio);
}

// ============================================
// PUBLIC API
// ============================================

/**
 * Score a candidate time slot for scheduling an event.
 *
 * @param params - Scoring parameters
 * @returns Scored slot with per-dimension breakdown
 */
export async function scoreSlot(params: {
  start: string;
  end: string;
  title: string;
  existingEvents: CalendarEvent[];
  preference?: "morning" | "afternoon" | "evening";
  weights?: OptimizationWeights;
}): Promise<Result<ScoredSlot, CalendarError>> {
  const weights = params.weights || DEFAULT_WEIGHTS;
  const preference = params.preference || "morning";

  // 1. Goal alignment score
  let goalAlignmentScore = 0;
  const alignResult = await checkAlignment(params.title);
  if (alignResult.success && alignResult.data.length > 0) {
    goalAlignmentScore =
      Math.max(...alignResult.data.map((a) => a.score)) / 100;
  }

  // 2. Time-of-day preference
  const hour = new Date(params.start).getHours();
  const timeScore = scoreTimeOfDay(hour, preference);

  // 3. Break coverage impact
  const config = getFrameworkConfig(BreakFramework.FiftyTwoSeventeen);
  const proposedEvent: CalendarEvent = {
    id: "proposed",
    title: params.title,
    start: params.start,
    end: params.end,
    isAllDay: false,
    isRecurring: false,
  };
  const withProposed = [...params.existingEvents, proposedEvent];
  const breakAnalysis = analyzeBreaks(withProposed, config);
  const breakScore = breakAnalysis.coverage / 100;

  // 4. Calendar density
  const dayEvents = params.existingEvents.filter((e) => {
    const eventDate = new Date(e.start).toDateString();
    const proposedDate = new Date(params.start).toDateString();
    return eventDate === proposedDate;
  });
  const densityScore = scoreDensity(dayEvents);

  // Compute composite score
  const composite =
    goalAlignmentScore * weights.goalAlignment +
    timeScore * weights.timeOfDayPreference +
    breakScore * weights.breakCoverageImpact +
    densityScore * weights.calendarDensity;

  const score: SlotScore = {
    goalAlignment: goalAlignmentScore,
    timeOfDayPreference: timeScore,
    breakCoverageImpact: breakScore,
    calendarDensity: densityScore,
    composite,
  };

  // Generate rationale
  const rationaleParts: string[] = [];
  if (goalAlignmentScore > 0.5) {
    rationaleParts.push(`strong goal alignment (${Math.round(goalAlignmentScore * 100)}%)`);
  }
  if (timeScore > 0.7) {
    rationaleParts.push(`preferred ${preference} time slot`);
  }
  if (densityScore > 0.6) {
    rationaleParts.push(`day has room for this event`);
  }
  if (breakScore > 0.7) {
    rationaleParts.push(`maintains healthy break coverage`);
  }

  const rationale =
    rationaleParts.length > 0
      ? `Selected slot: ${rationaleParts.join(", ")}`
      : `Slot scored ${Math.round(composite * 100)}% across all dimensions`;

  return {
    success: true,
    data: {
      start: params.start,
      end: params.end,
      score,
      rationale,
    },
  };
}

/**
 * Find and score multiple candidate slots for an event.
 *
 * @param params - Search parameters
 * @returns Array of scored slots, sorted by composite score
 */
export async function findBestSlots(params: {
  durationMinutes: number;
  title: string;
  existingEvents: CalendarEvent[];
  searchDate: string;
  preference?: "morning" | "afternoon" | "evening";
  weights?: OptimizationWeights;
  maxSlots?: number;
}): Promise<Result<ScoredSlot[], CalendarError>> {
  const {
    durationMinutes,
    title,
    existingEvents,
    searchDate,
    preference = "morning",
    weights,
    maxSlots = 5,
  } = params;

  // Generate candidate slots throughout the working day
  const date = new Date(searchDate);
  const candidates: Array<{ start: string; end: string }> = [];

  // Working hours: 8am - 6pm, 30-minute intervals
  for (let hour = 8; hour <= 18; hour++) {
    for (const minute of [0, 30]) {
      const start = new Date(date);
      start.setHours(hour, minute, 0, 0);
      const end = new Date(start.getTime() + durationMinutes * 60 * 1000);

      // Don't go past 7pm
      if (end.getHours() > 19) continue;

      candidates.push({
        start: start.toISOString(),
        end: end.toISOString(),
      });
    }
  }

  // Filter out slots that conflict with existing events
  const freeSlots = candidates.filter((slot) => {
    const slotStart = new Date(slot.start).getTime();
    const slotEnd = new Date(slot.end).getTime();

    return !existingEvents.some((event) => {
      const eventStart = new Date(event.start).getTime();
      const eventEnd = new Date(event.end || event.start).getTime();
      return slotStart < eventEnd && slotEnd > eventStart;
    });
  });

  // Score each free slot
  const scoredSlots: ScoredSlot[] = [];
  for (const slot of freeSlots) {
    const result = await scoreSlot({
      start: slot.start,
      end: slot.end,
      title,
      existingEvents,
      preference,
      weights,
    });
    if (result.success) {
      scoredSlots.push(result.data);
    }
  }

  // Sort by composite score descending
  scoredSlots.sort((a, b) => b.score.composite - a.score.composite);

  return { success: true, data: scoredSlots.slice(0, maxSlots) };
}

/**
 * Generate optimization suggestions for a day's schedule.
 *
 * @param events - Events for the day
 * @returns Array of optimization suggestions
 */
export async function generateOptimizationSuggestions(
  events: CalendarEvent[]
): Promise<Result<OptimizationSuggestion[], CalendarError>> {
  const suggestions: OptimizationSuggestion[] = [];

  // Check for conflicts
  const conflictResult = detectConflicts(events);
  if (conflictResult.success && conflictResult.data.length > 0) {
    for (const conflict of conflictResult.data) {
      suggestions.push({
        type: "resolve_conflict",
        description: `Resolve overlap between "${conflict.eventA.title}" and "${conflict.eventB.title}" (${conflict.overlapMinutes} min overlap)`,
        impact: `Eliminates ${conflict.overlapMinutes}-minute scheduling conflict`,
        rationale: `${conflict.resolutionOptions[0]?.description || "Move one event to eliminate overlap"}`,
        priority: conflict.overlapMinutes > 30 ? "high" : "medium",
      });
    }
  }

  // Check break coverage
  const config = getFrameworkConfig(BreakFramework.FiftyTwoSeventeen);
  const breakAnalysis = analyzeBreaks(events, config);

  if (breakAnalysis.coverage < 60) {
    suggestions.push({
      type: "insert_break",
      description: `Break coverage is ${breakAnalysis.coverage}% - insert ${breakAnalysis.suggestions.length} recommended break(s)`,
      impact: `Increase break coverage to healthy levels (target: 85%+)`,
      rationale: `Research shows regular breaks improve focus and prevent burnout. Current coverage is below the 60% minimum threshold.`,
      priority: "high",
    });
  } else if (breakAnalysis.suggestions.length > 0) {
    suggestions.push({
      type: "insert_break",
      description: `${breakAnalysis.suggestions.length} break opportunity available`,
      impact: `Improve break coverage from ${breakAnalysis.coverage}% toward 85%`,
      rationale: `Adding recommended breaks aligns with the 52/17 framework for sustained productivity`,
      priority: "low",
    });
  }

  return { success: true, data: suggestions };
}

// CLI interface
if (import.meta.main) {
  console.log(`SchedulingOptimizer - Multi-Dimensional Slot Scoring

Dimensions:
  1. Goal alignment (35%)
  2. Time-of-day preference (25%)
  3. Break coverage impact (20%)
  4. Calendar density (20%)

Usage: Import and call scoreSlot(), findBestSlots(), or generateOptimizationSuggestions().
`);
}
