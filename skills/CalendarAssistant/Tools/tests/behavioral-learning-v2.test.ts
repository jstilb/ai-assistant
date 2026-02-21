/**
 * behavioral-learning-v2.test.ts - Tests for BehavioralLearningV2
 *
 * TDD: RED phase tests for pattern extraction and preference refinement.
 */

import { describe, test, expect } from "bun:test";
import type { CalendarEvent } from "../types";

import {
  extractPatterns,
  refinePreferences,
  getTimeOfDayDistribution,
  getDayOfWeekDistribution,
  getEventCategoryBreakdown,
} from "../BehavioralLearningV2";

// Helper to create test events across multiple days
function makeEvents(
  title: string,
  count: number,
  startHour: number,
  opts: Partial<CalendarEvent> = {}
): CalendarEvent[] {
  return Array.from({ length: count }, (_, i) => {
    const day = String(1 + i).padStart(2, "0");
    return {
      id: `evt_${title.replace(/\s/g, "_")}_${i}`,
      title,
      start: `2026-02-${day}T${String(startHour).padStart(2, "0")}:00:00`,
      end: `2026-02-${day}T${String(startHour + 1).padStart(2, "0")}:00:00`,
      isAllDay: false,
      isRecurring: false,
      ...opts,
    };
  });
}

// ============================================
// extractPatterns
// ============================================

describe("extractPatterns", () => {
  test("detects recurring events from title grouping", () => {
    const events = [
      ...makeEvents("Team Standup", 5, 9),
      ...makeEvents("Random Activity", 1, 14),
    ];
    const patterns = extractPatterns(events);
    // Team Standup appears 5 times -> should be a pattern
    const standupPattern = patterns.find((p) => p.title === "Team Standup");
    expect(standupPattern).toBeDefined();
    expect(standupPattern!.occurrences).toBe(5);
  });

  test("requires minimum 2 occurrences for pattern detection", () => {
    const events = makeEvents("One-Off Event", 1, 10);
    const patterns = extractPatterns(events);
    expect(patterns.length).toBe(0);
  });

  test("computes confidence based on frequency", () => {
    // 10 occurrences in 30 days should have higher confidence than 2
    const highFreq = makeEvents("Daily Standup", 10, 9);
    const lowFreq = makeEvents("Monthly Review", 2, 14);
    const allEvents = [...highFreq, ...lowFreq];
    const patterns = extractPatterns(allEvents);

    const daily = patterns.find((p) => p.title === "Daily Standup");
    const monthly = patterns.find((p) => p.title === "Monthly Review");

    expect(daily).toBeDefined();
    expect(monthly).toBeDefined();
    expect(daily!.confidence).toBeGreaterThan(monthly!.confidence);
  });

  test("identifies preferred time slot for recurring events", () => {
    const events = makeEvents("Focus Time", 5, 9); // always at 9am
    const patterns = extractPatterns(events);
    const pattern = patterns.find((p) => p.title === "Focus Time");
    expect(pattern).toBeDefined();
    expect(pattern!.preferredHour).toBe(9);
  });

  test("returns empty array for no events", () => {
    const patterns = extractPatterns([]);
    expect(patterns).toEqual([]);
  });

  test("boosts confidence for events marked as recurring", () => {
    const recurringEvents = makeEvents("Weekly Sync", 3, 10, { isRecurring: true });
    const nonRecurring = makeEvents("Ad-Hoc Meeting", 3, 14, { isRecurring: false });
    const patterns = extractPatterns([...recurringEvents, ...nonRecurring]);

    const recurring = patterns.find((p) => p.title === "Weekly Sync");
    const adhoc = patterns.find((p) => p.title === "Ad-Hoc Meeting");

    expect(recurring).toBeDefined();
    expect(adhoc).toBeDefined();
    expect(recurring!.confidence).toBeGreaterThan(adhoc!.confidence);
  });
});

// ============================================
// refinePreferences
// ============================================

