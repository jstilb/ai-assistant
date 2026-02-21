#!/usr/bin/env bun
/**
 * BehavioralLearningV2.ts - Pattern Extraction & Preference Refinement
 *
 * Analyzes 30-day event history to extract behavioral patterns:
 * - Recurring event detection (title grouping, frequency)
 * - Time-of-day distribution analysis
 * - Day-of-week distribution
 * - Event category breakdown
 * - Preference refinement suggestions
 *
 * @module BehavioralLearningV2
 */

import type { CalendarEvent } from "./types";

// ============================================
// TYPES
// ============================================

export interface EventPattern {
  title: string;
  occurrences: number;
  confidence: number; // 0-1
  preferredHour: number;
  averageDurationMinutes: number;
  isRecurring: boolean;
}

export interface PreferenceSuggestion {
  type: string;
  currentValue: string;
  suggestedValue: string;
  reason: string;
  confidence: number;
}

export interface TimeOfDayDistribution {
  morning: number; // 6am-12pm
  afternoon: number; // 12pm-5pm
  evening: number; // 5pm+
}

export interface DayOfWeekDistribution {
  [dayName: string]: number;
}

export interface EventCategoryBreakdown {
  meeting: number;
  focus: number;
  break: number;
  other: number;
}

// ============================================
// EVENT CLASSIFICATION (matching ScheduleHealthReport patterns)
// ============================================

const MEETING_KEYWORDS = [
  "meeting", "standup", "stand-up", "sync", "1:1", "one-on-one",
  "call", "interview", "review", "retro", "planning", "grooming",
  "kickoff", "check-in", "catchup", "catch-up", "huddle", "scrum",
  "sprint", "demo", "presentation", "workshop", "all-hands", "town hall",
  "client", "stakeholder",
];

const FOCUS_KEYWORDS = [
  "focus", "deep work", "deep-work", "writing", "coding", "design",
  "research", "study", "learning", "reading", "concentration",
  "heads down", "heads-down", "solo", "individual", "creative",
  "project", "task", "work session", "build",
];

const BREAK_KEYWORDS = [
  "break", "lunch", "coffee", "walk", "gym", "exercise", "rest",
  "relax", "recharge", "personal", "errand", "appointment",
];

function classifyEvent(event: CalendarEvent): "meeting" | "focus" | "break" | "other" {
  const text = event.title.toLowerCase();

  for (const keyword of MEETING_KEYWORDS) {
    if (text.includes(keyword)) return "meeting";
  }
  for (const keyword of FOCUS_KEYWORDS) {
    if (text.includes(keyword)) return "focus";
  }
  for (const keyword of BREAK_KEYWORDS) {
    if (text.includes(keyword)) return "break";
  }

  return "other";
}

function getEventDurationMinutes(event: CalendarEvent): number {
  const start = new Date(event.start).getTime();
  const end = new Date(event.end || event.start).getTime();
  return Math.max(0, (end - start) / (1000 * 60));
}

// ============================================
// PATTERN EXTRACTION
// ============================================

const MIN_OCCURRENCES_FOR_PATTERN = 2;

/**
 * Extract recurring patterns from event history.
 * Groups events by title, counts occurrences, determines preferred time.
 */
export function extractPatterns(events: CalendarEvent[]): EventPattern[] {
  if (events.length === 0) return [];

  // Group events by title
  const groups: Record<string, CalendarEvent[]> = {};
  for (const event of events) {
    const key = event.title;
    if (!groups[key]) groups[key] = [];
    groups[key].push(event);
  }

  const patterns: EventPattern[] = [];

  for (const [title, groupEvents] of Object.entries(groups)) {
    if (groupEvents.length < MIN_OCCURRENCES_FOR_PATTERN) continue;

    // Compute preferred hour (most common start hour)
    const hourCounts: Record<number, number> = {};
    let totalDuration = 0;
    let hasRecurring = false;

    for (const event of groupEvents) {
      const hour = new Date(event.start).getHours();
      hourCounts[hour] = (hourCounts[hour] || 0) + 1;
      totalDuration += getEventDurationMinutes(event);
      if (event.isRecurring) hasRecurring = true;
    }

    // Find most common hour
    let preferredHour = 0;
    let maxHourCount = 0;
    for (const [hour, count] of Object.entries(hourCounts)) {
      if (count > maxHourCount) {
        maxHourCount = count;
        preferredHour = parseInt(hour, 10);
      }
    }

    // Compute confidence: based on occurrence frequency
    // More occurrences = higher confidence, capped at 1.0
    // Base: occurrences / 30 (assumes 30-day window)
    let confidence = Math.min(1.0, groupEvents.length / 20);

    // Boost for calendar-marked recurring events
    if (hasRecurring) {
      confidence = Math.min(1.0, confidence * 1.3);
    }

    patterns.push({
      title,
      occurrences: groupEvents.length,
      confidence: Math.round(confidence * 100) / 100,
      preferredHour,
      averageDurationMinutes: Math.round(totalDuration / groupEvents.length),
      isRecurring: hasRecurring,
    });
  }

  // Sort by confidence descending
  patterns.sort((a, b) => b.confidence - a.confidence);

  return patterns;
}

