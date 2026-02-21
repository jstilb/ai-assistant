#!/usr/bin/env bun
/**
 * WeeklyScorecardGenerator.test.ts - Tests for the weekly scorecard generator
 *
 * TDD Red Phase: These tests define the contract for the weekly scorecard.
 * They must FAIL before implementation, then pass after.
 */

import { describe, test, expect } from "bun:test";
import {
  calculateWeekOverWeekTrend,
  detectPattern,
  formatTrendArrow,
  aggregateCommitments,
  formatHabitPerformanceTable,
  formatLeadMeasureScorecard,
  formatCommitmentReview,
  formatPatternsDetected,
  formatNextWeekPreview,
  generateVoiceSummary,
  parseSheetRows,
  getWeekDates,
} from "../WeeklyScorecardGenerator.ts";

// ============================================================================
// Unit Tests: getWeekDates
// ============================================================================

describe("getWeekDates", () => {
  test("returns 7 dates ending at the given date (Sunday)", () => {
    const dates = getWeekDates("2026-02-08");
    expect(dates).toHaveLength(7);
    expect(dates[0]).toBe("2026-02-02");
    expect(dates[6]).toBe("2026-02-08");
  });

  test("returns correct week for mid-week date", () => {
    const dates = getWeekDates("2026-02-05");
    expect(dates).toHaveLength(7);
    expect(dates[0]).toBe("2026-01-30");
    expect(dates[6]).toBe("2026-02-05");
  });
});

// ============================================================================
// Unit Tests: calculateWeekOverWeekTrend
// ============================================================================

describe("calculateWeekOverWeekTrend", () => {
  test("returns positive delta when this week is better", () => {
    const result = calculateWeekOverWeekTrend(80, 60);
    expect(result.direction).toBe("up");
    expect(result.delta).toBe(20);
    expect(result.thisWeek).toBe(80);
    expect(result.lastWeek).toBe(60);
  });

  test("returns negative delta when this week is worse", () => {
    const result = calculateWeekOverWeekTrend(40, 70);
    expect(result.direction).toBe("down");
    expect(result.delta).toBe(-30);
  });

  test("returns flat when values are equal", () => {
    const result = calculateWeekOverWeekTrend(50, 50);
    expect(result.direction).toBe("flat");
    expect(result.delta).toBe(0);
  });

  test("handles zero last week gracefully", () => {
    const result = calculateWeekOverWeekTrend(50, 0);
    expect(result.direction).toBe("up");
    expect(result.delta).toBe(50);
  });
});

// ============================================================================
// Unit Tests: detectPattern
// ============================================================================

describe("detectPattern", () => {
  test("detects improving pattern with 3+ consecutive increases", () => {
    const dailyValues = [40, 50, 60, 70, 80, 85, 90];
    const pattern = detectPattern(dailyValues);
    expect(pattern).toBe("improving");
  });

  test("detects declining pattern with 3+ consecutive decreases", () => {
    const dailyValues = [90, 85, 80, 70, 60, 50, 40];
    const pattern = detectPattern(dailyValues);
    expect(pattern).toBe("declining");
  });

  test("detects stalled pattern with mixed values", () => {
    const dailyValues = [50, 60, 50, 60, 50, 60, 50];
    const pattern = detectPattern(dailyValues);
    expect(pattern).toBe("stalled");
  });

  test("handles empty array", () => {
    const pattern = detectPattern([]);
    expect(pattern).toBe("stalled");
  });

  test("handles single value", () => {
    const pattern = detectPattern([50]);
    expect(pattern).toBe("stalled");
  });
});

// ============================================================================
// Unit Tests: formatTrendArrow
// ============================================================================

describe("formatTrendArrow", () => {
  test("returns up arrow for positive trend", () => {
    expect(formatTrendArrow("up")).toContain("^");
  });

  test("returns down arrow for negative trend", () => {
    expect(formatTrendArrow("down")).toContain("v");
  });

  test("returns flat arrow for flat trend", () => {
    expect(formatTrendArrow("flat")).toContain("-");
  });
});

// ============================================================================
// Unit Tests: aggregateCommitments
// ============================================================================

describe("aggregateCommitments", () => {
  test("calculates correct completion rate from planned vs evening data", () => {
    const planned = [
      { date: "2026-02-02", priorities: [{ title: "Task A" }, { title: "Task B" }] },
      { date: "2026-02-03", priorities: [{ title: "Task C" }] },
    ];
    const evenings = [
      { date: "2026-02-02", completed: ["Task A"], incomplete: ["Task B"] },
      { date: "2026-02-03", completed: ["Task C"], incomplete: [] },
    ];

    const result = aggregateCommitments(planned, evenings);
    expect(result.totalPlanned).toBe(3);
    expect(result.totalCompleted).toBe(2);
    expect(result.completionRate).toBeCloseTo(66.7, 0);
  });

  test("handles empty inputs", () => {
    const result = aggregateCommitments([], []);
    expect(result.totalPlanned).toBe(0);
    expect(result.totalCompleted).toBe(0);
    expect(result.completionRate).toBe(0);
  });
});

