---
name: prd
description: Synthesize the current conversation context into a Product Requirements Document and write it to MEMORY/WORK/. Do NOT interview — work from what's already in context. USE WHEN prd, write a prd, product requirements document, /prd, capture this as a prd, turn this into a prd, requirements doc, spec from context.
---

# /prd — Synthesize Context Into a PRD

Take the current conversation and codebase understanding and produce a PRD artifact. Do **NOT** interview — work from what's already known.

## When to use

When Jm has been discussing a feature, problem, or initiative and wants to capture the current state as a durable artifact. The conversation already has the context. Your job is to *synthesize*, not to discover.

If important fields are genuinely unknown after exploring the conversation context — flag them in the PRD as `(open)` rather than asking. Asking now stalls the artifact; capturing it as `(open)` keeps the PRD honest and lets `/grillme` or `/grillwithdocs` resolve them later.

## Process

1. **Survey the conversation context.** What is the user actually trying to build, fix, or change? Distinguish problem-statement from solution-direction.

2. **Explore the codebase if needed.** Use the project's domain glossary (`CONTEXT.md` / `CONTEXT-MAP.md`) and check ADRs in the area you're touching. PRD vocabulary should match the project's domain vocabulary, not introduce new terms.

3. **Sketch the major modules.** Use the LANGUAGE.md vocabulary (see `skills/Development/ImproveCodebaseArchitecture/LANGUAGE.md`):
   - Which **modules** will be built or modified?
   - What is the **interface** of each — types, invariants, error modes, ordering?
   - Are there opportunities to extract **deep modules** (small interface, lots of behaviour behind it)?

4. **Apply the deletion test** to anything proposed. If a new module wouldn't concentrate complexity that's currently distributed across N callers, don't propose it.

5. **Write the PRD using the template below.**

6. **Write the artifact to** `MEMORY/WORK/<YYYYMMDD-HHMMSS>_<short-slug>/PRD.md`. Create the directory if needed. Use Bash `date` for the timestamp; pick the slug from the user's framing (kebab-case, ≤6 words).

7. **Show Jm the PRD inline** and the artifact path. Offer to break into vertical-slice issues via the AGENT-BRIEF format (`skills/Automation/AutonomousWork/Templates/AGENT-BRIEF.md`) if the work is multi-step.

## Template

```markdown
# PRD: {Title — what the work delivers}

> Synthesized from conversation on {YYYY-MM-DD}. Source: {chat / voice / cron / handoff}.

## Problem Statement

The problem the user is facing, from the user's perspective. Not the solution, not the architecture — the friction.

## Solution

The solution to the problem, from the user's perspective. Plain English. No file paths, no class names — what the user gets.

## User Stories

A LONG, numbered list of user stories. Format: "As a {actor}, I want {feature}, so that {benefit}."

1. As a ..., I want ..., so that ...
2. ...

The list should be extensive — cover the golden path, edge cases, error states, and the un-glamorous cases (empty state, large dataset, slow connection).

## Implementation Decisions

- The **modules** that will be built or modified (use LANGUAGE.md vocabulary — module / interface / seam / adapter)
- The **interfaces** that will change (types, invariants, error modes, ordering — not just signatures)
- Architectural decisions and the reasoning
- Schema changes
- API contracts
- Specific interactions

Do NOT include file paths or code snippets — they go stale fast.

## Testing Decisions

- A description of what makes a good test in this PRD's scope (behaviour through public interfaces, not implementation details — see `/tdd`)
- Which modules will have tests written, and at what seam
- Prior art: similar tests in the codebase
- Mocking strategy if cross-seam dependencies exist (see `/tdd` mocking.md)

## Out of Scope

What is explicitly NOT being addressed in this PRD. Adjacent features that might seem related but are separate. The explicit "no" is as valuable as the "yes."

## Open Questions

Items still needing resolution. Each should be specific and actionable. If you'd ask the user, write the question here instead.

- (open) Question 1
- (open) Question 2

## Further Notes

Anything else: constraints not visible in the code, references to ADRs, links to related WORK items.
```

## Anti-patterns

- ❌ Asking the user a flurry of questions before writing — that's `/grillme` or `/grillwithdocs`, not `/prd`
- ❌ Including file paths or line numbers — they go stale fast
- ❌ Mixing problem and solution in the same paragraph
- ❌ Skipping "Out of Scope" — implicit scope leads to gold-plating
- ❌ Re-stating the user's framing without sharpening it — if the conversation said "fix the queue thing", the PRD should name what specifically needs to be fixed and what done looks like

## Relationship to existing skills

- **`/grillwithdocs`**: when the conversation lacks enough signal to write a coherent PRD, run grilling first to surface the missing decisions, then come back to `/prd`.
- **`/improvecodebasearchitecture`**: if the PRD touches a deepening opportunity, propose the deepened module shape in the Implementation Decisions section.
- **`/tdd`**: the Testing Decisions section should reference the public-interface-test discipline.
- **`/work` AGENT-BRIEF**: a PRD becomes one or more AGENT-BRIEFs when broken into vertical-slice issues. The PRD lives at the feature level; AGENT-BRIEFs live at the slice level.
