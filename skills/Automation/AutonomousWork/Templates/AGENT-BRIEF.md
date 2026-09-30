# AGENT-BRIEF Format for Work Queue Items

The contract every work-queue spec should follow before being handed to a TaskOrchestrator. Distilled from Matt Pocock's `to-issues` / `triage` skills, adapted to Kaya's WORK queue model.

## Why this format

A work-queue item may sit in `MEMORY/QUEUES/approved-work.jsonl` (or `MEMORY/WORK/work-queue.json`) for hours, days, or weeks before a TaskOrchestrator picks it up. The codebase will change in the meantime. The brief must stay useful even as files are renamed, moved, or refactored.

**Durability over precision.** **Behavioural, not procedural.** **Complete acceptance criteria.** **Explicit out-of-scope.**

- ✅ Describe interfaces, types, behavioural contracts.
- ✅ Name specific types, function signatures, or config shapes the agent should look for.
- ❌ Do NOT reference file paths or line numbers — they go stale.
- ❌ Do NOT assume the current implementation structure will remain the same.

## Template

```markdown
## Agent Brief

**Category:** bug / enhancement
**Summary:** one-line description of what needs to happen

**Current behavior:**
What happens now. For bugs, this is the broken behavior. For enhancements,
this is the status quo the feature builds on.

**Desired behavior:**
What should happen after the agent's work is complete. Be specific about
edge cases and error conditions.

**Key interfaces:**
- `TypeName` — what needs to change and why
- `functionName()` return type — what it currently returns vs what it should return
- Config shape — any new configuration options needed

**Acceptance criteria:**
- [ ] Specific, testable criterion 1
- [ ] Specific, testable criterion 2
- [ ] Specific, testable criterion 3

**Out of scope:**
- Thing that should NOT be changed or addressed in this issue
- Adjacent feature that might seem related but is separate

**Slice type:** AFK (agent can complete without human) / HITL (needs human decision)
**Blocked by:** item-id-of-prerequisite, or "None"
```

## Worked example (good)

```markdown
## Agent Brief

**Category:** bug
**Summary:** WorkQueue CLI clobbers status updates when prepare/started run after reload

**Current behavior:**
The WorkQueue CLI's `prepare` and `started` subcommands reload the queue from
disk before mutating, then write back. When called after an in-memory status
mutation, the disk reload silently overwrites the in-memory change.

**Desired behavior:**
Status mutations should be atomic with respect to CLI reloads. Either the CLI
acquires a lock, or callers do all CLI ops first and then perform a single
atomic status update at the end.

**Key interfaces:**
- The WorkQueue mutation interface — `started()`, `prepare()`, `updateStatus()` should not silently lose updates when interleaved
- Whatever load/save path mediates between disk and in-memory state

**Acceptance criteria:**
- [ ] Calling `prepare()` after an in-memory status change preserves the change
- [ ] Test case: mutate status in-memory → call `prepare()` → verify status still applied
- [ ] No silent overwrite of in-memory state by disk reload

**Out of scope:**
- Replacing JSON storage with a real database
- Migrating the dual-queue (QUEUES/ vs WORK/) to a single store

**Slice type:** AFK
**Blocked by:** None
```

## Anti-patterns

- "Fix the queue bug" — no category, vague description, no criteria
- "Open WorkQueue.ts and modify line 224" — file path + line, will go stale
- "Make it work right" — not testable
- "Fix everything related" — no scope boundaries, gold-plating risk

## Where to apply

- **`/work` queue items**: every item entering the queue should have this shape in its spec/brief.
- **Manual TaskOrchestrator spawning**: when calling Task() with a TaskOrchestrator subagent, pass a brief in this format.
- **Cross-session work handoff**: same — assume the next session knows nothing.

## Relationship to existing memory

- `feedback_work_orchestration_mandatory.md` says spawn Opus TaskOrchestrators per item — this brief is the *contract* the orchestrator consumes
- `project_report_done_pitfalls.md` lists three SkepticalVerifier failure modes — a well-formed AGENT-BRIEF prevents most of them by making "what counts as done" explicit upfront
