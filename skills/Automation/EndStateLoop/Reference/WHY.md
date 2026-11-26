# EndStateLoop: why the rules are as they are

The core files (`SKILL.md`, `Workflows/Orchestrate.md`, `Workflows/Exam.md`, `Workflows/Build.md`, `Workflows/Check.md`) say what to do. This file keeps the evidence, the dated incidents and the quotes that only explain a rule. Open it when you need the why of a rule; a session does not read it at its start. Each section names the core file and the step that its notes support. The text moved here from the core on 2026-11-18 (PLAN-25) with its words unchanged.

## SKILL.md

### Skill origin

Jm, 2026-11-09 (verbatim): "go ahead and build it, starting with the scoreboards. make a skill for this type of workflow so we can use it again in the future."

### Skill evidence

Why (evidence, 2026-11-09):
- Learn caught 16 of 16 of its own planted faults, and 6 of 10 from an independent writer.
- One session that plans, builds and marks: 12 handoffs in 10 hours (Learn). A conductor with bounded chains: 10 of 10 plans in about 9 hours with 2 conductor sessions (deepening, 2026-11-08).

### Skill board

Why one fixed path outside every worktree: the orchestrator and the examiner both write the board from different worktrees.

### Skill status page

- Redesigned 2026-11-18 after Jm: "this UI is not intuitive ... it is crowded, messy, the lack of interactivity is strange". This is why a page change is first used in a browser for each of Jm's tasks at 1280 px and 390 px and judged against the UI bar, not only for errors.
- The store rule (only the owner writes; a Contributor-level write is refused) was checked 2026-11-18.
- Jm's feedback reaches `FEEDBACK.md` at the orchestrator's next wake: at most about 50 min later.

### Skill rules: a move

Release 11, 2026-11-10: Jm, "how do we fixe the endstateloopso these aren't just writing tests, making rows that change nothing?" (Learn F-011, edition F-008). This is why a unit that shipped nothing is not a move, even when its row went up, and why a unit that changes nothing that Jm receives is not a unit (Orchestrate step 3).

### Skill rules: runlock

- How the two locks work: the model lock is light on memory; it keeps the call rate. A run that gives both locks in one call waits holding nothing, then takes the model lock ahead of the other model waiters.
- `RUNLOCK_FIRST=1` exists so that a proven change does not wait behind exam runs: a proven change goes before exam runs.
- Why two locks: on 2026-11-10 one Learn lock held 1 model batch and 5 waiters while 68 % of memory was free.
- Never nest: 2026-11-10: a nested call held the model lock idle behind 5 memory-lock tickets.
- `RUNLOCK_FIRST=1` for the merge check of a proven unit: 2026-11-10 09:53: an examiner that ran back to back took the lock again at once, while 7 waiters, two of them proven merges, waited up to 75 min.

### Skill rules: daemon restart

2026-11-10 09:59: a daemon restart killed 11 sessions, the whole Learn loop. Resumes with flags started copies with new ids, and the copies' original jobs then lost their `EnterWorktree` worktrees and branches (learn-exam-15, -18, -19; a `git worktree add` tree survived).

### Skill rules: wait in flight

- learn-orch-2, 2026-11-10 (05:56): the daemon retired it while it sat idle at its prompt with nothing in flight; a subscription is not work in flight.
- learn-exam-1, 2026-11-09 22:38: an idle notice came while the session waited on its own background run. This is why an idle notice is not a result.

### Skill rules: usage stop

The guard is checked before each slice, with no earlier line. This keeps the real stop close to Jm's limit, so no one stops early (2026-11-10: an early 87 % line held both loops idle below Jm's 90 %).

### Skill rules: no permission prompts

2026-11-10: learn-unit-U19 hung 55 min on a Bash with `rm`.

## Workflows/Orchestrate.md

### Orchestrate step 1

An addendum once answered a real stall (Learn, 2026-11-10 07:08). This is why only a full re-plan gets the `Re-plan at:` line, and why the gate reads that line, not the file time.

### Orchestrate step 2

The list of things that are not waits (the weekly usage, a missing prerequisite, "later in this chain") comes from Jm's check, 2026-11-10, F-015 and F-013.

### Orchestrate step 3

- Step 0 must decide: form-doc 2026-11-18: U19 closed "fail by one case" of 19; U15 closed an audio clock with 91.8 % recall on a raw false-onset bar; Jm, F-010: "not taking the easy way out".
- A unit that changes nothing that Jm receives is not a unit: Jm, 2026-11-10; Learn F-011, edition F-008 (quote under "Skill rules: a move").

### Orchestrate step 4

- "Workspace not trusted": the workdir `~/.claude` is safe because the contract tells the builder to read `AGENTS.md` first.
- Re-arm the wait at each wake: learn-orch-2, 2026-11-10 05:56 (see "Skill rules: wait in flight").

### Orchestrate step 5

