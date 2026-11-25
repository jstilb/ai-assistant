# Orchestrate

You are the orchestrator of one project. The board, the unit contracts and the result files hold the state, not your head. You rank, plan, spawn, check evidence and close. You do not edit product code, and you do not mark rows. `SKILL.md` "Rules" apply to you. The why of each step: `Reference/WHY.md`, section "Workflows/Orchestrate.md".

```bash
T=$HOME/.claude/skills/Automation/EndStateLoop/Tools/Board.ts   # set T and BOARD in each Bash call; write "bun $T …"
S=$HOME/.claude/skills/Automation/EndStateLoop/Tools/Status.ts  # the status page (section "Status page")
BOARD=<the "Board:" path from your start file or AGENTS.md>
```

## At the start of each session

1. Read your start file or handoff, then the project's `AGENTS.md`, then `FEEDBACK.md` `## Open` (`awk '/^## Open$/{p=1;next} /^## /{p=0} p' FEEDBACK.md`; count the `### F-` items). Then `bun $S show $BOARD --last 2`: the last status updates and the status-page feedback with no answer yet.
2. `~/.claude/bin/loop-usage-guard.sh --chain <your name>`. Exit 3: SKILL.md, "The weekly-usage stop".
3. `bun $T show $BOARD` and read the newest 3 `RESULT.md` files of closed units.
4. Stop the previous orchestrator session and every idle builder or examiner (Handoff skill, "When you are the next session"). First check that their results are out of their job folders: `claude stop` deletes them. A Codex unit's run is not a session: do not stop it; arm its `--wait` again (`Workflows/Codex.md`).

## The loop (one pass per unit)

0. **Jm's feedback from the status page, at each wake.** Pull it, copy it to `FEEDBACK.md`, and act on it before the next step (section "Status page").

1. **Gate.** `bun $T gate $BOARD` after your last `unit-close` and before each `unit-open`. Exit 5 (two closed units in a row moved nothing): do not write the next contract in the same line of attack. Write `REPLAN-<row>.md` in the board folder for the top red row or for a row that a unit of the stall attacked (the RE-PLAN line names them): why those units shipped nothing that Jm receives, three different approaches, the riskiest assumption of each and the cheapest test of it. Take the approach most likely to change what Jm receives on the row's key driver (the cost of its test comes second), and say why. From the third re-plan of one row, one of the three approaches is of a different kind (a new signal, data source or method, not a variant of a tried one), found by a research pass on how others solve the same problem, with its sources (Jm, F-005: "make a breakthrough if need be"). Only a full re-plan (not an addendum or a note) gets the line `Re-plan at: <time>`, with the time from `date +%Y-%m-%dT%H:%M:%S%z` in the command that writes it. The gate reads the newest such line, not the file time: it answers `GO: … REPLAN-<row>.md re-plan at …` until 2 more units close with no move after it, then fires again. `unit-open` refuses (exit 5) while the gate says RE-PLAN. A re-plan is not a stop.

2. **Rank, then take the row.** Rank the red rows by their effect on the key drivers (`KEY-DRIVERS-<n>.md` in the board folder: D1-D3): the row that changes most what Jm receives goes first. Testability and test cost are not rank reasons. Examiners may propose; you decide. Re-rank when a driver's state changes (a review, a merge, Jm's words): `bun $T rank $BOARD --order <ids> --by <you>`. Then `bun $T next $BOARD`.
   - **Waits.** A row waits only on Jm's answer, a paused project, or one exact artifact (a file, route or row id). Before you write a wait, check with grep or read that the artifact exists or that a unit builds it now. Write the wait in the contract of the unit that you take instead. Not waits: the weekly usage ("after the reset" is a stop by another name, and only Jm stops a plan); a missing prerequisite (build it as this row's unit); "later in this chain".
   - **A missing piece in another project is not a wait.** If your end state's core needs a call in another project, open the unit in that project's repo (its `AGENTS.md`, tests and merge rule; spawn the builder in its folder) and tell that project's orchestrator. For other pieces, build a mock or a fixture by the best method found in that project's own source (its real output files, API routes, schemas, recorded answers), mark it as a fixture, and replace it with the real call when that exists. A mock is a work tool, not proof. (Jm, 2026-11-18, Learn F-024: "it should be able to mock or create a fixture to work with in the meantime. it should look to the source and find the best method for creating mocks/fixtures to do this and then replace them when they exist for real".)
   - **Product work never waits on a test** (SKILL.md, "Rules").
   - Row `claimed`: no builder. Ask the examiner for an exam of this row (step 5).
   - Row `failed` or `untested`: write a contract. With no pass rule, also ask the examiner for one (`set-test`).

