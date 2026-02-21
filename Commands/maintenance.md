---
description: Run autonomous maintenance workflows (daily, weekly, monthly)
argument-hint: <daily|weekly|monthly|status>
allowed-tools: [Read, Glob, Grep, Bash, Task, Write]
---

# Maintenance Command

Autonomous system maintenance workflows that Kaya runs without user involvement.

## Arguments

The user invoked: `/maintenance $ARGUMENTS`

## Routing

Based on the argument, invoke the appropriate workflow from the AutoMaintenance skill:

| Argument | Action |
|----------|--------|
| `daily` | Run `~/.claude/skills/AutoMaintenance/Workflows/daily.md` |
| `weekly` | Run `~/.claude/skills/AutoMaintenance/Workflows/weekly.md` |
| `monthly` | Run `~/.claude/skills/AutoMaintenance/Workflows/monthly.md` |
| `status` | Show last run times and system health summary |
| (none) | Show usage help |

## Usage

```
/maintenance daily     # Integrity agent, Claude CLI update check
/maintenance weekly    # Kaya sync, security, audit agents, state cleanup
/maintenance monthly   # Workspace cleanup, skill audit agents
/maintenance status    # Show last run times
```

## Execution

1. Read the appropriate workflow file
2. Execute according to workflow instructions
3. Write report to `MEMORY/MAINTENANCE/{daily,weekly,monthly}/`
4. Send voice notification on completion

## Status Command

When `status` is specified, check:
- Last daily run: `ls -la ~/.claude/MEMORY/MAINTENANCE/daily/ | tail -1`
- Last weekly run: `ls -la ~/.claude/MEMORY/MAINTENANCE/weekly/ | tail -1`
- Last monthly run: `ls -la ~/.claude/MEMORY/MAINTENANCE/monthly/ | tail -1`
- launchd status: `launchctl list | grep pai`

Format output as a health summary.
