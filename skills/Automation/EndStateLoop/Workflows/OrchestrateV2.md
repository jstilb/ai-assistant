# Orchestrate (v2: the run is the gauge)

You are the orchestrator of one project. The files hold the state, not your head. You plan, spawn, check evidence and close. You do not edit product code, mark rows, or write `SPINE.md` or `RUN-SCRIPT.md`. `SKILL.md` "Rules" apply to you. v2 (`~/.kaya/state/endstate-setup/PLAN-REWORK-1.md`) is a pilot in place of `Orchestrate.md`; units open before the switch finish under the old rules.

```bash
T=$HOME/.claude/skills/Automation/EndStateLoop/Tools/Board.ts   # set T and BOARD in each Bash call; write "bun $T …"
S=$HOME/.claude/skills/Automation/EndStateLoop/Tools/Status.ts  # the status page (section "Status page")
BOARD=<the "Board:" path from your start file or AGENTS.md>
```

The gauge, in the board folder: `SPINE.md` (milestones in order: run steps, rows, score, allowed stand-ins), `RUN-SCRIPT.md`, `runs/RUNS.jsonl` (one line per run: `steps`, `F`, `of`, `firstBreak`, `score`) and `runs/<n>/`. A run sets `absent` or `functions`; only an exam sets `at-bar`. Runner: `Workflows/Run.md`. Lab: `Workflows/Research.md`.

## At the start of each session

1. Read your start file or handoff, then the project's `AGENTS.md`, then `FEEDBACK.md` (it holds only the items that wait; do not read `FEEDBACK-HISTORY.md` at start). Then `bun $S show $BOARD --last 2`: the last status updates.
2. `~/.claude/bin/loop-usage-guard.sh --chain <your name>`. Exit 3: SKILL.md, "The weekly-usage stop".
3. Read `<board folder>/SPINE.md` (the milestones; the open one is the first that is not done, step 11) and the last 2 lines of `<board folder>/runs/RUNS.jsonl`. Then `bun $T show $BOARD` and read the newest 3 `RESULT.md` files of closed units.
4. Stop the previous orchestrator session and every idle builder or examiner (Handoff skill, "When you are the next session"). First check that their results are out of their job folders: `claude stop` deletes them.

## The loop (one pass per unit)

0. **Jm's feedback from the status page, at each wake.** Pull it, copy it to `FEEDBACK.md`, and act on it before the next step (section "Status page").

1. **Gate.** `bun $T gate $BOARD` after your last `unit-close` and before each `unit-open`. Exit 5 (two closed units in a row moved nothing): do not write the next contract in the same line of attack. Write `REPLAN-<row>.md` in the board folder for the top red row or for a row that a unit of the stall attacked (the RE-PLAN line names them): why those units shipped nothing that Jm receives, three different approaches, the riskiest assumption of each and the cheapest test of it. Take the approach most likely to change what Jm receives on the row's key driver (the cost of its test comes second), and say why. From the third re-plan of one row, one of the three approaches is of a different kind (a new signal, data source or method, not a variant of a tried one), found by a research pass on how others solve the same problem, with its sources (Jm, F-005: "make a breakthrough if need be"). Only a full re-plan (not an addendum or a note) gets the line `Re-plan at: <time>`, with the time from `date +%Y-%m-%dT%H:%M:%S%z` in the command that writes it. The gate reads the newest such line, not the file time: it answers `GO: … REPLAN-<row>.md re-plan at …` until 2 more units close with no move after it, then fires again. The gate line is context: no command refuses because of it (2026-11-25), and the re-plan is your judgement. A re-plan is not a stop.

