# CompleteTask Workflow

Mark one or more tasks as complete in LucidTasks.

## Trigger

- "done"
- "complete task"
- "/lt done"
- "/lt complete"

## Purpose

Mark a task as finished and move it to the done state. Supports single tasks by ID, fuzzy title matching, and batch completion of multiple tasks in one command.

## Steps

1. **Parse input** - Extract task ID(s) or title fragment from arguments
2. **Find task** - Lookup by ID (prefix `t-`) or fuzzy match via FTS when a title fragment is given
3. **Mark complete** - Update status to `done` with `completed_at` timestamp auto-set
4. **Log activity** - Completion note and elapsed time (if `started_at` is set) written to activity log
5. **Voice notification** - Automatic via `notifySync()` in TaskManager

## CLI Usage

### Implemented

```bash
# By exact task ID (prefix t-)
bun skills/LucidTasks/Tools/TaskManager.ts done t-abc123-xyz

# By title fragment (fuzzy match via FTS)
bun skills/LucidTasks/Tools/TaskManager.ts done "Fix auth bug"

# Batch complete multiple tasks (mix of IDs and title fragments)
bun skills/LucidTasks/Tools/TaskManager.ts done t-abc123 t-def456 t-ghi789

# With completion note (appended to activity log for all tasks in batch)
bun skills/LucidTasks/Tools/TaskManager.ts done t-abc123-xyz --note "Fixed by adding null check"

# Batch with note
bun skills/LucidTasks/Tools/TaskManager.ts done t-001 t-002 t-003 --note "Sprint cleanup"

# JSON output (pipe-friendly)
bun skills/LucidTasks/Tools/TaskManager.ts done t-abc123 --json
```

### Flags

| Flag | Description | Status |
|------|-------------|--------|
| `--note "text"` | Add completion note to activity log | Implemented |
| `--json` | Output as JSON (`{ completed, failed }`) | Implemented |

### Planned

No additional flags planned at this time.

## Resolution Logic

- **ID match**: Argument matches `/^t-/` pattern → direct ID lookup via `getTask()`
- **Fuzzy match**: No `t-` prefix → full-text search via `searchTasks(arg, 5)` → filters out done/cancelled results
  - If exactly 1 active match: complete it
  - If 0 active matches: error with reason (already done, or no match)
  - If multiple active matches: print candidates and exit with error (ambiguous)

## Duration Tracking

If a task has `started_at` set (via `next --start`), the elapsed time is automatically calculated on completion:

```
elapsed_minutes = round((completed_at - started_at) / 60000)
```

Elapsed time appears in the output line and is logged to the activity log.

## Voice Notification

Automatic via `notifySync("Completed: <title>")` in TaskManager.ts. No manual notification required.

## Integration

- Updates task status to `done`
- Sets `completed_at` timestamp automatically
- Calculates duration from `started_at` if present
- Logs activity with optional `--note` and elapsed minutes
- Sends voice notification for all completed tasks

## Output

Single task completion:

```
Completed: Fix authentication bug (took 2h 15m)
```

Batch completion with summary:

```
Completed: Task 1
Completed: Task 2
Completed: Task 3

Summary: 3 completed, 0 failed
```

JSON output (`--json`):

```json
{
  "completed": [
    { "task": { "id": "t-abc123", "title": "Fix auth bug", "status": "done", ... }, "elapsed_minutes": 135 }
  ],
  "failed": []
}
```
