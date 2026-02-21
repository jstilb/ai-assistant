/**
 * TaskManager.test.ts - Test Suite for TaskManager Helper Functions
 *
 * Tests for parseRelativeDate, formatTaskLine, formatTaskDetail, safeParseJSON,
 * and scoreTask.
 */

import { describe, it, expect } from "bun:test";
import {
  parseRelativeDate,
  formatTaskLine,
  formatTaskDetail,
  safeParseJSON,
  scoreTask,
} from "../TaskManager.ts";
import type { Task } from "../TaskDB.ts";

// ============================================================================
// parseRelativeDate
// ============================================================================

describe("parseRelativeDate", () => {
  it("parses 'today'", () => {
    const result = parseRelativeDate("today");
    const today = new Date().toISOString().split("T")[0];
    expect(result).toBe(today);
  });

  it("parses 'tomorrow'", () => {
    const result = parseRelativeDate("tomorrow");
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    expect(result).toBe(tomorrow.toISOString().split("T")[0]);
  });

  it("parses 'tmrw' (abbreviation for tomorrow)", () => {
    const result = parseRelativeDate("tmrw");
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    expect(result).toBe(tomorrow.toISOString().split("T")[0]);
  });

  it("parses day names (mon, tue, wed, thu, fri, sat, sun)", () => {
    const result = parseRelativeDate("fri");
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(result).not.toBeNull();
  });

  it("parses full day names (monday, tuesday, etc.)", () => {
    const result = parseRelativeDate("monday");
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(result).not.toBeNull();
  });

  it("parses wednesday specially", () => {
    const result = parseRelativeDate("wednesday");
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(result).not.toBeNull();
  });

  it("parses +Nd format (e.g., +3d)", () => {
    const result = parseRelativeDate("+3d");
    const expected = new Date();
    expected.setDate(expected.getDate() + 3);
    expect(result).toBe(expected.toISOString().split("T")[0]);
  });

  it("parses +Nw format (e.g., +2w)", () => {
    const result = parseRelativeDate("+2w");
    const expected = new Date();
    expected.setDate(expected.getDate() + 14);
    expect(result).toBe(expected.toISOString().split("T")[0]);
  });

  it("passes through ISO date format", () => {
    const result = parseRelativeDate("2026-03-15");
    expect(result).toBe("2026-03-15");
  });

  it("returns null for invalid input", () => {
    const result = parseRelativeDate("invalid date");
    expect(result).toBeNull();
  });

  it("is case-insensitive", () => {
    const result1 = parseRelativeDate("TODAY");
    const result2 = parseRelativeDate("FRI");
    const today = new Date().toISOString().split("T")[0];
    expect(result1).toBe(today);
    expect(result2).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

// ============================================================================
// formatTaskLine
// ============================================================================

describe("formatTaskLine", () => {
  const mockTask = (overrides: Partial<Task> = {}): Task => ({
    id: "t-abc123",
    title: "Test task",
    description: "",
    status: "inbox",
    priority: 2,
    energy_level: null,
    estimated_minutes: null,
    due_date: null,
    scheduled_date: null,
    project_id: null,
    goal_id: null,
    mission_id: null,
    parent_task_id: null,
    context_tags: "[]",
    labels: "[]",
    ai_priority_score: null,
    ai_reasoning: null,
    recurrence_rule: null,
    raw_input: null,
    asana_gid: null,
    queue_item_id: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    completed_at: null,
    ...overrides,
  });

  it("formats inbox status correctly", () => {
    const line = formatTaskLine(mockTask({ status: "inbox" }));
    expect(line).toContain("[ ]");
  });

  it("formats next status correctly", () => {
    const line = formatTaskLine(mockTask({ status: "next" }));
    expect(line).toContain("[>]");
  });

  it("formats in_progress status correctly", () => {
    const line = formatTaskLine(mockTask({ status: "in_progress" }));
    expect(line).toContain("[~]");
  });

  it("formats done status correctly", () => {
    const line = formatTaskLine(mockTask({ status: "done" }));
    expect(line).toContain("[x]");
  });

  it("formats high priority (1) correctly", () => {
    const line = formatTaskLine(mockTask({ priority: 1 }));
    expect(line).toContain("!!!");
  });

  it("formats normal priority (2) correctly", () => {
    const line = formatTaskLine(mockTask({ priority: 2 }));
    expect(line).toContain("!! ");
  });

  it("formats low priority (3) correctly", () => {
    const line = formatTaskLine(mockTask({ priority: 3 }));
    expect(line).toContain("!  ");
  });

  it("includes due date when present", () => {
    const line = formatTaskLine(mockTask({ due_date: "2026-02-15" }));
    expect(line).toContain("due:2026-02-15");
  });

  it("includes goal ID when present", () => {
    const line = formatTaskLine(mockTask({ goal_id: "G25" }));
    expect(line).toContain("G25");
  });

  it("includes project ID when present", () => {
    const line = formatTaskLine(mockTask({ project_id: "p-xyz789" }));
    expect(line).toContain("@p-xyz789");
  });

  it("includes task ID and title", () => {
    const line = formatTaskLine(mockTask());
    expect(line).toContain("t-abc123");
    expect(line).toContain("Test task");
  });
});

// ============================================================================
// formatTaskDetail
// ============================================================================

describe("formatTaskDetail", () => {
  const mockTask = (overrides: Partial<Task> = {}): Task => ({
    id: "t-abc123",
    title: "Test task",
    description: "",
    status: "inbox",
    priority: 2,
    energy_level: null,
    estimated_minutes: null,
    due_date: null,
    scheduled_date: null,
    project_id: null,
    goal_id: null,
    mission_id: null,
    parent_task_id: null,
    context_tags: "[]",
    labels: "[]",
    ai_priority_score: null,
    ai_reasoning: null,
    recurrence_rule: null,
    raw_input: null,
    asana_gid: null,
    queue_item_id: null,
    created_at: "2026-02-13T12:00:00Z",
    updated_at: "2026-02-13T12:00:00Z",
    completed_at: null,
    ...overrides,
  });

  it("includes all required fields", () => {
    const detail = formatTaskDetail(mockTask());
    expect(detail).toContain("ID:");
    expect(detail).toContain("Title:");
    expect(detail).toContain("Status:");
    expect(detail).toContain("Priority:");
    expect(detail).toContain("Created:");
    expect(detail).toContain("Updated:");
  });

  it("includes description when present", () => {
    const detail = formatTaskDetail(mockTask({ description: "Test description" }));
    expect(detail).toContain("Description: Test description");
  });

  it("includes due date when present", () => {
    const detail = formatTaskDetail(mockTask({ due_date: "2026-02-15" }));
    expect(detail).toContain("Due:         2026-02-15");
  });

  it("includes scheduled date when present", () => {
    const detail = formatTaskDetail(mockTask({ scheduled_date: "2026-02-14" }));
    expect(detail).toContain("Scheduled:   2026-02-14");
  });

  it("includes goal ID when present", () => {
    const detail = formatTaskDetail(mockTask({ goal_id: "G25" }));
    expect(detail).toContain("Goal:        G25");
  });

  it("includes mission ID when present", () => {
    const detail = formatTaskDetail(mockTask({ mission_id: "M6" }));
    expect(detail).toContain("Mission:     M6");
  });

  it("includes project ID when present", () => {
    const detail = formatTaskDetail(mockTask({ project_id: "p-xyz789" }));
    expect(detail).toContain("Project:     p-xyz789");
  });

  it("includes energy level when present", () => {
    const detail = formatTaskDetail(mockTask({ energy_level: "high" }));
    expect(detail).toContain("Energy:      high");
  });

  it("includes estimated minutes when present", () => {
    const detail = formatTaskDetail(mockTask({ estimated_minutes: 45 }));
    expect(detail).toContain("Est. Time:   45 min");
  });

  it("includes parent task ID when present", () => {
    const detail = formatTaskDetail(mockTask({ parent_task_id: "t-parent123" }));
    expect(detail).toContain("Parent:      t-parent123");
  });

  it("includes Asana GID when present", () => {
    const detail = formatTaskDetail(mockTask({ asana_gid: "1234567890" }));
    expect(detail).toContain("Asana GID:   1234567890");
  });

  it("includes AI priority score when present", () => {
    const detail = formatTaskDetail(mockTask({ ai_priority_score: 0.85 }));
    expect(detail).toContain("AI Score:    0.85");
  });

  it("includes AI reasoning when present", () => {
    const detail = formatTaskDetail(mockTask({ ai_reasoning: "High impact task" }));
    expect(detail).toContain("AI Reason:   High impact task");
  });

  it("includes context tags when present", () => {
    const detail = formatTaskDetail(mockTask({ context_tags: JSON.stringify(["work", "urgent"]) }));
    expect(detail).toContain("Tags:        work, urgent");
  });

  it("includes labels when present", () => {
    const detail = formatTaskDetail(mockTask({ labels: JSON.stringify(["important"]) }));
    expect(detail).toContain("Labels:      important");
  });

  it("includes completed_at when present", () => {
    const detail = formatTaskDetail(mockTask({ completed_at: "2026-02-13T14:00:00Z" }));
    expect(detail).toContain("Completed:   2026-02-13T14:00:00Z");
  });
});

// ============================================================================
// safeParseJSON
// ============================================================================

describe("safeParseJSON", () => {
  it("returns empty array for null input", () => {
    const result = safeParseJSON(null);
    expect(result).toEqual([]);
  });

  it("returns empty array for undefined input", () => {
    const result = safeParseJSON(undefined);
    expect(result).toEqual([]);
  });

  it("returns empty array for empty string", () => {
    const result = safeParseJSON("");
    expect(result).toEqual([]);
  });

  it("parses valid JSON array", () => {
    const result = safeParseJSON('["tag1", "tag2", "tag3"]');
    expect(result).toEqual(["tag1", "tag2", "tag3"]);
  });

  it("returns empty array for invalid JSON", () => {
    const result = safeParseJSON("not json");
    expect(result).toEqual([]);
  });

  it("returns empty array for non-array JSON", () => {
    const result = safeParseJSON('{"key": "value"}');
    expect(result).toEqual([]);
  });

  it("handles malformed JSON gracefully", () => {
    const result = safeParseJSON('["incomplete",');
    expect(result).toEqual([]);
  });
});

// ============================================================================
// parseRelativeDate - edge cases
// ============================================================================

describe("parseRelativeDate - edge cases", () => {
  it("handles whitespace padding", () => {
    const result = parseRelativeDate("  tomorrow  ");
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    expect(result).toBe(tomorrow.toISOString().split("T")[0]);
  });

  it("handles +0d (today via offset)", () => {
    const result = parseRelativeDate("+0d");
    const today = new Date().toISOString().split("T")[0];
    expect(result).toBe(today);
  });

  it("handles +1d", () => {
    const result = parseRelativeDate("+1d");
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    expect(result).toBe(tomorrow.toISOString().split("T")[0]);
  });

  it("wraps day name to next week when it matches today", () => {
    // Any day name that matches today should return 7 days from now (not today)
    const now = new Date();
    const dayNames = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
    const todayAbbrev = dayNames[now.getDay()];

    const result = parseRelativeDate(todayAbbrev);
    expect(result).not.toBeNull();

    // The result should be 7 days from now, not today
    const today = now.toISOString().split("T")[0];
    const sevenDaysLater = new Date(now);
    sevenDaysLater.setDate(sevenDaysLater.getDate() + 7);
    const sevenDaysStr = sevenDaysLater.toISOString().split("T")[0];

    expect(result).toBe(sevenDaysStr);
    expect(result).not.toBe(today);
  });
});

// ============================================================================
// formatTaskLine - edge cases
// ============================================================================

describe("formatTaskLine - edge cases", () => {
  const mockTask = (overrides: Partial<Task> = {}): Task => ({
    id: "t-abc123",
    title: "Test task",
    description: "",
    status: "inbox",
    priority: 2,
    energy_level: null,
    estimated_minutes: null,
    due_date: null,
    scheduled_date: null,
    project_id: null,
    goal_id: null,
    mission_id: null,
    parent_task_id: null,
    context_tags: "[]",
    labels: "[]",
    ai_priority_score: null,
    ai_reasoning: null,
    recurrence_rule: null,
    raw_input: null,
    asana_gid: null,
    queue_item_id: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    completed_at: null,
    started_at: null,
    ...overrides,
  });

  it("handles unknown status gracefully with fallback icon", () => {
    // Cast through unknown to bypass TypeScript's type checking for testing
    const task = mockTask({ status: "unknown_status" as unknown as Task["status"] });
    const line = formatTaskLine(task);
    expect(line).toContain("[?]");
  });

  it("handles priority value not in 1-3 with spaces fallback", () => {
    // Cast to test boundary behavior
    const task = mockTask({ priority: 99 as Task["priority"] });
    const line = formatTaskLine(task);
    expect(line).toContain("   ");
  });

  it("handles all metadata combined (due_date, goal_id, project_id)", () => {
    const task = mockTask({
      due_date: "2026-03-01",
      goal_id: "G25",
      project_id: "p-backend-xyz",
    });
    const line = formatTaskLine(task);
    expect(line).toContain("due:2026-03-01");
    expect(line).toContain("G25");
    expect(line).toContain("@p-backend-xyz");
  });
});

// ============================================================================
// scoreTask - 7-factor scoring algorithm
// ============================================================================

describe("scoreTask - scoring algorithm", () => {
  const makeTask = (overrides: Partial<Task> = {}): Task => ({
    id: "t-test-001",
    title: "Test",
    description: "",
    status: "next",
    priority: 2,
    energy_level: null,
    estimated_minutes: null,
    due_date: null,
    scheduled_date: null,
    project_id: null,
    goal_id: null,
    mission_id: null,
    parent_task_id: null,
    context_tags: "[]",
    labels: "[]",
    ai_priority_score: null,
    ai_reasoning: null,
    recurrence_rule: null,
    raw_input: null,
    asana_gid: null,
    queue_item_id: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    completed_at: null,
    started_at: null,
    ...overrides,
  });

  const baseCtx = {
    activeGoalIds: [],
    now: new Date(),
  };

  it("adds +50 for overdue tasks", () => {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const task = makeTask({ due_date: yesterday.toISOString().split("T")[0] });
    const result = scoreTask(task, baseCtx);
    expect(result.score).toBeGreaterThanOrEqual(50);
    expect(result.reasons.some((r) => r.includes("Overdue"))).toBe(true);
  });

  it("adds +30 for high priority (priority 1)", () => {
    const task = makeTask({ priority: 1 });
    const result = scoreTask(task, baseCtx);
    expect(result.score).toBeGreaterThanOrEqual(30);
    expect(result.reasons.some((r) => r.includes("High priority"))).toBe(true);
  });

  it("adds +15 for normal priority (priority 2)", () => {
    const task = makeTask({ priority: 2 });
    const result = scoreTask(task, baseCtx);
    expect(result.score).toBeGreaterThanOrEqual(15);
    expect(result.reasons.some((r) => r.includes("Normal priority"))).toBe(true);
  });

  it("adds zero for low priority (priority 3)", () => {
    const task = makeTask({ priority: 3, due_date: null, goal_id: null });
    const result = scoreTask(task, { ...baseCtx, now: new Date() });
    // Low priority adds no score, recently updated adds +5 if within 24h
    // Base score should be 5 (recently updated) or 0
    expect(result.reasons.every((r) => !r.includes("priority"))).toBe(true);
  });

  it("adds +20 for due within 48 hours (not overdue)", () => {
    const in24h = new Date();
    in24h.setHours(in24h.getHours() + 24);
    const task = makeTask({ due_date: in24h.toISOString().split("T")[0] });
    const result = scoreTask(task, baseCtx);
    // Due soon could also equal today which is within 48h
    expect(result.reasons.some((r) => r.includes("Due in"))).toBe(true);
  });

  it("adds +15 for tasks aligned with active goals", () => {
    const task = makeTask({ goal_id: "G25" });
    const ctx = { ...baseCtx, activeGoalIds: ["G25"] };
    const result = scoreTask(task, ctx);
    expect(result.reasons.some((r) => r.includes("Goal G25 aligned"))).toBe(true);
  });

  it("adds +0 for goal not in active list", () => {
    const task = makeTask({ goal_id: "G99" });
    const ctx = { ...baseCtx, activeGoalIds: ["G25"] };
    const result = scoreTask(task, ctx);
    expect(result.reasons.some((r) => r.includes("G99"))).toBe(false);
  });

  it("adds +10 for project context match", () => {
    const task = makeTask({ project_id: "p-backend" });
    const ctx = { ...baseCtx, projectFilter: "p-backend" };
    const result = scoreTask(task, ctx);
    expect(result.reasons.some((r) => r.includes("Matches project"))).toBe(true);
  });

  it("adds +10 for energy level match", () => {
    const task = makeTask({ energy_level: "high" });
    const ctx = { ...baseCtx, energyFilter: "high" as const };
    const result = scoreTask(task, ctx);
    expect(result.reasons.some((r) => r.includes("Energy match: high"))).toBe(true);
  });

  it("adds +5 for recently updated tasks (within 24h)", () => {
    // Task updated right now is within 24h
    const task = makeTask({ updated_at: new Date().toISOString(), priority: 3 });
    const result = scoreTask(task, baseCtx);
    expect(result.reasons.some((r) => r.includes("Recently updated"))).toBe(true);
  });

  it("does NOT add +5 for tasks updated more than 24h ago", () => {
    const twoDaysAgo = new Date();
    twoDaysAgo.setDate(twoDaysAgo.getDate() - 2);
    const task = makeTask({ updated_at: twoDaysAgo.toISOString(), priority: 3 });
    const result = scoreTask(task, baseCtx);
    expect(result.reasons.some((r) => r.includes("Recently updated"))).toBe(false);
  });

  it("overdue task scores higher than high priority non-overdue task", () => {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const overdueTask = makeTask({ due_date: yesterday.toISOString().split("T")[0], priority: 3 });

    const highPriorityTask = makeTask({ priority: 1, due_date: null });

    const overdueResult = scoreTask(overdueTask, baseCtx);
    const priorityResult = scoreTask(highPriorityTask, baseCtx);

    expect(overdueResult.score).toBeGreaterThan(priorityResult.score);
  });
});
