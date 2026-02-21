/**
 * RationaleGenerator Test Suite - Phase 4
 *
 * Tests template-based rationale generation, per-dimension scoring,
 * prohibited phrase filtering, and recommendation generation.
 *
 * @module rationale-generator.test
 */

import { describe, it, expect } from "bun:test";
import {
  generateCreateRationale,
  generateModifyRationale,
  generateDeleteRationale,
  generateQueryRationale,
  generateOptimizationRationale,
  validateRationale,
  PROHIBITED_PHRASES,
  scoreDimension,
} from "../RationaleGenerator";
import { IntentType } from "../types";
import type {
  ParsedIntent,
  GoalAlignment,
  SlotScore,
  Conflict,
  BreakAnalysis,
  ConflictType,
  CalendarEvent,
} from "../types";

// ============================================================================
// Helpers
// ============================================================================

function makeIntent(overrides?: Partial<ParsedIntent>): ParsedIntent {
  return {
    type: IntentType.Create,
    confidence: 0.9,
    entities: { title: "Team Standup" },
    rawInput: "schedule team standup",
    ...overrides,
  };
}

function makeGoalAlignment(overrides?: Partial<GoalAlignment>): GoalAlignment {
  return {
    goalId: "goal-1",
    goalTitle: "Ship Q1 Feature",
    score: 85,
    matchedKeywords: ["feature", "development"],
    ...overrides,
  };
}

function makeSlotScore(overrides?: Partial<SlotScore>): SlotScore {
  return {
    goalAlignment: 0.85,
    timeOfDayPreference: 0.9,
    breakCoverageImpact: 0.75,
    calendarDensity: 0.6,
    composite: 0.78,
    ...overrides,
  };
}

// ============================================================================
// Tests
// ============================================================================

