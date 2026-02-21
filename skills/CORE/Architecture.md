# CORE Architecture Patterns

This document captures reusable architectural patterns that have proven valuable across multiple skills.

---

## Boundary Enforcement Pattern

**Status:** Production-ready (CalendarAssistant)
**Use case:** Skills that perform high-impact actions requiring user approval or safety guardrails

### Overview

The Boundary Enforcement Pattern implements a tri-state rule engine (Always/Ask/Never) for action gating. It provides confidence-based downgrading and full audit integration for every decision.

### Core Concepts

**Tri-State Decision Model:**
- **Always**: Auto-approved actions that can proceed without user confirmation
- **Ask**: Actions requiring explicit user approval before execution
- **Never**: Permanently blocked actions that cannot be performed under any circumstances

**Confidence-Based Downgrade:**
- Actions on the Always list can be downgraded to Ask if confidence is below threshold (typically 70%)
- This provides dynamic safety based on system certainty
- Example: Calendar read is normally Always, but with 50% confidence becomes Ask

**Audit Integration:**
- Every boundary check is logged to audit trail
- Records: action, decision, confidence, reasoning, outcome
- Enables post-hoc analysis and accountability

### Implementation Reference

**Canonical Implementation:** `skills/CalendarAssistant/Tools/ApprovalRouter.ts`

CalendarAssistant implements this pattern with domain-specific triggers:
- External attendees (>=3 participants)
- Recurring event deletion
- Protected time block modification
- Low confidence intent classification (<75%)
- All delete operations (safety rule)

### When to Use

Apply this pattern when your skill:
1. Performs actions with user-visible side effects
2. Needs to differentiate between safe and risky operations
3. Should adjust behavior based on classification confidence
4. Requires audit trails for compliance or debugging

### Design Principles

**Separation of Concerns:**
- Rule definitions (constants) separate from enforcement logic (class)
- Each skill defines its own domain-specific action lists
- Enforcement engine is reusable pattern, not shared code

**Default to Safety:**
- Unknown actions default to Ask, never to Always
- Confidence below threshold downgrades to Ask
- Never list is permanent (no confidence override)

**Observable Decisions:**
- Every decision logged with full context
- Reasoning provided for every outcome
- Enables learning and rule refinement over time

### Key Implementation Details

```typescript
// From Kaya's boundary-enforcer.ts (reference implementation)

// Confidence-based downgrade for Always actions
if (baseDecision === 'always' && confidence < CONFIDENCE_THRESHOLD) {
  finalDecision = 'ask';
  reason = `Action is normally auto-approved, but confidence is low. Requesting confirmation.`;
  requiresApproval = true;
}

// Audit logging integration
await auditLogger.log({
  action: `boundary_check:${action}`,
  category: 'boundary',
  input: context,
  reasoning: reason,
  outcome: finalDecision === 'never' ? 'blocked' : finalDecision === 'ask' ? 'pending' : 'success',
  details: { decision, baseDecision, confidence, requiresApproval }
});
```

### Customization Guidelines

Each skill should define its own:
1. **Action lists** - Domain-specific actions (e.g., calendar vs task management)
2. **Confidence thresholds** - Appropriate risk tolerance for the domain
3. **Approval triggers** - What constitutes a high-impact action

**Example: CalendarAssistant customizations**
- Attendee count threshold (3+ requires approval)
- Protected time block definitions
- Recurring event special handling

### Testing Recommendations

1. **Unit tests** - Verify each action maps to correct decision
2. **Confidence tests** - Ensure downgrade triggers at threshold
3. **Audit tests** - Confirm all decisions are logged
4. **Integration tests** - Test real workflows with approval required

### Related Patterns

- **Audit Logging** - Every boundary check should be audited
- **Cost Tracking** - Boundary decisions can influence cost (more LLM calls for low confidence)
- **Progressive Disclosure** - Ask decisions can include contextual help

---

## Future: Cost Observability

**Status:** Design pattern (not yet implemented)
**Prior art:** Kaya skill cost-tracker.ts

### Overview

As the system increasingly uses autonomous agents with LLM inference, cost visibility becomes critical. The Cost Tracking pattern provides per-invocation token accounting, daily budget enforcement, and alert thresholds.

### Core Concepts

**Per-Model Token Tracking:**
- Track input and output tokens separately by model (haiku, sonnet, opus)
- Maintain running cost totals using current API pricing
- Record per-invocation metrics for observability

**Daily Budget Enforcement:**
- Configurable daily budget cap (e.g., $0.50)
- Alert at 80% threshold (warning before hard stop)
- Hard stop at 100% (refuse further invocations)
- Automatic reset at day boundary

**Cost Estimation:**
- Pre-flight cost estimation before expensive operations
- Enables "would this exceed budget?" checks
- Supports cost-aware decision making

### Design from Kaya (Reference)

```typescript
// Token costs per 1K tokens (as of implementation)
const TOKEN_COSTS = {
  haiku: { input: 0.00025, output: 0.00125 },
  sonnet: { input: 0.003, output: 0.015 },
  opus: { input: 0.015, output: 0.075 }
};

// Budget enforcement with graduated response
if (totalCostUsd >= dailyBudget * 0.80 && !budgetAlertSent) {
  // Soft warning at 80%
  alert = `Budget alert: ${percent}% of daily budget used`;
}

if (totalCostUsd >= dailyBudget) {
  // Hard stop at 100%
  budgetExceeded = true;
  alert = `Budget exceeded. Hard stop.`;
}
```

### Why Not Implemented Yet

**Blocking issues:**
1. Claude Code sessions don't currently expose token counts to tools
2. The inference system would need instrumentation to report usage
3. Real cost tracking requires billing API integration or CLI output parsing
4. Estimates are not sufficient for production cost control

**When to implement:**
- When token usage data becomes available via API
- When autonomous work scales to require cost oversight
- When multi-model inference patterns need optimization

### Design Principles for Future Implementation

**Accuracy over Estimation:**
- Use actual reported token counts, not estimates
- Pull pricing from API or config (not hardcoded)
- Handle pricing changes gracefully

**State Persistence:**
- JSON state file with backup-before-write
- Day boundary auto-reset
- Separate budgets per profile or skill (optional)

**Integration Points:**
- Wrap all inference calls in cost tracking
- Emit cost metrics to observability system
- Include cost in audit logs for high-impact actions

**User Control:**
- Per-skill budget overrides
- Temporary budget increases for specific sessions
- Cost reporting in daily briefing

### Reference Implementation

See `skills/Kaya/src/observability/cost-tracker.ts` for a complete reference implementation (207 lines). Note that it's architected correctly but lacks real token data integration.

---

## Pattern Contribution Guidelines

When adding new patterns to this document:

1. **Status** - Clearly mark as "Production-ready", "In development", or "Future"
2. **Reference Implementation** - Link to canonical code that demonstrates the pattern
3. **Prior Art** - Credit skills or external sources that inspired the pattern
4. **When to Use** - Clear criteria for applicability
5. **When NOT to Use** - Anti-patterns and known limitations
6. **Design Principles** - Core architectural decisions
7. **Customization Guidelines** - How to adapt for different domains
8. **Testing Recommendations** - How to verify correct implementation

---

*This document is a living resource. As skills mature and new patterns emerge, update this document to capture institutional knowledge.*
