# Ralph Building Mode Prompt Template

Copy this file to your project root and customize.

---

## Instructions for Claude

0a. Study `specs/*` with up to 500 parallel Sonnet subagents to learn application specifications.

0b. Study @IMPLEMENTATION_PLAN.md to understand current priorities.

0c. Application source code is in `src/*`. Shared utilities are in `src/lib/*`.

1. **Implement functionality per specifications** using parallel subagents:
   - Follow @IMPLEMENTATION_PLAN.md
   - Choose the MOST IMPORTANT uncompleted item
   - Before making changes, search codebase first
   - "Don't assume not implemented; confirm with code search first"
   - Use up to 500 Sonnet subagents for searches/reads
   - Use only 1 subagent for build/tests (prevents race conditions)
   - Use Opus subagents for complex reasoning
   - Ultrathink before implementing

2. **After implementing, run tests.** "If functionality is missing then it's your job to add it as per specifications."

3. **When discovering issues**, immediately update @IMPLEMENTATION_PLAN.md:
   - Add new tasks for discovered issues
   - When resolved, mark item as complete and remove from list

4. **When tests pass**:
   - Update @IMPLEMENTATION_PLAN.md (mark current task done)
   - `git add -A`
   - `git commit -m "Descriptive message of what was implemented"`
   - `git push`

## Priority Rules (in descending order)

99999. When authoring documentation, capture the why, not just the what.

999999. Single sources of truth. No migrations, adapters, or duplicate implementations.

9999999. Create git tag when no errors remain (starting at 0.0.0).

99999999. Implement functionality completely—no placeholders, no TODOs, no "implement later" comments.

999999999. Tests must pass before committing. No broken tests in commits.

9999999999. Keep @AGENTS.md operational only—status notes belong in IMPLEMENTATION_PLAN.md.

## Backpressure Commands

Before committing, ensure these pass:

```bash
bun run typecheck  # or: tsc --noEmit
bun run lint       # or: eslint .
bun run test       # or: jest / vitest
bun run build      # verify build succeeds
```

If any fail, fix before committing. The commit MUST leave the codebase in a working state.

## ULTIMATE GOAL

[CUSTOMIZE THIS: Same as in PROMPT_plan.md]

## Completion Promise

When the current task is FULLY COMPLETE with passing tests:

```
<promise>TASK_COMPLETE</promise>
```

When ALL tasks in IMPLEMENTATION_PLAN.md are complete:

```
<promise>ALL_COMPLETE</promise>
```

Only output these promises when truly complete—premature promises break the loop.
