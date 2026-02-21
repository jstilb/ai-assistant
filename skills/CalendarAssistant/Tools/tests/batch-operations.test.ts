/**
 * batch-operations.test.ts - Tests for BatchOperations
 *
 * TDD: RED phase tests for bulk schedule, bulk reschedule, template-based scheduling.
 */

import { describe, test, expect } from "bun:test";
import type { CalendarEvent, NewEvent } from "../types";

import {
  validateBatchRequest,
  bulkSchedule,
  bulkReschedule,
  applyTemplate,
} from "../BatchOperations";

// Helper
function makeEvent(
  title: string,
  start: string,
  end: string,
  opts: Partial<CalendarEvent> = {}
): CalendarEvent {
  return {
    id: `evt_${title.replace(/\s/g, "_")}`,
    title,
    start,
    end,
    isAllDay: false,
    isRecurring: false,
    ...opts,
  };
}

// ============================================
// validateBatchRequest
// ============================================

describe("validateBatchRequest", () => {
  test("accepts valid batch of events (under max)", () => {
    const events: NewEvent[] = Array.from({ length: 5 }, (_, i) => ({
      title: `Event ${i}`,
      start: `2026-02-06T${String(9 + i).padStart(2, "0")}:00:00`,
      end: `2026-02-06T${String(10 + i).padStart(2, "0")}:00:00`,
    }));
    const result = validateBatchRequest(events);
    expect(result.success).toBe(true);
  });

  test("rejects batch exceeding max size (20)", () => {
    const events: NewEvent[] = Array.from({ length: 25 }, (_, i) => ({
      title: `Event ${i}`,
      start: `2026-02-06T09:00:00`,
      end: `2026-02-06T10:00:00`,
    }));
    const result = validateBatchRequest(events);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe("VALIDATION");
    }
  });

  test("rejects empty batch", () => {
    const result = validateBatchRequest([]);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe("VALIDATION");
    }
  });

  test("rejects events missing required fields", () => {
    const events = [{ title: "", start: "2026-02-06T09:00:00", end: "2026-02-06T10:00:00" }];
    const result = validateBatchRequest(events);
    expect(result.success).toBe(false);
  });
});

// ============================================
// bulkSchedule
// ============================================

describe("bulkSchedule", () => {
  test("returns per-item results for dry-run", async () => {
    const events: NewEvent[] = [
      { title: "Meeting A", start: "2026-02-06T09:00:00", end: "2026-02-06T10:00:00" },
      { title: "Meeting B", start: "2026-02-06T11:00:00", end: "2026-02-06T12:00:00" },
    ];
    const result = await bulkSchedule(events, { dryRun: true });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.items.length).toBe(2);
      expect(result.data.summary.total).toBe(2);
    }
  });

  test("skips events with validation errors in dry-run", async () => {
    const events: NewEvent[] = [
      { title: "Good Event", start: "2026-02-06T09:00:00", end: "2026-02-06T10:00:00" },
      { title: "", start: "2026-02-06T11:00:00", end: "2026-02-06T12:00:00" }, // invalid
    ];
    const result = await bulkSchedule(events, { dryRun: true });
    expect(result.success).toBe(true);
    if (result.success) {
      const failed = result.data.items.filter((i) => i.status === "failed");
      expect(failed.length).toBe(1);
    }
  });
});

// ============================================
// bulkReschedule
// ============================================

describe("bulkReschedule", () => {
  test("returns per-item results for dry-run reschedule", async () => {
    const requests = [
      {
        eventTitle: "Meeting A",
        newStart: "2026-02-07T09:00:00",
        newEnd: "2026-02-07T10:00:00",
      },
      {
        eventTitle: "Meeting B",
        newStart: "2026-02-07T11:00:00",
        newEnd: "2026-02-07T12:00:00",
      },
    ];
    const result = await bulkReschedule(requests, { dryRun: true });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.items.length).toBe(2);
    }
  });

  test("rejects empty reschedule batch", async () => {
    const result = await bulkReschedule([], { dryRun: true });
    expect(result.success).toBe(false);
  });
});

// ============================================
// applyTemplate
// ============================================

describe("applyTemplate", () => {
  test("generates events from template for a target date", async () => {
    const template = {
      name: "Focus Day",
      events: [
        { title: "Morning Focus", dayOffset: 0, startTime: "09:00", durationMinutes: 120 },
        { title: "Lunch Break", dayOffset: 0, startTime: "12:00", durationMinutes: 60 },
        { title: "Afternoon Focus", dayOffset: 0, startTime: "13:00", durationMinutes: 120 },
      ],
    };
    const result = await applyTemplate(template, "2026-02-10", { dryRun: true });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.items.length).toBe(3);
      expect(result.data.summary.total).toBe(3);
    }
  });

  test("supports multi-day templates with dayOffset", async () => {
    const template = {
      name: "Sprint Week",
      events: [
        { title: "Sprint Planning", dayOffset: 0, startTime: "09:00", durationMinutes: 120 },
        { title: "Sprint Review", dayOffset: 4, startTime: "14:00", durationMinutes: 60 },
        { title: "Sprint Retro", dayOffset: 4, startTime: "15:00", durationMinutes: 60 },
      ],
    };
    const result = await applyTemplate(template, "2026-02-10", { dryRun: true });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.items.length).toBe(3);
      // First event on Feb 10, last two on Feb 14
      const firstItem = result.data.items[0];
      const lastItem = result.data.items[2];
      expect(firstItem.title).toBe("Sprint Planning");
      expect(lastItem.title).toBe("Sprint Retro");
    }
  });

  test("rejects template with no events", async () => {
    const template = { name: "Empty", events: [] };
    const result = await applyTemplate(template, "2026-02-10", { dryRun: true });
    expect(result.success).toBe(false);
  });
});
