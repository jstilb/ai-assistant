# LucidTasks — Task State and Routing

LucidTasks owns the `tasks` table in `lucidtasks.db`. Its task state and routing terms are distinct from the Spec Pipeline's `pipeline_items.stage` and classifier verdicts.

## Language

**LucidTask**:
A task row with a `t-…` ID, title, status, priority, optional project and schedule fields, and an optional disposition. `Tools/TaskDB.ts` defines its schema.

**Status**:
The task's workflow state: `inbox`, `next`, `in_progress`, `waiting`, `someday`, `done`, or `cancelled`. Status does not say whether Kaya may execute the task.

**Open (Status set)**:
A task whose Status is in `OPEN_TASK_STATUSES`: `inbox`, `next`, `in_progress`, or `waiting`. It is every Status not in `CLOSED_TASK_STATUSES` (`done`, `cancelled`, `someday`); `TaskDB.ts` derives one from the other.
_Avoid_: "active" for this set (Project status `active` is a different thing).

**Disposition**:
The separate routing decision in `tasks.disposition`: `autonomous`, `needs-jm`, `personal-todo`, or `drop`; `NULL` means no routing decision is recorded. [DISPOSITION_CONTRACT.md](DISPOSITION_CONTRACT.md) owns the exact writer and handoff contract. The Spec Pipeline's classifier outcome is a different field and should be called a triage verdict.

**Priority**:
The task's 1–3 urgency value. Priority and status are independent; neither grants execution authority.

**Icebox**:
A project for parked work. `someday` is a task status; a task can also belong to the Icebox project. Preserve both meanings when filtering or moving tasks.

**Task Executor (Lane A)**:
The autonomous executor under `Tools/executor/` that selects tasks with `disposition='autonomous'` and applies its own gates. It does not turn every task into a Spec Pipeline item.

**Task event**:
One row in the `task_events` table: a task change, completion, automation action, or comment, with its actor. Called `activity_log` before ontology ruling D10; `TaskDB` renames an old `activity_log` on open (`PRAGMA user_version` 1 = renamed) and `Tools/MigrateTaskEvents.ts` runs or rolls back the rename on demand.
_Avoid_: activity log, log ("Log" means a LifeOS domain table; LifeOS has its own unrelated `activity_log`).

**Outcome**:
What came of a closed task — headline, links or a no-artifact reason, optional check, for-Jm items, details. Stored as JSON in `tasks.outcome`; `Tools/TaskOutcome.ts` owns the shape. An agent cannot move a task to `done` without an acceptable one.
_Avoid_: result, summary.

**Bookkeeping close**:
An agent close with nothing to link, because other work finished (queue item done, escalation resolved). `TaskDB.bookkeepingClose` is the only writer; it keeps an acceptable Outcome or records a system one.
_Avoid_: auto-close, system close.

**Task read interface**:
The only way code outside LucidTasks reads `lucidtasks.db` (ADR-030 lane): `TaskDB.listTasks` over one `TaskFilter` (incl. `between` on a timestamp column), on a connection from `openTaskDBReadOnly`, which never creates the DB, runs schema init, then sets `query_only`. The caller closes it. Task events: `TaskDB.listTaskEvents` (id order, `changes` parsed). A read-only connection never prunes events. Planned addition: `countTasks`.
_Avoid_: raw SQL on `tasks`, own `new Database(lucidtasks.db)`.

## Relationships

- Status says where the task sits; disposition says who or what may act on it; priority helps order eligible work.
- A task may be `someday` regardless of its project, while Icebox is a project name.
- The Task Executor (Lane A) consumes eligible autonomous tasks; QueueRouter's Spec Pipeline has its own item IDs, stages, and approval gate.
