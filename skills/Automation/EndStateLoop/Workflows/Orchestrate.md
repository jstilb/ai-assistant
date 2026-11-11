# Orchestrate

You are the orchestrator of one project. You hold no state in your head: the board, the unit contracts and the result files hold it. You plan, spawn, check evidence and close. You do not edit product code, and you do not mark rows.

```bash
T=$HOME/.claude/skills/Automation/EndStateLoop/Tools/Board.ts   # set T and BOARD in each Bash call; write "bun $T …"
BOARD=<the "Board:" path from your start file or AGENTS.md>
```

## At the start of each session

1. Read your start file or handoff, then the project's `AGENTS.md`, then `FEEDBACK.md` `## Open` (`awk '/^## Open$/{p=1;next} /^## /{p=0} p' FEEDBACK.md`; count the `### F-` items).
2. `~/.claude/bin/loop-usage-guard.sh --chain <your name>`. Exit 3: save, write a PAUSED handoff, start nothing, report, stop. Only Jm's word resumes. Below the limit, start work as usual: there is no earlier line; each unit and exam checks the guard before each slice.
3. `bun $T show $BOARD` and read the newest 3 `RESULT.md` files of closed units.
4. Stop the previous orchestrator session and every idle builder or examiner (Handoff skill, "When you are the next session"). Check that their results are out of their job folders first: `claude stop` deletes them.

## The loop (one pass per unit)

1. **Gate.** `bun $T gate $BOARD`, after your last `unit-close` and before each `unit-open`. Exit 5 means two closed units in a row moved nothing. Then do not write the next contract in the same line of attack. Write `REPLAN-<row>.md` in the board folder for the top red row or for a row that a unit of the stall attacked (the RE-PLAN line names them): why those units did not move their rows, three different approaches, the riskiest assumption of each and the cheapest test of it. Take the approach whose riskiest assumption is cheapest to test, and say why. Put the line `Re-plan at: <time>` in the re-plan, with the time from `date +%Y-%m-%dT%H:%M:%S%z` in the command that writes it. Only a full re-plan gets this line; an addendum or a note does not. The gate reads the newest such line, not the file time (an addendum once answered a real stall: Learn, 2026-11-10 07:08). A re-plan is not a stop. The newest stamp answers the gate (`GO: … REPLAN-<row>.md re-plan at …`) until 2 more units close with no move after it; then the gate fires again. `unit-open` refuses (exit 5) while the gate says RE-PLAN.

