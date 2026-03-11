# NextTask Workflow

Get the next recommended task to work on using a 7-factor scoring algorithm.

## Trigger

- "what's next"
- "next task"
- "/lt next"
- "what should I work on"

## Purpose

Intelligently suggest the next task(s) based on urgency, priority, goal alignment, project context, energy match, and recency. Returns a ranked list of top candidates with scoring rationale.

## Steps

1. **Fetch candidates** - Load up to 50 tasks with status `next`, `in_progress`, or `inbox`
2. **Apply pre-filters** - Narrow by `--project` or `--goal` if specified (hard filters, not boosts)
3. **Score each task** - Run 7-factor scoring algorithm (see below)
4. **Sort and slice** - Order by score descending, tiebreak by priority/due/created; take top N
5. **Optional: Start** - If `--start` flag given, set top task to `in_progress` and record `started_at`
6. **Output** - Display ranked list with scores and reasons

## CLI Usage

```bash
# Get top 3 suggested tasks (default)
bun skills/Productivity/LucidTasks/Tools/TaskManager.ts next

# Filter to tasks in a specific project (hard filter)
bun skills/Productivity/LucidTasks/Tools/TaskManager.ts next --project backend

# Filter to tasks linked to a specific goal (hard filter)
bun skills/Productivity/LucidTasks/Tools/TaskManager.ts next --goal G25

# Boost tasks matching energy level (soft boost, all tasks still shown)
bun skills/Productivity/LucidTasks/Tools/TaskManager.ts next --energy high

# Show top N candidates (default: 3)
bun skills/Productivity/LucidTasks/Tools/TaskManager.ts next --top 5

# Start working on the top suggestion (sets in_progress + started_at timer)
bun skills/Productivity/LucidTasks/Tools/TaskManager.ts next --start

# Combine filters
bun skills/Productivity/LucidTasks/Tools/TaskManager.ts next --project writing --energy high --top 5

# JSON output (pipe-friendly, includes score and reasons)
bun skills/Productivity/LucidTasks/Tools/TaskManager.ts next --json
```

### Flags

| Flag | Description | Status |
|------|-------------|--------|
| `--project <name\|id>` | Hard-filter to tasks in this project | Implemented |
| `--goal <id>` | Hard-filter to tasks linked to this goal | Implemented |
| `--energy low\|medium\|high` | Boost tasks matching energy level (+10 pts) | Implemented |
| `--top <N>` | Number of suggestions to show (default: 3) | Implemented |
| `--start` | Set top task to in_progress, record started_at | Implemented |
| `--json` | Output as JSON with score and reasons array | Implemented |

## Scoring Algorithm

Each candidate task is scored by `scoreTask()`. Factors are cumulative — higher score = higher priority.

| Factor | Condition | Score |
|--------|-----------|-------|
| Overdue | `due_date < today` | +50 |
| High priority | `priority == 1` | +30 |
| Normal priority | `priority == 2` | +15 |
| Due soon | `due_date` within next 48h (not overdue) | +20 |
| Goal alignment | `goal_id` in TELOS active goals | +15 |
| Project match | Task's `project_id` matches `--project` filter | +10 |
| Energy match | Task's `energy_level` matches `--energy` filter | +10 |
| Recently updated | `updated_at` within last 24h | +5 |

**Tiebreaker order** (when scores are equal):
1. Priority ASC (lower number = higher priority)
2. `due_date` ASC (earlier due date first, nulls last)
3. `created_at` DESC (newer tasks first)

**Energy filter behavior:** `--energy` is a soft boost only. Tasks of all energy levels are included in results — matching tasks just score +10 higher. Use `--project` or `--goal` for hard exclusion.

## Voice Notification

Automatic via `notifySync()` is NOT called in `cmdNext`. Notification is only triggered if `--start` is used (via activity log). No manual notification required for browsing suggestions.

## Integration

- Reads TELOS goal data for active goal IDs (goal alignment scoring)
- Respects project assignments via `getProjectByName()` or `getProject()`
- `--start` calls `db.setStartedAt()` and `db.logActivity("started")`
- Results can be piped: `next --json | jq '.[0].task.id'`

## Output

Text output (default):

```
Suggested next tasks:

  1. [Score: 80] !!! t-abc123-xyz  Fix auth bug due:2026-02-17 G25 @backend
     Overdue (+50) + High priority (+30)

  2. [Score: 30] !! t-def456-uvw  Write chapter 3 due:2026-02-18 G13
     Normal priority (+15) + Due in 36h (+20) + Goal G13 aligned (+15)

  3. [Score: 15] !   t-ghi789-rst  Review PR
     Normal priority (+15)
```

JSON output (`--json`):

```json
[
  {
    "task": { "id": "t-abc123-xyz", "title": "Fix auth bug", ... },
    "score": 80,
    "reasons": ["Overdue (+50)", "High priority (+30)"]
  }
]
```

With `--start`:

```
Started: Fix auth bug (timer running)
```