describe("RationaleGenerator", () => {
  // ============================================================================
  // 1. Prohibited Phrase Validation
  // ============================================================================
  describe("prohibited phrase validation", () => {
    it("should have at least 8 prohibited phrases", () => {
      expect(PROHIBITED_PHRASES.length).toBeGreaterThanOrEqual(8);
    });

    it("should include 'I think' as prohibited", () => {
      expect(PROHIBITED_PHRASES.some((p) => p.toLowerCase().includes("i think"))).toBe(true);
    });

    it("should include 'probably' as prohibited", () => {
      expect(PROHIBITED_PHRASES.some((p) => p.toLowerCase().includes("probably"))).toBe(true);
    });

    it("should reject text containing prohibited phrases", () => {
      expect(validateRationale("I think this time works")).toBe(false);
      expect(validateRationale("This is probably fine")).toBe(false);
      expect(validateRationale("Seems good to me")).toBe(false);
      expect(validateRationale("This should be fine")).toBe(false);
      expect(validateRationale("Looks okay for now")).toBe(false);
    });

    it("should accept clean rationale text", () => {
      expect(
        validateRationale(
          "Scheduled at 2pm because this aligns with your deep work preference"
        )
      ).toBe(true);
      expect(
        validateRationale(
          "Meeting placed after lunch to avoid the 3pm cluster"
        )
      ).toBe(true);
    });

    it("should be case-insensitive", () => {
      expect(validateRationale("I THINK this works")).toBe(false);
      expect(validateRationale("PROBABLY fine")).toBe(false);
    });
  });

  // ============================================================================
  // 2. Per-Dimension Scoring
  // ============================================================================
  describe("per-dimension scoring", () => {
    it("should score goal alignment dimension", () => {
      const score = scoreDimension("goalAlignment", 0.85);
      expect(score.name).toBe("Goal Alignment");
      expect(score.score).toBe(85);
      expect(score.explanation).toBeDefined();
      expect(score.explanation.length).toBeGreaterThan(0);
    });

    it("should score time-of-day preference dimension", () => {
      const score = scoreDimension("timeOfDayPreference", 0.9);
      expect(score.name).toBe("Time-of-Day Preference");
      expect(score.score).toBe(90);
    });

    it("should score calendar density dimension", () => {
      const score = scoreDimension("calendarDensity", 0.3);
      expect(score.name).toBe("Calendar Density");
      expect(score.score).toBe(30);
      // Low density should mention "dense" or "heavy"
      expect(score.explanation.toLowerCase()).toMatch(/dense|heavy|full/);
    });

    it("should score break coverage dimension", () => {
      const score = scoreDimension("breakCoverageImpact", 0.8);
      expect(score.name).toBe("Break Coverage");
      expect(score.score).toBe(80);
    });

    it("should clamp scores between 0 and 100", () => {
      const high = scoreDimension("goalAlignment", 1.5);
      expect(high.score).toBeLessThanOrEqual(100);

      const low = scoreDimension("goalAlignment", -0.5);
      expect(low.score).toBeGreaterThanOrEqual(0);
    });
  });

  // ============================================================================
  // 3. Create Rationale
  // ============================================================================
  describe("create rationale", () => {
    it("should generate rationale with goal alignment", () => {
      const rationale = generateCreateRationale({
        intent: makeIntent(),
        goalAlignments: [makeGoalAlignment()],
      });
      expect(rationale.summary).toContain("Team Standup");
      expect(rationale.summary).toContain("Ship Q1 Feature");
      expect(rationale.dimensions.length).toBeGreaterThanOrEqual(1);
    });

    it("should generate rationale with slot scores", () => {
      const rationale = generateCreateRationale({
        intent: makeIntent(),
        slotScore: makeSlotScore(),
      });
      expect(rationale.dimensions.length).toBeGreaterThanOrEqual(3);
      // Should have time-of-day, density, break coverage dimensions
      const dimNames = rationale.dimensions.map((d) => d.name);
      expect(dimNames).toContain("Time-of-Day Preference");
      expect(dimNames).toContain("Calendar Density");
      expect(dimNames).toContain("Break Coverage");
    });

    it("should generate rationale with both goals and scores", () => {
      const rationale = generateCreateRationale({
        intent: makeIntent(),
        goalAlignments: [makeGoalAlignment()],
        slotScore: makeSlotScore(),
      });
      expect(rationale.dimensions.length).toBeGreaterThanOrEqual(4);
    });

    it("should generate human-readable recommendation format", () => {
      const rationale = generateCreateRationale({
        intent: makeIntent({ entities: { title: "Deep Work Session" } }),
        goalAlignments: [makeGoalAlignment({ goalTitle: "Complete Project X" })],
        slotScore: makeSlotScore({ timeOfDayPreference: 0.95 }),
        preferenceNotes: ["Morning slot selected for optimal focus time"],
      });
      // Should read like: "Scheduled at 2pm because this aligns with your deep work preference"
      expect(rationale.summary.length).toBeGreaterThan(20);
      expect(validateRationale(rationale.summary)).toBe(true);
    });

    it("should include preference notes in summary", () => {
      const rationale = generateCreateRationale({
        intent: makeIntent(),
        preferenceNotes: ["Avoids the 3pm meeting cluster"],
      });
      expect(rationale.summary).toContain("3pm meeting cluster");
    });

    it("should never contain prohibited phrases in output", () => {
      // Run many combinations to catch edge cases
      const combinations = [
        { intent: makeIntent(), goalAlignments: [makeGoalAlignment()] },
        { intent: makeIntent(), slotScore: makeSlotScore() },
        { intent: makeIntent() },
        {
          intent: makeIntent(),
          goalAlignments: [makeGoalAlignment({ score: 10, matchedKeywords: [] })],
        },
      ];
      for (const params of combinations) {
        const rationale = generateCreateRationale(params);
        expect(validateRationale(rationale.summary)).toBe(true);
        if (rationale.recommendation) {
          expect(validateRationale(rationale.recommendation)).toBe(true);
        }
      }
    });

    it("should include break analysis warning in summary", () => {
      const rationale = generateCreateRationale({
        intent: makeIntent(),
        breakAnalysis: {
          coverage: 45,
          suggestions: [],
          removedBreaks: [],
          warning: "Low break coverage",
        },
      });
      expect(rationale.summary.toLowerCase()).toContain("break");
    });

    it("should include conflict count in summary", () => {
      const mockEvent: CalendarEvent = {
        id: "e1",
        title: "Event",
        start: "2026-02-06T10:00:00Z",
        end: "2026-02-06T11:00:00Z",
        isAllDay: false,
        isRecurring: false,
      };
      const rationale = generateCreateRationale({
        intent: makeIntent(),
        conflicts: [
          {
            type: "partial_overlap" as ConflictType,
            eventA: mockEvent,
            eventB: mockEvent,
            overlapMinutes: 30,
            resolutionOptions: [],
          },
        ],
      });
      expect(rationale.summary.toLowerCase()).toContain("conflict");
    });
  });

  // ============================================================================
  // 4. Modify Rationale
  // ============================================================================
  describe("modify rationale", () => {
    it("should generate modify rationale", () => {
      const rationale = generateModifyRationale({
        intent: makeIntent({ type: IntentType.Modify }),
        originalEvent: {
          title: "Team Sync",
          start: "2026-02-06T10:00:00Z",
          end: "2026-02-06T11:00:00Z",
        },
      });
      expect(rationale.summary).toContain("Team Sync");
      expect(rationale.summary.toLowerCase()).toContain("modif");
    });

    it("should use 'Rescheduled' for move intents", () => {
      const rationale = generateModifyRationale({
        intent: makeIntent({ type: IntentType.Move }),
        originalEvent: {
          title: "Team Sync",
          start: "2026-02-06T10:00:00Z",
          end: "2026-02-06T11:00:00Z",
        },
      });
      expect(rationale.summary).toContain("Rescheduled");
    });
  });

  // ============================================================================
  // 5. Delete Rationale
  // ============================================================================
  describe("delete rationale", () => {
    it("should confirm user confirmation in delete rationale", () => {
      const rationale = generateDeleteRationale({
        eventTitle: "Sprint Review",
        isRecurring: false,
        confirmed: true,
      });
      expect(rationale.summary).toContain("Sprint Review");
      expect(rationale.summary.toLowerCase()).toContain("confirm");
    });

    it("should note recurring event in delete rationale", () => {
      const rationale = generateDeleteRationale({
        eventTitle: "Weekly Standup",
        isRecurring: true,
        confirmed: true,
      });
      expect(rationale.summary.toLowerCase()).toContain("recurring");
    });
  });

  // ============================================================================
  // 6. Query Rationale
  // ============================================================================
  describe("query rationale", () => {
    it("should include result count", () => {
      const rationale = generateQueryRationale({
        queryType: "daily agenda",
        resultCount: 8,
      });
      expect(rationale.summary).toContain("8");
      expect(rationale.summary).toContain("daily agenda");
    });
  });

  // ============================================================================
  // 7. Optimization Rationale
  // ============================================================================
  describe("optimization rationale", () => {
    it("should include suggestion count and scores", () => {
      const rationale = generateOptimizationRationale({
        suggestionCount: 3,
        goalAlignmentScore: 72,
        breakCoverage: 85,
        conflictCount: 1,
      });
      expect(rationale.summary).toContain("3");
      expect(rationale.summary).toContain("72%");
      expect(rationale.summary).toContain("85%");
      expect(rationale.dimensions.length).toBeGreaterThanOrEqual(2);
    });

    it("should include conflict count when present", () => {
      const rationale = generateOptimizationRationale({
        suggestionCount: 2,
        goalAlignmentScore: 80,
        breakCoverage: 90,
        conflictCount: 2,
      });
      expect(rationale.summary).toContain("2 conflict");
    });

    it("should never produce prohibited phrases", () => {
      const rationale = generateOptimizationRationale({
        suggestionCount: 0,
        goalAlignmentScore: 100,
        breakCoverage: 100,
        conflictCount: 0,
      });
      expect(validateRationale(rationale.summary)).toBe(true);
    });
  });

  // ============================================================================
  // 8. Edge Cases
  // ============================================================================
  describe("edge cases", () => {
    it("should handle empty goal alignments", () => {
      const rationale = generateCreateRationale({
        intent: makeIntent(),
        goalAlignments: [],
      });
      expect(rationale.summary).toBeDefined();
      expect(validateRationale(rationale.summary)).toBe(true);
    });

    it("should handle missing entities title", () => {
      const rationale = generateCreateRationale({
        intent: makeIntent({ entities: {} }),
      });
      expect(rationale.summary).toBeDefined();
      expect(rationale.summary).toContain("event");
    });

    it("should handle zero scores gracefully", () => {
      const rationale = generateCreateRationale({
        intent: makeIntent(),
        slotScore: makeSlotScore({
          goalAlignment: 0,
          timeOfDayPreference: 0,
          breakCoverageImpact: 0,
          calendarDensity: 0,
          composite: 0,
        }),
      });
      expect(rationale.dimensions.length).toBeGreaterThan(0);
      expect(validateRationale(rationale.summary)).toBe(true);
    });
  });
});
