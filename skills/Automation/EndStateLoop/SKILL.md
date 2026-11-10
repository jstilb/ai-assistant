---
name: EndStateLoop
description: Run a product build over many sessions toward a stated end state without drift, with a scoreboard that has one row per end-state sentence, an outside examiner that marks it, a per-project orchestrator that spawns one-unit builder sessions, and a no-move gate. USE WHEN end-state loop, project loop, loop drift, scoreboard, end-state board, examiner, exam a loop, orchestrator session, conductor, loop check, check in on the loops, set up a loop, convert a loop, OR meaningful progress toward an end state.
---

# EndStateLoop

A loop that marks its own work drifts. This skill moves the judgment of progress out of the loop: the end state is an exam in a file, an outside session marks it, and the session that plans the work never builds and never marks.

Jm, 2026-11-09 (verbatim): "go ahead and build it, starting with the scoreboards. make a skill for this type of workflow so we can use it again in the future."

## Why (evidence, 2026-11-09)

- Learn caught 16 of 16 of its own planted faults, and 6 of 10 from an independent writer. One miss was the week count, its success measure.
- The edition's judge that plays Jm failed its test twice. The next test used the same kind of judge, so a fail could not show which part was wrong.
- One session that plans, builds and marks: 12 handoffs in 10 hours (Learn). A conductor with bounded chains: 10 of 10 plans in about 9 hours with 2 conductor sessions (deepening, 2026-11-08).

## The pattern

```
 FILES (the state)                    SESSIONS (short, one purpose each)

 SCOREBOARD.json <---- marks -------  EXAMINER      fresh never-seen set, fixed brief
     |                                    ^
     | top red row                        | "unit ready"
     v                                    |
 unit contract   <---- writes ------  ORCHESTRATOR  one per project; it loops
     |                                    |
     | the only input                     | spawns and closes
     v                                    v
 RESULT.md       <---- writes ------  BUILDER       one unit, own worktree, no successor
```

| Role | Does | Never |
|---|---|---|
| **Orchestrator** (one per project) | Reads the board, takes the top red row, writes a unit contract, spawns and closes sessions, merges and deploys after a pass | Edits product code. Marks a row. Writes the examiner's brief or sets. Acts on a report without evidence on disk |
| **Builder** (one per unit) | Builds one unit from its contract, runs its own checks, writes `RESULT.md`, ends | Touches the board or the exam folder. Spawns a successor. Goes past 40 % context (then the unit was too large) |
| **Examiner** (outside the loop) | Runs the row's frozen pass rule on the real product with a set that the builder never saw. Writes marks. Runs the product review and re-ranks red rows | Reuses a set. Takes the builder's own test or prose as proof. Marks with a judge that did not pass its own test |

## The board

One file per project, `SCOREBOARD.json`, with one row per sentence of the end state. Tool: `bun ~/.claude/skills/Automation/EndStateLoop/Tools/Board.ts`.

The board is **not** tracked in git. The orchestrator and the examiner both write it from different worktrees, so it lives at one fixed path outside every worktree: the project's ignored data folder or its evidence folder (Learn: `data/endstate/`; the edition: `~/projects/intake-backups/endstate/`). The project's `AGENTS.md` and each orchestrator handoff carry the line `Board: <absolute path>`. The tool locks each write, keeps the last version as `SCOREBOARD.json.bak`, and the `marks` and `units` lists are the history. The same folder holds `EXAMINER-BRIEF.md`, `units/`, `requests/` (one exam request per examiner session), `exam/` (sets and evidence), `REVIEW-<n>.md` and `REPLAN-<row>.md`.

| Status | Meaning |
|---|---|
| `proven` | The examiner ran the frozen pass rule on a never-seen set, and it passed |
| `claimed` | The loop's own test passes. No outside exam yet |
| `failed` | The last run of the frozen rule failed |
| `untested` | No test without a person exists, or it never ran |

Progress is one number: rows `proven` of all rows. Each handoff and each report to Jm opens with it.

## Rules

Jm's words (sources: `~/.claude/CLAUDE.md`, each project's `FEEDBACK.md`):
- No row waits on Jm. "why can't we test the end state without me? none of the end state is unverifiable … do not take the easy way out" (2026-11-09). Jm does the final check only.
- No limit claim without a test. Before "cannot", "not reachable" or "no data", name the test and its result; else write "not tested".
- Only Jm stops a plan (2026-11-08). A re-plan is not a stop. A gate that waits on Jm gets one question with a default.
- Handoff at 40 % context (2026-10-27), by the Handoff skill. Free the work memory that is no longer needed (2026-11-08).

