/**
 * Goal Alignment Engine Test Suite
 *
 * Tests event-to-goal keyword matching, alignment scoring,
 * multi-event analysis, alignment reports, and the checkAlignment API.
 *
 * ISC #5: Every action includes rationale with goal references
 * ISC #6: Alignment scoring accuracy
 *
 * @module goal-alignment.test
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, unlinkSync, mkdirSync } from "fs";
import { dirname } from "path";
import type { CalendarEvent, Goal, GoalAlignment } from "../types";
import { GoalLevel } from "../types";

// ==========================================================================
// Setup test environment
// ==========================================================================

const TEST_DIR = `/tmp/calendar-assistant-plus-alignment-test-${process.pid}`;
const TEST_GOALS_PATH = `${TEST_DIR}/skills/CalendarAssistant/data/goals.json`;

process.env.KAYA_DIR = TEST_DIR;

let GoalStore: typeof import("../GoalStore");
let GoalAlignmentEngine: typeof import("../GoalAlignmentEngine");

// ==========================================================================
// Test helpers
// ==========================================================================

function makeEvent(overrides: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    id: `evt_${Math.random().toString(36).slice(2, 8)}`,
    title: "Test Event",
    start: "2026-02-05T09:00:00Z",
    end: "2026-02-05T10:00:00Z",
    isAllDay: false,
    isRecurring: false,
    ...overrides,
  };
}

// ==========================================================================
// Tests
// ==========================================================================

describe("GoalAlignmentEngine", () => {
  beforeEach(async () => {
    mkdirSync(dirname(TEST_GOALS_PATH), { recursive: true });
    if (existsSync(TEST_GOALS_PATH)) {
      unlinkSync(TEST_GOALS_PATH);
    }
    GoalStore = await import("../GoalStore");
    GoalAlignmentEngine = await import("../GoalAlignmentEngine");
  });

  afterEach(() => {
    if (existsSync(TEST_GOALS_PATH)) {
      try {
        unlinkSync(TEST_GOALS_PATH);
      } catch {
        // Ignore
      }
    }
  });

  // ========================================================================
  // 1. scoreEvent - single event against goals
  // ========================================================================
  describe("scoreEvent", () => {
    it("should return 0 score when no goals exist", async () => {
      const event = makeEvent({ title: "Random Meeting" });
      const result = await GoalAlignmentEngine.scoreEvent(event);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.overallScore).toBe(0);
        expect(result.data.alignments.length).toBe(0);
      }
    });

    it("should score event matching a goal keyword", async () => {
      await GoalStore.addGoal("Improve customer retention", GoalLevel.Quarterly);

      const event = makeEvent({ title: "Customer retention analysis meeting" });
      const result = await GoalAlignmentEngine.scoreEvent(event);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.overallScore).toBeGreaterThan(0);
        expect(result.data.alignments.length).toBeGreaterThan(0);
        expect(result.data.alignments[0].matchedKeywords.length).toBeGreaterThan(0);
      }
    });

    it("should return 0 for event not matching any goals", async () => {
      await GoalStore.addGoal("Learn piano", GoalLevel.Weekly);

      const event = makeEvent({ title: "Team standup" });
      const result = await GoalAlignmentEngine.scoreEvent(event);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.overallScore).toBe(0);
        expect(result.data.alignments.length).toBe(0);
      }
    });

    it("should match against event description too", async () => {
      await GoalStore.addGoal("Exercise and fitness", GoalLevel.Weekly);

      const event = makeEvent({
        title: "Morning Block",
        description: "30 minute exercise routine",
      });
      const result = await GoalAlignmentEngine.scoreEvent(event);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.overallScore).toBeGreaterThan(0);
      }
    });

    it("should score higher for more keyword matches", async () => {
      await GoalStore.addGoal(
        "Write blog posts about machine learning",
        GoalLevel.Quarterly
      );

      const eventFew = makeEvent({ title: "Writing session" });
      const eventMany = makeEvent({
        title: "Writing blog post about machine learning",
      });

      const resultFew = await GoalAlignmentEngine.scoreEvent(eventFew);
      const resultMany = await GoalAlignmentEngine.scoreEvent(eventMany);

      expect(resultFew.success).toBe(true);
      expect(resultMany.success).toBe(true);

      if (resultFew.success && resultMany.success) {
        expect(resultMany.data.overallScore).toBeGreaterThan(
          resultFew.data.overallScore
        );
      }
    });

    it("should match against multiple goals", async () => {
      await GoalStore.addGoal("Improve writing skills", GoalLevel.Quarterly);
      await GoalStore.addGoal(
        "Build engineering blog",
        GoalLevel.Quarterly
      );

      const event = makeEvent({
        title: "Writing session for engineering blog",
      });
      const result = await GoalAlignmentEngine.scoreEvent(event);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.alignments.length).toBe(2);
      }
    });

    it("should sort alignments by score descending", async () => {
      await GoalStore.addGoal("Learn piano and music theory", GoalLevel.Weekly);
      await GoalStore.addGoal("Practice piano daily", GoalLevel.Weekly);

      const event = makeEvent({
        title: "Piano practice session with music theory",
      });
      const result = await GoalAlignmentEngine.scoreEvent(event);
      expect(result.success).toBe(true);
      if (result.success && result.data.alignments.length >= 2) {
        expect(result.data.alignments[0].score).toBeGreaterThanOrEqual(
          result.data.alignments[1].score
        );
      }
    });

    it("should include goal title and ID in alignment", async () => {
      const addResult = await GoalStore.addGoal("Exercise routine", GoalLevel.Weekly);
      expect(addResult.success).toBe(true);
      if (!addResult.success) return;

      const event = makeEvent({ title: "Exercise routine" });
      const result = await GoalAlignmentEngine.scoreEvent(event);
      expect(result.success).toBe(true);
      if (result.success && result.data.alignments.length > 0) {
        expect(result.data.alignments[0].goalId).toBe(addResult.data.id);
        expect(result.data.alignments[0].goalTitle).toBe("Exercise routine");
      }
    });

    it("should cap score at 100", async () => {
      // Create a goal with many keywords that all match
      await GoalStore.addGoal(
        "Complete quarterly financial review report analysis",
        GoalLevel.Quarterly
      );

      const event = makeEvent({
        title: "Complete quarterly financial review report analysis discussion",
      });
      const result = await GoalAlignmentEngine.scoreEvent(event);
      expect(result.success).toBe(true);
      if (result.success && result.data.alignments.length > 0) {
        expect(result.data.alignments[0].score).toBeLessThanOrEqual(100);
      }
    });
  });

  // ========================================================================
  // 2. scoreEvents - multi-event scoring
  // ========================================================================
  describe("scoreEvents", () => {
    it("should score multiple events", async () => {
      await GoalStore.addGoal("Exercise and fitness", GoalLevel.Weekly);

      const events = [
        makeEvent({ title: "Morning exercise" }),
        makeEvent({ title: "Team standup" }),
        makeEvent({ title: "Fitness class" }),
      ];

      const result = await GoalAlignmentEngine.scoreEvents(events);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.alignments.length).toBe(3);
      }
    });

    it("should compute aggregate score across all events", async () => {
      await GoalStore.addGoal("Exercise", GoalLevel.Weekly);

      const events = [
        makeEvent({ title: "Exercise session" }),
        makeEvent({ title: "Team meeting" }),
      ];

      const result = await GoalAlignmentEngine.scoreEvents(events);
      expect(result.success).toBe(true);
      if (result.success) {
        // Aggregate should be average of all event scores
        expect(result.data.aggregateScore).toBeGreaterThanOrEqual(0);
        expect(result.data.aggregateScore).toBeLessThanOrEqual(100);
      }
    });

    it("should return 0 aggregate when no events", async () => {
      await GoalStore.addGoal("Test Goal", GoalLevel.Weekly);

      const result = await GoalAlignmentEngine.scoreEvents([]);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.aggregateScore).toBe(0);
        expect(result.data.alignments.length).toBe(0);
      }
    });

    it("should handle events with no goal matches", async () => {
      await GoalStore.addGoal("Piano practice", GoalLevel.Weekly);

      const events = [
        makeEvent({ title: "Dentist appointment" }),
        makeEvent({ title: "Grocery shopping" }),
      ];

      const result = await GoalAlignmentEngine.scoreEvents(events);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.aggregateScore).toBe(0);
      }
    });

    it("should compute correct average for mixed scores", async () => {
      await GoalStore.addGoal("Writing practice", GoalLevel.Weekly);

      const events = [
        makeEvent({ title: "Writing practice session" }), // should match
        makeEvent({ title: "Dental checkup" }), // no match
      ];

      const result = await GoalAlignmentEngine.scoreEvents(events);
      expect(result.success).toBe(true);
      if (result.success) {
        // Aggregate is average: (score + 0) / 2
        const writingScore =
          result.data.alignments.find((a) => a.event.title.includes("Writing"))
            ?.overallScore || 0;
        const expected = Math.round(writingScore / 2);
        expect(result.data.aggregateScore).toBe(expected);
      }
    });
  });

  // ========================================================================
  // 3. checkAlignment - propose event alignment
  // ========================================================================
  describe("checkAlignment", () => {
    it("should check alignment for a proposed event title", async () => {
      await GoalStore.addGoal("Learn TypeScript", GoalLevel.Quarterly);

      const result = await GoalAlignmentEngine.checkAlignment(
        "TypeScript tutorial session"
      );
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.length).toBeGreaterThan(0);
        expect(result.data[0].matchedKeywords).toContain("typescript");
      }
    });

    it("should return empty for non-matching title", async () => {
      await GoalStore.addGoal("Learn piano", GoalLevel.Weekly);

      const result = await GoalAlignmentEngine.checkAlignment("Dentist visit");
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.length).toBe(0);
      }
    });

    it("should check alignment with description", async () => {
      await GoalStore.addGoal("Meditation practice", GoalLevel.Weekly);

      const result = await GoalAlignmentEngine.checkAlignment(
        "Morning block",
        "Guided meditation and mindfulness practice"
      );
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.length).toBeGreaterThan(0);
      }
    });

    it("should sort results by score descending", async () => {
      await GoalStore.addGoal("Learn piano", GoalLevel.Weekly);
      await GoalStore.addGoal(
        "Practice piano scales and music",
        GoalLevel.Weekly
      );

      const result = await GoalAlignmentEngine.checkAlignment(
        "Piano scales practice session with music theory"
      );
      expect(result.success).toBe(true);
      if (result.success && result.data.length >= 2) {
        expect(result.data[0].score).toBeGreaterThanOrEqual(result.data[1].score);
      }
    });
  });

  // ========================================================================
  // 4. generateAlignmentReport
  // ========================================================================
  describe("generateAlignmentReport", () => {
    it("should generate a formatted report", async () => {
      await GoalStore.addGoal("Exercise", GoalLevel.Weekly);
      await GoalStore.addGoal("Writing", GoalLevel.Weekly);

      const events = [
        makeEvent({ title: "Morning exercise routine" }),
        makeEvent({ title: "Writing session" }),
        makeEvent({ title: "Dentist appointment" }),
      ];

      const result = await GoalAlignmentEngine.generateAlignmentReport(events);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toContain("Goal Alignment Report");
        expect(result.data).toContain("Overall Alignment:");
        expect(result.data).toContain("Events Analyzed: 3");
      }
    });

    it("should list aligned events in report", async () => {
      await GoalStore.addGoal("Exercise routine", GoalLevel.Weekly);

      const events = [makeEvent({ title: "Exercise routine session" })];

      const result = await GoalAlignmentEngine.generateAlignmentReport(events);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toContain("Top Aligned Events:");
        expect(result.data).toContain("Exercise routine session");
      }
    });

    it("should list unaligned events in report", async () => {
      await GoalStore.addGoal("Piano practice", GoalLevel.Weekly);

      const events = [
        makeEvent({ title: "Dental checkup" }),
        makeEvent({ title: "Grocery shopping" }),
      ];

      const result = await GoalAlignmentEngine.generateAlignmentReport(events);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toContain("Unaligned Events");
        expect(result.data).toContain("Dental checkup");
      }
    });

    it("should handle empty events array", async () => {
      const result = await GoalAlignmentEngine.generateAlignmentReport([]);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toContain("Events Analyzed: 0");
      }
    });

    it("should show aligned and unaligned counts", async () => {
      await GoalStore.addGoal("Exercise", GoalLevel.Weekly);

      const events = [
        makeEvent({ title: "Exercise class" }),
        makeEvent({ title: "Random meeting" }),
      ];

      const result = await GoalAlignmentEngine.generateAlignmentReport(events);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toContain("Aligned Events:");
        expect(result.data).toContain("Unaligned Events:");
      }
    });
  });

  // ========================================================================
  // 5. Scoring accuracy - specific keyword matching scenarios
  // ========================================================================
  describe("scoring accuracy", () => {
    it("should match partial keyword overlap", async () => {
      await GoalStore.addGoal(
        "Improve customer satisfaction scores",
        GoalLevel.Quarterly
      );

      const event = makeEvent({
        title: "Customer feedback review",
      });
      const result = await GoalAlignmentEngine.scoreEvent(event);
      expect(result.success).toBe(true);
      if (result.success) {
        // "customer" matches
        expect(result.data.overallScore).toBeGreaterThan(0);
      }
    });

    it("should be case-insensitive", async () => {
      await GoalStore.addGoal("EXERCISE DAILY", GoalLevel.Weekly);

      const event = makeEvent({ title: "morning exercise" });
      const result = await GoalAlignmentEngine.scoreEvent(event);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.overallScore).toBeGreaterThan(0);
      }
    });

    it("should match goal title words even if not in keyword list", async () => {
      // The engine also checks goalText words (from title) against event text
      await GoalStore.addGoal("Ship product launch", GoalLevel.Quarterly);

      const event = makeEvent({ title: "Product launch planning" });
      const result = await GoalAlignmentEngine.scoreEvent(event);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.overallScore).toBeGreaterThan(0);
        expect(result.data.alignments[0].matchedKeywords.length).toBeGreaterThan(0);
      }
    });

    it("should not match single common word overlap", async () => {
      // Words like "the", "a" are filtered by keyword extraction
      await GoalStore.addGoal("The best quarterly plan", GoalLevel.Quarterly);

      // "meeting" does not appear in goal keywords or title words
      const event = makeEvent({ title: "Daily meeting" });
      const result = await GoalAlignmentEngine.scoreEvent(event);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.overallScore).toBe(0);
      }
    });

    it("should handle goals with no extractable keywords gracefully", async () => {
      // Title with only stop words and short words
      await GoalStore.addGoal("Be on it", GoalLevel.Weekly);

      const event = makeEvent({ title: "Some random event" });
      const result = await GoalAlignmentEngine.scoreEvent(event);
      expect(result.success).toBe(true);
      // Should not crash, just low/zero score
      if (result.success) {
        expect(result.data.overallScore).toBeGreaterThanOrEqual(0);
      }
    });
  });

  // ========================================================================
  // 6. No raw file I/O compliance
  // ========================================================================
  describe("no raw file I/O compliance", () => {
    it("should not use readFileSync in GoalAlignmentEngine source", async () => {
      const source = await Bun.file(
        `${process.env.HOME}/.claude/skills/CalendarAssistant/Tools/GoalAlignmentEngine.ts`
      ).text();
      expect(source).not.toContain("readFileSync");
    });

    it("should not use writeFileSync in GoalAlignmentEngine source", async () => {
      const source = await Bun.file(
        `${process.env.HOME}/.claude/skills/CalendarAssistant/Tools/GoalAlignmentEngine.ts`
      ).text();
      expect(source).not.toContain("writeFileSync");
    });

    it("should not use raw fetch in GoalAlignmentEngine source", async () => {
      const source = await Bun.file(
        `${process.env.HOME}/.claude/skills/CalendarAssistant/Tools/GoalAlignmentEngine.ts`
      ).text();
      // Should not have raw fetch( calls
      expect(source).not.toMatch(/\bfetch\s*\(/);
    });
  });
});
