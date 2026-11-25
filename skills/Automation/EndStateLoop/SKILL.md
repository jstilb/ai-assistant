---
name: EndStateLoop
description: Run a product build over many sessions toward a stated end state without drift, with a scoreboard that has one row per end-state sentence, an outside examiner that marks it, a per-project orchestrator that spawns one-unit builder sessions, and a no-move gate. USE WHEN end-state loop, project loop, loop drift, scoreboard, end-state board, examiner, exam a loop, orchestrator session, conductor, loop check, check in on the loops, set up a loop, convert a loop, loop status page, status update, feedback to the orchestrator, OR meaningful progress toward an end state.
---

# EndStateLoop

A loop that marks its own work drifts. This skill moves the judgment of progress out of the loop: the end state is an exam in a file, an outside session marks it, and the session that plans the work never builds and never marks.

The core files say what to do. The evidence, dated incidents and quotes behind each rule are in `Reference/WHY.md` (one section per file and step); read it only for the why.

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
| **Orchestrator** (one per project) | Ranks the red rows by their effect on the key drivers, takes the top one, writes a unit contract, spawns and closes sessions, merges and deploys after a pass | Edits product code. Marks a row. Writes the examiner's brief or sets. Acts on a report without evidence on disk |
| **Builder** (one per unit) | Builds one unit from its contract, runs its own checks, writes `RESULT.md`, ends | Touches the board or the exam folder. Spawns a successor. Goes past 40 % context (then the unit was too large) |
| **Examiner** (outside the loop) | Runs the row's frozen pass rule on the real product with a set that the builder never saw. Writes marks. Runs the product review and may propose an order | Reuses a set. Takes the builder's own test or prose as proof. Marks with a judge that did not pass its own test |

## The board

One file per project, `SCOREBOARD.json`, one row per sentence of the end state. Tool: `bun ~/.claude/skills/Automation/EndStateLoop/Tools/Board.ts`. The board is **not** in git: it lives at one fixed path outside every worktree, in the project's ignored data folder or its evidence folder (Learn: `data/endstate/`; the edition: `~/projects/intake-backups/endstate/`). The project's `AGENTS.md` and each orchestrator handoff carry the line `Board: <absolute path>`. The tool locks each write and keeps the last version as `SCOREBOARD.json.bak`; the `marks` and `units` lists are the history. The board folder also holds `EXAMINER-BRIEF.md`, `units/`, `requests/` (one exam request per examiner session), `exam/` (sets and evidence), `REVIEW-<n>.md`, `REPLAN-<row>.md`, `KEY-DRIVERS-<n>.md` and `HOLES.md`.

| Status | Meaning |
|---|---|
| `proven` | The examiner ran the frozen pass rule on a never-seen set, and it passed |
| `claimed` | The loop's own test passes. No outside exam yet |
| `failed` | The last run of the frozen rule failed |
| `untested` | No test without a person exists, or it never ran |

**Progress** is the end-state path, run end to end by an agent on the real product as Jm would use it, with before and after images of what changed. Each handoff and report to Jm opens with it per key driver (`KEY-DRIVERS-<n>.md`): did what Jm receives get better, yes or no. Rows `proven` is a support count, not progress.

## Status page

Jm reads every loop on one private claude.ai page: **https://claude.ai/artifact/HYZQ2KKQxtwphAwRGs8kXb** (source `Tools/StatusPage.html`). Jm's words that define it, and the orchestrator's steps: `Workflows/Orchestrate.md`, section "Status page". If you change the page, read `Workflows/StatusPageChange.md` first.

The page is a copy of the record on disk next to the board (`status/`; Orchestrate.md, "Status page"); only a Claude session writes it (ArtifactData). Store rule: only the owner writes (a Contributor-level write is refused).

## Rules

Jm's words (sources: `~/.claude/CLAUDE.md`, each project's `FEEDBACK.md`):
- No row waits on Jm. "why can't we test the end state without me? none of the end state is unverifiable … do not take the easy way out" (2026-11-09). Jm does the final check only.
- No use is measured or reported during the build: "i am not using edition or learn until they are completed. so they need to stop trying to measure usage. this was stated directly a while back. same goes for all projects at this time" (2026-11-18, F-030). The end state's use-based final check is read only at Jm's final test.
- No limit claim without a test. Before "cannot", "not reachable", "blocked" or "no data" (in a report, a contract, a wait or a handoff lesson), name the test and its result; else write "not tested".
- Only Jm stops a plan (2026-11-08). A re-plan is not a stop. A gate that waits on Jm gets one question with a default.
- No stall (2026-11-18, edition F-025, form-doc F-010): "i want to ensure they are unblociking themselves and not taking the easy way out. these should not be stalling". A failed test tool, a wait for data and a weak first check do not stop product work (Orchestrate steps 2-3).
- Handoff at 40 % context (2026-10-27), by the Handoff skill. Free the work memory that is no longer needed (2026-11-08).