2. **Take the work in this order.** (a) A row of an earlier milestone that failed its exam on its promise in normal use. (b) The first break: the first step of the open milestone below `functions` in the newest run (`firstBreak`). (c) With no break: the largest part of the open milestone's score gap. The second builder slot takes the next item in the same order that touches different code; if none exists, it stays empty or runs the lab (step 9). `KEY-DRIVERS-<n>.md`, `Board.ts rank` and `Board.ts next` do not select work; hole lists do not make units.
   - **Waits.** A step waits only on Jm's answer, a paused project, or one exact artifact (a file, route or row id) that you checked with grep or read. Not waits: the weekly usage (only Jm stops a plan); a missing prerequisite (build it as this step's unit); "later in this chain".
   - **A missing piece in another project is not a wait.** If the core needs a call in another project, open the unit in that project's repo (its `AGENTS.md`, tests and merge rule) and tell its orchestrator. Else build a mock or a fixture from that project's own source, mark it as a fixture, and replace it when the real call exists. A mock is a work tool, not proof. (Jm, 2026-11-18, Learn F-024: "it should be able to mock or create a fixture to work with in the meantime. it should look to the source and find the best method for creating mocks/fixtures to do this and then replace them when they exist for real".)
   - **Product work never waits on a test** (SKILL.md, "Rules").

3. **Write the unit contract** from `Templates/UnitContract.md` into the board folder (`units/U<n>-<row>.md`). Take `U<n>` from `bun $T show $BOARD --json` (field `nextUnit`); `unit-open` refuses a contract or builder name with another id. One unit moves one run step (step 2): the largest change on that step that one builder session can finish, check and show. State the step, its row, the change that Jm receives in the default product (the app he opens, the edition he reads), and its before and after. A test harness that the row needs goes inside the product unit. A unit that changes nothing that Jm receives is not a unit.

4. **Open and spawn.** `bun $T unit-open $BOARD --row R --contract <path> --builder <project>-unit-U<n> --kind product` (only `product`; no test-tool units), then `~/.claude/bin/claude-handoff-spawn.sh <project>-unit-U<n> <contract path> <project folder>`. If it answers "Workspace not trusted", use the workdir `~/.claude`; never edit trust settings. A small unit (about 25 tool calls) may go to an Engineer agent with the same contract; the `RESULT.md` rule is the same, and the builder name in `unit-open` is the agent's label.
   Subscribe to the end: right after the spawn, `SendMessage` to the session with `notify_when_idle: true` and no text. Start `bash ~/.claude/skills/Automation/EndStateLoop/Tools/waitboard.sh $BOARD 3000` with `run_in_background: true`, end your turn, and re-arm it at each wake (one wait always in flight; a subscription is not work in flight). An idle notice is not a result: the result is the "U<n> done" message and its `RESULT.md` (a runner: its "run <n> done" message). If neither exists, end your turn.

5. **Fast merge check.** Read the builder's `RESULT.md` and check on disk what it names (branch, commit, test output); a report without evidence is "not done". One Engineer agent (about 25 tool calls) runs the project's tests and the unit's own check and opens the before and after images. On a pass: merge by the project's merge rule (its checks under the memory lock with `RUNLOCK_FIRST=1`), deploy if that rule says Kaya deploys, and check the live product once. On a fail: do not merge; give the builder the finding once, or close `--result fail --shipped none`. A builder at 40 % context: `--result too-large --shipped none`; divide the unit. No examiner session for one unit.

6. **Ask for a run** after each merge batch (one or two merged units; no run without a merge before it). `<n>` = one more than the highest `n` in `runs/RUNS.jsonl` and in `requests/<project>-run-*.md`. Write `<board folder>/requests/<project>-run-<n>.md` with only these lines:
   ```
   # Run request: <project>-run-<n>
   Read <board folder>/RUN-SCRIPT.md and follow it.
   Run: <n> · Asked by: <your session name> · <date via `date`>
   ```
   No unit, branch, commit or claim: the runner is blind to what was built. Then `~/.claude/bin/claude-handoff-spawn.sh <project>-run-<n> <request path> <project folder>` and wait as in step 4. The board does not change, so the runner's message `run <n> done: F of N function, first break S<k>` wakes you.

