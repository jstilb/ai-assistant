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
   - A sentence that describes a change in Jm ("he understands more", "practice sessions per week") is not a row as written. Jm, 2026-11-10: "change the end state goals so they don't describe a change in me, but rather something verifiable without me that is an accurate representation of what I want (it can be as many metrics as we need)". Turn it into metrics of four kinds: **fit** (his own records are the answer key: held-out items from his history, his TELOS goals, his calendar), **truth** (planted items with a known answer), **effect** (a reader or learner agent that has his knowledge record; answers checked by code; the instrument passes its own test first), **ease** (taps, minutes, typed fields, ready by a time; counted by code). His use is an information line from the logs, never a row or a gate. A "what stays" sentence is a guard row: checked at each exam, never progress.

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

## Change the end state of a live board (v2)

1. Write `<board folder>/ENDSTATE-v2-DRAFT.md`: one line per metric with the sentence of Jm that it serves (`file:line`), its kind, a test that needs no person, a draft bar, and the v1 rows that it covers. Label Jm's words and Kaya's text.
2. Start one examiner in mode "rules" (a request in `requests/`): it checks each metric's source, names a test that needs no person, sets a draft bar on a held-out set, and says "same test" or "new test" per v1 row. Output: `ENDSTATE-v2-RULES.md`. No board write.
3. Send Jm the final text for approval (one word). The board does not change before his yes.
4. Rebuild the rows. Keep every v1 row id: closed units name them, and closed units are not rewritten. Each v1 row takes the v2 sentence of its metric; new metrics get new ids. A row with the same test keeps its marks. A row with a new test gets a setup mark `untested` with the note "v2 test; earlier marks were for the v1 test". `Board.ts validate`, then tell the orchestrator.

## Done when

`Board.ts validate` exits 0; an independent agent checked the rows; the examiner brief exists; the orchestrator runs or the live chain has the message; Jm has the board.
