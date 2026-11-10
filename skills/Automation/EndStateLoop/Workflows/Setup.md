# Setup

Put a project on the end-state loop: write its scoreboard, its examiner brief and its orchestrator start file. Run it once per project, from a session that is not the project's loop.

## Before you start

- The project has an end state in Jm's words or approved by Jm (`AGENTS.md` "Intent", an ALIGNMENT file, `FEEDBACK.md`). If it has none, stop and ask Jm for it: do not write one for him.
- Read `FEEDBACK.md` `## Open` with an anchored range: `awk '/^## Open$/{p=1;next} /^## /{p=0} p' FEEDBACK.md`.
- If a loop already runs on the project, do not change its files. Send it messages.

## Steps

1. **Pick the board folder.** It is outside every git worktree, so that the orchestrator and the examiner can both write one file: the project's ignored data folder (Learn: `data/endstate/`) or its evidence folder (the edition: `~/projects/intake-backups/endstate/`). The board is `SCOREBOARD.json` there. Never `~/.kaya`.

2. **Write the rows: one per sentence of the end state.**
   - Quote the sentence word for word, with its `file:line`. Mark an elision with "…".
   - Include Jm's own words about the product (his first request, his complaints). A row that no sentence of Jm or of the approved end state supports does not belong on the board.
   - One row per sentence, not per feature. Learn, 2026-11-09: every feature was green, and the sentence "coaches write the model live, in the session" had no test.
   - A sentence that needs a paused project still gets a row (`untested`, ranked last).

3. **Give each row its test.** Search the loop's records for a test that needs no person and a pass rule that was written before a run. Copy the rule's numbers exactly, with the rule file. If no rule exists, leave `passRule` null and `kind` "none": the examiner writes the rule before the first run. Do not write a rule and present it as the loop's.

4. **Mark from evidence on disk** with `Board.ts mark --role setup`. A setup mark is `claimed`, `failed` or `untested`, never `proven`.
   - `claimed`: the loop's own test passes on its records.
   - `failed`: the last run of the frozen rule failed, or an independent test showed that the row's test misses a fault on that sentence.
   - `untested`: no test, or it never ran.

5. **Rank the rows that are not proven** (`Board.ts rank`). First: the success measure, then the rows whose test has a known hole, then the claimed rows (they need only an exam), then rows that are not built, then rows that wait on a paused project. The examiner's first product review replaces this order.

6. **Check the draft.** `Board.ts validate <board>`. Then give both the board and the end-state sources to one fresh agent: is a sentence missing, is a quote wrong, is a status too generous? Apply what it proves.

7. **Write the examiner brief** from `Templates/ExaminerBrief.md` into the board folder (`EXAMINER-BRIEF.md`). Fill in: how to start the product on a copy, the privacy rules, the exam folder. The orchestrator does not edit this file.

8. **Start or convert the loop.**
   - New loop: write the start file from `Templates/OrchestratorStart.md` to `~/.kaya/handoffs/<date>-<project>-orch-1.md` and start it: `~/.claude/bin/claude-handoff-spawn.sh <project>-orch-1 <file> <project folder>`.
   - A live chain: send it one message with Jm's words, the board path and this skill's path. It changes role at its next handoff: its successor is `<project>-orch-1`. Record Jm's words in the project's `FEEDBACK.md`.
   - Add the line `Board: <absolute path>` to the project's `AGENTS.md` at its next product review (or ask the loop to do it).

9. **Run the first exam** (Exam workflow, mode "baseline"): the examiner takes every `claimed` row. Report the board to Jm: `Board.ts show <board>`.

## Done when

`Board.ts validate` exits 0; an independent agent checked the rows; the examiner brief exists; the orchestrator runs or the live chain has the message; Jm has the board.