The examiner starts from a request file, not a message: a file is evidence, and a message can arrive late or be held.

### Orchestrate step 7

2026-11-12: the edition held 103 worktrees, about 0.6 GB each, on a disk at 97 %.

### Orchestrate status page

- The page is a fourth door for Jm's feedback (SKILL.md, "Integration"). The session reads the page store and writes the item itself.
- `--answer` with an F-item from another door reads the item from `FEEDBACK.md`, and the page shows Jm's words with your answer.
- The page shows each goal by its sentence from the board, so a post names the goal as Jm sees it.
- The field limits exist because Jm reads the updates on a phone.

`--progress`: the page shows the facts next to the verdict, so a verdict that the facts do not carry is seen at once.

Plain words: Jm, 2026-11-18, on the first page: "it is crowded, messy". The first real updates were full of codes ("U66 (R22)", "exam-81", "E1 step 0").

### Orchestrate report

Row counts are not progress (Jm, 2026-11-10; Learn F-010, edition F-007: "are we making real progress towards the actual end state goals and not just some proxy metric?").

## Workflows/StatusPageChange.md

See "Skill status page" above (the 2026-11-18 redesign after "this UI is not intuitive").

## Workflows/Exam.md

### Exam step 2

The known-good and known-bad run before a new rule's first real run: rules that could never pass cost the loops days on 2026-11-17/18.

## Workflows/Build.md

### Build step 5

Look at each slice as Jm sees it: Jm 2026-11-18, F-026/F-030/F-015: "are the agents actually looking at the apps as they build them?"

### Build rules

A first check decides only with enough items: Jm, 2026-11-18: "not taking the easy way out".

## Workflows/Check.md

### Claim audit per merge (2026-11-24)

Problem: the form-doc loop on Gemini merged 23 units with 0 exams. Each unit was self-marked "moved". The exam that followed (exam-29) failed 7 of the rows it examined and found 2 false claims on Jm's page.

Why exams were not the fix: from 2026-11-09 to 2026-11-18, exams were the progress currency, and they became the work. Examiners used 43 % of the tokens. 49 of 124 failed marks were test defects, not product faults. The exam clock was removed on 2026-11-18. A new exam clock and a rank-by-exam rule, built on 2026-11-24, repeated two removed designs. The watch reverted them (commit 6ec5885c8).

Jm's 2026-11-19 design: a fresh reviewer after each merge, plus one exam per version. The claim audit is this reviewer, kept cheap and on the path to Jm.

Jm, form-doc F-029, 2026-11-24: "how do we ensure you as the orchestraor of orchestraotrs keeps other orchestrators accountable? how do those orchestrators maintain focus to make meaningful progress (even without you steering them)?" and, on exams: "just remember that we actually moved things away from exams before because they caused issues. it may actullay be helpful to see what we've tried before."

Principle: nobody checks their own work. Each layer is checked by something it cannot set. Jm sees the result without a pass through the checked layer.

First live result: U78 (2026-11-24 15:43). The auditor found 2 FALSE claims of 8 (6 true): "named by starting court side" was turn parity only, and "47 of 51" was a fitted pairing. The move was revoked. Earlier the same day, a revoked U76 and a failed U77 had made the gate say RE-PLAN, and the board refused the unit-open of U78 until a re-plan file existed.

A held post is a failure too: the watch held post form-doc-0060 for a correction post, and Jm's page had no update for 2 h (Jm: "why is the endstate loop artifact not being updated?"). Now the post goes at once with an audit line (`Workflows/Watch.md`, "Status page").

## Cuts of 2026-11-25

Jm, 2026-11-25 (verbatim): "how much of this is unnecessary deterministic tooling? these are file reads and writes. are we overcomplicating this skill?" Then: "make changes".

- `Status.ts pull` and `inbox` (about 190 lines): the page store held 0 feedback documents after 7 days; three incident fixes went into the save folder of `pull`, and one save held a session 8.5 h. A session now makes one ArtifactData query and writes the item itself.
- The contract text scan in `unit-open` (about 125 lines): a regex with negation rules read contract prose for `rm`, `EnterWorktree` and save paths. That is a judgement about content. The rule stays as text (SKILL.md, "No permission prompts"), and the stop guard shows a session that waits.
- The `unit-open` refusal on the no-move gate: the three projects hold 46 re-plan files, form-doc row E1 has 10 versions, and its board still showed stall 9. The gate produced documents, not moves. `gate` still prints the line and exits 5, as context for the orchestrator and for the spawn script.
- The internal-code check in `post`: a word blocklist on the model's text. The field sizes stay, because the page has fixed fields.
- `codex-unit.sh` and `Workflows/Codex.md`: the newest Codex run log on disk was from 2026-11-19. Git has both files.
- Before a new tool command: is it a lock, atomic state, the spawn substrate or machine state? If not, write the sentence, not the code.