Kaya's design rules (change them with evidence):
- A test with a known answer comes first: planted faults, planted items, planted facts, held-out samples. A judge marks a row only after the judge passed its own test.
- The pass rule is in the board before the run. A set is used once; after the run it is burned.
- A unit fits one builder session. Two closed units in a row with no board move: the orchestrator re-plans with a different approach (Orchestrate step 1; `Board.ts gate` exits 5 and `unit-open` refuses until then). A move is a unit that closed `pass` and put a change live (`--shipped` is not `none`); a row mark is not needed. A unit that shipped nothing is not a move, even when its row went up.
- After each merge, a fresh reviewer audits the unit's claims against the product (`Workflows/Check.md`, "Claim audit (per merge)"; `Tools/ClaimAudit.ts` when a driver, not a Claude orchestrator, runs it). A failed audit revokes the move (`Board.ts unit-audit`).
- **Bars for "met"** (Jm form-doc F-029, 2026-11-24): a small-v1 current bet lists, for each item, the measured number now with its source (an exam or a product output, never a builder claim), the bar, and the test. Every status post gives 2 or 3 driver numbers with `Status.ts post --number "LABEL|NOW|BEFORE|BAR"`. Examples: edition `intake/AGENTS.md` "Bars for met"; form-doc `AGENTS.md`.
- Each unit is a `product` unit: it changes what Jm receives. A test tool is built only inside a driver's product unit; product units never wait for a row's test tool or mark. A row's test rule has at most 2 versions; then the examiner judges the product directly (Exam step 2).
- At most 2 builders per project at one time (16 GB Mac), and only on rows that touch different code.
- Heavy runs go through `Tools/runlock.sh <lock dir> <session name> <command…>` with the two locks that the examiner brief names (Learn: `data/endstate/RUN.lock` and `data/endstate/MODEL.lock`): the memory lock for one memory-heavy run at a time (a browser, a test suite over the product, a copy server, a fault run); the model lock for one batch of model calls at a time. A run that needs both gives both in one call, the memory lock first (`runlock.sh <memory lock>,<model lock> <you> <command…>`). Never nest two runlock calls (the tool refuses). Waiters queue first come, first served (tickets in `<lock>.queue/`); only the merge check of a proven unit runs with `RUNLOCK_FIRST=1`, and it goes first. Never remove a lock that you do not own.
- A copy of the data is not a copy of a shared quota. Free model pools and API limits that the live product uses are live resources: each contract and brief names them and the cap for test runs.
- A daemon restart kills every background session. Resume each one with `claude --bg --resume <sessionId>` and no flags (with flags the CLI starts a copy with a new id). Before any resume, stop or rm of a session, commit and push its branch. Long runs work in a `git worktree add` tree.
- A wait is not a session: end the turn, and wake on the done message. While you wait (a builder, a lock, a long run), keep one background command in flight (`run_in_background`; the orchestrator: `Tools/waitboard.sh`): the daemon retires a background session that sits idle at its prompt with nothing in flight after about 60 min. Stop every process that you started.
- Marks are a convention, not a lock: the threat is honest drift, not forgery. `Board.ts` refuses a `proven` mark without the examiner role, a set id and evidence on disk.
- **The weekly-usage stop.** `~/.claude/bin/loop-usage-guard.sh --chain <your session name>`: the orchestrator at the start of each session; a builder or an examiner before each slice or batch of model calls. There is no earlier line: below the limit, work as usual. At exit 3, the orchestrator saves, writes a PAUSED handoff, starts nothing, reports and stops (only Jm's word resumes); a builder or an examiner commits and pushes what is done, writes `RESULT.md` or its report with the steps left, reports and stops.
- **No permission prompts** (builder, examiner): a prompt hangs a background session. Do not run `rm`: move a file to `~/.Trash`, or leave scratch in your job tmp. If a command is refused, take another way; do not run it again.

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
| **Watch** | a session started as `endstate-setup-N`; "watch the loops" | `Workflows/Watch.md` |
| **ForeignLoop** | a loop whose orchestrator runs on a non-Claude model CLI (Gemini `agy`) | `Workflows/ForeignLoop.md` |

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
→ spawn builder formdoc-unit-U12; start waitboard.sh in the background; end the turn; wake on its done message
→ examiner marks R4; on a pass merge and close the sessions
```

**Example 3: A check from outside**
```
Jm: "check in on the ongoing loops"
→ Check: read each board, the job states and the newest results against the disk
→ report alive / per key driver: better, yes or no / drift signs / usage; send findings to the orchestrators
```

## Quick Reference

Commands and tool usage: `Reference/QUICK-REFERENCE.md`. Templates: `Templates/UnitContract.md`, `Templates/ExaminerBrief.md`, `Templates/OrchestratorStart.md`.

## Integration

### Uses
- **Handoff** (`Automation/Handoff/SKILL.md`): the 40 % handoff and `bin/claude-handoff-spawn.sh` (it runs `Board.ts gate` when a handoff has a `Board:` line).
- **ProjectStandard** (`Development/ProjectStandard/SKILL.md`): `AGENTS.md`, `FEEDBACK.md`, the product review.
- `bin/loop-usage-guard.sh`: the weekly-usage stop.

### Feeds Into
- Each project's `SCOREBOARD.json` and `FEEDBACK.md`; LucidTasks parent task of the project.
- The status page (https://claude.ai/artifact/HYZQ2KKQxtwphAwRGs8kXb): a fourth door for Jm's project feedback (ProjectStandard, point 3), in the same item format.

**Last Updated:** 2026-11-18
