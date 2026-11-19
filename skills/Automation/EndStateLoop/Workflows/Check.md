# Check

A check from outside on the live loops: are they alive, and do they move toward their end states? Run it when Jm asks, from a session that is not one of the loops. It is read-only on the projects.

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
   - A status page that lags: units closed with no post after them, or Jm's feedback with no receipt or no answer for more than 2 h.
   - A `--progress yes` that the facts in the same update do not carry (live changes 0), or `--aligned yes` while a `FEEDBACK.md` `## Open` item asks for a row change.

5. **Usage and memory.** `MEMORY/State/rate-limits.json` (`sevenDay`), the readings in the handoffs, the reset time. Give the rate in points per hour and the time when it reaches 100 %. `top -l 1 -o mem`: name sessions and helper processes that no loop needs.

6. **Send findings** to each orchestrator with `SendMessage`. Label them: your proposals, not Jm's words; not a stop. The orchestrator ranks them. Never change a loop's files, a stop file or a paused chain.

7. **Report to Jm** in ASD-STE100: one table (loop · alive · per key driver: did what Jm receives get better, yes or no, with the before and after images · the gap), what you sent, usage, the paused loops, and the decisions that only he can make, each with a default.

## Do not

- Do not propose a trial by Jm as the fix for a weak mark. Design a test that needs no person (Jm, 2026-11-09).
- Do not copy a loop's limit claim into your report without its test.
- Do not accept an agent's summary as your finding: check the numbers that you report.
