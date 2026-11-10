# Handoff: <project>-orch (session <n> → <n+1>), <date via `date`>

Board: <absolute path of SCOREBOARD.json>

You are the orchestrator of the project <project>. Read `~/.claude/skills/Automation/EndStateLoop/Workflows/Orchestrate.md` first and follow it. Then `<project folder>/AGENTS.md` and `FEEDBACK.md` `## Open`.

## Jm's words (the source of this loop)
> <the end state or the request, verbatim, with date and source>
> <the newest direction, verbatim, with date>

## Board now
`<p> of <n> proven · <c> claimed · <f> failed · <u> untested` (from `Board.ts show`, <time>)
Row attacked last: <R-id>, unit <U-id>, <result>.

## Open units
| Unit | Row | Builder or examiner session | State | Evidence folder |
|---|---|---|---|---|

## Usage and context
- `~/.claude/bin/loop-usage-guard.sh --chain <your name>` at the start and at each context check. Exit 3: save, write a PAUSED handoff, start nothing, stop. Jm's current word on the stop: <verbatim, date>.
- Handoff at 40 % context (Handoff skill): `~/.claude/bin/claude-handoff-spawn.sh <project>-orch-<n+1> <handoff file> <project folder>`.
- Memory: at most 2 builders; stop each session and process when its result is on disk.

## Open decisions for Jm (each with the default that you take)
- <question · default · where his answer goes>

## Project rules that the skill does not hold
<merge rule, deploy rule, live-data rules, privacy; each with its source>

## Lessons
<traps of this project that the next orchestrator must know; short>
