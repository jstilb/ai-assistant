# QuickSpec Workflow

**Abbreviated specification generation with 5 focused questions.**

Use when:
- Time is limited
- Agent/task is well-understood
- Minimal documentation needed
- Rapid prototyping

## Quick Interview (5 Questions)

### Question 1: Identity & Purpose
```
Header: "What"
Question: "What is this agent called and what does it do? (Name + one sentence purpose)"
Options: [Text input]
```

### Question 2: User Story & Priority
```
Header: "User Story"
Question: "Describe the primary user story: As a [who], I want [what] so that [why]. Priority?"
Options:
- "P1 - Core" - Must have for the agent to be useful
- "P2 - Supporting" - Enhances the core but not essential
- "P3 - Enhancement" - Nice to have, can defer
```

### Question 3: Input/Output
```
Header: "I/O"
Question: "What goes in and what comes out?"
Options: [Text input - format: "IN: description → OUT: description"]
```

### Question 4: Key Constraint
```
Header: "Constraint"
Question: "What's the ONE most important constraint or guardrail?"
Options: [Text input]
```

### Question 5: Success Metric
```
Header: "Success"
Question: "How do you know it worked?"
Options:
- "Output matches expected format"
- "Human approves result"
- "Automated test passes"
- "Measurable metric met"
```

## Quick Template

Generate this minimal spec:

```markdown
# {{AGENT_NAME}} - Quick Spec

**Purpose:** {{PURPOSE}}

## User Story
**As a** {{USER_ROLE}}, **I want** {{CAPABILITY}} **so that** {{BENEFIT}}.
**Priority:** {{PRIORITY}}

## Input → Output
**In:** {{INPUT}}
**Out:** {{OUTPUT}}

## Key Constraint
🚫 {{CONSTRAINT}}

## Success Criteria
✅ {{SUCCESS_METRIC}}

## Commands
```
{{INFERRED_COMMANDS}}
```

---
*Quick spec generated {{DATE}}. Expand with full CreateSpec workflow for complete specification.*
```

## Inference

From the 5 answers, infer:
- Likely tools needed
- Basic workflow steps
- Common boundaries for this type
- Suggested test cases

Include an "Expand This Spec" section with prompts to fill gaps.
