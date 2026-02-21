/**
 * invitation-handler.test.ts - Tests for InvitationHandler
 *
 * TDD: RED phase tests for auto-accept/decline rules with priority-based evaluation.
 */

import { describe, test, expect, beforeEach } from "bun:test";

import {
  addAcceptRule,
  addDeclineRule,
  getRules,
  clearRules,
  evaluateInvitation,
  type Invitation,
  type InvitationRule,
} from "../InvitationHandler";

// Reset rules before each test
beforeEach(async () => {
  await clearRules();
});

// ============================================
// addAcceptRule / addDeclineRule
// ============================================

describe("addAcceptRule", () => {
  test("adds an accept rule with conditions", async () => {
    const result = await addAcceptRule({
      name: "Accept from boss",
      priority: 10,
      conditions: [{ type: "organizerContains", value: "boss@company.com" }],
    });
    expect(result.success).toBe(true);

    const rules = await getRules();
    expect(rules.success).toBe(true);
    if (rules.success) {
      expect(rules.data.length).toBe(1);
      expect(rules.data[0].action).toBe("accept");
    }
  });
});

describe("addDeclineRule", () => {
  test("adds a decline rule with conditions", async () => {
    const result = await addDeclineRule({
      name: "Decline large meetings",
      priority: 5,
      conditions: [{ type: "minAttendees", value: "15" }],
    });
    expect(result.success).toBe(true);

    const rules = await getRules();
    expect(rules.success).toBe(true);
    if (rules.success) {
      expect(rules.data.length).toBe(1);
      expect(rules.data[0].action).toBe("decline");
    }
  });
});

// ============================================
// clearRules
// ============================================

describe("clearRules", () => {
  test("removes all rules", async () => {
    await addAcceptRule({
      name: "Rule 1",
      priority: 1,
      conditions: [{ type: "titleContains", value: "standup" }],
    });
    await addDeclineRule({
      name: "Rule 2",
      priority: 2,
      conditions: [{ type: "isRecurring", value: "true" }],
    });

    await clearRules();
    const rules = await getRules();
    expect(rules.success).toBe(true);
    if (rules.success) {
      expect(rules.data.length).toBe(0);
    }
  });
});

// ============================================
// evaluateInvitation
// ============================================

describe("evaluateInvitation", () => {
  test("matches accept rule by organizer", async () => {
    await addAcceptRule({
      name: "Accept from team lead",
      priority: 10,
      conditions: [{ type: "organizerContains", value: "lead@company.com" }],
    });

    const invitation: Invitation = {
      title: "Sprint Planning",
      organizer: "lead@company.com",
      start: "2026-02-06T09:00:00",
      end: "2026-02-06T10:00:00",
      attendeeCount: 5,
      isRecurring: false,
    };

    const decision = await evaluateInvitation(invitation);
    expect(decision.action).toBe("accept");
    expect(decision.matchedRule).toBe("Accept from team lead");
  });

  test("matches decline rule by attendee count", async () => {
    await addDeclineRule({
      name: "Decline large meetings",
      priority: 5,
      conditions: [{ type: "minAttendees", value: "15" }],
    });

    const invitation: Invitation = {
      title: "All-Hands Meeting",
      organizer: "hr@company.com",
      start: "2026-02-06T14:00:00",
      end: "2026-02-06T15:00:00",
      attendeeCount: 50,
      isRecurring: false,
    };

    const decision = await evaluateInvitation(invitation);
    expect(decision.action).toBe("decline");
  });

  test("higher priority rule wins over lower priority", async () => {
    await addAcceptRule({
      name: "Accept recurring",
      priority: 5,
      conditions: [{ type: "isRecurring", value: "true" }],
    });
    await addDeclineRule({
      name: "Decline large",
      priority: 10,
      conditions: [{ type: "minAttendees", value: "15" }],
    });

    const invitation: Invitation = {
      title: "All Company Sync",
      organizer: "ceo@company.com",
      start: "2026-02-06T14:00:00",
      end: "2026-02-06T15:00:00",
      attendeeCount: 100,
      isRecurring: true,
    };

    // Decline rule has higher priority (10) so it wins
    const decision = await evaluateInvitation(invitation);
    expect(decision.action).toBe("decline");
  });

  test("returns needs_review when no rules match", async () => {
    const invitation: Invitation = {
      title: "Random Meeting",
      organizer: "unknown@other.com",
      start: "2026-02-06T14:00:00",
      end: "2026-02-06T15:00:00",
      attendeeCount: 3,
      isRecurring: false,
    };

    const decision = await evaluateInvitation(invitation);
    expect(decision.action).toBe("needs_review");
  });

  test("matches titleContains condition (case-insensitive)", async () => {
    await addAcceptRule({
      name: "Accept standups",
      priority: 5,
      conditions: [{ type: "titleContains", value: "standup" }],
    });

    const invitation: Invitation = {
      title: "Daily STANDUP",
      organizer: "team@company.com",
      start: "2026-02-06T09:00:00",
      end: "2026-02-06T09:15:00",
      attendeeCount: 6,
      isRecurring: true,
    };

    const decision = await evaluateInvitation(invitation);
    expect(decision.action).toBe("accept");
  });

  test("flags large_meeting for 15+ attendees", async () => {
    const invitation: Invitation = {
      title: "Town Hall",
      organizer: "exec@company.com",
      start: "2026-02-06T14:00:00",
      end: "2026-02-06T15:00:00",
      attendeeCount: 50,
      isRecurring: false,
    };

    const decision = await evaluateInvitation(invitation);
    expect(decision.flags).toContain("large_meeting");
  });

  test("flags recurring invitations", async () => {
    const invitation: Invitation = {
      title: "Weekly Sync",
      organizer: "team@company.com",
      start: "2026-02-06T09:00:00",
      end: "2026-02-06T10:00:00",
      attendeeCount: 5,
      isRecurring: true,
    };

    const decision = await evaluateInvitation(invitation);
    expect(decision.flags).toContain("recurring");
  });
});
