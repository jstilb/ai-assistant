#!/usr/bin/env bun
/**
 * EveningCheckinGenerator.test.ts - Tests for evening check-in generator
 *
 * Tests the core logic: planned vs completed comparison, positive-first
 * formatting, habit prompt generation, and delivery orchestration.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { join } from "path";
import { existsSync, mkdirSync, writeFileSync, unlinkSync } from "fs";

const KAYA_HOME = process.env.KAYA_DIR || join(process.env.HOME!, ".claude");
const BRIEFINGS_DIR = join(KAYA_HOME, "MEMORY", "BRIEFINGS");
const TEST_DATE = "2099-12-31";

// ============================================================================
// Test: Planned priorities file reading
// ============================================================================

describe("EveningCheckinGenerator", () => {
  const testPlannedPath = join(BRIEFINGS_DIR, `planned-priorities-${TEST_DATE}.json`);
  const testEveningPath = join(BRIEFINGS_DIR, `evening-${TEST_DATE}.md`);

  const samplePlanned = {
    date: TEST_DATE,
    generatedAt: "2099-12-31T08:00:00.000Z",
    priorities: [
      {
        rank: 1,
        title: "Review PR for auth module",
        source: "lucidtasks",
        urgency: "due-today",
        timeEstimate: "15-30 min",
        alignmentTag: "M5/G28 (AI Tools)",
        taskId: "111111",
      },
      {
        rank: 2,
        title: "Write blog post draft",
        source: "lucidtasks",
        urgency: "goal-aligned",
        timeEstimate: "60-90 min",
        alignmentTag: "M2 (Creative)",
        taskId: "222222",
      },
      {
        rank: 3,
        title: "Book hotel in Sedona",
        source: "lucidtasks",
        urgency: "goal-aligned",
        timeEstimate: "30-60 min",
        alignmentTag: "M0 (Adventurer)",
        taskId: "333333",
      },
    ],
    availableHours: 6,
    calendarEvents: 2,
  };

  beforeEach(() => {
    // Ensure test directory exists
    if (!existsSync(BRIEFINGS_DIR)) {
      mkdirSync(BRIEFINGS_DIR, { recursive: true });
    }
  });

  afterEach(() => {
    // Cleanup test files
    try { unlinkSync(testPlannedPath); } catch {}
    try { unlinkSync(testEveningPath); } catch {}
  });

  test("reads planned priorities JSON correctly", async () => {
    writeFileSync(testPlannedPath, JSON.stringify(samplePlanned, null, 2));

    // Import the module
    const { readPlannedPriorities } = await import("./EveningCheckinGenerator.ts");
    const result = readPlannedPriorities(TEST_DATE);

    expect(result).not.toBeNull();
    expect(result!.date).toBe(TEST_DATE);
    expect(result!.priorities).toHaveLength(3);
    expect(result!.priorities[0].title).toBe("Review PR for auth module");
  });

  test("returns null when planned priorities file does not exist", async () => {
    const { readPlannedPriorities } = await import("./EveningCheckinGenerator.ts");
    const result = readPlannedPriorities("1900-01-01");

    expect(result).toBeNull();
  });

  // ============================================================================
  // Test: Completion comparison logic
  // ============================================================================

  test("calculateCompletion matches completed tasks against planned priorities", async () => {
    const { calculateCompletion } = await import("./EveningCheckinGenerator.ts");

    const planned = samplePlanned.priorities;
    const completedTasks = [
      { name: "Review PR for auth module", gid: "111111", completed: true },
      { name: "Some other task not planned", gid: "999999", completed: true },
    ];

    const result = calculateCompletion(planned, completedTasks);

    expect(result.completedCount).toBe(1);
    expect(result.totalPlanned).toBe(3);
    expect(result.completionRate).toBeCloseTo(33.3, 0);
    expect(result.completed).toHaveLength(1);
    expect(result.completed[0].title).toBe("Review PR for auth module");
    expect(result.incomplete).toHaveLength(2);
    expect(result.bonusCompleted).toHaveLength(1);
    expect(result.bonusCompleted[0].name).toBe("Some other task not planned");
  });

  test("calculateCompletion handles zero planned priorities", async () => {
    const { calculateCompletion } = await import("./EveningCheckinGenerator.ts");

    const result = calculateCompletion([], []);

    expect(result.completedCount).toBe(0);
    expect(result.totalPlanned).toBe(0);
    expect(result.completionRate).toBe(0);
  });

  test("calculateCompletion matches by taskId when title differs", async () => {
    const { calculateCompletion } = await import("./EveningCheckinGenerator.ts");

    const planned = samplePlanned.priorities;
    const completedTasks = [
      { name: "PR auth module (renamed)", gid: "111111", completed: true },
    ];

    const result = calculateCompletion(planned, completedTasks);
    expect(result.completedCount).toBe(1);
  });

  // ============================================================================
  // Test: Positive-first formatting
  // ============================================================================

  test("formatEveningSummary puts accomplishments first", async () => {
    const { formatEveningSummary } = await import("./EveningCheckinGenerator.ts");

    const completionData = {
      completedCount: 2,
      totalPlanned: 3,
      completionRate: 66.7,
      completed: [
        { title: "Review PR for auth module", alignmentTag: "M5/G28 (AI Tools)" },
        { title: "Book hotel in Sedona", alignmentTag: "M0 (Adventurer)" },
      ],
      incomplete: [
        { title: "Write blog post draft", alignmentTag: "M2 (Creative)" },
      ],
      bonusCompleted: [],
    };

    const markdown = formatEveningSummary(TEST_DATE, completionData);

    // Accomplishments section should appear before incomplete
    const accomplishmentIndex = markdown.indexOf("Accomplishments");
    const incompleteIndex = markdown.indexOf("Tomorrow Candidates");

    expect(accomplishmentIndex).toBeGreaterThan(-1);
    expect(incompleteIndex).toBeGreaterThan(-1);
    expect(accomplishmentIndex).toBeLessThan(incompleteIndex);

    // Should contain completion rate
    expect(markdown).toContain("66.7%");
    // Should mention completed tasks
    expect(markdown).toContain("Review PR for auth module");
  });

  test("formatEveningSummary includes bonus tasks section", async () => {
    const { formatEveningSummary } = await import("./EveningCheckinGenerator.ts");

    const completionData = {
      completedCount: 1,
      totalPlanned: 1,
      completionRate: 100,
      completed: [
        { title: "Review PR for auth module", alignmentTag: "M5/G28 (AI Tools)" },
      ],
      incomplete: [],
      bonusCompleted: [
        { name: "Fixed CI pipeline", gid: "444444" },
      ],
    };

    const markdown = formatEveningSummary(TEST_DATE, completionData);

    expect(markdown).toContain("Bonus");
    expect(markdown).toContain("Fixed CI pipeline");
  });

  // ============================================================================
  // Test: Voice line generation
  // ============================================================================

  test("generateVoiceLine stays under 16 words", async () => {
    const { generateVoiceLine } = await import("./EveningCheckinGenerator.ts");

    const voiceLine = generateVoiceLine({
      completedCount: 2,
      totalPlanned: 3,
      completionRate: 66.7,
      completed: [],
      incomplete: [],
      bonusCompleted: [],
    });

    const words = voiceLine.split(/\s+/).length;
    expect(words).toBeLessThanOrEqual(16);
    expect(voiceLine.length).toBeGreaterThan(0);
  });

  // ============================================================================
  // Test: Evening summary file write
  // ============================================================================

  test("writeEveningSummary creates markdown file", async () => {
    const { writeEveningSummary } = await import("./EveningCheckinGenerator.ts");

    const markdown = "# Evening Check-in\n\nTest content";
    writeEveningSummary(TEST_DATE, markdown);

    expect(existsSync(testEveningPath)).toBe(true);

    const content = await Bun.file(testEveningPath).text();
    expect(content).toContain("Test content");
  });
});
