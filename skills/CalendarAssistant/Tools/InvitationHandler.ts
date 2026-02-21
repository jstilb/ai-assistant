#!/usr/bin/env bun
/**
 * InvitationHandler.ts - Auto-Accept/Decline Rules for Calendar Invitations
 *
 * Rule-based invitation evaluation with priority ordering.
 * Rules define conditions (organizer, title, attendee count, recurring)
 * and actions (accept, decline). Higher priority rules win.
 * Unmatched invitations get "needs_review" status.
 *
 * Persists rules via StateManager.
 *
 * @module InvitationHandler
 */

import { z } from "zod";
import { createStateManager } from "../../CORE/Tools/StateManager";
import type { Result, CalendarError } from "./types";

// ============================================
// TYPES
// ============================================

export interface InvitationCondition {
  type: "organizerContains" | "titleContains" | "minAttendees" | "isRecurring";
  value: string;
}

export interface InvitationRule {
  id: string;
  name: string;
  action: "accept" | "decline";
  priority: number; // Higher = takes precedence
  conditions: InvitationCondition[];
  createdAt: string;
}

export interface Invitation {
  title: string;
  organizer: string;
  start: string;
  end: string;
  attendeeCount: number;
  isRecurring: boolean;
  description?: string;
}

export interface InvitationDecision {
  action: "accept" | "decline" | "needs_review";
  matchedRule?: string;
  reason?: string;
  flags: string[];
}

interface RuleStore {
  rules: InvitationRule[];
  lastUpdated: string;
}

// ============================================
// SCHEMA
// ============================================

const ConditionSchema = z.object({
  type: z.enum(["organizerContains", "titleContains", "minAttendees", "isRecurring"]),
  value: z.string(),
});

const RuleSchema = z.object({
  id: z.string(),
  name: z.string(),
  action: z.enum(["accept", "decline"]),
  priority: z.number(),
  conditions: z.array(ConditionSchema),
  createdAt: z.string(),
});

const RuleStoreSchema = z.object({
  rules: z.array(RuleSchema),
  lastUpdated: z.string(),
});

// ============================================
// STATE MANAGER
// ============================================

const KAYA_DIR = process.env.KAYA_DIR || `${process.env.HOME}/.claude`;
const RULES_PATH = `${KAYA_DIR}/skills/CalendarAssistant/data/invitation-rules.json`;

const ruleManager = createStateManager<RuleStore>({
  path: RULES_PATH,
  schema: RuleStoreSchema,
  defaults: {
    rules: [],
    lastUpdated: new Date().toISOString(),
  },
  version: 1,
});

// ============================================
// HELPERS
// ============================================

