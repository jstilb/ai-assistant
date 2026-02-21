# /tasks - Task Maintenance Command

Automated Asana task management - overdue detection, triage, and health reports.

## Usage

```
/tasks [daily|weekly|monthly]
```

## Arguments

| Argument | Description |
|----------|-------------|
| `daily` | Overdue detection, due today, AI queue check |
| `weekly` | Full project triage, stale detection, prioritization |
| `monthly` | Archive stale tasks, project health report |
| (none) | Show command help |

## Examples

```
/tasks daily     # Run daily task check
/tasks weekly    # Run full weekly triage
/tasks monthly   # Run monthly cleanup and health report
```

## Execution

When this command is invoked, route to the TaskMaintenance skill:

```
Read and execute: ~/.claude/skills/TaskMaintenance/SKILL.md
```

The skill will route to the appropriate workflow based on the argument provided.

## Scheduled Runs

These workflows run automatically via launchd:

| Workflow | Schedule | launchd |
|----------|----------|---------|
| Daily | 8am daily | `com.pai.tasks-daily` |
| Weekly | Sunday 8am | `com.pai.tasks-weekly` |
| Monthly | 1st 6am | `com.pai.tasks-monthly` |

## Output

- Daily reports: `~/.claude/MEMORY/TASKS/daily/YYYY-MM-DD.md`
- Weekly reports: `~/.claude/MEMORY/TASKS/weekly/YYYY-WW.md`
- Monthly reports: `~/.claude/MEMORY/TASKS/monthly/YYYY-MM.md`
