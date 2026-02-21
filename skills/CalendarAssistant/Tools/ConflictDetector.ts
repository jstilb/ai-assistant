#!/usr/bin/env bun
/**
 * ConflictDetector.ts - Time Overlap Detection + Resolution
 *
 * Detects overlapping events (partial, full, adjacent-with-no-gap)
 * and generates resolution options for each conflict.
 * Handles recurring event overlaps and all-day vs timed event conflicts.
 *
 * @module ConflictDetector
 */

import type {
  CalendarEvent,
  Conflict,
  ConflictType,
  ResolutionOption,
  Result,
  CalendarError,
} from "./types";
import { ConflictType as CT } from "./types";

// ============================================
// OVERLAP DETECTION
// ============================================

/**
 * Determine the type and extent of overlap between two events.
 * Returns null if no overlap.
 */
function detectOverlap(
  eventA: CalendarEvent,
  eventB: CalendarEvent
): { type: ConflictType; overlapMinutes: number } | null {
  // Handle all-day vs timed event
  if (eventA.isAllDay !== eventB.isAllDay) {
    if (eventA.isAllDay || eventB.isAllDay) {
      // All-day events don't typically conflict with timed events
      // unless they represent blocking time
      const allDay = eventA.isAllDay ? eventA : eventB;
      const timed = eventA.isAllDay ? eventB : eventA;

      const allDayDate = new Date(allDay.start).toDateString();
      const timedDate = new Date(timed.start).toDateString();

      if (allDayDate === timedDate) {
        return {
          type: CT.AllDayVsTimed,
          overlapMinutes: 0, // Informational only
        };
      }
      return null;
    }
  }

  const startA = new Date(eventA.start).getTime();
  const endA = new Date(eventA.end || eventA.start).getTime();
  const startB = new Date(eventB.start).getTime();
  const endB = new Date(eventB.end || eventB.start).getTime();

  // No overlap
  if (endA <= startB || endB <= startA) {
    // Check adjacent-with-no-gap (end of one = start of other)
    if (endA === startB || endB === startA) {
      return {
        type: CT.AdjacentNoGap,
        overlapMinutes: 0,
      };
    }
    return null;
  }

  // Calculate overlap duration
  const overlapStart = Math.max(startA, startB);
  const overlapEnd = Math.min(endA, endB);
  const overlapMinutes = Math.round((overlapEnd - overlapStart) / (1000 * 60));

  // Determine overlap type
  if (startA <= startB && endA >= endB) {
    // A fully contains B
    return { type: CT.FullOverlap, overlapMinutes };
  }
  if (startB <= startA && endB >= endA) {
    // B fully contains A
    return { type: CT.FullOverlap, overlapMinutes };
  }

  // Check for recurring overlap
  if (eventA.isRecurring || eventB.isRecurring) {
    return { type: CT.RecurringOverlap, overlapMinutes };
  }

  // Partial overlap
  return { type: CT.PartialOverlap, overlapMinutes };
}

/**
 * Generate resolution options for a conflict.
 * Always provides at least 2 options.
 */