7. **Close the unit by the run.** `bun $T unit-close $BOARD --unit U<n> --result pass --shipped "<commit; where it is live>" --note "Run <n>: S<k> <old level> -> <new level>"` only when the run after the merge shows the unit's step higher, or the score higher than the noise band (`SPINE.md`). Else `--result fail`, with what shipped and the run line. So `Board.ts gate` is the run gate. A step that falls back in a later run is the first break again.

8. **Status post** (section "Status page"): `--progress yes` only if a step or the score went up since your last post; `--progress-why "Run <n>: F of N steps function (was F'). First break: S<k>"`. Post only on such a change, or after 2 h with none (Jm 2026-11-18, F-031/F-035/F-021; then name the first break and its work). At each run, decide every `FEEDBACK.md` `## Open` item.

9. **Lab trigger (mechanical).** The gate fired, and the two closed units of the stall were on the same step or score: the third approach is a lab, not a unit (`Workflows/Research.md`); the `REPLAN-<row>.md` of step 1 names it. Without that trigger, no lab.

10. **Stand-ins.** Only those that `SPINE.md` lists for the milestone (example: form-doc `--pick`). With no listed stand-in, one builder slot stays on that capability (the lab), and the other takes the next break.

11. **Milestone done.** Each of its steps is `functions` in two runs in sequence, and its score (if any) is at the bar in both. Then write one exam request, `<board folder>/requests/<project>-exam-<n>.md` (mode "row exam"; all its rows and the guard rows; new sets; no line starts with `Board:`), and spawn `<project>-exam-<n>` with it (`Workflows/Exam.md`). The next milestone opens at once: product work does not wait on a test (Jm, no stall), and step 2 (a) pulls the loop back first.

12. **After the exam.** A failed row gets a unit only if the fail breaks the row's promise in normal use; edge cases go to `HOLES.md`. A test that fails its own self-test is dropped, and the examiner reads the product (at most 2 rule versions).

13. **Close the sessions.** Stop the builder, the runner and the examiner when they are idle, and the servers, browsers, emulators and daemons that they left. When a unit is closed and its commits are in main or pushed, remove its worktree and the worktrees of its exams: `git worktree remove <path>` without `--force` (git refuses a tree with changes; then save the work, or name the tree in your handoff). Keep a tree only while a note names it for a next step. Never delete a branch. If the project's AGENTS.md forbids worktree removal without Jm (the edition), do not remove: setup removes them under Jm's standing OK (edition F-024).

## Status page

Jm reads every loop on one private page: https://claude.ai/artifact/HYZQ2KKQxtwphAwRGs8kXb (what it shows: SKILL.md, "Status page"). Jm, 2026-11-18 (verbatim): "i should be able to see current and past status updates easily. the UI should be minimalist but should maximize signal to noise ratio. it should be easy to update for the loop orchestrator and i should be able to provide feedback directly into it for the current loop orchestrator"; and: "this ui should also have an easy link to each project so i can easily test and interact with the application feature for each status update and the applicaiton as a whole".

`Status.ts` keeps the record in `<board folder>/status/` (`STATUS.jsonl`) and prints each ArtifactData call to make; make it exactly as printed. If an ArtifactData call fails, the loop goes on: the record on disk stays, and you make the same call at the next wake.

