# Watch

The watch is the head orchestrator over all live loops: the chain `endstate-setup-N`. Each loop has its own orchestrator. The watch keeps each loop moving toward its end state, keeps Jm's status page current and checks the claims. It never does a loop's own work. Run this workflow in a session that starts as `endstate-setup-N`.

The watch tools are in git in `Tools/watch/`. `~/.kaya/state/endstate-setup/` links to them and holds their state files (logs, `formdoc-last-pushed.txt`, `page-copies/`, `stops/`).

## Session start

1. Stop the predecessor session (Handoff skill, "When you are the next session", step 4). At its handoff it holds no wait, no timer and no agent.
2. Tell each live orchestrator and each loop host the new name: "Kaya's: setup is now endstate-setup-N".
3. Before you read the old session's view, run a fresh-agent Check (`Workflows/Check.md`, steps 1-5). Brief the agent with the board paths and Check.md, not with the handoff. Put its findings verbatim in your first report to Jm (Jm form-doc F-029, 2026-11-24).
4. Start the wait (next section).

## The wait

Keep one background wait in flight at all times. Start it with `run_in_background`, never with `&`. Start it again at every wake. After a session resume, the old wait is dead: start a new one.

`bash ~/.kaya/state/endstate-setup/wait-units-disk.sh <limit GiB> <step> <cap s> <board>...`

Example: `WAIT_SKIP_IDS=<ids> bash ~/.kaya/state/endstate-setup/wait-units-disk.sh 10 3 1800 <board> <board>`. It wakes the watch when:
- closed units grow by `<step>`;
- free disk is below `<limit GiB>`;
- a session is blocked for 10 min or more (for example on a permission prompt; only Jm answers it). `WAIT_SKIP_IDS` lists sessions that are blocked on Jm and already reported;
- a loop has a status-page lag (`page-lag.py --wake`);
- the cap `<cap s>` ends.

## Each wake

1. `claude agents --json > <job tmp>/agents.json`, then `python3 -I ~/.kaya/state/endstate-setup/drift.py <hours> <agents.json> <board>...`. Run it with 1 h, and with 8 h now and then: 8 h shows the same "next" line in many posts. It prints SHIP, TOP, CHURN, ZOMBIE, BLOCKED and exam-debt flags.
2. `~/.claude/bin/loop-usage-guard.sh`; `df -h /`; the stop alerts in `~/.kaya/state/endstate-setup/stops/CURRENT.json`.
3. For each loop: the tail of its newest decisions file and its log (for a driver loop, `LOOP.log`).
4. `python3 -I ~/.kaya/state/endstate-setup/page-lag.py`: one line per loop, OK or DUE.
5. Report the end-state numbers first (proven rows, the driver numbers of each loop). A check of one post is not a progress check.

## Status page

The page is https://claude.ai/artifact/HYZQ2KKQxtwphAwRGs8kXb. The watch keeps it current for every live loop (Jm, 2026-11-24: "why is the endstate loop artifact not being updated?").

- A loop that cannot reach claude.ai (a Gemini loop) cannot post. The watch relays each of its posts at once. Run the claim audit first (`Workflows/Check.md`). If a claim fails, send the post with a first line that names each FALSE claim. Never hold a post for a correction post.
- Send a post with `ArtifactData` `set`, collection `updates`, `doc_id` = the file name, `file_path` = the post file. Write the id of the last post that you sent to `formdoc-last-pushed.txt` (same folder as the tools).
- If a loop's newest post is more than 2 h old, tell its orchestrator to post now, with its driver numbers (`Status.ts post --number`). This holds when no unit changed.

## Steer a loop

Use a steer when a loop stops moving its end state. Do not wait for a stop.

1. Write the steer as a file in the project's `data/endstate/watch/` (`STEER-<n>-<topic>.md`). Label it: the watch's proposal, not Jm's words.
2. Send it through the loop host. The host places it in the orchestrator's `HANDOFF.md` at a step boundary.
3. Give the steer a guard with a stop test. Keep the guard until every point of the steer closes. If you end it after one point, the orchestrator drops the other points.
4. Check that the actor can follow the steer in its sandbox. A rule that the actor cannot follow fails silently (`bun` cannot run in the `agy` sandbox, so the orchestrator wrote the board by hand).

## Exam requests

A loop that cannot start Claude agents writes `data/endstate/requests/<prefix>-exam-<n>.md` (form-doc: `formdoc-exam-30.md`). Read it whole. If the request names a live Claude orchestrator, that orchestrator spawns the examiner (Orchestrate.md step 5): do not spawn a second one. Send your notes to the examiner, or ask the orchestrator first (two formdoc-exam-31 sessions, 2026-11-24). Add a section "Notes from the Kaya watch": report to `endstate-setup-N`, the rank order, and a usage stop 2 points below the loop pause (88 % while the pause is at 90 %). A ban on helper agents must name the agents that the row's own rule needs (for example blind labellers): those stay allowed. Spawn the examiner from `~/.claude` (a project folder that Claude does not trust cannot spawn). The examiner reports to the watch.

## Disk and Trash

If free disk falls fast, run `du -sh ~/.claude/jobs/*` first. Below 15 GiB, purge the loop Trash folders and log it (Jm, 2026-11-01). Before a purge, ask each orchestrator which Trash items it still needs: a Trash folder can hold the only copy of its inputs. Never remove a worktree with force. Never stop a loop's unit or builder sessions: their orchestrator owns them.

## Usage

Run `~/.claude/bin/loop-usage-guard.sh` at each wake. Give the rate in points per hour and the time when it reaches 100 %. Jm resets the usage at 100 % (F-014). Never measure or cite Jm's own use of a product.

## Report to Jm

Write in ASD-STE100. Put the end-state numbers first, then what moved for Jm (yes or no, with the reason), then the decisions that only he can make, each with a default. A loop that waits for Jm's word is not stopped: ask once with a default, then go on. A guard or classifier refusal is not worked around: report it.

## Handoff

At the context guard, follow the Handoff skill with `endstate-setup-<N+1>`. The handoff names the wait command, the per-wake steps, the open steers with their guards, the held posts and the open decisions. It keeps a log: `~/.kaya/state/endstate-setup/session<N>-log.md`, one line per step, times from `date`.

## Tools (`Tools/watch/`, linked from `~/.kaya/state/endstate-setup/`)

| Tool | Use |
|------|-----|
| `wait-units-disk.sh` | the background wait (see above) |
| `drift.py` | drift flags per board |
| `page-lag.py` | status-page lag: relay posts not yet sent, posts older than 2 h 10 min |
| `formdoc-board-requests.py` | runs the board writes that a Gemini orchestrator asks for (`Workflows/ForeignLoop.md`) |
