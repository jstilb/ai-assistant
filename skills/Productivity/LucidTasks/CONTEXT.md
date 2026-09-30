# LucidTasks — Task State and Routing

LucidTasks owns the `tasks` table in `lucidtasks.db`. Its task state and routing terms are distinct from the Spec Pipeline's `pipeline_items.stage` and classifier verdicts.

## Language

**LucidTask**:
A task row with a `t-…` ID, title, status, priority, optional project and schedule fields, and an optional disposition. `Tools/TaskDB.ts` defines its schema.

**Status**:
The task's workflow state: `inbox`, `next`, `in_progress`, `waiting`, `someday`, `done`, or `cancelled`. Status does not say whether Kaya may execute the task.

**Disposition**:
The separate routing decision in `tasks.disposition`: `autonomous`, `needs-jm`, `personal-todo`, or `drop`; `NULL` means no routing decision is recorded. [DISPOSITION_CONTRACT.md](DISPOSITION_CONTRACT.md) owns the exact writer and handoff contract. The Spec Pipeline's classifier outcome is a different field and should be called a triage verdict.

**Priority**:
The task's 1–3 urgency value. Priority and status are independent; neither grants execution authority.

**Icebox**:
A project for parked work. `someday` is a task status; a task can also belong to the Icebox project. Preserve both meanings when filtering or moving tasks.

**Task Executor (Lane A)**:
The autonomous executor under `Tools/executor/` that selects tasks with `disposition='autonomous'` and applies its own gates. It does not turn every task into a Spec Pipeline item.

**Task event**:
An audit entry currently stored in `activity_log` for a task change, completion, or comment. The approved D10 table rename to `task_events` is a separate migration and has not happened here.

## Relationships

- Status says where the task sits; disposition says who or what may act on it; priority helps order eligible work.
- A task may be `someday` regardless of its project, while Icebox is a project name.
- Lane A consumes eligible autonomous tasks; QueueRouter's Spec Pipeline has its own item IDs, stages, and approval gate.
