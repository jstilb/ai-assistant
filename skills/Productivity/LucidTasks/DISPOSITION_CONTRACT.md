# Disposition Contract

This document specifies the `disposition` column in the `tasks` table of `lucidtasks.db`.

## Column

`tasks.disposition TEXT` — nullable, defaults to `NULL`.

Written by the **InboxTriage agent** at 04:30 daily, the **scratchpad workflow** at capture time, or via the explicit `--disposition` flag on `tasks add`. `NULL` means the task predates triage or was created without routing.

## Enum Values (4-way)

| Value | Meaning | Downstream consumer |
|---|---|---|
| `autonomous` | Kaya can execute without Jm's involvement | AutonomousWork executor |
| `needs-jm` | Requires Jm's physical presence, credentials, or consequential authority | LucidTasks board (Needs-Jm project) |
| `personal-todo` | Personal errand requiring Jm's physical action but not authority | LucidTasks inbox |
| `drop` | Throwaway capture — discarded, no task created | (discarded) |

### Why lifeos-idea and note were removed

`lifeos-idea` and `note` had no task-level consumers. The InboxTriage and scratchpad agents handle those captures by **moving them to their real home** — LifeOS vault entries and Obsidian notes respectively — rather than creating a tagged task. Tagging a task `lifeos-idea` produced an orphaned task that nothing consumed; the agents now act directly on the content instead.

## Schema Location

`DispositionSchema` is defined in `skills/Productivity/LucidTasks/Tools/TaskDB.ts`.

## Governing Principle

The triage agent defaults to `autonomous`. `needs-jm` is reserved for genuinely human-gated situations (spending money, in-person presence, exclusive credentials). High-stakes work routes as `autonomous` with rationale in the task description — there are no confidence cutoffs or gate thresholds.

## Handoff Seam

Tasks where `disposition = 'autonomous'` are the handoff to the downstream autonomous executor. These tasks are NOT enqueued into the spec-pipeline directly — the executor reads `disposition = 'autonomous'` from the task table and decides how to process them.

## Files

- `skills/Productivity/InformationManager/Workflows/Triage-Inbox.md` — agent workflow that assigns disposition (runs at 04:30 daily)
- `skills/Productivity/InformationManager/Workflows/Organize-ScratchPad.md` — scratchpad workflow that routes captures (may write disposition directly)
- `skills/Productivity/InformationManager/docs/InformationLayout.md` — routing context both workflows read
- `skills/Productivity/LucidTasks/Tools/TaskDB.ts` — stores `disposition`; exports `DispositionSchema`
