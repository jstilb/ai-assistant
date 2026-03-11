# AddTask Workflow

Add a new task to LucidTasks.

## Trigger

- "add task"
- "new task"
- "/lt add"

## Purpose

Capture a task quickly with optional metadata (goal, project, due date, priority, energy level, time estimate, and more). All tasks land in the `inbox` status by default unless `--status` is specified.

## Steps

1. **Parse input** - Extract title (required) and optional flags
2. **Validate goal** - If `--goal` given, verify against TELOS active goals
3. **Resolve project** - If `--project` given, lookup by name or ID
4. **Parse dates** - Resolve `--due` and `--schedule` to ISO format
5. **Create task** - Insert into SQLite with all metadata
6. **Voice notification** - Automatic via `notifySync("Task added: <title>")` in TaskManager

## CLI Usage

```bash
# Basic task (lands in inbox)
bun skills/Productivity/LucidTasks/Tools/TaskManager.ts add "Fix auth bug"

# With description
bun skills/Productivity/LucidTasks/Tools/TaskManager.ts add "Deploy v2" --desc "Deploy to production"
bun skills/Productivity/LucidTasks/Tools/TaskManager.ts add "Deploy v2" --description "Deploy to production"

# Link to TELOS goal (validated against active goals)
bun skills/Productivity/LucidTasks/Tools/TaskManager.ts add "Write docs" --goal G25

# Assign to project (by name or ID)
bun skills/Productivity/LucidTasks/Tools/TaskManager.ts add "API endpoint" --project backend

# Set due date (relative formats)
bun skills/Productivity/LucidTasks/Tools/TaskManager.ts add "Review PR" --due tomorrow
bun skills/Productivity/LucidTasks/Tools/TaskManager.ts add "Sprint planning" --due fri
bun skills/Productivity/LucidTasks/Tools/TaskManager.ts add "Quarterly report" --due +2w

# Set due date (absolute ISO format)
bun skills/Productivity/LucidTasks/Tools/TaskManager.ts add "Conference talk" --due 2026-03-15

# Set scheduled date (when to appear in today's view)
bun skills/Productivity/LucidTasks/Tools/TaskManager.ts add "Weekly review" --schedule +7d

# Set priority (1=high, 2=normal default, 3=low)
bun skills/Productivity/LucidTasks/Tools/TaskManager.ts add "Critical bug" --priority 1

# Set initial status (default: inbox)
bun skills/Productivity/LucidTasks/Tools/TaskManager.ts add "Code review" --status next

# Set energy level
bun skills/Productivity/LucidTasks/Tools/TaskManager.ts add "Deep work task" --energy high
bun skills/Productivity/LucidTasks/Tools/TaskManager.ts add "Admin task" --energy low

# Set time estimate in minutes
bun skills/Productivity/LucidTasks/Tools/TaskManager.ts add "Write chapter" --estimate 90

# Set parent task (for subtasks)
bun skills/Productivity/LucidTasks/Tools/TaskManager.ts add "Write unit tests" --parent t-abc123

# Combined options
bun skills/Productivity/LucidTasks/Tools/TaskManager.ts add "New feature" --goal G30 --project frontend --due +3d --priority 2 --energy high --estimate 120

# JSON output
bun skills/Productivity/LucidTasks/Tools/TaskManager.ts add "My task" --json
```

### Implemented Flags

| Flag | Description | Status |
|------|-------------|--------|
| `--goal <id>` | Link to TELOS goal (validates against active goals) | Implemented |
| `--project <name\|id>` | Assign to project (lookup by name or ID) | Implemented |
| `--due <date>` | Set due date (today, tomorrow, fri, +3d, +2w, YYYY-MM-DD) | Implemented |
| `--schedule <date>` | Set scheduled date (same formats as `--due`) | Implemented |
| `--priority <1-3>` | Set priority: 1=high, 2=normal (default), 3=low | Implemented |
| `--status <status>` | Set initial status (default: inbox) | Implemented |
| `--desc <text>` | Add description (alias: `--description`) | Implemented |
| `--energy low\|medium\|high` | Set energy level for the task | Implemented |
| `--estimate <minutes>` | Set time estimate in minutes | Implemented |
| `--parent <task-id>` | Set parent task (creates a subtask) | Implemented |
| `--json` | Output created task as JSON | Implemented |

### Planned Flags

| Flag | Description | Status |
|------|-------------|--------|
| `--recur <rule>` | Set recurrence rule (e.g., "daily", "weekly") | Planned |
| `--calendar` | Flag task for calendar integration | Planned |
| `--queue <id>` | Link task to a queue item | Planned |

Note: `recurrence_rule` and `queue_item_id` columns exist in the database schema but are not yet settable via the `add` command.

## Date Formats

All date inputs accept:
- `today` - today's date
- `tomorrow` or `tmrw` - tomorrow
- `mon`, `tue`, `wed`, `thu`, `fri`, `sat`, `sun` - next occurrence of that day
- `monday`, `tuesday`, ..., `wednesday` - full day names
- `+3d` - N days from now
- `+2w` - N weeks from now
- `YYYY-MM-DD` - ISO date passthrough

## Goal Validation

If `--goal` is provided:
1. Loads all goal IDs from TELOS
2. Errors if the goal ID is not found
3. Warns (but continues) if the goal status is not "In Progress"

## Voice Notification

Automatic via `notifySync("Task added: <title>")` in TaskManager.ts. No manual notification required.

## Integration

- Links to TELOS goals via `--goal` flag (validated)
- Assigns to projects via `--project` flag (resolved by name or ID)
- Relative date parsing via `parseRelativeDate()`
- All tasks route to inbox by default for triage

## Output

```
Created: [ ] !!  t-lm7xyz-abc  Fix auth bug due:2026-02-17 G25 @backend
```

With `--json`:

```json
{
  "id": "t-lm7xyz-abc",
  "title": "Fix auth bug",
  "status": "inbox",
  "priority": 2,
  "due_date": "2026-02-17",
  "goal_id": "G25",
  "project_id": "p-backend-xyz",
  ...
}
```
