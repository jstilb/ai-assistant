/**
 * schedule-health-report.test.ts - Tests for ScheduleHealthReport
 *
 * TDD: RED phase tests for daily/weekly schedule health analysis.
 */

import { describe, test, expect } from "bun:test";
import type { CalendarEvent } from "../types";

// Helper to create test events
function makeEvent(
  title: string,
  startHour: number,
  endHour: number,
  opts: Partial<CalendarEvent> = {}
): CalendarEvent {
  const base = "2026-02-06";
  return {
    id: `evt_${title.replace(/\s/g, "_")}`,
    title,
    start: `${base}T${String(startHour).padStart(2, "0")}:00:00`,
    end: `${base}T${String(endHour).padStart(2, "0")}:00:00`,
    isAllDay: false,
    isRecurring: false,
    ...opts,
  };
}

// ============================================
// IMPORTS (will fail until implementation exists)
// ============================================

import {
  computeHealthMetrics,
  computeScheduleBalance,
  computeGoalAlignmentScore,
  generateDailyReport,
  generateWeeklyReport,
} from "../ScheduleHealthReport";

// ============================================
// computeHealthMetrics
// ============================================

describe("computeHealthMetrics", () => {
  test("returns zero metrics for empty event list", () => {
    const metrics = computeHealthMetrics([]);
    expect(metrics.totalEvents).toBe(0);
    expect(metrics.totalScheduledMinutes).toBe(0);
    expect(metrics.meetingCount).toBe(0);
    expect(metrics.focusCount).toBe(0);
    expect(metrics.breakCount).toBe(0);
  });

  test("classifies events by category correctly", () => {
    const events = [
      makeEvent("Team Standup", 9, 10),
      makeEvent("1:1 Meeting", 10, 11),
      makeEvent("Deep Work Session", 11, 13),
      makeEvent("Focus Time", 14, 16),
      makeEvent("Coffee Break", 16, 16), // 0-minute break
      makeEvent("Lunch Break", 12, 13),
    ];
    const metrics = computeHealthMetrics(events);
    expect(metrics.meetingCount).toBe(2); // standup + 1:1
    expect(metrics.focusCount).toBe(2); // deep work + focus time
    expect(metrics.breakCount).toBe(2); // coffee + lunch
  });

  test("computes total scheduled minutes correctly", () => {
    const events = [
      makeEvent("Meeting A", 9, 10), // 60 min
      makeEvent("Meeting B", 11, 12), // 60 min
      makeEvent("Focus Time", 14, 16), // 120 min
    ];
    const metrics = computeHealthMetrics(events);
    expect(metrics.totalScheduledMinutes).toBe(240);
    expect(metrics.totalEvents).toBe(3);
  });
});

// ============================================
// computeScheduleBalance
// ============================================

describe("computeScheduleBalance", () => {
  test("returns perfect balance for ideal distribution", () => {
    // Ideal: 30% meetings, 40% focus, 15% breaks, 15% free
    const events = [
      makeEvent("Meeting", 9, 11), // 120 min (30% of 400)
      makeEvent("Meeting 2", 11, 12), // 60 min
      // Total meetings: 180 min, but we need ~30%
      makeEvent("Focus Time", 13, 16), // 180 min
      makeEvent("Break", 12, 13), // 60 min
    ];
    const balance = computeScheduleBalance(events);
    expect(balance.score).toBeGreaterThan(0);
    expect(balance.score).toBeLessThanOrEqual(100);
    expect(balance.meetingRatio).toBeGreaterThanOrEqual(0);
    expect(balance.focusRatio).toBeGreaterThanOrEqual(0);
  });

  test("returns low score for meeting-heavy day", () => {
    const events = [
      makeEvent("Meeting A", 9, 10),
      makeEvent("Meeting B", 10, 11),
      makeEvent("Meeting C", 11, 12),
      makeEvent("Meeting D", 13, 14),
      makeEvent("Meeting E", 14, 15),
      makeEvent("Meeting F", 15, 16),
    ];
    const balance = computeScheduleBalance(events);
    expect(balance.score).toBeLessThan(60);
    expect(balance.meetingRatio).toBeGreaterThan(0.5);
  });

  test("returns zero score for empty schedule", () => {
    const balance = computeScheduleBalance([]);
    expect(balance.score).toBe(0);
    expect(balance.meetingRatio).toBe(0);
    expect(balance.focusRatio).toBe(0);
    expect(balance.breakRatio).toBe(0);
  });
});