describe("refinePreferences", () => {
  test("suggests preferred focus time based on event distribution", () => {
    // Most focus events in the morning
    const events = [
      ...makeEvents("Deep Work", 8, 9), // 8 focus sessions in AM
      ...makeEvents("Focus Time", 5, 10),
      ...makeEvents("Meeting", 3, 14), // some meetings in PM
    ];
    const suggestions = refinePreferences(events);
    const focusSuggestion = suggestions.find((s) => s.type === "preferred_focus_time");
    expect(focusSuggestion).toBeDefined();
    expect(focusSuggestion!.suggestedValue).toBe("morning");
  });

  test("suggests default event duration from most common", () => {
    const events = Array.from({ length: 10 }, (_, i) => ({
      id: `evt_${i}`,
      title: `Meeting ${i}`,
      start: `2026-02-06T09:00:00`,
      end: `2026-02-06T09:30:00`, // 30-minute meetings
      isAllDay: false,
      isRecurring: false,
    }));
    const suggestions = refinePreferences(events);
    const durationSuggestion = suggestions.find((s) => s.type === "default_event_duration");
    expect(durationSuggestion).toBeDefined();
    expect(durationSuggestion!.suggestedValue).toBe("30");
  });

  test("returns empty suggestions for no events", () => {
    const suggestions = refinePreferences([]);
    expect(suggestions).toEqual([]);
  });
});

// ============================================
// getTimeOfDayDistribution
// ============================================

describe("getTimeOfDayDistribution", () => {
  test("counts events by hour bucket", () => {
    const events = [
      ...makeEvents("Morning Event", 3, 9),
      ...makeEvents("Afternoon Event", 2, 14),
      ...makeEvents("Evening Event", 1, 18),
    ];
    const dist = getTimeOfDayDistribution(events);
    expect(dist.morning).toBe(3); // 6am-12pm
    expect(dist.afternoon).toBe(2); // 12pm-5pm
    expect(dist.evening).toBe(1); // 5pm+
  });

  test("returns zeros for empty events", () => {
    const dist = getTimeOfDayDistribution([]);
    expect(dist.morning).toBe(0);
    expect(dist.afternoon).toBe(0);
    expect(dist.evening).toBe(0);
  });
});

// ============================================
// getDayOfWeekDistribution
// ============================================

describe("getDayOfWeekDistribution", () => {
  test("counts events per day of week", () => {
    // Feb 2 is Monday, Feb 3 is Tuesday, etc.
    const events = [
      ...makeEvents("Monday Meeting", 2, 9), // Feb 1 (Sat), Feb 2 (Mon)
      { id: "evt_3", title: "Wed Event", start: "2026-02-04T09:00:00", end: "2026-02-04T10:00:00", isAllDay: false, isRecurring: false },
    ];
    const dist = getDayOfWeekDistribution(events);
    expect(dist).toBeInstanceOf(Object);
    // Should have keys for the days events appear on
    const totalEvents = Object.values(dist).reduce((a, b) => a + b, 0);
    expect(totalEvents).toBe(3);
  });
});

// ============================================
// getEventCategoryBreakdown
// ============================================

describe("getEventCategoryBreakdown", () => {
  test("categorizes events into meeting, focus, break, other", () => {
    const events = [
      { id: "1", title: "Sprint Meeting", start: "2026-02-06T09:00:00", end: "2026-02-06T10:00:00", isAllDay: false, isRecurring: false },
      { id: "2", title: "Deep Focus", start: "2026-02-06T10:00:00", end: "2026-02-06T12:00:00", isAllDay: false, isRecurring: false },
      { id: "3", title: "Coffee Break", start: "2026-02-06T12:00:00", end: "2026-02-06T12:30:00", isAllDay: false, isRecurring: false },
      { id: "4", title: "Grocery Shopping", start: "2026-02-06T17:00:00", end: "2026-02-06T18:00:00", isAllDay: false, isRecurring: false },
    ];
    const breakdown = getEventCategoryBreakdown(events);
    expect(breakdown.meeting).toBe(1);
    expect(breakdown.focus).toBe(1);
    expect(breakdown.break).toBe(1);
    expect(breakdown.other).toBe(1);
  });
});
