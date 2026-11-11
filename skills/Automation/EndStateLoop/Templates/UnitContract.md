# Unit <U-id>: <short name> (row <R-id>, project <name>)

You are a builder in an end-state loop. Read `~/.claude/skills/Automation/EndStateLoop/Workflows/Build.md` first, then `<project folder>/AGENTS.md`. Then do this unit and end. You have no successor.

Written by: <orchestrator session> · <date via `date`>

## The row
- **Sentence (the end state, verbatim):** "<row.sentence>" (`<row.source>`)
- **Status now:** <failed | untested> · **Gap:** <row.gap>
- **What the examiner will run after you** (frozen, from the board): <row.test.passRule>

## The unit
- **Kind:** product | test (`unit-open --kind`). product = changes what Jm receives; a test harness that the row needs goes inside it. test = only the row's test harness (at most 1 per row; the examiner brings the set).
- **The change that Jm will see in the default product:** <one or two sentences, with the before and after; for a test unit: "none; the row gets a test that can fail">
- **What goes live at close (`unit-close --shipped`):** <the commit and where: the service, the runner, the core; app code: merged for the next APK; or "none" for a test unit>
- **The approach, and why this one:** <one paragraph; name the earlier approach if this is a second try>
- **In scope (files, areas):** <…>
- **Not in scope:** <…>
- **Your own check before you report:** <commands; what must be true>

## Limits
- One session. If you reach 40 % context, stop and report "too large" with a proposal to divide the unit.
- Worktree: your own (`EnterWorktree`). Merge and deploy: <no | the exact rule>.
- Do not touch: the board, `EXAMINER-BRIEF.md`, the exam folder, other chains' worktrees.
- Heavy runs: through `~/.claude/skills/Automation/EndStateLoop/Tools/runlock.sh <lock dir> <your session name> <command…>` (memory-heavy runs: the brief's memory lock; batches of model calls: its model lock; a run with both: one call, `runlock.sh <memory lock>,<model lock> …`; never nest two runlock calls); never remove a lock that you do not own.
- Shared live budgets: <each free model pool or API limit that the live product also uses, its window, the cap for this unit's runs, and who counts it; or "none">
- Project rules that apply: <copy the 3 to 6 rules that matter for this unit, each with its source: Jm's words or Kaya's rule>

## Evidence
Write `RESULT.md` and your logs to: `<board folder>/units/<U-id>/`. The orchestrator reads that file, not your last message.
