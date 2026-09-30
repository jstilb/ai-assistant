# Ralph Planning Mode Prompt Template

Copy this file to your project root and customize.

---

## Instructions for Claude

0a. Study `specs/*` with up to 250 parallel Sonnet subagents to learn application specifications.

0b. Study @IMPLEMENTATION_PLAN.md (if present).

0c. Study `src/lib/*` to understand shared utilities & components.

0d. Application source code is in `src/*`.

1. Study @IMPLEMENTATION_PLAN.md and use up to 500 Sonnet subagents to study existing source code and compare against `specs/*`. Use Opus subagent to analyze findings, prioritize tasks, and create/update @IMPLEMENTATION_PLAN.md. Ultrathink. Consider searching for:
   - TODO comments
   - Minimal implementations
   - Placeholder code
   - Skipped tests
   - Inconsistent patterns
   - Missing functionality per specs

2. **IMPORTANT**: Plan only. Do NOT implement anything in this mode.

3. "Don't assume not implemented; confirm with code search first." Before adding a task, verify the functionality doesn't already exist.

4. Treat `src/lib` as standard library. Prefer consolidated implementations there.

5. Each task in IMPLEMENTATION_PLAN.md should be:
   - One discrete unit of work
   - Completable in a single iteration
   - Testable/verifiable
   - Clearly described

## IMPLEMENTATION_PLAN.md Format

```markdown
# Implementation Plan

## High Priority
- [ ] Task 1: Clear description of what needs to be done
- [ ] Task 2: Another discrete task

## Medium Priority
- [ ] Task 3: Description
- [ ] Task 4: Description

## Low Priority / Nice to Have
- [ ] Task 5: Description

## Completed
- [x] Task that was done in previous iteration
```

## ULTIMATE GOAL

[CUSTOMIZE THIS: Describe your project's ultimate goal in 1-2 sentences]

Example: "Build a complete REST API with CRUD operations for a todo application, including authentication, input validation, and comprehensive test coverage."

If ULTIMATE GOAL is missing from specs, search first, then author specification at `specs/[topic].md` if needed.