// ============================================
// PREFERENCE REFINEMENT
// ============================================

/**
 * Analyze events and suggest preference refinements.
 * Looks at focus time distribution and common event durations.
 */
export function refinePreferences(events: CalendarEvent[]): PreferenceSuggestion[] {
  if (events.length === 0) return [];

  const suggestions: PreferenceSuggestion[] = [];

  // 1. Suggest preferred focus time based on when focus events happen
  const focusEvents = events.filter((e) => classifyEvent(e) === "focus");
  if (focusEvents.length >= 3) {
    const dist = getTimeOfDayDistribution(focusEvents);
    let suggestedFocusTime: "morning" | "afternoon" | "evening" = "morning";

    if (dist.afternoon > dist.morning && dist.afternoon > dist.evening) {
      suggestedFocusTime = "afternoon";
    } else if (dist.evening > dist.morning && dist.evening > dist.afternoon) {
      suggestedFocusTime = "evening";
    }

    suggestions.push({
      type: "preferred_focus_time",
      currentValue: "morning",
      suggestedValue: suggestedFocusTime,
      reason: `${focusEvents.length} focus events analyzed. Most occur in the ${suggestedFocusTime}.`,
      confidence: Math.min(1, focusEvents.length / 10),
    });
  }

  // 2. Suggest default event duration from most common duration
  const durations = events.map((e) => getEventDurationMinutes(e)).filter((d) => d > 0);
  if (durations.length >= 5) {
    // Find most common duration (round to nearest 15 minutes)
    const roundedDurations: Record<number, number> = {};
    for (const d of durations) {
      const rounded = Math.round(d / 15) * 15;
      roundedDurations[rounded] = (roundedDurations[rounded] || 0) + 1;
    }

    let mostCommonDuration = 60;
    let maxCount = 0;
    for (const [duration, count] of Object.entries(roundedDurations)) {
      if (count > maxCount) {
        maxCount = count;
        mostCommonDuration = parseInt(duration, 10);
      }
    }

    suggestions.push({
      type: "default_event_duration",
      currentValue: "60",
      suggestedValue: String(mostCommonDuration),
      reason: `Most common event duration is ${mostCommonDuration} minutes (${maxCount} events).`,
      confidence: Math.min(1, maxCount / durations.length),
    });
  }

  return suggestions;
}

// ============================================
// DISTRIBUTION ANALYSIS
// ============================================

/**
 * Count events by time-of-day bucket.
 * Morning: 6am-12pm, Afternoon: 12pm-5pm, Evening: 5pm+
 */
export function getTimeOfDayDistribution(events: CalendarEvent[]): TimeOfDayDistribution {
  const dist: TimeOfDayDistribution = { morning: 0, afternoon: 0, evening: 0 };

  for (const event of events) {
    const hour = new Date(event.start).getHours();
    if (hour >= 6 && hour < 12) {
      dist.morning++;
    } else if (hour >= 12 && hour < 17) {
      dist.afternoon++;
    } else if (hour >= 17) {
      dist.evening++;
    }
  }

  return dist;
}

/**
 * Count events per day of week.
 */
export function getDayOfWeekDistribution(events: CalendarEvent[]): DayOfWeekDistribution {
  const dayNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const dist: DayOfWeekDistribution = {};

  for (const event of events) {
    const dayIndex = new Date(event.start).getDay();
    const dayName = dayNames[dayIndex];
    dist[dayName] = (dist[dayName] || 0) + 1;
  }

  return dist;
}

/**
 * Categorize events into meeting, focus, break, other.
 */
export function getEventCategoryBreakdown(events: CalendarEvent[]): EventCategoryBreakdown {
  const breakdown: EventCategoryBreakdown = { meeting: 0, focus: 0, break: 0, other: 0 };

  for (const event of events) {
    const category = classifyEvent(event);
    breakdown[category]++;
  }

  return breakdown;
}

// ============================================
// CLI INTERFACE
// ============================================

if (import.meta.main) {
  const args = process.argv.slice(2);
  const command = args[0];

  if (command === "help" || !command) {
    console.log(`BehavioralLearningV2 - Pattern Extraction & Preference Refinement

Usage:
  bun run BehavioralLearningV2.ts help          Show this help

Exports:
  extractPatterns(events)             Extract recurring patterns
  refinePreferences(events)           Suggest preference updates
  getTimeOfDayDistribution(events)    Time-of-day event counts
  getDayOfWeekDistribution(events)    Day-of-week event counts
  getEventCategoryBreakdown(events)   Category breakdown
`);
  }
}
