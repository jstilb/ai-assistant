# ForeignLoop

A loop whose orchestrator runs on a model CLI that is not Claude. Example: form-doc runs on Gemini through the Antigravity CLI, `agy -p` (Jm, form-doc F-026, 2026-11-22: "i want you to continue form doc work using gemini antigravity. have it continue the orhcestration loop for formdoc"). The other steps of the loop (board, units, exams, status page) stay the same. This page lists what changes.

Worked example: `/Users/[user]/projects/form-doc/data/endstate/orch-agy/` (`loop.sh`, `PROMPT.md`, `BOARD-HELP.txt`, `HANDOFF.md`).

## The driver script

A bash driver (`loop.sh`) replaces the Claude orchestrator session. One run of the CLI is one step, in a fresh conversation. The state of the loop lives in files.

- `PROMPT.md` is the prompt of each orchestrator step. It tells the model to read `AGENTS.md` and `HANDOFF.md` first.
- `HANDOFF.md` holds the state, the open unit, the next step and the steers. The orchestrator updates it at the end of each step.
- `NEXT-PROMPT.md`: the orchestrator writes a whole brief there for a builder or reviewer that must be independent. The driver runs it as the next step (if the file is not empty) and moves it to `logs/`.
- `STOP`: the driver exits when this file exists. Write it only on Jm's word.
- Disk floor: below 15 GiB free, the driver waits 30 min.
- Failure backoff: after a failed step it waits 5 min; after 5 failures in a row, 60 min; on a quota signal, 30 min. After a good step it waits 30 s.
- A per-step timeout (`--print-timeout`) is the only cap. It fails loud in the log.
- The driver logs each step to `LOOP.log`: role, exit code, status, seconds, the first words of the answer.

## What the sandbox cannot do

The CLI sandbox has no network, and `bun Board.ts` fails in it. The orchestrator writes a request file, and the driver does the action after the step.

| Need | Request file | Who does it |
|------|--------------|-------------|
| `git push` | `PUSH-REQUESTS`, one line `<branch> <full sha>` | the driver; refused when the sha does not match the branch; never forced |
| Board write | `BOARD-REQUESTS`, one JSON line `{"cmd": …, "args": […]}` | `~/.kaya/state/endstate-setup/formdoc-board-requests.py`; the result goes to `BOARD-RESULTS.md` |
| Examiner | `data/endstate/requests/<prefix>-exam-<n>.md` (form-doc: `formdoc-exam-30.md`) | the watch (`Workflows/Watch.md`) |
| Status post to the page | `Status.ts post` writes a file | the watch relays it at once |

The orchestrator never edits `SCOREBOARD.json` by hand: a hand write breaks the board for all later writes. `BOARD-HELP.txt` holds the `Board.ts` usage that the orchestrator needs. The request runner allows only `unit-open`, `unit-close` and `mark`. It refuses `--role examiner` and `--status proven`.

The claim audit runs outside the sandbox. The board-request runner runs `Tools/ClaimAudit.ts run <board> --unit U<n> --by <name> --results BOARD-RESULTS.md` right after each `unit-close` line, before any later line, so that the next `unit-open` meets the gate after a false move is revoked (2026-11-24: U79 opened before U78's revoke). After each step, the driver also runs `ClaimAudit.ts next <board> --since U<n>` as a backstop for an audit run that failed. The tool starts one fresh headless Claude in plan mode (`AgentSpawner` "readonly"). Never use `--dangerously-skip-permissions`. The orchestrator reads the block `## claim audit U<n>` in `BOARD-RESULTS.md` at the start of its next step.

## Secrets

A model CLI from another company must not get Claude credentials. A model that prints its environment would send them to a third party. Run the CLI like this:

`env -u CLAUDE_CODE_OAUTH_TOKEN -u CLAUDE_CODE_MESSAGING_TOKEN -u ANTHROPIC_API_KEY agy -p …`

Check by count (for example, the number of token names in the step logs). Never print a token.

## The host session

A Claude session, the host (`formdoc-agy-host-N`), runs the driver with `run_in_background`. It does no project work.

- It starts or restarts the driver at step boundaries only. Read the last lines of `LOOP.log` first.
- If the driver exits 3 times in 1 hour, the host does not restart it. It writes the cause to `ASK-JM.md` with a default and tells the watch.
- It edits a running driver only by atomic replace (a new file, then a move), then restarts it at a step boundary. Keep a backup of the old file.
- It places the steers of the watch in `HANDOFF.md` at a step boundary and keeps their guards. The watch says when a guard ends.
- It reports to the watch. A status request is not a stop.
- At its context guard, it hands off with the Handoff skill. The successor stops the host only when the driver is between steps.
