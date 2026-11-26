# Check

A check from outside on the live loops: are they alive, and do they move toward their end states? Run it when Jm asks, from a session that is not one of the loops. It is read-only on the projects. A new watch session (the chain that watches the loops) also starts with it: one fresh agent runs steps 1-5 before the session reads the old session's view in its handoff, and its findings go into the session's first report to Jm verbatim (Jm form-doc F-029, 2026-11-24: the watch must not inherit its predecessor's blind spots).

## Steps

1. **Find the loops.** `ListAgents`; `~/.claude/jobs/<id>/state.json` (`state`, `tempo`, `detail`, `updatedAt`); the newest files in `~/.kaya/handoffs/`; `~/.kaya/handoffs/PAUSED-2026-11-02.md` for the paused chains and Jm's words on each. A paused chain stays paused: only Jm's word starts it.

2. **Read the board of each live project.** `Board.ts show <board>` and `KEY-DRIVERS-<n>.md` beside it. Compare with the last check per key driver: did what Jm receives get better, and by which units. If a project has no board, run Setup first. Then `Status.ts show <board> --last 3`: the orchestrator's own verdicts and the feedback from the status page (https://claude.ai/artifact/HYZQ2KKQxtwphAwRGs8kXb) that has no answer.

3. **Read claims against the disk.** For the newest 2 or 3 closed units: does `RESULT.md` name evidence that exists; does the mark's set folder exist; is the live product on the merged commit. Use one agent per project for this read when it is noisy, and verify its main numbers yourself.

4. **Look for drift signs.**
   - A session that changed nothing that Jm receives. A unit picked from a hole or by testability, not from a key driver's biggest missing piece.
   - A wait that holds a session while the board has work that needs no wait.
   - Planted faults or test sets from the same session that wrote the test. Ask who wrote them.
   - A test whose ground truth is a judge that did not pass its own test.
   - A limit claim ("cannot", "no data", "adds noise") with no test behind it.
   - A step that waits on, measures or reports Jm's use (F-030).
   - Gains that small samples cannot carry.
   - A status page that lags: units closed with no post after them, or Jm's feedback with no receipt or no answer for more than 2 h; an item that has its answer and still sits in `FEEDBACK.md`.
   - A `--progress yes` that the facts in the same update do not carry (live changes 0), or `--aligned yes` while an open `FEEDBACK.md` item asks for a row change.

5. **Usage and memory.** `MEMORY/State/rate-limits.json` (`sevenDay`), the readings in the handoffs, the reset time. Give the rate in points per hour and the time when it reaches 100 %. `top -l 1 -o mem`: name sessions and helper processes that no loop needs.

6. **Send findings** to each orchestrator with `SendMessage`. Label them: your proposals, not Jm's words; not a stop. The orchestrator ranks them. Never change a loop's files, a stop file or a paused chain.

7. **Report to Jm** in ASD-STE100: one table (loop · alive · per key driver: did what Jm receives get better, yes or no, with the before and after images · the gap), what you sent, usage, the paused loops, and the decisions that only he can make, each with a default.

## Claim audit (per merge)

Why (Jm form-doc F-029, 2026-11-24): a loop that checks its own work ships false claims, and each one counts as a move, so the gate never fires. Exams cannot be the fix: as the progress currency (11-09 to 11-18) they became the work, and the 11-18 exam clock was removed (rootcause SYNTHESIS-1). Jm's 11-19 design is a fresh reviewer after each merge plus one exam per version. This audit is that fresh reviewer, kept cheap and on the path to Jm.

- **When:** after each merge, before the status post that names it reaches Jm's page. For a loop whose orchestrator cannot start Claude agents (Gemini `agy`), its driver runs `Tools/ClaimAudit.ts` between steps (`next <board> --since U<n>`, then `run <board> --unit U<n> --by <name> --results <file the next step reads>`): one fresh headless sonnet with this section as its brief, `AUDIT.md`, and the `unit-audit` below; the watch reads `AUDIT.md` before it sends the post. A Claude orchestrator runs it as its fast merge check (Orchestrate.md step 5), as an Agent or with the same tool.
- **Who:** one fresh agent (sonnet; `RateLimitGuard.ts --preferred sonnet`) that did not build or review the unit. Budget about 25 tool calls. Give it the post (or `RESULT.md`), the unit folder, the merged commit, the row sentences and Jm's words for the row; not the builder's verdict.
- **What it checks**, per claim in the post (`where`, `done`, `progress`): the product evidence (the run's output, the report line, the picture) and the code path that makes it on the merged commit. A claim is FALSE when the evidence does not show it; when the product reads labels, a hand bank or check-half data at run time; when a count of coverage is worded as accuracy ("15 of 15 attributed"); or when a number does not recompute. UNCLEAR when the evidence is not on disk. It does not rerun the builder's own check scripts as its proof.
- **Output:** `AUDIT.md` in the unit folder: one line per claim (TRUE / FALSE / UNCLEAR, file:line or the picture).
- **On FALSE:** do not hold the post: send it at once with a first line that names each FALSE claim and says the move does not count (a held post left Jm's page silent for 2 h on 2026-11-24, Jm: "why is the endstate loop artifact not being updated?"); the loop's next post corrects the claims; `Board.ts unit-audit <board> --unit U<n> --result fail --by <name> --note "<claim>: <evidence>"` (the move is revoked; two revoked units in a row make the gate say RE-PLAN); mark the row `failed` with the evidence when the row's claim rests on it; send the loop a steer with a stop test. **On UNCLEAR or over-wide, with no FALSE** (a claim worded wider than its evidence, e.g. a rule said for all cases but tested on some, or a simulated number not labelled as simulated; or evidence not on disk): the loop writes a correction post that narrows or labels each such claim, and it goes to the page with the post. The move stands only when the auditor verified the live change itself (the product output on the merged commit shows it): `unit-audit --result pass --note "UNCLEAR <claim>; correction <post id>; live change: <evidence>"`. If the live change is not verified, record `--result fail`, as for FALSE (edition U172, 2026-11-24: over-wide rule wording, correction post edition-0094, live 'restated out 1' verified, so pass). **On all TRUE:** send the post; `unit-audit --result pass`.

## Do not

- Do not propose a trial by Jm as the fix for a weak mark. Design a test that needs no person (Jm, 2026-11-09).
- Do not copy a loop's limit claim into your report without its test.
- Do not accept an agent's summary as your finding: check the numbers that you report.
