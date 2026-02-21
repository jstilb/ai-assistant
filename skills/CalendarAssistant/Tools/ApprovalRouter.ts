#!/usr/bin/env bun
/**
 * ApprovalRouter.ts - Gate High-Impact Calendar Actions
 *
 * Determines whether a calendar action requires explicit user approval
 * before execution. Approval triggers:
 * - Events with >=3 external attendees
 * - Recurring event deletion
 * - Protected time block modification
 * - Confidence < 75% on intent classification
 *
 * @module ApprovalRouter
 */

import type {
  ParsedIntent,
  CalendarEvent,
  ApprovalRequest,
  ApprovalTrigger,
  Result,
  CalendarError,
  ProtectedBlock,
} from "./types";
import { IntentType, ApprovalTrigger as AT } from "./types";

// ============================================
// CONFIGURATION
// ============================================

const DEFAULT_ATTENDEE_THRESHOLD = 3;
const DEFAULT_CONFIDENCE_THRESHOLD = 0.75;

// ============================================
// APPROVAL CHECKS
// ============================================

/**
 * Check if an action requires approval.
 *
 * @param params - Action parameters
 * @returns Approval request if needed, null if auto-approved
 */
export function checkApproval(params: {
  intent: ParsedIntent;
  existingEvent?: CalendarEvent;
  protectedBlocks?: ProtectedBlock[];
  attendeeThreshold?: number;
  confidenceThreshold?: number;
}): ApprovalRequest | null {
  const {
    intent,
    existingEvent,
    protectedBlocks = [],
    attendeeThreshold = DEFAULT_ATTENDEE_THRESHOLD,
    confidenceThreshold = DEFAULT_CONFIDENCE_THRESHOLD,
  } = params;

  // Check 1: Low confidence
  if (intent.confidence < confidenceThreshold) {
    return {
      action: `${intent.type} operation`,
      reason: AT.LowConfidence,
      impact: `Intent classification confidence is ${Math.round(intent.confidence * 100)}% (below ${Math.round(confidenceThreshold * 100)}% threshold). The system may have misunderstood your request.`,
      options: [
        "Proceed with this interpretation",
        "Rephrase the request",
        "Cancel",
      ],
      intent,
    };
  }

  // Check 2: External attendees
  const attendees = intent.entities.attendees || [];
  if (attendees.length >= attendeeThreshold) {
    return {
      action: `${intent.type} event with ${attendees.length} attendees`,
      reason: AT.ExternalAttendees,
      impact: `Calendar invitations will be sent to ${attendees.length} external participants: ${attendees.slice(0, 3).join(", ")}${attendees.length > 3 ? ` and ${attendees.length - 3} more` : ""}`,
      options: [
        "Send invitations to all attendees",
        "Create event without sending invitations",
        "Cancel",
      ],
      intent,
    };
  }

  // Check 3: Recurring event deletion
  if (
    intent.type === IntentType.Delete &&
    existingEvent?.isRecurring
  ) {
    return {
      action: `Delete recurring event "${existingEvent.title}"`,
      reason: AT.RecurringDeletion,
      impact: `This is a recurring event. Deleting may affect future occurrences.`,
      options: [
        "Delete only this occurrence",
        "Delete all future occurrences",
        "Cancel deletion",
      ],
      event: existingEvent,
      intent,
    };
  }

  // Check 4: All deletes require confirmation (safety rule)
  if (intent.type === IntentType.Delete) {
    return {
      action: `Delete event "${existingEvent?.title || intent.entities.title || "unknown"}"`,
      reason: AT.ProtectedTime, // Using generic trigger for delete confirmation
      impact: `Event will be permanently removed from your calendar.`,
      options: ["Confirm deletion", "Cancel"],
      event: existingEvent,
      intent,
    };
  }

  // Check 5: Protected time blocks
  if (
    (intent.type === IntentType.Create ||
      intent.type === IntentType.Move) &&
    protectedBlocks.length > 0
  ) {
    const proposedTime = intent.entities.time;
    if (proposedTime) {
      for (const block of protectedBlocks) {
        // Simple overlap check based on labels/times
        if (
          block.start &&
          block.end &&
          proposedTime >= block.start &&
          proposedTime <= block.end
        ) {
          return {
            action: `${intent.type} event during protected time "${block.label}"`,
            reason: AT.ProtectedTime,
            impact: `This event would be scheduled during your protected "${block.label}" block (${block.start}-${block.end}).`,
            options: [
              "Override protected time for this event",
              "Find an alternative time",
              "Cancel",
            ],
            intent,
          };
        }
      }
    }
  }

  // No approval required
  return null;
}

/**
 * Format an approval request for display.
 *
 * @param request - The approval request
 * @returns Formatted string for user display
 */
export function formatApprovalPrompt(request: ApprovalRequest): string {
  const lines: string[] = [];

  lines.push(`APPROVAL REQUIRED`);
  lines.push(`=================`);
  lines.push(`Action: ${request.action}`);
  lines.push(`Reason: ${formatTriggerReason(request.reason)}`);
  lines.push(`Impact: ${request.impact}`);
  lines.push(``);
  lines.push(`Options:`);
  request.options.forEach((opt, i) => {
    lines.push(`  ${i + 1}. ${opt}`);
  });

  return lines.join("\n");
}

/**
 * Format the trigger reason for display.
 */
function formatTriggerReason(trigger: ApprovalTrigger): string {
  const reasons: Record<ApprovalTrigger, string> = {
    [AT.ExternalAttendees]: "External attendees will receive calendar invitations",
    [AT.RecurringDeletion]: "Deleting a recurring event series",
    [AT.ProtectedTime]: "Action involves protected time block",
    [AT.LowConfidence]: "Low confidence in intent classification",
  };
  return reasons[trigger] || String(trigger);
}

// CLI interface
if (import.meta.main) {
  console.log(`ApprovalRouter - High-Impact Action Gating

Approval triggers:
  1. Events with >=3 external attendees
  2. Recurring event deletion
  3. Protected time block modification
  4. Confidence < 75% on intent classification
  5. All delete operations (safety rule)

Usage: Import and call checkApproval().
`);
}