function generateId(): string {
  return `rule_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Check if an invitation matches a single condition.
 */
function matchesCondition(invitation: Invitation, condition: InvitationCondition): boolean {
  switch (condition.type) {
    case "organizerContains":
      return invitation.organizer.toLowerCase().includes(condition.value.toLowerCase());
    case "titleContains":
      return invitation.title.toLowerCase().includes(condition.value.toLowerCase());
    case "minAttendees":
      return invitation.attendeeCount >= parseInt(condition.value, 10);
    case "isRecurring":
      return invitation.isRecurring === (condition.value.toLowerCase() === "true");
    default:
      return false;
  }
}

/**
 * Check if an invitation matches ALL conditions of a rule.
 */
function matchesRule(invitation: Invitation, rule: InvitationRule): boolean {
  return rule.conditions.every((condition) => matchesCondition(invitation, condition));
}

/**
 * Detect flags for an invitation (metadata, not rule-based).
 */
function detectFlags(invitation: Invitation): string[] {
  const flags: string[] = [];

  if (invitation.attendeeCount >= 15) {
    flags.push("large_meeting");
  }
  if (invitation.isRecurring) {
    flags.push("recurring");
  }

  return flags;
}

// ============================================
// PUBLIC API
// ============================================

/**
 * Add an accept rule.
 */
export async function addAcceptRule(params: {
  name: string;
  priority: number;
  conditions: InvitationCondition[];
}): Promise<Result<InvitationRule, CalendarError>> {
  try {
    const rule: InvitationRule = {
      id: generateId(),
      name: params.name,
      action: "accept",
      priority: params.priority,
      conditions: params.conditions,
      createdAt: new Date().toISOString(),
    };

    await ruleManager.update((store) => ({
      rules: [...store.rules, rule],
      lastUpdated: new Date().toISOString(),
    }));

    return { success: true, data: rule };
  } catch (err) {
    return {
      success: false,
      error: {
        code: "UNKNOWN",
        message: `Failed to add accept rule: ${err instanceof Error ? err.message : String(err)}`,
        retryable: false,
      },
    };
  }
}

/**
 * Add a decline rule.
 */
export async function addDeclineRule(params: {
  name: string;
  priority: number;
  conditions: InvitationCondition[];
}): Promise<Result<InvitationRule, CalendarError>> {
  try {
    const rule: InvitationRule = {
      id: generateId(),
      name: params.name,
      action: "decline",
      priority: params.priority,
      conditions: params.conditions,
      createdAt: new Date().toISOString(),
    };

    await ruleManager.update((store) => ({
      rules: [...store.rules, rule],
      lastUpdated: new Date().toISOString(),
    }));

    return { success: true, data: rule };
  } catch (err) {
    return {
      success: false,
      error: {
        code: "UNKNOWN",
        message: `Failed to add decline rule: ${err instanceof Error ? err.message : String(err)}`,
        retryable: false,
      },
    };
  }
}

/**
 * Get all rules.
 */
export async function getRules(): Promise<Result<InvitationRule[], CalendarError>> {
  try {
    const store = await ruleManager.load();
    return { success: true, data: store.rules };
  } catch (err) {
    return {
      success: false,
      error: {
        code: "UNKNOWN",
        message: `Failed to load rules: ${err instanceof Error ? err.message : String(err)}`,
        retryable: true,
      },
    };
  }
}

/**
 * Clear all rules (primarily for testing).
 */
export async function clearRules(): Promise<void> {
  await ruleManager.save({
    rules: [],
    lastUpdated: new Date().toISOString(),
  });
}

/**
 * Remove a rule by ID.
 */
export async function removeRule(ruleId: string): Promise<Result<{ removed: true }, CalendarError>> {
  try {
    await ruleManager.update((store) => ({
      rules: store.rules.filter((r) => r.id !== ruleId),
      lastUpdated: new Date().toISOString(),
    }));
    return { success: true, data: { removed: true } };
  } catch (err) {
    return {
      success: false,
      error: {
        code: "UNKNOWN",
        message: `Failed to remove rule: ${err instanceof Error ? err.message : String(err)}`,
        retryable: false,
      },
    };
  }
}

/**
 * Evaluate an invitation against all rules.
 * Returns the action from the highest-priority matching rule,
 * or "needs_review" if no rules match.
 */
export async function evaluateInvitation(invitation: Invitation): Promise<InvitationDecision> {
  const flags = detectFlags(invitation);

  const rulesResult = await getRules();
  if (!rulesResult.success || rulesResult.data.length === 0) {
    return { action: "needs_review", reason: "No rules defined", flags };
  }

  const rules = rulesResult.data;

  // Find all matching rules
  const matchingRules = rules.filter((rule) => matchesRule(invitation, rule));

  if (matchingRules.length === 0) {
    return { action: "needs_review", reason: "No rules matched", flags };
  }

  // Sort by priority descending - highest wins
  matchingRules.sort((a, b) => b.priority - a.priority);
  const winner = matchingRules[0];

  return {
    action: winner.action,
    matchedRule: winner.name,
    reason: `Matched rule "${winner.name}" (priority ${winner.priority})`,
    flags,
  };
}

// ============================================
// CLI INTERFACE
// ============================================

if (import.meta.main) {
  const args = process.argv.slice(2);
  const command = args[0];

  if (command === "rules") {
    const result = await getRules();
    console.log(JSON.stringify(result, null, 2));
  } else if (command === "clear") {
    await clearRules();
    console.log("All rules cleared.");
  } else {
    console.log(`InvitationHandler - Auto-Accept/Decline Rules

Usage:
  bun run InvitationHandler.ts rules     Show all rules
  bun run InvitationHandler.ts clear     Clear all rules

Exports:
  addAcceptRule(params)         Add an accept rule
  addDeclineRule(params)        Add a decline rule
  getRules()                    Get all rules
  clearRules()                  Clear all rules
  removeRule(id)                Remove a rule
  evaluateInvitation(inv)       Evaluate an invitation
`);
  }
}