Kaya's design rules (change them with evidence):
- A test with a known answer comes first: planted faults, planted items, planted facts, held-out samples. A judge marks a row only after the judge passed its own test.
- The pass rule is in the board before the run. A set is used once; after the run it is burned.
- A unit fits one builder session. Two closed units in a row with no board move: the orchestrator re-plans the top red row with a different approach (`Board.ts gate` exits 5). A move is a unit that closed `pass` and whose own row went up (untested < failed < claimed < proven). A mark on another row is not a move (since 2026-11-09: the first rule counted any status change on the board, so parallel exams hid 4 failed units).
- At most 2 builders per project at one time (16 GB Mac). One heavy run (a test suite over the product, a fault run, a batch of model calls) at a time per Mac: `Tools/runlock.sh <lock dir> <session name> <command…>`. Never remove a lock that you do not own.
- A copy of the data is not a copy of a shared quota. Free model pools and API limits that the live product uses are live resources: each contract and brief names them and the cap for test runs.
- A wait is not a session: end the turn, wake on the builder's idle notice.
- Marks are a convention, not a lock: the threat is honest drift, not forgery. `Board.ts` refuses a `proven` mark without the examiner role, a set id and evidence on disk.

## Workflow Announcement

```
Running the **WorkflowName** workflow in the **EndStateLoop** skill to ACTION...
```

## Workflow Routing

| Workflow | Trigger | File |
|----------|---------|------|
| **Setup** | "set up a loop", "write the scoreboard", "convert a loop" | `Workflows/Setup.md` |
| **Orchestrate** | a session started as a project's orchestrator | `Workflows/Orchestrate.md` |
| **Build** | a session started from a unit contract | `Workflows/Build.md` |
| **Exam** | a session started from an examiner brief; "exam the loop", "product review" | `Workflows/Exam.md` |
| **Check** | "check in on the loops", "are the loops making progress" | `Workflows/Check.md` |

## Examples

**Example 1: A new project loop**
```
Jm: "set up a loop for form-doc"
→ Setup: write SCOREBOARD.json from the end-state text, one row per sentence
→ write the examiner brief and the orchestrator start file from Templates/
→ start the orchestrator in the project folder; report the board to Jm
```

**Example 2: The orchestrator's turn**
```
Session formdoc-orch-3 starts from its handoff
→ Orchestrate: Board.ts gate → Board.ts next → unit contract for row R4
→ spawn builder formdoc-unit-U12; end the turn; wake on its idle notice
→ examiner marks R4; on a pass merge and close the sessions
```

**Example 3: A check from outside**
```
Jm: "check in on the ongoing loops"
→ Check: read each board, the job states and the newest results against the disk
→ report alive / board number / drift signs / usage; send findings to the orchestrators
```

## Quick Reference

Shell variables do not last between Bash calls, and zsh does not split `$B` into words. Set `T` in the same call and write `bun $T …`:

```bash
T=$HOME/.claude/skills/Automation/EndStateLoop/Tools/Board.ts
bun $T show <board>                  # table + "N of M proven" + stall count
bun $T validate <board>              # schema, ids, evidence paths; exit 1 when invalid
bun $T next <board>                  # the top red row as JSON
bun $T gate <board>                  # exit 5: two units with no move → re-plan
bun $T set-test <board> --row R --name N --kind known-answer --pass-rule "…" [--command C] [--rule-file F]
bun $T mark <board> --row R --status proven --by learn-exam-1 --role examiner --set <id> --evidence <p1,p2> --note "…"
bun $T rank <board> --order R4,R2,R7 --by learn-exam-1
bun $T unit-open <board> --row R --contract <path> --builder <session>
bun $T unit-close <board> --unit U3 --result pass|fail|too-large --note "…"
~/.claude/skills/Automation/EndStateLoop/Tools/runlock.sh <lock dir> <session name> <command…>   # one heavy run at a time
```

Templates: `Templates/UnitContract.md`, `Templates/ExaminerBrief.md`, `Templates/OrchestratorStart.md`.

## Integration

### Uses
- **Handoff** (`Automation/Handoff/SKILL.md`): the 40 % handoff and `bin/claude-handoff-spawn.sh` (it runs `Board.ts gate` when a handoff has a `Board:` line).
- **ProjectStandard** (`Development/ProjectStandard/SKILL.md`): `AGENTS.md`, `FEEDBACK.md`, the product review.
- `bin/loop-usage-guard.sh`: the weekly-usage stop.

### Feeds Into
- Each project's `SCOREBOARD.json` and `FEEDBACK.md`; LucidTasks parent task of the project.

**Last Updated:** 2026-11-09
