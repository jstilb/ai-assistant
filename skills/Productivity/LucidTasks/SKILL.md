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

## Project routing

Read `../InformationManager/docs/InformationLayout.md` and live project descriptions before assigning a project. Project means subject/outcome; disposition means executor. Kaya system work belongs in Kaya; work Kaya performs for another subject stays in that subject project. Youtube is Jm's own channel, not media consumption. Meta holds personal operating plans/reviews; Kaya holds LifeOS implementation work. Preserve machine-linked escalations in Kaya — Needs Jm and existing Icebox parking.

## Task context standard

Jm's ruling (2026-09-21): **a task must carry its context in the description, or link it so it is easily opened.** Jm or any agent should be able to open a task and know what to do without hunting through memory files or plan docs. This applies to every writer: CLI, board, Telegram, LifeOS capture, queue split, decompose, and escalations.

```
WHAT: the concrete action and why it exists (1-2 sentences)
HOW: steps, or numbered OPTIONS with the recommended one if it is a decision
DONE WHEN: observable end state
DEPENDS ON / UNBLOCKS: related task ids (only if real)
CONTEXT: /abs/path/doc.md (section, ~line) | ~/.kaya/memory/x.md | https://... | t-xxxx-xxxxx
```

- **Proportional.** A personal quick-capture ("buy vitamix") needs only what real context exists; link the plan/research note if one exists, otherwise a short WHAT and `NEEDS JM: <what is unknown>`. Never pad, never fabricate.
- **Machine-created tasks always carry a CONTEXT link** (spec path, queue item, parent task, plan doc). "Context: ~/.kaya/memory/x.md" alone does NOT meet the standard: pull the what/how/options out of that file and link the deeper plan docs it points to.
- **Enforcement is a lint, not a gate.** `tasks add` warns when the description has no openable link; `tasks context-lint` lists every open task that fails; the board renders paths, URLs and task ids as clickable chips (paths open via `GET /api/open`). Subtasks from `decompose`, queue `split`, and board AI reorganize inherit the parent's `CONTEXT:` lines.
- Helpers: `hasContextLink()`, `inheritedContextLines()` in `Tools/TaskDB.ts`.

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
kaya-cli tasks priority [--top N]            # MY prioritized list across ALL projects (Jm's lane; = board "Priority" mode)
kaya-cli tasks estimate [--lane jm|kaya|all] [--dry-run|--refresh]  # Fill energy + time estimates (AI); kaya lane calibrated to actuals
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
kaya-cli tasks icebox <id|title>...          # Move task(s) to someday (icebox) status
kaya-cli tasks list [--status X] [--project X] [--goal X] [--limit N]  # Filtered listing
kaya-cli tasks context-lint [--json]         # Open tasks with no context link (see "Task context standard")
kaya-cli tasks ls [opts]                     # Alias for list
kaya-cli tasks board [--no-open]             # Open the live, always-on task board (127.0.0.1:7777)
kaya-cli tasks habits [--task <id>] [--days 30]  # Habit tracking and streaks
kaya-cli tasks save-view "name" [--status X] [--project X] [--goal X] [--energy X]  # Save a named filter view
kaya-cli tasks views                         # List all saved views
kaya-cli tasks view-saved "name"             # Apply a saved view
```

### Live Board (always-on)

`kaya-cli tasks board` opens a **live, interactive** web board backed by the live DB
— see and edit tasks in the browser without going through Kaya, always up to date.
It is served by an always-on localhost server (`Tools/BoardServer.ts`, launchd job
`com.kaya.lucidtasks-board`, loopback-only on **127.0.0.1:7777**). The page auto-refreshes
every 30s and supports mark-done (with Undo), status/priority cycling, project + due-date
edits, inline title edits, quick-add, and a Projects/Status layout toggle (Icebox hidden by
default). The **Done** filter shows completed + cancelled tasks (fetched on demand, newest
first, with completion dates and a ↺ reopen-to-Next button). Search matches title, goal,
project name, and tags. Keyboard: `/` focuses search, `n` opens quick-add, `Esc` closes/clears.

- **Server not running?** `kaya-cli tasks board` prints a start hint. Start it with:
  `launchctl kickstart -k gui/$UID/com.kaya.lucidtasks-board`
- **⚠️ After editing `BoardServer.ts`:** bun caches compiled TS in the running process, so
  restart it to pick up changes: `launchctl kickstart -k gui/$UID/com.kaya.lucidtasks-board`
- The plist is defined in `bin/rebuild-plists.sh` (block `com.kaya.lucidtasks-board`).
- Handler tests: `bun skills/Productivity/LucidTasks/Tools/__tests__/BoardServer.test.ts`

### Priority list (my ranked list across all projects)

The board's **Priority** mode (and `kaya-cli tasks priority`) is one ranked LIST — not a
kanban — of everything that is Jm's to do: active tasks whose `disposition` is not
`autonomous`/`drop` (null = untriaged still counts as Jm's), excluding the Icebox project.
Ranking = the stored `ai_priority_score` (written by `prioritize` / the 06:30 morning
cron's rescore; `refreshed …` in the header tells you how fresh it is) with the live
7-factor score as fallback; `waiting` rows trail the list. No LLM call at render time.
Each row shows rank, project, due, **energy** (click to cycle) and **time estimate**
(click to type minutes; `+est` when missing), the score (green = AI-ranked) and the AI's
one-line reasoning; the totals bar sums estimated hours per energy level for whatever
is currently shown (search/chips narrow it). API: `GET /api/priority` →
`{items, totals, ai_scored_at}` (`Tools/PriorityList.ts`).

`kaya-cli tasks estimate` fills `energy_level` + `estimated_minutes` for tasks missing
either, in two lanes (`Tools/EstimateFill.ts`, shared with the morning cron's Step 5 —
`autopilot.auto_estimate`): **jm** = Jm's own work, a human's wall-clock; **kaya** = the
executor's autonomous lane, an *agent's* wall-clock. Kaya over-estimates its own work
badly (2026-09-10: median estimate 5.7× the actual over 43 completed tasks, most actuals
under 25 min), so the kaya lane feeds `TaskDB.getEstimateCalibration('autonomous')` —
measured median ratio / median actual / p75 — into the prompt and hard-caps at 150 min.
`--dry-run` previews, `--refresh` overwrites the whole lane. Writes are verified by
re-read; tasks the AI didn't return are reported, never invented (exit 1).

### Icebox (Someday status)

`someday` is the **icebox** status — tasks parked indefinitely, invisible to Kaya's
triage/automation pipeline (KayaTaskClassifier only sweeps `inbox/next/in_progress/waiting`).

- **CLI**: `kaya-cli tasks icebox <id|title>...` — sets status `someday`, logs "iceboxed"
- **Reverse**: `kaya-cli tasks edit <id> --status next` (or any active status)
- **Board**: "Icebox" filter button shows only `someday` tasks; "All" mode hides them by
  default — check "Show someday in All" to reveal them alongside active tasks.

### Global Flags

| Flag | Description |
|------|-------------|
| `--json` | Output as JSON (pipe-friendly, works with all commands) |
| `--help` / `-h` | Show help text |

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
- **TaskManager.ts** - Business logic + CLI interface (all commands above)
- **TaskScorer.ts** - 7-factor deterministic scoring, used as the default fallback under `next`/`prioritize` and as LLM prompt context
- **PriorityList.ts** - Jm's cross-project ranked list (lane filter + ranking + totals); backs `GET /api/priority`, the board's Priority mode and `tasks priority`/`estimate`
- **TaskAI.ts** - AI extraction/scoring/weekly-review calls (Haiku/Sonnet/Opus tiers), owns loud failure reporting for its own degraded paths
- **TaskAutomation.ts** - Scheduled automation workflows: morning (6:30 AM), evening (9 PM), weekly (Sunday 10 AM), monthly crons
- **KayaTaskClassifier.ts** - Triage/disposition classification feeding the `disposition` column consumed by the lane-a executor
- **BoardServer.ts** - Always-on live web board server (127.0.0.1:7777, launchd `com.kaya.lucidtasks-board`)
- **executor/** - Lane-a autonomous executor: polls `disposition='autonomous'` tasks, spawns build+verify agents, merges to `main` (cron `com.kaya.cron.autonomous-executor`, 19:00 daily)
- **TelosGoalLoader.ts** - Parse TELOS markdown into structured data

### Database Schema (5 Tables)
- `tasks` - All task records with status, priority, dates, metadata
- `projects` - Project groupings with goal links
- `activity_log` - Full audit trail of task changes
- `habit_completions` - Daily habit check-in records (schema ready)
- `saved_views` - Named filter/sort presets (schema ready)
- `tasks_fts` - FTS5 virtual table for full-text search

### Feeds Into
- **DailyBriefing** - Task counts, priorities, inbox status
- **CalendarAssistant** - Scheduled task time-blocking, via `scheduler/sources/LucidTasksAdapter.ts`
- **QueueRouter** - Task-to-queue bridge for autonomous work, via `KayaTaskClassifier.ts` / `TaskDB`'s `queue_item_id` back-link (`TaskManagerAddRouting.test.ts`, `TaskDB.queueSync.test.ts`)

### MCPs Used
- None (pure local SQLite + file system)

---

**Last Updated:** 2026-09-10
