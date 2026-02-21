/**
 * Goal Store Test Suite
 *
 * Tests CRUD operations for hierarchical goals (Yearly -> Quarterly -> Weekly)
 * persisted via StateManager. Verifies no raw JSON.parse/readFileSync usage.
 *
 * ISC #4: CRUD hierarchy, persistence survives restart, no raw file I/O
 *
 * @module goal-store.test
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, unlinkSync, mkdirSync } from "fs";
import { dirname } from "path";
import type { Goal, Result, CalendarError } from "../types";
import { GoalLevel } from "../types";

// ==========================================================================
// We test GoalStore by importing it directly. Since GoalStore uses
// StateManager internally, we need to point it to a test-specific file.
// We set the KAYA_DIR env var to redirect to a temp location.
// ==========================================================================

const TEST_DIR = `/tmp/calendar-assistant-plus-store-test-${process.pid}`;
const TEST_GOALS_PATH = `${TEST_DIR}/skills/CalendarAssistant/data/goals.json`;

// Set test environment before imports
process.env.KAYA_DIR = TEST_DIR;

// Dynamic import to pick up the env var
let GoalStore: typeof import("../GoalStore");

// ==========================================================================
// Since GoalStore references createStateManager at module load time with the
// path derived from KAYA_DIR, and we've set KAYA_DIR before import, the
// StateManager will write to our test location.
//
// However, since the module may have already been loaded by Bun's module
// system, we test the logic by directly testing the public API functions.
// ==========================================================================

describe("GoalStore", () => {
  beforeEach(async () => {
    // Ensure test directory exists
    mkdirSync(dirname(TEST_GOALS_PATH), { recursive: true });
    // Clean up any previous test data
    if (existsSync(TEST_GOALS_PATH)) {
      unlinkSync(TEST_GOALS_PATH);
    }
    // Dynamically import to get fresh module state
    GoalStore = await import("../GoalStore");
  });

  afterEach(() => {
    if (existsSync(TEST_GOALS_PATH)) {
      try {
        unlinkSync(TEST_GOALS_PATH);
      } catch {
        // Ignore cleanup errors
      }
    }
  });

  // ========================================================================
  // 1. addGoal - basic creation
  // ========================================================================
  describe("addGoal", () => {
    it("should create a yearly goal with auto-generated id", async () => {
      const result = await GoalStore.addGoal("Launch Product", GoalLevel.Yearly);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.id).toMatch(/^goal_/);
        expect(result.data.title).toBe("Launch Product");
        expect(result.data.level).toBe(GoalLevel.Yearly);
        expect(result.data.status).toBe("active");
        expect(result.data.keywords.length).toBeGreaterThan(0);
        expect(result.data.createdAt).toBeTruthy();
        expect(result.data.updatedAt).toBeTruthy();
      }
    });

    it("should create a quarterly goal", async () => {
      const result = await GoalStore.addGoal(
        "Complete Q1 Planning",
        GoalLevel.Quarterly
      );
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.level).toBe(GoalLevel.Quarterly);
      }
    });

    it("should create a weekly goal", async () => {
      const result = await GoalStore.addGoal(
        "Write blog post",
        GoalLevel.Weekly
      );
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.level).toBe(GoalLevel.Weekly);
      }
    });

    it("should create a goal with a parent reference", async () => {
      const parentResult = await GoalStore.addGoal(
        "Yearly Revenue Target",
        GoalLevel.Yearly
      );
      expect(parentResult.success).toBe(true);
      if (!parentResult.success) return;

      const childResult = await GoalStore.addGoal(
        "Q1 Revenue Sprint",
        GoalLevel.Quarterly,
        parentResult.data.id
      );
      expect(childResult.success).toBe(true);
      if (childResult.success) {
        expect(childResult.data.parentId).toBe(parentResult.data.id);
      }
    });

    it("should create a goal with target hours per week", async () => {
      const result = await GoalStore.addGoal(
        "Exercise Routine",
        GoalLevel.Weekly,
        undefined,
        5
      );
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.targetHoursPerWeek).toBe(5);
      }
    });

    it("should extract keywords from goal title", async () => {
      const result = await GoalStore.addGoal(
        "Complete the quarterly financial review",
        GoalLevel.Quarterly
      );
      expect(result.success).toBe(true);
      if (result.success) {
        // Should filter stop words ("the") and short words
        expect(result.data.keywords).toContain("complete");
        expect(result.data.keywords).toContain("quarterly");
        expect(result.data.keywords).toContain("financial");
        expect(result.data.keywords).toContain("review");
        expect(result.data.keywords).not.toContain("the");
      }
    });

    it("should generate unique IDs for multiple goals", async () => {
      const ids: string[] = [];
      for (let i = 0; i < 5; i++) {
        const result = await GoalStore.addGoal(`Goal ${i}`, GoalLevel.Weekly);
        expect(result.success).toBe(true);
        if (result.success) {
          ids.push(result.data.id);
        }
      }
      const uniqueIds = new Set(ids);
      expect(uniqueIds.size).toBe(5);
    });
  });

  // ========================================================================
  // 2. getActiveGoals
  // ========================================================================
  describe("getActiveGoals", () => {
    it("should return empty array when no goals exist", async () => {
      const result = await GoalStore.getActiveGoals();
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toEqual([]);
      }
    });

    it("should return all active goals", async () => {
      await GoalStore.addGoal("Goal A", GoalLevel.Yearly);
      await GoalStore.addGoal("Goal B", GoalLevel.Quarterly);
      await GoalStore.addGoal("Goal C", GoalLevel.Weekly);

      const result = await GoalStore.getActiveGoals();
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.length).toBe(3);
      }
    });

    it("should not return completed goals", async () => {
      const addResult = await GoalStore.addGoal("Done Goal", GoalLevel.Weekly);
      expect(addResult.success).toBe(true);
      if (!addResult.success) return;

      await GoalStore.updateGoalStatus(addResult.data.id, "completed");

      const result = await GoalStore.getActiveGoals();
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.length).toBe(0);
      }
    });

    it("should not return paused goals", async () => {
      const addResult = await GoalStore.addGoal("Paused Goal", GoalLevel.Weekly);
      expect(addResult.success).toBe(true);
      if (!addResult.success) return;

      await GoalStore.updateGoalStatus(addResult.data.id, "paused");

      const result = await GoalStore.getActiveGoals();
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.length).toBe(0);
      }
    });
  });

  // ========================================================================
  // 3. getGoalsByLevel
  // ========================================================================
  describe("getGoalsByLevel", () => {
    it("should filter by yearly level", async () => {
      await GoalStore.addGoal("Yearly 1", GoalLevel.Yearly);
      await GoalStore.addGoal("Quarterly 1", GoalLevel.Quarterly);
      await GoalStore.addGoal("Weekly 1", GoalLevel.Weekly);

      const result = await GoalStore.getGoalsByLevel(GoalLevel.Yearly);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.length).toBe(1);
        expect(result.data[0].level).toBe(GoalLevel.Yearly);
      }
    });

    it("should filter by quarterly level", async () => {
      await GoalStore.addGoal("Y1", GoalLevel.Yearly);
      await GoalStore.addGoal("Q1", GoalLevel.Quarterly);
      await GoalStore.addGoal("Q2", GoalLevel.Quarterly);
      await GoalStore.addGoal("W1", GoalLevel.Weekly);

      const result = await GoalStore.getGoalsByLevel(GoalLevel.Quarterly);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.length).toBe(2);
      }
    });

    it("should return empty when no goals at level", async () => {
      await GoalStore.addGoal("Y1", GoalLevel.Yearly);

      const result = await GoalStore.getGoalsByLevel(GoalLevel.Weekly);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.length).toBe(0);
      }
    });

    it("should only return active goals at level", async () => {
      const add1 = await GoalStore.addGoal("W1", GoalLevel.Weekly);
      await GoalStore.addGoal("W2", GoalLevel.Weekly);

      if (add1.success) {
        await GoalStore.updateGoalStatus(add1.data.id, "completed");
      }

      const result = await GoalStore.getGoalsByLevel(GoalLevel.Weekly);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.length).toBe(1);
        expect(result.data[0].title).toBe("W2");
      }
    });
  });

  // ========================================================================
  // 4. getChildGoals
  // ========================================================================
  describe("getChildGoals", () => {
    it("should return children of a parent goal", async () => {
      const parent = await GoalStore.addGoal("Parent Goal", GoalLevel.Yearly);
      expect(parent.success).toBe(true);
      if (!parent.success) return;

      await GoalStore.addGoal("Child A", GoalLevel.Quarterly, parent.data.id);
      await GoalStore.addGoal("Child B", GoalLevel.Quarterly, parent.data.id);
      await GoalStore.addGoal("Unrelated", GoalLevel.Quarterly);

      const result = await GoalStore.getChildGoals(parent.data.id);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.length).toBe(2);
        expect(result.data.every((g) => g.parentId === parent.data.id)).toBe(true);
      }
    });

    it("should return empty for goal with no children", async () => {
      const result = await GoalStore.getChildGoals("nonexistent_id");
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.length).toBe(0);
      }
    });

    it("should not return completed children", async () => {
      const parent = await GoalStore.addGoal("Parent", GoalLevel.Yearly);
      if (!parent.success) return;

      const child = await GoalStore.addGoal(
        "Child",
        GoalLevel.Quarterly,
        parent.data.id
      );
      if (!child.success) return;

      await GoalStore.updateGoalStatus(child.data.id, "completed");

      const result = await GoalStore.getChildGoals(parent.data.id);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.length).toBe(0);
      }
    });
  });

  // ========================================================================
  // 5. updateGoalStatus
  // ========================================================================
  describe("updateGoalStatus", () => {
    it("should mark a goal as completed", async () => {
      const add = await GoalStore.addGoal("Test Goal", GoalLevel.Weekly);
      expect(add.success).toBe(true);
      if (!add.success) return;

      // Small delay to ensure updatedAt timestamp differs
      await new Promise((r) => setTimeout(r, 10));

      const result = await GoalStore.updateGoalStatus(add.data.id, "completed");
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.status).toBe("completed");
        // updatedAt should be newer than the original
        expect(
          new Date(result.data.updatedAt).getTime()
        ).toBeGreaterThanOrEqual(new Date(add.data.createdAt).getTime());
      }
    });

    it("should mark a goal as paused", async () => {
      const add = await GoalStore.addGoal("Test Goal", GoalLevel.Weekly);
      if (!add.success) return;

      const result = await GoalStore.updateGoalStatus(add.data.id, "paused");
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.status).toBe("paused");
      }
    });

    it("should reactivate a paused goal", async () => {
      const add = await GoalStore.addGoal("Test Goal", GoalLevel.Weekly);
      if (!add.success) return;

      await GoalStore.updateGoalStatus(add.data.id, "paused");
      const result = await GoalStore.updateGoalStatus(add.data.id, "active");
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.status).toBe("active");
      }
    });

    it("should return error for nonexistent goal", async () => {
      const result = await GoalStore.updateGoalStatus(
        "nonexistent_goal_id",
        "completed"
      );
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe("VALIDATION");
        expect(result.error.message).toContain("not found");
      }
    });
  });

  // ========================================================================
  // 6. deleteGoal
  // ========================================================================
  describe("deleteGoal", () => {
    it("should delete an existing goal", async () => {
      const add = await GoalStore.addGoal("To Delete", GoalLevel.Weekly);
      expect(add.success).toBe(true);
      if (!add.success) return;

      const result = await GoalStore.deleteGoal(add.data.id);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.deleted).toBe(true);
      }

      // Verify it's gone
      const active = await GoalStore.getActiveGoals();
      expect(active.success).toBe(true);
      if (active.success) {
        expect(active.data.find((g) => g.id === add.data.id)).toBeUndefined();
      }
    });

    it("should succeed silently for nonexistent goal", async () => {
      // Deleting a non-existent goal should succeed (idempotent)
      const result = await GoalStore.deleteGoal("nonexistent_id");
      expect(result.success).toBe(true);
    });

    it("should not affect other goals when deleting", async () => {
      const add1 = await GoalStore.addGoal("Keep Me", GoalLevel.Yearly);
      const add2 = await GoalStore.addGoal("Delete Me", GoalLevel.Weekly);
      expect(add1.success).toBe(true);
      expect(add2.success).toBe(true);
      if (!add1.success || !add2.success) return;

      await GoalStore.deleteGoal(add2.data.id);

      const active = await GoalStore.getActiveGoals();
      expect(active.success).toBe(true);
      if (active.success) {
        expect(active.data.length).toBe(1);
        expect(active.data[0].title).toBe("Keep Me");
      }
    });
  });

  // ========================================================================
  // 7. getGoalHierarchy
  // ========================================================================
  describe("getGoalHierarchy", () => {
    it("should return empty hierarchy when no goals", async () => {
      const result = await GoalStore.getGoalHierarchy();
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.yearly).toEqual([]);
        expect(result.data.quarterly).toEqual([]);
        expect(result.data.weekly).toEqual([]);
      }
    });

    it("should organize goals into hierarchy", async () => {
      await GoalStore.addGoal("Y1", GoalLevel.Yearly);
      await GoalStore.addGoal("Y2", GoalLevel.Yearly);
      await GoalStore.addGoal("Q1", GoalLevel.Quarterly);
      await GoalStore.addGoal("Q2", GoalLevel.Quarterly);
      await GoalStore.addGoal("Q3", GoalLevel.Quarterly);
      await GoalStore.addGoal("W1", GoalLevel.Weekly);
      await GoalStore.addGoal("W2", GoalLevel.Weekly);

      const result = await GoalStore.getGoalHierarchy();
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.yearly.length).toBe(2);
        expect(result.data.quarterly.length).toBe(3);
        expect(result.data.weekly.length).toBe(2);
      }
    });

    it("should exclude non-active goals from hierarchy", async () => {
      const y = await GoalStore.addGoal("Yearly Active", GoalLevel.Yearly);
      const q = await GoalStore.addGoal(
        "Quarterly Complete",
        GoalLevel.Quarterly
      );
      await GoalStore.addGoal("Weekly Active", GoalLevel.Weekly);

      if (q.success) {
        await GoalStore.updateGoalStatus(q.data.id, "completed");
      }

      const result = await GoalStore.getGoalHierarchy();
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.yearly.length).toBe(1);
        expect(result.data.quarterly.length).toBe(0);
        expect(result.data.weekly.length).toBe(1);
      }
    });
  });

  // ========================================================================
  // 8. Full hierarchy - 3 yearly, 6 quarterly, 12 weekly (ISC #4)
  // ========================================================================
  describe("full hierarchy creation (ISC #4)", () => {
    it("should support 3 yearly + 6 quarterly + 12 weekly goals", async () => {
      // Create 3 yearly goals
      const yearlyIds: string[] = [];
      for (let i = 1; i <= 3; i++) {
        const r = await GoalStore.addGoal(`Yearly Goal ${i}`, GoalLevel.Yearly);
        expect(r.success).toBe(true);
        if (r.success) yearlyIds.push(r.data.id);
      }

      // Create 6 quarterly goals (2 per yearly)
      const quarterlyIds: string[] = [];
      for (let i = 0; i < yearlyIds.length; i++) {
        for (let j = 1; j <= 2; j++) {
          const r = await GoalStore.addGoal(
            `Q${i * 2 + j} Goal`,
            GoalLevel.Quarterly,
            yearlyIds[i]
          );
          expect(r.success).toBe(true);
          if (r.success) quarterlyIds.push(r.data.id);
        }
      }

      // Create 12 weekly goals (2 per quarterly)
      for (let i = 0; i < quarterlyIds.length; i++) {
        for (let j = 1; j <= 2; j++) {
          const r = await GoalStore.addGoal(
            `Week ${i * 2 + j} Task`,
            GoalLevel.Weekly,
            quarterlyIds[i]
          );
          expect(r.success).toBe(true);
        }
      }

      // Verify hierarchy
      const hierarchy = await GoalStore.getGoalHierarchy();
      expect(hierarchy.success).toBe(true);
      if (hierarchy.success) {
        expect(hierarchy.data.yearly.length).toBe(3);
        expect(hierarchy.data.quarterly.length).toBe(6);
        expect(hierarchy.data.weekly.length).toBe(12);
      }

      // Verify parent-child relationships
      for (const yearlyId of yearlyIds) {
        const children = await GoalStore.getChildGoals(yearlyId);
        expect(children.success).toBe(true);
        if (children.success) {
          expect(children.data.length).toBe(2);
        }
      }

      for (const quarterlyId of quarterlyIds) {
        const children = await GoalStore.getChildGoals(quarterlyId);
        expect(children.success).toBe(true);
        if (children.success) {
          expect(children.data.length).toBe(2);
        }
      }
    });
  });

  // ========================================================================
  // 9. Keyword extraction
  // ========================================================================
  describe("keyword extraction", () => {
    it("should extract meaningful words from title", async () => {
      const result = await GoalStore.addGoal(
        "Improve customer retention metrics",
        GoalLevel.Quarterly
      );
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.keywords).toContain("improve");
        expect(result.data.keywords).toContain("customer");
        expect(result.data.keywords).toContain("retention");
        expect(result.data.keywords).toContain("metrics");
      }
    });

    it("should filter common stop words", async () => {
      const result = await GoalStore.addGoal(
        "The goal is to be the best at this",
        GoalLevel.Weekly
      );
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.keywords).not.toContain("the");
        expect(result.data.keywords).not.toContain("is");
        expect(result.data.keywords).not.toContain("to");
        expect(result.data.keywords).not.toContain("be");
        expect(result.data.keywords).not.toContain("at");
      }
    });

    it("should filter short words (<=2 chars)", async () => {
      const result = await GoalStore.addGoal(
        "Go to NY for AI conference",
        GoalLevel.Weekly
      );
      expect(result.success).toBe(true);
      if (result.success) {
        // "go" has 2 chars, should be filtered
        expect(result.data.keywords).not.toContain("go");
        // "ny" has 2 chars, filtered
        expect(result.data.keywords).not.toContain("ny");
        // "for" is a stop word
        expect(result.data.keywords).not.toContain("for");
        // "conference" should remain
        expect(result.data.keywords).toContain("conference");
      }
    });
  });

  // ========================================================================
  // 10. No raw file I/O (ISC #4 compliance)
  // ========================================================================
  describe("no raw file I/O compliance (ISC #4)", () => {
    it("should not import or call readFileSync in GoalStore source", async () => {
      const source = await Bun.file(
        `${process.env.HOME}/.claude/skills/CalendarAssistant/Tools/GoalStore.ts`
      ).text();
      // Strip comments before checking for actual usage
      const stripped = source.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
      expect(stripped).not.toMatch(/\breadFileSync\s*\(/);
      expect(stripped).not.toMatch(/import.*readFileSync/);
    });

    it("should not import or call writeFileSync in GoalStore source", async () => {
      const source = await Bun.file(
        `${process.env.HOME}/.claude/skills/CalendarAssistant/Tools/GoalStore.ts`
      ).text();
      const stripped = source.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
      expect(stripped).not.toMatch(/\bwriteFileSync\s*\(/);
      expect(stripped).not.toMatch(/import.*writeFileSync/);
    });

    it("should not use raw JSON.parse(readFileSync) pattern", async () => {
      const source = await Bun.file(
        `${process.env.HOME}/.claude/skills/CalendarAssistant/Tools/GoalStore.ts`
      ).text();
      expect(source).not.toMatch(/JSON\.parse\s*\(\s*readFileSync/);
    });

    it("should use StateManager (createStateManager import)", async () => {
      const source = await Bun.file(
        `${process.env.HOME}/.claude/skills/CalendarAssistant/Tools/GoalStore.ts`
      ).text();
      expect(source).toContain("createStateManager");
    });
  });
});