// ============================================
// computeGoalAlignmentScore
// ============================================

describe("computeGoalAlignmentScore", () => {
  test("returns 0 for events with no goal keywords", () => {
    const events = [
      makeEvent("Random Activity", 9, 10),
      makeEvent("Another Thing", 11, 12),
    ];
    const score = computeGoalAlignmentScore(events, []);
    expect(score).toBe(0);
  });

  test("returns higher score when events match goal keywords", () => {
    const events = [
      makeEvent("Sprint Planning", 9, 10),
      makeEvent("Writing Session", 11, 12),
    ];
    const goalKeywords = ["sprint", "planning", "writing"];
    const score = computeGoalAlignmentScore(events, goalKeywords);
    expect(score).toBeGreaterThan(50);
  });

  test("returns 0 for empty events", () => {
    const score = computeGoalAlignmentScore([], ["keyword"]);
    expect(score).toBe(0);
  });
});

// ============================================
// generateDailyReport
// ============================================

describe("generateDailyReport", () => {
  test("generates report with all required sections", () => {
    const events = [
      makeEvent("Team Standup", 9, 10),
      makeEvent("Deep Focus", 10, 12),
      makeEvent("Lunch Break", 12, 13),
      makeEvent("Client Meeting", 14, 15),
    ];
    const report = generateDailyReport(events);
    expect(report.date).toBeTruthy();
    expect(report.metrics).toBeDefined();
    expect(report.balance).toBeDefined();
    expect(report.recommendations).toBeInstanceOf(Array);
    expect(report.overallHealthScore).toBeGreaterThanOrEqual(0);
    expect(report.overallHealthScore).toBeLessThanOrEqual(100);
  });

  test("generates recommendations for unbalanced schedule", () => {
    const events = [
      makeEvent("Meeting 1", 9, 10),
      makeEvent("Meeting 2", 10, 11),
      makeEvent("Meeting 3", 11, 12),
      makeEvent("Meeting 4", 13, 14),
      makeEvent("Meeting 5", 14, 15),
    ];
    const report = generateDailyReport(events);
    expect(report.recommendations.length).toBeGreaterThan(0);
  });
});

// ============================================
// generateWeeklyReport
// ============================================

describe("generateWeeklyReport", () => {
  test("generates weekly report aggregating multiple days", () => {
    const monday = [
      makeEvent("Meeting", 9, 10, { start: "2026-02-02T09:00:00", end: "2026-02-02T10:00:00" }),
      makeEvent("Focus", 10, 12, { start: "2026-02-02T10:00:00", end: "2026-02-02T12:00:00" }),
    ];
    const tuesday = [
      makeEvent("Deep Work", 9, 12, { start: "2026-02-03T09:00:00", end: "2026-02-03T12:00:00" }),
    ];

    const allEvents = [...monday, ...tuesday];
    const report = generateWeeklyReport(allEvents);
    expect(report.weekStartDate).toBeTruthy();
    expect(report.dailyReports).toBeInstanceOf(Array);
    expect(report.weeklyHealthScore).toBeGreaterThanOrEqual(0);
    expect(report.weeklyHealthScore).toBeLessThanOrEqual(100);
    expect(report.trends).toBeDefined();
  });

  test("handles empty week gracefully", () => {
    const report = generateWeeklyReport([]);
    expect(report.weeklyHealthScore).toBe(0);
    expect(report.dailyReports).toBeInstanceOf(Array);
  });
});
