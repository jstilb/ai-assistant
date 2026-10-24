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
3. **Record outcome** - Build the outcome from `--outcome`, `--link`, `--check`, `--no-artifact`, `--for-jm`, and `--details`. The CLI validates the whole outcome first
4. **Create for-Jm tasks** - Each `--for-jm` item becomes a `needs-jm` child task. Nothing is created if the close is refused
5. **Mark complete** - Update status to `done` with `completed_at` timestamp auto-set. The database checks the outcome rule
6. **Record task event** - Completion note and elapsed time (if `started_at` is set) written to task events
7. **Voice notification** - Automatic via `notifySync()` in TaskManager

## CLI Usage

### Implemented

```bash
# Code change: headline + links + check
bun skills/Productivity/LucidTasks/Tools/TaskManager.ts done t-abc123-xyz --outcome "Fixed auth null check" --link skills/Productivity/LucidTasks/Tools/TaskDB.ts --link https://example.com/pr/1 --check "bun test /abs/path/auth.test.ts"

# Decision, nothing to link
bun skills/Productivity/LucidTasks/Tools/TaskManager.ts done "Fix auth bug" --outcome "Chose to keep the old login flow" --no-artifact "decision made in chat"

# Items only Jm can do (each becomes a needs-jm child task)
bun skills/Productivity/LucidTasks/Tools/TaskManager.ts done t-abc123 --outcome "Built report" --link /abs/path/report.md --for-jm "Review the report" --for-jm "Pick a launch date"

# Batch: the same outcome goes to every task
bun skills/Productivity/LucidTasks/Tools/TaskManager.ts done t-001 t-002 t-003 --outcome "Sprint cleanup" --no-artifact "bookkeeping only"

# Fill outcome details (--note fills details when --details is absent)
bun skills/Productivity/LucidTasks/Tools/TaskManager.ts done t-abc123-xyz --outcome "Fixed auth null check" --link /abs/path/file.ts --note "Fixed by adding null check"

# JSON output (pipe-friendly)
bun skills/Productivity/LucidTasks/Tools/TaskManager.ts done t-abc123 --outcome "Fixed auth" --link /abs/path/file.ts --json
```

### Flags

| Flag | Description | Status |
|------|-------------|--------|
| `--outcome "text"` | One-line headline: what changed | Implemented |
| `--link <path\|url\|task-id>` | Where the work is. Repeatable. A 7-40 character hex string is a commit. Prefixes `commit:`, `branch:`, `task:`, `repo:`, `url:` force the kind | Implemented |
| `--check "cmd"` | One command or step that verifies the work | Implemented |
| `--no-artifact "why"` | Reason there is nothing to link | Implemented |
| `--for-jm "item"` | Item for Jm. Repeatable. Creates a `needs-jm` child task | Implemented |
| `--details "text"` | Full report, folded by default | Implemented |
| `--actor <name>` | Who closes the task (default `user`). `board` and `telegram` are refused | Implemented |
| `--note "text"` | Add completion note to task events. Fills details when `--details` is absent | Implemented |
| `--json` | Output as JSON (`{ completed, failed }`) | Implemented |

### Outcome rule

An agent is every actor except `board` and `telegram`. It cannot close a task without a headline AND at least one `--link` or a `--no-artifact` reason.

If the outcome is missing, the command prints an error that names the missing part and the fix. It exits with code 1. No task closes.

The default CLI actor is `user`. The rule treats it as an agent. A person who uses the raw CLI also passes an outcome. For a quick close, use `--no-artifact`.

`--actor board` and `--actor telegram` are refused for closes. Those names belong to the board and Telegram.

In a batch, the CLI checks the outcome flags up front. If they are missing or invalid, no task closes. If one task id is unknown, the CLI skips it and reports it. The other tasks close ("N completed, M failed").

### Planned

None.

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

Elapsed time appears in the output line and is logged to the task events.

## Voice Notification

Automatic via `notifySync("Completed: <title>")` in TaskManager.ts. No manual notification required.

## Integration

- Updates task status to `done`
- Sets `completed_at` timestamp automatically
- Calculates duration from `started_at` if present
- Stores the outcome (headline, links, check, for-Jm items, details) on the task
- Creates `needs-jm` child tasks for `--for-jm` items
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