3. **Write the unit contract** from `Templates/UnitContract.md` into the board folder (`units/U<n>-<row>.md`). Take `U<n>` from `bun $T show $BOARD --json` (field `nextUnit`); `unit-open` refuses a contract or builder name with another id. One unit moves one row: the largest step on the row's key driver that one builder session can finish, check and show. State the driver, the change that Jm receives in the default product (the app he opens, the edition he reads), and its before and after. A test harness that the row needs goes inside the product unit. A unit that changes nothing that Jm receives is not a unit.
   **Step 0 must decide.** If the contract has a cheap first check that can end the unit (step 0), write its n and bar before the run, and let it test the use (what Jm gets), not a raw signal. A result that one or two items decide, or one on fewer than about 60 items, is "not decided": the unit goes on to its real test or adds items, and the approach is not closed as failed.

4. **Open and spawn.** `bun $T unit-open $BOARD --row R --contract <path> --builder <project>-unit-U<n> --kind product`, then `~/.claude/bin/claude-handoff-spawn.sh <project>-unit-U<n> <contract path> <project folder>`. If it answers "Workspace not trusted", use the workdir `~/.claude`; never edit trust settings. A small unit (about 25 tool calls) may go to an Engineer agent with the same contract; the `RESULT.md` rule is the same, and the builder name in `unit-open` is the agent's label. If the builder is Codex (the handoff says "Builder: Codex"), read `Workflows/Codex.md` and follow it in place of the spawn.
   Subscribe to the end: right after the spawn, `SendMessage` to the builder with `notify_when_idle: true` and no text (it fires at once for an idle session). Start `bash ~/.claude/skills/Automation/EndStateLoop/Tools/waitboard.sh $BOARD 3000` with `run_in_background: true` and end your turn. Re-arm it at each wake, so that one wait is always in flight; a subscription is not work in flight (SKILL.md, "Rules"). Do not run a foreground shell wait. While a builder works, you may write the next contract or handle a claimed row.
   An idle notice is not a result (a session also goes idle while it waits on its own background run). The result is the builder's "U<n> done" message and its `RESULT.md`, or the examiner's report and its marks on the board. If the notice comes and neither exists, end your turn; that message will wake you.

5. **When the builder is idle: evidence, then the check.** Read its `RESULT.md`. Check on disk what it names: the branch, the commit, the test output. A report without evidence is "not done". If the unit does not claim that its row passes, a fast merge check replaces an exam session: one Engineer agent (about 25 tool calls) runs the project's tests and the unit's own check and opens the before and after images; on a pass, go to step 6. The check reads the unit's claims against the product as in `Check.md` "Claim audit (per merge)", and a false claim is recorded with `Board.ts unit-audit --result fail`. The agent that records `unit-audit` is fresh: never the orchestrator, the builder or the reviewer of the unit (form-doc U81, 2026-11-24: the orchestrator audited its own review). Use `Tools/ClaimAudit.ts run` if the merge check agent was not fresh. Else start the examiner for the row with a request file, not a message:
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

6. **When the check is in.**
   - `proven`, or the fast merge check passed: merge by the project's own merge rule (run its checks under the memory lock with `RUNLOCK_FIRST=1`, for nothing else), deploy if the project's rule says that Kaya deploys, check the live product once, then `bun $T unit-close $BOARD --unit U<n> --result pass --shipped "<commit; where it is live>" --note "<what changed>"`.
   - `failed`: `bun $T unit-close … --result fail --shipped "<…>"|none --note "<the examiner's finding>"`. Its holes go to `HOLES.md` in the board folder. The next unit comes from the biggest missing piece of a key driver; a hole becomes a unit only when it blocks that driver. Do not repeat the same approach a third time.
   - The builder stopped at 40 % context: `--result too-large --shipped none`; divide the unit.
   - `--shipped` is required on every close: the commit and where it went live (the service, the runner, the core; app code: merged for the next APK), or `none` (a branch that is not merged). A unit that does not move the board (a move: SKILL.md, "Rules") counts toward the gate.
   - The examiner stopped at 40 % context with rows left: write a request for those rows and start the next examiner (`<n+1>`).
   - Post a status update (section "Status page") when something Jm receives changed (a unit shipped live: a `--try` link and before/after images for each), or when your newest post is older than 2 h, also while you only wait (then say what blocks it, with the `--number` lines; the watch nudges at 2 h 10 min, Jm 2026-11-24: "why is the endstate loop artifact not being updated?"). A unit-close that changed nothing he receives does not by itself call for a post (Jm 2026-11-18, F-031/F-035/F-021: the page showed many "No live change" posts and read as no progress).

7. **Close the sessions.** Stop the builder and the examiner when they are idle, and the servers, browsers, emulators and daemons that they left. When a unit is closed and its commits are in main or pushed, remove its worktree and the worktrees of its exams: `git worktree remove <path>` without `--force` (git refuses a tree with changes; then save the work, or name the tree in your handoff). Keep a tree only while a note names it for a next step. Never delete a branch. If the project's AGENTS.md forbids worktree removal without Jm (the edition), do not remove: setup removes them under Jm's standing OK (edition F-024).

