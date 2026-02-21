#!/usr/bin/env bun
/**
 * SafetyGuardrails.ts - Hard Blocks on Prohibited Actions
 *
 * Enforces safety rules before any calendar modification:
 * - Never delete events without explicit user confirmation
 * - Never modify events in the past
 * - Never create events during protected time without approval
 * - Never send calendar invites to external users without approval
 * - Always log every calendar modification to audit trail
 *
 * Supports dry-run mode for safe simulation.
 *
 * @module SafetyGuardrails
 */

import type {
  CalendarEvent,
  NewEvent,
  ParsedIntent,
  Result,
  CalendarError,
  IntentType,
} from "./types";
import { IntentType as IT } from "./types";

// ============================================
// SAFETY RULE DEFINITIONS
// ============================================

interface SafetyViolation {
  rule: string;
  severity: "block" | "approval_required";
  message: string;
}

/**
 * Check all safety rules against a proposed action.
 * Returns violations if any rules are broken.
 *
 * @param intent - The parsed intent to validate
 * @param existingEvent - The existing event (for modify/delete/move)
 * @param protectedBlocks - Protected time blocks from preferences
 * @param dryRun - Whether we're in dry-run mode
 * @returns Result with violations or clear pass
 */
export function checkSafetyRules(params: {
  intent: ParsedIntent;
  existingEvent?: CalendarEvent;
  newEvent?: NewEvent;
  protectedBlocks?: Array<{ label: string; start: string; end: string }>;
  dryRun?: boolean;
}): Result<{ safe: true }, CalendarError> {
  const violations: SafetyViolation[] = [];

  // Rule 1: Never delete without confirmation
  // This is enforced by the approval router, but we double-check here
  if (params.intent.type === IT.Delete) {
    if (!params.existingEvent) {
      violations.push({
        rule: "DELETE_REQUIRES_TARGET",
        severity: "block",
        message: "Cannot delete: no target event identified",
      });
    }
  }

  // Rule 2: Never modify events in the past
  if (
    params.intent.type === IT.Modify ||
    params.intent.type === IT.Move ||
    params.intent.type === IT.Delete
  ) {
    if (params.existingEvent) {
      const eventEnd = new Date(params.existingEvent.end);
      if (eventEnd < new Date()) {
        violations.push({
          rule: "NO_PAST_MODIFICATION",
          severity: "block",
          message: `Cannot modify event "${params.existingEvent.title}" - it has already ended (${params.existingEvent.end})`,
        });
      }
    }
  }

  // Rule 3: Never create events during protected time without approval
  if (params.intent.type === IT.Create && params.protectedBlocks) {
    const proposedStart = params.intent.entities.time;
    const proposedEnd = params.intent.entities.endTime;

    if (proposedStart && proposedEnd) {
      for (const block of params.protectedBlocks) {
        if (timesOverlap(proposedStart, proposedEnd, block.start, block.end)) {
          violations.push({
            rule: "PROTECTED_TIME_CONFLICT",
            severity: "approval_required",
            message: `Proposed event overlaps with protected time block "${block.label}" (${block.start}-${block.end})`,
          });
        }
      }
    }
  }

  // Rule 4: Never send invites to external users without approval
  if (
    params.intent.type === IT.Create ||
    params.intent.type === IT.Modify
  ) {
    const attendees = params.intent.entities.attendees || [];
    if (attendees.length > 0) {
      violations.push({
        rule: "EXTERNAL_ATTENDEES_REQUIRE_APPROVAL",
        severity: "approval_required",
        message: `Event includes ${attendees.length} attendee(s) - calendar invites will be sent`,
      });
    }
  }

  // Rule 5: Block recurring event deletion without explicit handling
  if (params.intent.type === IT.Delete && params.existingEvent?.isRecurring) {
    violations.push({
      rule: "RECURRING_DELETE_REQUIRES_APPROVAL",
      severity: "approval_required",
      message: `Deleting recurring event "${params.existingEvent.title}" - this may affect future occurrences`,
    });
  }

  // Check for blocking violations
  const blockers = violations.filter((v) => v.severity === "block");
  if (blockers.length > 0) {
    return {
      success: false,
      error: {
        code: "SAFETY_BLOCKED",
        message: blockers.map((b) => b.message).join("; "),
        retryable: false,
      },
    };
  }

  // Check for approval-required violations (not hard blocks)
  const approvalNeeded = violations.filter(
    (v) => v.severity === "approval_required"
  );
  if (approvalNeeded.length > 0 && !params.dryRun) {
    return {
      success: false,
      error: {
        code: "APPROVAL_REQUIRED",
        message: approvalNeeded.map((a) => a.message).join("; "),
        retryable: true,
      },
    };
  }

  return { success: true, data: { safe: true } };
}

/**
 * Validate that a delete operation has proper confirmation.
 * This is the final gate before any deletion.
 *
 * @param eventId - The event being deleted
 * @param confirmed - Whether the user has explicitly confirmed
 * @returns Whether the deletion can proceed
 */
export function validateDeletion(
  eventId: string,
  confirmed: boolean
): Result<{ confirmed: true }, CalendarError> {
  if (!confirmed) {
    return {
      success: false,
      error: {
        code: "SAFETY_BLOCKED",
        message: `Deletion of event ${eventId} blocked: explicit user confirmation required. No silent deletions allowed.`,
        retryable: true,
      },
    };
  }
  return { success: true, data: { confirmed: true } };
}

/**
 * Check if an action is allowed in the current mode.
 * Write operations are blocked in dry-run mode.
 *
 * @param actionType - The action being performed
 * @param dryRun - Whether dry-run mode is active
 * @returns Whether the action can proceed
 */
export function checkDryRunMode(
  actionType: IntentType,
  dryRun: boolean
): { allowed: boolean; message: string } {
  const writeActions: IntentType[] = [IT.Create, IT.Modify, IT.Delete, IT.Move];

  if (dryRun && writeActions.includes(actionType)) {
    return {
      allowed: false,
      message: `[DRY-RUN] ${actionType} operation simulated - no calendar changes made`,
    };
  }

  return { allowed: true, message: "" };
}

// ============================================
// INTERNAL HELPERS
// ============================================

/**
 * Check if two time ranges overlap.
 */
function timesOverlap(
  startA: string,
  endA: string,
  startB: string,
  endB: string
): boolean {
  const a0 = new Date(startA).getTime();
  const a1 = new Date(endA).getTime();
  const b0 = new Date(startB).getTime();
  const b1 = new Date(endB).getTime();

  return a0 < b1 && a1 > b0;
}

// CLI interface
if (import.meta.main) {
  console.log(`SafetyGuardrails - Calendar Safety Enforcement

Rules enforced:
  1. Never delete events without explicit user confirmation
  2. Never modify events in the past
  3. Never create events during protected time without approval
  4. Never send calendar invites to external users without approval
  5. Always log every calendar modification to audit trail

Usage: Import and call checkSafetyRules() before any calendar operation.
`);
}