function generateResolutions(
  eventA: CalendarEvent,
  eventB: CalendarEvent,
  conflictType: ConflictType,
  overlapMinutes: number
): ResolutionOption[] {
  const options: ResolutionOption[] = [];

  if (conflictType === CT.AllDayVsTimed) {
    options.push({
      description: `Keep both - "${eventA.title}" (all-day) and "${eventB.title}" can coexist`,
      action: "ask_user",
      targetEvent: eventA.id,
    });
    options.push({
      description: `Mark "${eventA.isAllDay ? eventA.title : eventB.title}" as non-blocking`,
      action: "ask_user",
      targetEvent: eventA.isAllDay ? eventA.id : eventB.id,
    });
    return options;
  }

  if (conflictType === CT.AdjacentNoGap) {
    options.push({
      description: `Add ${5}-minute buffer between "${eventA.title}" and "${eventB.title}"`,
      action: "shorten",
      targetEvent: eventA.id,
      suggestedDuration: -5, // shorten by 5 minutes
    });
    options.push({
      description: `Keep back-to-back scheduling as is`,
      action: "ask_user",
      targetEvent: eventA.id,
    });
    return options;
  }

  // For real overlaps, always provide move options for both events
  const endA = new Date(eventA.end || eventA.start);
  const suggestedMoveA = new Date(
    endA.getTime() + overlapMinutes * 60 * 1000
  ).toISOString();

  options.push({
    description: `Move "${eventA.title}" to after "${eventB.title}"`,
    action: "move",
    targetEvent: eventA.id,
    suggestedTime: suggestedMoveA,
  });

  const endB = new Date(eventB.end || eventB.start);
  const suggestedMoveB = new Date(
    endB.getTime() + overlapMinutes * 60 * 1000
  ).toISOString();

  options.push({
    description: `Move "${eventB.title}" to after "${eventA.title}"`,
    action: "move",
    targetEvent: eventB.id,
    suggestedTime: suggestedMoveB,
  });

  // Shorten option if partial overlap
  if (
    conflictType === CT.PartialOverlap &&
    overlapMinutes > 0
  ) {
    options.push({
      description: `Shorten "${eventA.title}" by ${overlapMinutes} minutes to eliminate overlap`,
      action: "shorten",
      targetEvent: eventA.id,
      suggestedDuration: -overlapMinutes,
    });
  }

  // Always include ask-user option
  options.push({
    description: `Keep both events and decide manually`,
    action: "ask_user",
    targetEvent: eventA.id,
  });

  return options;
}

// ============================================
// PUBLIC API
// ============================================

/**
 * Detect all conflicts in a set of calendar events.
 *
 * @param events - Calendar events to check
 * @returns Array of detected conflicts with resolution options
 */
export function detectConflicts(
  events: CalendarEvent[]
): Result<Conflict[], CalendarError> {
  const conflicts: Conflict[] = [];

  // Sort by start time
  const sorted = [...events].sort(
    (a, b) => new Date(a.start).getTime() - new Date(b.start).getTime()
  );

  // Compare each pair of events
  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length; j++) {
      const eventA = sorted[i];
      const eventB = sorted[j];

      // Optimization: if eventB starts after eventA ends + buffer, skip rest
      const endA = new Date(eventA.end || eventA.start).getTime();
      const startB = new Date(eventB.start).getTime();
      if (startB > endA + 60 * 60 * 1000) break; // 1-hour lookahead

      const overlap = detectOverlap(eventA, eventB);
      if (overlap) {
        conflicts.push({
          type: overlap.type,
          eventA,
          eventB,
          overlapMinutes: overlap.overlapMinutes,
          resolutionOptions: generateResolutions(
            eventA,
            eventB,
            overlap.type,
            overlap.overlapMinutes
          ),
        });
      }
    }
  }

  return { success: true, data: conflicts };
}

/**
 * Check if a proposed event conflicts with existing events.
 *
 * @param proposedStart - Start time of proposed event
 * @param proposedEnd - End time of proposed event
 * @param existingEvents - Existing calendar events
 * @returns Conflicts with the proposed event
 */
export function checkProposedConflicts(
  proposedStart: string,
  proposedEnd: string,
  proposedTitle: string,
  existingEvents: CalendarEvent[]
): Conflict[] {
  const proposed: CalendarEvent = {
    id: "proposed",
    title: proposedTitle,
    start: proposedStart,
    end: proposedEnd,
    isAllDay: false,
    isRecurring: false,
  };

  const allEvents = [...existingEvents, proposed];
  const result = detectConflicts(allEvents);

  if (!result.success) return [];

  // Filter to only conflicts involving the proposed event
  return result.data.filter(
    (c) => c.eventA.id === "proposed" || c.eventB.id === "proposed"
  );
}

// CLI interface
if (import.meta.main) {
  console.log(`ConflictDetector - Calendar Conflict Detection

Detects:
  - Full overlaps (one event contains another)
  - Partial overlaps (events partially overlap)
  - Adjacent with no gap (back-to-back, no buffer)
  - All-day vs timed event conflicts
  - Recurring event overlaps

Each conflict includes 2+ resolution options.

Usage: Import and call detectConflicts() or checkProposedConflicts().
`);
}
