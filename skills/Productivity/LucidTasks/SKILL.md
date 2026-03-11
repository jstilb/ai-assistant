---
name: LucidTasks
description: AI-first task management replacing Asana. USE WHEN tasks, task management, add task, complete task, task inbox, task projects, task search, task stats, lucid tasks, lt, todo, to-do, my tasks, next task, task migration.
---
# LucidTasks

AI-first task management system. Local SQLite storage, TELOS goal integration, full CLI interface. Replaces Asana with deeper AI integration and zero subscription cost.

**USE WHEN:** tasks, task management, add task, complete task, inbox, projects, search tasks, task stats, next task, todo, lucid tasks, lt.

## Voice Notification

Uses `notifySync()` from `lib/core/NotificationService.ts`:
- Task added: `notifySync("Task added: <title>")`
- Task completed: `notifySync("Completed: <title>")`
- Migration done: `notifySync("Asana migration complete")`

## Customization

| Setting | Default | Description |
|---------|---------|-------------|
| DB path | `Data/lucidtasks.db` | SQLite database location |
| Batch size | 50 | Tasks per AI classification batch |
| TELOS cache TTL | 5 min | How long goal data is cached |

## Workflow Routing

**When executing a workflow, output this notification:**

```
Running the **WorkflowName** workflow from the **LucidTasks** skill...
```

| Workflow | Trigger | File |
|----------|---------|------|
| **AddTask** | "add task", "new task", "/lt add" | `Workflows/AddTask.md` |
| **CompleteTask** | "done", "complete task", "/lt done" | `Workflows/CompleteTask.md` |
| **InboxReview** | "inbox", "review inbox", "/lt inbox" | `Workflows/InboxReview.md` |
| **NextTask** | "what should I work on", "/lt next" | `Workflows/NextTask.md` |

## Commands

```
kaya-cli tasks                               # Today's tasks (next + in_progress + scheduled today)
kaya-cli tasks today                         # Alias for today's tasks
kaya-cli tasks inbox                         # Inbox items needing triage
kaya-cli tasks add "title"                   # Add to inbox
kaya-cli tasks add "title" --goal G25 --project myproject --due fri
kaya-cli tasks done <id|title>               # Mark complete (by ID or fuzzy title match)
kaya-cli tasks done t-001 t-002 t-003        # Batch complete multiple tasks
kaya-cli tasks done <id> --note "text"       # Complete with activity note
kaya-cli tasks next                          # AI-suggested next tasks (7-factor scoring)
kaya-cli tasks next --project backend        # Filter by project
kaya-cli tasks next --goal G25               # Filter by goal
kaya-cli tasks next --energy high            # Boost matching energy level
kaya-cli tasks next --top 5                  # Show top N candidates
kaya-cli tasks next --start                  # Start top task (set in_progress + timer)
kaya-cli tasks projects                      # List projects
kaya-cli tasks project-add "name" --goal G25 --color blue  # Create project
kaya-cli tasks search "query"                # Full-text search
kaya-cli tasks stats                         # Dashboard with counts
kaya-cli tasks dashboard                     # Alias for stats
kaya-cli tasks view <id>                     # View task details + activity log
kaya-cli tasks show <id>                     # Alias for view
kaya-cli tasks get <id>                      # Alias for view
kaya-cli tasks edit <id> --title/--status/--due/--priority/--goal/--project/--energy/--estimate
kaya-cli tasks update <id> [opts]            # Alias for edit
kaya-cli tasks list [--status X] [--project X] [--goal X] [--limit N]  # Filtered listing
kaya-cli tasks ls [opts]                     # Alias for list
kaya-cli tasks migrate [--dry-run] [--skip-ai]  # Asana migration
```

### Global Flags

| Flag | Description |
|------|-------------|
| `--json` | Output as JSON (pipe-friendly, works with all commands) |
| `--help` / `-h` | Show help text |

### Planned Commands

These commands have schema support in the database but CLI is not yet implemented:

```
kaya-cli tasks habits                        # Habit tracking (schema exists, CLI pending)
kaya-cli tasks save-view "name" [--filter]   # Save a named filter/sort preset (schema exists, CLI pending)
kaya-cli tasks views                         # List saved views (schema exists, CLI pending)
kaya-cli tasks view-saved <id>               # Execute a saved view (schema exists, CLI pending)
```

## Examples

**Example 1: Quick task capture**
```
User: "Add a task to call the dentist"
-> bun skills/Productivity/LucidTasks/Tools/TaskManager.ts add "Call the dentist"
-> Task created in inbox with auto-generated ID
```

**Example 2: Task with metadata**
```
User: "Add task 'Write chapter 3' for my novel goal, due Friday"
-> bun skills/Productivity/LucidTasks/Tools/TaskManager.ts add "Write chapter 3" --goal G13 --due fri
-> Task created with TELOS goal link and due date
```

**Example 3: Complete and review**
```
User: "Mark task abc123 as done"
-> bun skills/Productivity/LucidTasks/Tools/TaskManager.ts done t-abc123
-> Task completed, activity logged, voice notification sent
```

**Example 4: Smart next task**
```
User: "What should I work on?"
-> bun skills/Productivity/LucidTasks/Tools/TaskManager.ts next --top 3
-> Returns top 3 scored tasks with reasons
```

**Example 5: Start working on a task**
```
User: "Start working on the next task"
-> bun skills/Productivity/LucidTasks/Tools/TaskManager.ts next --start
-> Top task set to in_progress, timer started
```

## Telegram Commands

| Command | Description | Maps To |
|---------|-------------|---------|
| /tasks | Today's tasks | `TaskManager.ts today` |
| /next | Suggested next task | `TaskManager.ts next` |
| /done `<id>` | Complete a task | `TaskManager.ts done <id>` |
| /add `<title>` | Quick task capture | `TaskManager.ts add "<title>"` |

## Integration

### Uses
- **TELOS Goals** (read-only) - `USER/TELOS/GOALS.md` for goal mapping
- **TELOS Missions** (read-only) - `USER/TELOS/MISSIONS.md` for mission context
- **SQLite** - `skills/Productivity/LucidTasks/Data/lucidtasks.db` via `bun:sqlite`

### Tools
- **TaskDB.ts** - SQLite database layer (CRUD, queries, indices, FTS5, 5 tables)
- **TaskManager.ts** - Business logic + CLI interface + 7-factor scoring algorithm
- **TelosGoalLoader.ts** - Parse TELOS markdown into structured data
- **MigrationRunner.ts** - Asana JSON to SQLite migration

### Database Schema (5 Tables)
- `tasks` - All task records with status, priority, dates, metadata
- `projects` - Project groupings with goal links
- `activity_log` - Full audit trail of task changes
- `habit_completions` - Daily habit check-in records (schema ready)
- `saved_views` - Named filter/sort presets (schema ready)
- `tasks_fts` - FTS5 virtual table for full-text search

### Feeds Into
- **DailyBriefing** - Task counts, priorities, inbox status
- **CalendarAssistant** - Scheduled task time-blocking (planned)
- **QueueRouter** - Task-to-queue bridge for autonomous work (planned)

### MCPs Used
- None (pure local SQLite + file system)

---

**Last Updated:** 2026-02-17
