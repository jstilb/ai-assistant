# Human Task Overlay

> *Apply this overlay to Current Work specs for tasks requiring human involvement*

---

## A. Human-in-the-Loop Points

### Decision Points Requiring Human Input

| Decision Point | Context | What Human Provides | Timing |
|----------------|---------|---------------------|--------|
| {{DECISION_1}} | {{CONTEXT}} | {{INPUT_NEEDED}} | {{WHEN}} |
| {{DECISION_2}} | {{CONTEXT}} | {{INPUT_NEEDED}} | {{WHEN}} |
| {{DECISION_3}} | {{CONTEXT}} | {{INPUT_NEEDED}} | {{WHEN}} |

### Information AI Cannot Determine

| Information | Why Human Needed | How to Request |
|-------------|------------------|----------------|
| {{INFO_1}} | {{RATIONALE}} | {{METHOD}} |
| {{INFO_2}} | {{RATIONALE}} | {{METHOD}} |
| {{INFO_3}} | {{RATIONALE}} | {{METHOD}} |

### Quality Gates Requiring Human Approval

| Gate | Criteria | Approver | SLA |
|------|----------|----------|-----|
| {{GATE_1}} | {{CRITERIA}} | {{ROLE}} | {{TIMEFRAME}} |
| {{GATE_2}} | {{CRITERIA}} | {{ROLE}} | {{TIMEFRAME}} |
| {{GATE_3}} | {{CRITERIA}} | {{ROLE}} | {{TIMEFRAME}} |

---

## B. Approval Workflow

### Approval Stages

```
Stage 1: {{STAGE_NAME}}
├── Approver: {{ROLE/PERSON}}
├── Criteria: {{APPROVAL_CRITERIA}}
├── Escalation: {{IF_NO_RESPONSE}}
└── Timeout: {{TIMEFRAME}}

Stage 2: {{STAGE_NAME}}
├── Approver: {{ROLE/PERSON}}
├── Criteria: {{APPROVAL_CRITERIA}}
├── Escalation: {{IF_NO_RESPONSE}}
└── Timeout: {{TIMEFRAME}}

Stage 3: {{STAGE_NAME}} (Final)
├── Approver: {{ROLE/PERSON}}
├── Criteria: {{APPROVAL_CRITERIA}}
├── Escalation: {{IF_NO_RESPONSE}}
└── Timeout: {{TIMEFRAME}}
```

### Approval Request Format

```markdown
## 🔔 Approval Request: {{REQUEST_TYPE}}

**Requested By:** {{REQUESTOR}}
**Date:** {{DATE}}
**Priority:** {{LOW|MEDIUM|HIGH|URGENT}}

### Summary
{{BRIEF_DESCRIPTION}}

### Context
{{RELEVANT_BACKGROUND}}

### What Needs Approval
{{SPECIFIC_ITEM}}

### Impact
- **If Approved:** {{OUTCOME}}
- **If Denied:** {{ALTERNATIVE_PATH}}

### Supporting Information
{{LINKS_OR_ATTACHMENTS}}

### Deadline
{{WHEN_NEEDED_BY}}

---
**[APPROVE]** | **[DENY]** | **[REQUEST CHANGES]** | **[DEFER]**
```

### Approval Response Handling

| Response | Action |
|----------|--------|
| APPROVE | Proceed to next stage or execute |
| DENY | Log reason, notify requestor, close or revise |
| REQUEST CHANGES | Return to preparation with specific feedback |
| DEFER | Schedule follow-up, continue other work |
| NO RESPONSE | Escalate per timeout policy |

---

## C. Context Handoff

### AI → Human Handoff

*What AI prepares before human involvement:*

| Handoff Point | AI Prepares | Format | Location |
|---------------|-------------|--------|----------|
| {{POINT_1}} | {{PREPARED_CONTENT}} | {{FORMAT}} | {{WHERE}} |
| {{POINT_2}} | {{PREPARED_CONTENT}} | {{FORMAT}} | {{WHERE}} |
| {{POINT_3}} | {{PREPARED_CONTENT}} | {{FORMAT}} | {{WHERE}} |

**Handoff Package Template:**
```markdown
## Handoff: {{TASK_NAME}}

### Executive Summary
{{ONE_PARAGRAPH_SUMMARY}}

### Current State
{{WHERE_WE_ARE}}

### What's Needed From You
{{SPECIFIC_ASK}}

### Options (if applicable)
1. {{OPTION_1}} - {{PROS_CONS}}
2. {{OPTION_2}} - {{PROS_CONS}}
3. {{OPTION_3}} - {{PROS_CONS}}

### Recommended Action
{{RECOMMENDATION_WITH_RATIONALE}}

### Supporting Materials
- {{LINK_1}}
- {{LINK_2}}

### Deadline
{{WHEN_NEEDED}}

### How to Respond
{{INSTRUCTIONS}}
```

### Human → AI Handoff

*What human provides back to AI:*

| Return Point | Human Provides | Expected Format | Validation |
|--------------|----------------|-----------------|------------|
| {{POINT_1}} | {{HUMAN_INPUT}} | {{FORMAT}} | {{HOW_VALIDATED}} |
| {{POINT_2}} | {{HUMAN_INPUT}} | {{FORMAT}} | {{HOW_VALIDATED}} |
| {{POINT_3}} | {{HUMAN_INPUT}} | {{FORMAT}} | {{HOW_VALIDATED}} |

**Response Capture Template:**
```markdown
## Response: {{ORIGINAL_REQUEST}}

### Decision
{{APPROVE|DENY|MODIFY|OTHER}}

### Rationale
{{WHY_THIS_DECISION}}

### Additional Context (if any)
{{CONTEXT_FOR_AI}}

### Constraints or Requirements
{{THINGS_TO_CONSIDER}}

### Follow-up Needed?
{{YES_NO_AND_WHAT}}
```

---

## D. Communication Preferences

### Notification Channels

| Priority | Primary Channel | Fallback | Escalation |
|----------|-----------------|----------|------------|
| LOW | {{CHANNEL}} | {{FALLBACK}} | After {{TIME}} |
| MEDIUM | {{CHANNEL}} | {{FALLBACK}} | After {{TIME}} |
| HIGH | {{CHANNEL}} | {{FALLBACK}} | After {{TIME}} |
| URGENT | {{CHANNEL}} | {{FALLBACK}} | Immediate |

### Communication Style

- **Tone:** {{FORMAL|CASUAL|TECHNICAL}}
- **Detail Level:** {{SUMMARY|DETAILED|COMPREHENSIVE}}
- **Format Preference:** {{BULLETS|PROSE|STRUCTURED}}

### Availability Constraints

| Day | Available Hours | Timezone |
|-----|-----------------|----------|
| Weekdays | {{HOURS}} | {{TZ}} |
| Weekends | {{HOURS_OR_UNAVAILABLE}} | {{TZ}} |
| Holidays | {{POLICY}} | - |

---

## E. Escalation Contacts

| Level | Contact | When to Escalate | Method |
|-------|---------|------------------|--------|
| L1 | {{PERSON_ROLE}} | {{CRITERIA}} | {{METHOD}} |
| L2 | {{PERSON_ROLE}} | {{CRITERIA}} | {{METHOD}} |
| L3 | {{PERSON_ROLE}} | {{CRITERIA}} | {{METHOD}} |

---

*This overlay extends the Current Work spec with human-in-the-loop considerations. Apply by filling in the placeholders above and appending to Section 8 of the Current Work template.*
