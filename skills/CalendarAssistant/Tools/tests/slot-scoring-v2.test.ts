/**
 * slot-scoring-v2.test.ts - Tests for enhanced SlotScoring with feedback weighting
 *
 * TDD: Tests for feedback-weighted scoring and time-of-day preference learning.
 */

import { describe, test, expect } from "bun:test";
import type { CalendarEvent } from "../types";

import {
  recordSlotFeedback,
  getTimePreferenceFromFeedback,
  scoreSlotWithFeedback,
  clearFeedback,
} from "../SlotScoringV2";

// Helper
function makeEvent(
  title: string,
  startHour: number,
  endHour: number
): CalendarEvent {
  const base = "2026-02-06";
  return {
    id: `evt_${title.replace(/\s/g, "_")}`,
    title,
    start: `${base}T${String(startHour).padStart(2, "0")}:00:00`,
    end: `${base}T${String(endHour).padStart(2, "0")}:00:00`,
    isAllDay: false,
    isRecurring: false,
  };
}

// ============================================
// recordSlotFeedback
// ============================================

describe("recordSlotFeedback", () => {
  test("records positive feedback for a time slot", async () => {
    await clearFeedback();
    const result = await recordSlotFeedback({
      hour: 9,
      feedback: "positive",
      eventCategory: "focus",
    });
    expect(result.success).toBe(true);
  });

  test("records negative feedback for a time slot", async () => {
    await clearFeedback();
    const result = await recordSlotFeedback({
      hour: 14,
      feedback: "negative",
      eventCategory: "meeting",
    });
    expect(result.success).toBe(true);
  });
});

// ============================================
// getTimePreferenceFromFeedback
// ============================================

describe("getTimePreferenceFromFeedback", () => {
  test("returns default morning preference with no feedback", async () => {
    await clearFeedback();
    const pref = await getTimePreferenceFromFeedback();
    expect(pref).toBe("morning");
  });

  test("detects afternoon preference from feedback pattern", async () => {
    await clearFeedback();
    // Record 5 positive afternoon feedbacks
    for (let i = 0; i < 5; i++) {
      await recordSlotFeedback({ hour: 14, feedback: "positive", eventCategory: "focus" });
    }
    // Record 5 negative morning feedbacks
    for (let i = 0; i < 5; i++) {
      await recordSlotFeedback({ hour: 9, feedback: "negative", eventCategory: "focus" });
    }
    const pref = await getTimePreferenceFromFeedback();
    expect(pref).toBe("afternoon");
  });
});

// ============================================
// scoreSlotWithFeedback
// ============================================

describe("scoreSlotWithFeedback", () => {
  test("returns score between 0 and 1", async () => {
    await clearFeedback();
    const score = await scoreSlotWithFeedback({
      start: "2026-02-06T09:00:00",
      end: "2026-02-06T10:00:00",
      title: "Focus Session",
      existingEvents: [],
    });
    expect(score.composite).toBeGreaterThanOrEqual(0);
    expect(score.composite).toBeLessThanOrEqual(1);
  });

  test("boosts score for hours with positive feedback history", async () => {
    await clearFeedback();
    // Record positive feedback for 9am
    for (let i = 0; i < 5; i++) {
      await recordSlotFeedback({ hour: 9, feedback: "positive", eventCategory: "focus" });
    }
    // Record negative feedback for 3pm
    for (let i = 0; i < 5; i++) {
      await recordSlotFeedback({ hour: 15, feedback: "negative", eventCategory: "focus" });
    }

    const morningScore = await scoreSlotWithFeedback({
      start: "2026-02-06T09:00:00",
      end: "2026-02-06T10:00:00",
      title: "Focus Session",
      existingEvents: [],
    });

    const afternoonScore = await scoreSlotWithFeedback({
      start: "2026-02-06T15:00:00",
      end: "2026-02-06T16:00:00",
      title: "Focus Session",
      existingEvents: [],
    });

    expect(morningScore.feedbackBoost).toBeGreaterThan(afternoonScore.feedbackBoost);
  });

  test("includes density scoring from existing events", async () => {
    await clearFeedback();
    const packed: CalendarEvent[] = [
      makeEvent("Meeting 1", 9, 10),
      makeEvent("Meeting 2", 10, 11),
      makeEvent("Meeting 3", 11, 12),
      makeEvent("Meeting 4", 13, 14),
      makeEvent("Meeting 5", 14, 15),
    ];

    const busyDayScore = await scoreSlotWithFeedback({
      start: "2026-02-06T15:00:00",
      end: "2026-02-06T16:00:00",
      title: "Another Meeting",
      existingEvents: packed,
    });

    const freeDayScore = await scoreSlotWithFeedback({
      start: "2026-02-06T15:00:00",
      end: "2026-02-06T16:00:00",
      title: "Another Meeting",
      existingEvents: [],
    });

    expect(freeDayScore.densityScore).toBeGreaterThan(busyDayScore.densityScore);
  });
});