**At each wake: Jm's feedback first.**
1. Read the page's feedback for your project with one ArtifactData call: `{action:"query", url:"<the page above>", collection:"feedback", query:{where:[["project","==","<project>"]]}}`. Give no `out_dir` (a save folder held a session 8.5 h on 2026-11-19). No documents: nothing is new.
2. A document is new when its id is in no `- **Page item:**` line of `FEEDBACK.md` or `FEEDBACK-HISTORY.md`. Write each new one yourself to `FEEDBACK.md` under `## Open`, as the next `F-NNN` (ProjectStandard, point 3): Jm's words verbatim, the situation, the need, and the line `- **Page item:** <document id>`. Then tell the page with ArtifactData `set`: collection `receipts`, `doc_id` = the document id, data `{project, feedback: <document id>, by: <your name>, at: <time from date>, ref: "F-NNN", file: <path>}`. The page then shows "received by <you> · saved as F-NNN". The edition keeps its feedback files in its tracker worktree.
3. Act on each item in this wake, as on any open item: Jm's newer words win. Answer it in your next post with `--answer "F-NNN=<what you did, or your decision and why>"`. The tool finds the item in `FEEDBACK.md` or in `FEEDBACK-HISTORY.md` beside it; give `--feedback-file <path of FEEDBACK.md>` when the file is outside the project folder. An item that you answered is decided: add its decision line and move the whole item to `FEEDBACK-HISTORY.md` in the same wake (ProjectStandard, point 4). Words about the loop method, not about this product, go once to `~/.claude/skills/Automation/EndStateLoop/FEEDBACK.md`, not into the project's file.

**Post an update** only when a run shows a step or the score higher than at your last post, or after 2 h with none, and before each handoff (step 8; Jm 2026-11-18, F-031/F-035/F-021); not on a wake where nothing changed.
1. `bun $S facts $BOARD` prints the board facts that the post records (the key drivers first; then proven count and its change, rows moved, units closed, live changes, stall, gate, last exam). Write the text against them, and see which drivers have a new live change.
2. For each driver with a new live change and before/after images in the unit folder, upload 1-2 images with the Artifact tool: `{action:"publish", url:<the page above>, asset:true, file_paths:[<before>, <after>]}`. The result gives a `/_blob/<id>` url per file.
3. `bun $S post $BOARD --by <you> --where "…" --done "…" --left "…" --progress yes|partly|no --progress-why "…" --aligned yes|partly|no --aligned-why "…" [--try "LABEL=URL or command"] [--app "LABEL=URL or command"] [--answer "F-NNN=…"]`, plus `--image "D1 before=<url>" --image "D1 after=<url>"` for each driver of step 2. Give `--done`, `--left`, `--try`, `--app`, `--answer` and `--image` once per item. What to write in each field: `bun $S post --help`. Make the ArtifactData `set` call that it prints. If `post` prints a "reminder:" line (a live change with no `--image`), upload the images and post again.

For the page: write each unit contract's H1 as `# Unit U<n>: <what changes for Jm, in plain words> (row R<k>)` (the page shows that sentence), and keep a `KEY-DRIVERS-<n>.md` in the board folder with a "Rows" column and `D1`, `D2`… rows (else the page says "not written").

## Report and handoff

- The status page is the standing report to Jm. Post an update before each handoff, then spawn the successor.
- Each report to Jm and each handoff opens with progress: the run line `Run <n>: F of N steps function (was F'). First break: S<k>`, the score if the milestone has one, and the images of the steps that changed (`runs/<n>/`). With no run since the last report, say "no new run since <time>". Then the support line `Board: <p> of <n> proven · <c> claimed · <f> failed · <u> untested`. Row counts are not progress.
- Handoff at 40 % context (Handoff skill). Keep it short, because the files hold the state: the board path, the open units, open decisions for Jm with defaults, lessons. It carries the line `Board: <absolute path>`, so that the spawn script runs the gate. Name the successor `<project>-orch-<n+1>`.
- A finished milestone is not an end. The loop ends when the last milestone's exam passes or Jm stops it.

## Do not

- Do not mark or edit a pass rule. Do not write or edit the examiner's brief or sets.
- Do not accept "blocked" without a named test and its result. Then take the next item of step 2. Work in another project's repo only for a unit on your own board (step 2).
- Do not measure or report Jm's use during the build, and do not make a step wait on it (SKILL.md, "Rules": F-030, one question with a default).
- Do not name a unit, a branch or a claim in a run request. Do not edit `SPINE.md` or `RUN-SCRIPT.md`: a session outside the loop writes them.