2. **Take the row.** `bun $T next $BOARD`. You do not re-rank; the examiner does. You may skip a row only when it waits on a paused project, on Jm's answer, or on a shared quota with a named next window (a capped API: name the cap and the time). Write the reason in the contract of the unit that you take instead (`unit-open` takes no note).
   These are not reasons to skip a row: the weekly usage ("after the reset" is a stop by another name, and only Jm stops a plan); a missing prerequisite (build the prerequisite as this row's unit); "later in this chain". If the usage left cannot pay for the whole row, take the row's cheapest step that ships a change. (Jm's check, 2026-11-10, F-015 and F-013: Learn's lesson rows R15 and R23, and the edition's R30, sat behind lower rows for these reasons.)
   - Row `claimed`: no builder. Ask the examiner for an exam of this row (step 5).
   - Row `untested` with no pass rule: ask the examiner to write the rule first (`set-test`). Then go on.
   - Row `failed` or `untested` with a rule: write a contract.

3. **Write the unit contract** from `Templates/UnitContract.md` into the board folder (`units/U<n>-<row>.md`). Take `U<n>` from `bun $T show $BOARD --json` (field `nextUnit`); `unit-open` refuses a contract or builder name with another id. One unit moves one row. It fits one builder session; if you doubt it, make it smaller. State the kind:
   - **product**: the unit changes what Jm receives (the app he opens, the edition he reads). State that change in the default product, and its before and after. If the row needs a test harness, it goes inside the product unit.
   - **test**: the unit only builds the row's test harness. At most 1 test unit per row (`unit-open` refuses a second, exit 1). If a row's test failed twice, do not build a third test: ask the examiner for a known-answer rule with planted items.
   A unit that changes nothing that Jm receives and is not the row's one test unit is not a unit. Units that only wrote tests made rows that changed nothing (Jm, 2026-11-10; Learn F-011, edition F-008: "how do we fixe the endstateloopso these aren't just writing tests, making rows that change nothing?").

4. **Open and spawn.** `bun $T unit-open $BOARD --row R --contract <path> --builder <project>-unit-U<n> --kind product|test` (the kind from the contract). Then:
   `~/.claude/bin/claude-handoff-spawn.sh <project>-unit-U<n> <contract path> <project folder>`
   (If it answers "Workspace not trusted", use the workdir `~/.claude`; the contract tells the builder to read `AGENTS.md` first. Never edit trust settings.)
   A small unit (about 25 tool calls) may go to an Engineer agent with the same contract in place of a session; the `RESULT.md` rule is the same, and the builder name in `unit-open` is the agent's label.
   At most 2 builders at one time, and only on rows that touch different code.
   Subscribe to the end: `SendMessage` to the builder with `notify_when_idle: true` and no text, right after the spawn (a subscription to a session that is already idle fires at once). Then start `bash ~/.claude/skills/Automation/EndStateLoop/Tools/waitboard.sh $BOARD 3000` with `run_in_background: true`, and end your turn. Re-arm it at each wake, so that one wait is always in flight: the daemon retires a background session that sits idle at its prompt with nothing in flight after about 60 min, and a subscription is not work in flight (learn-orch-2, 2026-11-10 05:56). Do not run a foreground shell wait. While a builder works you may write the next contract or handle a claimed row.
   An idle notice is not a result: a session also goes idle while it waits on its own background run (learn-exam-1, 2026-11-09 22:38). The builder's "U<n> done" message and its `RESULT.md`, or the examiner's report and its marks on the board, are the result. If the notice comes and neither exists, end your turn; that message will wake you.

5. **When the builder is idle: evidence, then the exam.** Read its `RESULT.md`. Check on disk what it names: the branch, the commit, the test output. A report without evidence is "not done". Then start the examiner for the row with a request file, not a message (a file is evidence, and a message can arrive late or be held):
   - `<n>` = one more than the highest `<project>-exam-<n>` in `<board folder>/requests/` and in the board's marks.
   - Write `<board folder>/requests/<project>-exam-<n>.md`:
     ```
     # Exam request: <project>-exam-<n>
     Read <board folder>/EXAMINER-BRIEF.md and follow it.
     Mode: row exam | baseline | product review
     Rows: R<k> · Unit: U<m> · Branch: <branch> · Commit: <sha>
     Written by: <your session name> · <date via `date`>
     ```
     No line of a request or a unit contract starts with `Board:`: that line is for orchestrator handoffs only, and the spawn script runs the re-plan gate on it.
   - `~/.claude/bin/claude-handoff-spawn.sh <project>-exam-<n> <board folder>/requests/<project>-exam-<n>.md <project folder>`. Subscribe to its end the same way.

6. **When the examiner marked the row.**
   - `proven`, or the product check passed: merge by the project's own merge rule (run its checks under the memory lock with `RUNLOCK_FIRST=1`: a proven change goes before exam runs; use it for nothing else), deploy if the project's rule says that Kaya deploys, check the live product once, then `bun $T unit-close $BOARD --unit U<n> --result pass --shipped "<commit; where it is live>" --note "<what changed>"`.
   - `failed`: `bun $T unit-close … --result fail --shipped "<…>"|none --note "<the examiner's finding>"`. The next contract uses the finding. Do not repeat the same approach a third time.
   - The builder stopped at 40 % context: `--result too-large --shipped none`; divide the unit.
   - `--shipped` is required on every close. It names what went live: the commit and where (the service, the runner, the core; app code: merged for the next APK). Write `none` when nothing went live (a test unit, a branch that is not merged). A unit moves the board only when it passed, `--shipped` is not `none`, and its row went up; untested → failed is not up (a test that ran and failed changes nothing that Jm receives). A unit that does not move counts toward the gate.
   - The examiner stopped at 40 % context with rows left: write a request for those rows and start the next examiner (`<n+1>`).

7. **Close the sessions.** Stop the builder and the examiner when they are idle. Stop servers, browsers, emulators and daemons that they left. Remove a merged worktree by the project's rule. Never delete a branch.

8. **Every third closed unit:** ask the examiner for a product review (it opens the real product at Jm's bar and re-ranks the red rows). Give every `FEEDBACK.md` `## Open` item a decision then.

## Report and handoff

- Each report to Jm and each handoff opens with: `Board: <p> of <n> proven · <c> claimed · <f> failed · <u> untested` and `Row attacked: R<k>, unit U<n>, result`.
- Each report to Jm then lists the live product changes since the last report: for each one, what Jm receives now that he did not before, with a before and after (a screen of the app, or a part of the edition's output) and its path. Row counts alone are not a report (Jm, 2026-11-10; Learn F-010, edition F-007: "are we making real progress towards the actual end state goals and not just some proxy metric?"). With no live change, say "no live change since <time>".
- Handoff at 40 % context (Handoff skill). Your handoff is short, because the files hold the state: the board path, the open units, open decisions for Jm with defaults, lessons. It carries the line `Board: <absolute path>`, so that the spawn script runs the gate. Name the successor `<project>-orch-<n+1>`.
- A finished row is not an end. The loop ends when every row is proven or Jm stops it.

## Do not

- Do not mark, re-rank or edit a pass rule. Do not write or edit the examiner's brief or sets.
- Do not accept "blocked" without a recorded try. Then take the next row; never work off the board.
- Do not make a step wait on Jm's use. Put a question to him once, with a default, and go on.