// ============================================================================
// Unit Tests: parseSheetRows
// ============================================================================

describe("parseSheetRows", () => {
  test("parses boolean habit rows correctly", () => {
    const rows = [
      ["Habit", "2026-02-02", "2026-02-03", "2026-02-04"],
      ["Exercise", "TRUE", "FALSE", "TRUE"],
      ["Read", "TRUE", "TRUE", "FALSE"],
    ];
    const result = parseSheetRows(rows);
    expect(result).toHaveLength(2);
    expect(result[0]!.name).toBe("Exercise");
    expect(result[0]!.values).toEqual([true, false, true]);
    expect(result[1]!.name).toBe("Read");
    expect(result[1]!.values).toEqual([true, true, false]);
  });

  test("handles empty rows", () => {
    const result = parseSheetRows([]);
    expect(result).toEqual([]);
  });

  test("handles rows with empty names", () => {
    const rows = [
      ["Habit", "2026-02-02"],
      ["", "TRUE"],
      ["Read", "TRUE"],
    ];
    const result = parseSheetRows(rows);
    expect(result).toHaveLength(1);
    expect(result[0]!.name).toBe("Read");
  });
});

// ============================================================================
// Unit Tests: Formatting Functions
// ============================================================================

describe("formatHabitPerformanceTable", () => {
  test("generates markdown table with trend arrows", () => {
    const habits = [
      { name: "Exercise", thisWeekPct: 85, lastWeekPct: 70, trend: "up" as const },
      { name: "Read", thisWeekPct: 40, lastWeekPct: 60, trend: "down" as const },
    ];
    const md = formatHabitPerformanceTable(habits);
    expect(md).toContain("Exercise");
    expect(md).toContain("85%");
    expect(md).toContain("70%");
    expect(md).toContain("Read");
    expect(md).toContain("40%");
    expect(md).toContain("|");
  });
});

describe("formatLeadMeasureScorecard", () => {
  test("generates scorecard with WIG gap analysis", () => {
    const measures = [
      { id: "S0", name: "Deep Work", thisWeek: 3.5, lastWeek: 2.0, target: 4.0, direction: "up" as const, delta: 1.5 },
    ];
    const md = formatLeadMeasureScorecard(measures);
    expect(md).toContain("S0");
    expect(md).toContain("Deep Work");
    expect(md).toContain("3.5");
    expect(md).toContain("Target");
  });
});

describe("formatCommitmentReview", () => {
  test("shows planned vs actual and completion rate", () => {
    const commitments = {
      totalPlanned: 10,
      totalCompleted: 7,
      completionRate: 70,
      dailyBreakdown: [
        { date: "2026-02-02", planned: 3, completed: 2 },
      ],
    };
    const md = formatCommitmentReview(commitments);
    expect(md).toContain("70");
    expect(md).toContain("10");
    expect(md).toContain("7");
  });
});

describe("formatPatternsDetected", () => {
  test("includes improving/declining/stalled labels", () => {
    const patterns = [
      { name: "Exercise", pattern: "improving" as const, data: [60, 70, 80, 85, 90] },
      { name: "Read", pattern: "declining" as const, data: [90, 80, 70, 60, 50] },
      { name: "Meditate", pattern: "stalled" as const, data: [50, 50, 50, 50, 50] },
    ];
    const md = formatPatternsDetected(patterns);
    expect(md).toContain("Improving");
    expect(md).toContain("Declining");
    expect(md).toContain("Stalled");
    expect(md).toContain("Exercise");
    expect(md).toContain("Read");
  });
});

describe("formatNextWeekPreview", () => {
  test("includes calendar events and suggested focus", () => {
    const preview = {
      events: [{ title: "Team Standup", date: "2026-02-10", time: "9:00 AM" }],
      suggestedFocus: ["Exercise", "Deep Work"],
    };
    const md = formatNextWeekPreview(preview);
    expect(md).toContain("Team Standup");
    expect(md).toContain("Exercise");
    expect(md).toContain("Deep Work");
  });

  test("handles empty events", () => {
    const preview = {
      events: [],
      suggestedFocus: ["Exercise"],
    };
    const md = formatNextWeekPreview(preview);
    expect(md).toContain("Exercise");
  });
});

// ============================================================================
// Unit Tests: generateVoiceSummary
// ============================================================================

describe("generateVoiceSummary", () => {
  test("generates summary with top 3 insights under 16 words", () => {
    const insights = [
      "Habit completion up 15% this week",
      "S3 lead measure is critical at 20%",
      "Commitment rate improved to 80%",
    ];
    const voice = generateVoiceSummary(insights);
    const wordCount = voice.split(/\s+/).length;
    expect(wordCount).toBeLessThanOrEqual(16);
    expect(voice.length).toBeGreaterThan(0);
  });

  test("handles empty insights", () => {
    const voice = generateVoiceSummary([]);
    expect(voice.length).toBeGreaterThan(0);
  });
});