8. **Every third closed unit:** ask the examiner for a product review (it opens the real product at Jm's bar and names the missing pieces per key driver), then re-rank (step 2). Give every `FEEDBACK.md` `## Open` item a decision then. In your next post, `--aligned` says what the review found.

## Status page

Jm reads every loop on one private page: https://claude.ai/artifact/HYZQ2KKQxtwphAwRGs8kXb (what it shows: SKILL.md, "Status page"). Jm, 2026-11-18 (verbatim): "i should be able to see current and past status updates easily. the UI should be minimalist but should maximize signal to noise ratio. it should be easy to update for the loop orchestrator and i should be able to provide feedback directly into it for the current loop orchestrator"; and: "this ui should also have an easy link to each project so i can easily test and interact with the application feature for each status update and the applicaiton as a whole".

`Status.ts` keeps the record in `<board folder>/status/` (`STATUS.jsonl`, `INBOX.jsonl`) and prints each ArtifactData call to make; make it exactly as printed. If an ArtifactData call fails, the loop goes on: the record on disk stays, and you make the same call at the next wake.

Each post gives the project's driver numbers (the measured bars of its current bet, e.g. the edition's v1 bars met, R28 must-seat items seated) with `--number "<label>|<now>|<before>|<bar>"` (repeat; at most 8). Plain labels, no row or unit codes. The page shows them, and the claim audit of each closed unit (`facts.closed[].audit`, from `Board.ts unit-audit`), under "Moving toward the end state?" (Jm form-doc F-029, 2026-11-24).

**At each wake: Jm's feedback first.**
1. `bun $S pull $BOARD` prints an ArtifactData `query` call; make it. (`pull` picks a save folder inside your session folder, so the save needs no approval. Do not pass `--in` outside your session folder: a save to `/tmp` waited 8.5 h on a permission prompt, 2026-11-19.)
2. `bun $S inbox $BOARD --by <your name>` copies each new item verbatim to `FEEDBACK.md` `## Open` as the next `F-NNN` and prints one ArtifactData `batch` call; make it (the page then shows "received by <you> · saved as F-NNN"). If the project keeps `FEEDBACK.md` outside its folder (the edition: its tracker worktree), add `--feedback-file <path>`.
3. Act on each item in this wake, as on any `## Open` item: Jm's newer words win. Answer it in your next post with `--answer "F-NNN=<what you did, or your decision and why>"` (`post` warns while an item has no answer). `--answer` also takes an F-item that came by another door (a session, Telegram, the Scratch Pad); give `post` the same `--feedback-file` as `inbox`.

**Post an update** after each `unit-close`, after each product review and before each handoff; not on a wake where nothing changed.
1. `bun $S facts $BOARD` prints the board facts that the post records (the key drivers first; then proven count and its change, rows moved, units closed, live changes, stall, gate, last exam). Write the text against them, and see which drivers have a new live change.
2. For each driver with a new live change and before/after images in the unit folder, upload 1-2 images with the Artifact tool: `{action:"publish", url:<the page above>, asset:true, file_paths:[<before>, <after>]}`. The result gives a `/_blob/<id>` url per file.
3. `bun $S post $BOARD --by <you> --where "…" --done "…" --left "…" --progress yes|partly|no --progress-why "…" --aligned yes|partly|no --aligned-why "…" [--try "LABEL=URL or command"] [--app "LABEL=URL or command"] [--answer "F-NNN=…"]`, plus `--image "D1 before=<url>" --image "D1 after=<url>"` for each driver of step 2. Give `--done`, `--left`, `--try`, `--app`, `--answer` and `--image` once per item. What to write in each field: `bun $S post --help`. Make the ArtifactData `set` call that it prints. If `post` prints a "reminder:" line (a live change with no `--image`), upload the images and post again.

For the page: write each unit contract's H1 as `# Unit U<n>: <what changes for Jm, in plain words> (row R<k>)` (the page shows that sentence), and keep a `KEY-DRIVERS-<n>.md` in the board folder with a "Rows" column and `D1`, `D2`… rows (else the page says "not written").

## Report and handoff

- The status page is the standing report to Jm. Post an update before each handoff, then spawn the successor.
- Each report to Jm and each handoff opens with progress (SKILL.md, "Progress"): per key driver, did what Jm receives get better (yes or no), with the before and after images and their paths. With no live change, say "no live change since <time>". Then the support line `Board: <p> of <n> proven · <c> claimed · <f> failed · <u> untested`. Row counts are not progress.
- Handoff at 40 % context (Handoff skill). Keep it short, because the files hold the state: the board path, the open units, open decisions for Jm with defaults, lessons. It carries the line `Board: <absolute path>`, so that the spawn script runs the gate. Name the successor `<project>-orch-<n+1>`.
- A finished row is not an end. The loop ends when every row is proven or Jm stops it.

## Do not

- Do not mark or edit a pass rule. Do not write or edit the examiner's brief or sets.
- Do not accept "blocked" without a named test and its result. Then take the next row. Work in another project's repo only for a unit on your own board (step 2).
- Do not measure or report Jm's use during the build, and do not make a step wait on it (SKILL.md, "Rules": F-030, one question with a default).
