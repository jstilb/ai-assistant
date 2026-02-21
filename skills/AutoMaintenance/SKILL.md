---
name: AutoMaintenance
description: Autonomous system maintenance workflows. USE WHEN maintenance daily, maintenance weekly, maintenance monthly, system health, automated cleanup, launchd jobs, scheduled maintenance.
---

# AutoMaintenance Skill

Autonomous system maintenance workflows that Kaya runs WITHOUT user involvement.

**USE WHEN:** maintenance daily, maintenance weekly, maintenance monthly, system health check, automated cleanup, launchd scheduled jobs, Kaya system maintenance.

**Key Principle:** These workflows run headlessly via launchd scheduling. They maintain system health, update context, and ensure Kaya operates at peak performance.

## Voice Notification

→ Uses `notifySync()` from `skills/CORE/Tools/NotificationService.ts`

## Workflow Routing

| Trigger | Workflow | Schedule |
|---------|----------|----------|
| `/maintenance daily` | `--tier daily` | 8am daily |
| `/maintenance weekly` | `--tier weekly` | Full weekly (includes daily) |
| `/maintenance monthly` | `--tier monthly` | Full monthly (includes daily + weekly) |
| `/maintenance status` | Show last run times and health summary | Manual |

## Staggered Schedule (Rate Limit Avoidance)

To avoid rate limits, weekly and monthly workflows are staggered across multiple days:

### Weekly Workflows

| Day | Tier | What Runs |
|-----|------|-----------|
| **Sunday 8am** | `weekly-security` | Security audit, Kaya sync, privacy validation |
| **Monday 8am** | `weekly-cleanup` | State cleanup, log rotation |
| **Tuesday 8am** | `weekly-reports` | Memory consolidation, weekly report generation |

### Monthly Workflows (First Week Only)

| Day | Tier | What Runs |
|-----|------|-----------|
| **Thursday 8am** | `monthly-workspace` | Workspace cleanup, stale branches, temp files |
| **Friday 8am** | `monthly-skills` | Comprehensive skill health audit |
| **Saturday 8am** | `monthly-reports` | Monthly report generation, aggregation |

## Quick Reference

| Workflow | Purpose | Duration | Output |
|----------|---------|----------|--------|
| **Daily** | Integrity check, Claude CLI update | < 5 min | `MEMORY/AutoMaintenance/daily/YYYY-MM-DD.md` |
| **Weekly-Security** | Security audit, Kaya sync | < 5 min | Logs only |
| **Weekly-Cleanup** | State/log cleanup | < 3 min | Logs only |
| **Weekly-Reports** | Memory consolidation, report | < 5 min | `MEMORY/AutoMaintenance/weekly/YYYY-MM-DD.md` |
| **Monthly-Workspace** | Workspace cleanup | < 5 min | Logs only |
| **Monthly-Skills** | Skill audit | < 10 min | Logs only |
| **Monthly-Reports** | Monthly report | < 5 min | `MEMORY/AutoMaintenance/monthly/YYYY-MM-DD.md` |

## Output Paths

All outputs follow the standardized pattern:

```
MEMORY/AutoMaintenance/{workflow}/YYYY-MM-DD.md
```

| Workflow | Output Directory |
|----------|-----------------|
| Daily | `MEMORY/AutoMaintenance/daily/` |
| Weekly | `MEMORY/AutoMaintenance/weekly/` |
| Monthly | `MEMORY/AutoMaintenance/monthly/` |
| Errors | `MEMORY/AutoMaintenance/errors.jsonl` |

## Scheduling Architecture

```
launchd plist → shell script → bun Workflows.ts → WorkflowExecutor → NotificationService
```

### launchd Plists (~/Library/LaunchAgents/)

**Daily:**
- `com.pai.daily.plist` - Runs at 8am daily

**Weekly (Staggered):**
- `com.pai.weekly-sun.plist` - Sunday 8am (security)
- `com.pai.weekly-mon.plist` - Monday 8am (cleanup)
- `com.pai.weekly-tue.plist` - Tuesday 8am (reports)

**Monthly (First Week):**
- `com.pai.monthly-thu.plist` - Thursdays 8am (workspace, first Thursday only)
- `com.pai.monthly-fri.plist` - Fridays 8am (skills, first Friday only)
- `com.pai.monthly-sat.plist` - Saturdays 8am (reports, first Saturday only)

**Legacy (kept for backwards compatibility):**
- `com.pai.weekly.plist` - Full weekly (Sunday 8am)
- `com.pai.monthly.plist` - Full monthly (1st of month 8am)

### Runner Scripts (~/.claude/bin/)

| Script | Invokes |
|--------|---------|
| `pai-daily.sh` | `Workflows.ts --tier daily` |
| `pai-weekly-sun.sh` | `Workflows.ts --tier weekly-security` |
| `pai-weekly-mon.sh` | `Workflows.ts --tier weekly-cleanup` |
| `pai-weekly-tue.sh` | `Workflows.ts --tier weekly-reports` |
| `pai-monthly-thu.sh` | `Workflows.ts --tier monthly-workspace` |
| `pai-monthly-fri.sh` | `Workflows.ts --tier monthly-skills` |
| `pai-monthly-sat.sh` | `Workflows.ts --tier monthly-reports` |

## Tools

| Tool | Purpose |
|------|---------|
| `Tools/Workflows.ts` | Main workflow execution engine |

## CLI Usage

```bash
# Execute full workflow tiers
bun run ~/.claude/skills/AutoMaintenance/Tools/Workflows.ts --tier daily
bun run ~/.claude/skills/AutoMaintenance/Tools/Workflows.ts --tier weekly
bun run ~/.claude/skills/AutoMaintenance/Tools/Workflows.ts --tier monthly

# Execute staggered sub-tiers
bun run ~/.claude/skills/AutoMaintenance/Tools/Workflows.ts --tier weekly-security
bun run ~/.claude/skills/AutoMaintenance/Tools/Workflows.ts --tier weekly-cleanup
bun run ~/.claude/skills/AutoMaintenance/Tools/Workflows.ts --tier weekly-reports
bun run ~/.claude/skills/AutoMaintenance/Tools/Workflows.ts --tier monthly-workspace
bun run ~/.claude/skills/AutoMaintenance/Tools/Workflows.ts --tier monthly-skills
bun run ~/.claude/skills/AutoMaintenance/Tools/Workflows.ts --tier monthly-reports

# Resume from checkpoint
bun run ~/.claude/skills/AutoMaintenance/Tools/Workflows.ts --tier weekly --resume

# Check launchd status
launchctl list | grep pai
```

## Error Handling

Errors are logged to `MEMORY/AutoMaintenance/errors.jsonl` in JSONL format:

```json
{"date":"2026-02-01T08:00:00Z","workflow":"AutoMaintenance-daily","step":"integrity-check","error":"Path not found"}
```

## Success Criteria

- [ ] Daily workflow completes in < 5 minutes
- [ ] Weekly workflows complete in < 10 minutes total (across 3 days)
- [ ] Monthly workflows complete in < 15 minutes total (across 3 days)
- [ ] All launchd plists load without errors
- [ ] Reports written to correct paths
- [ ] Voice notification on completion
- [ ] Errors logged to errors.jsonl

## Integration

### Uses
- **CORE/WorkflowExecutor** - Step execution, checkpointing, ISC validation
- **CORE/NotificationService** - Voice and push notifications

### Feeds Into
- **MEMORY/AutoMaintenance/** - All maintenance reports and error log
- **System** - Health status for system overview

## Customization

| Parameter | Default | Location | Description |
|-----------|---------|----------|-------------|
| `KAYA_HOME` | `~/.claude` | env var / `Workflows.ts` | Base path for all Kaya directories |
| `MAINTENANCE_DIR` | `MEMORY/AutoMaintenance` | `Workflows.ts` | Report and error output directory |
| `checkpointDir` | `.checkpoints/` | `Workflows.ts` | Checkpoint files for resume support |
| Schedule times | 8am | launchd plists | Edit plist `StartCalendarInterval` values |
| Work item retention | 7 days | `stateCleanup()` | Days before completed items are archived |
| Debug log retention | 14 days | `logRotation()` | Days before debug logs are deleted |
| File history retention | 30 days | `logRotation()` | Days before file-history is cleaned |
| Secret scan timeout | 120s | `secretScanning()` | TruffleHog scan timeout in ms |
| Staggered schedule | Sun/Mon/Tue + Thu/Fri/Sat | launchd plists | Weekly and monthly day assignments |

To customize schedules, edit the corresponding launchd plists in `~/Library/LaunchAgents/`.

---

## What This Skill Does NOT Handle

These concerns are handled by other skills:

| Concern | Handled By |
|---------|------------|
| Context refresh | InformationManager |
| Daily briefing | AutoInfoOrg (future) |
| Signal synthesis | ContinualLearning |
| Learning consolidation | ContinualLearning |

---

## Examples

**Example 1: Run daily maintenance manually**
```
User: run maintenance daily
Kaya: Running the Daily maintenance workflow...
      [Executes integrity check, Claude CLI update]
      Daily maintenance complete. Report saved to MEMORY/AutoMaintenance/daily/2026-02-01.md
```

**Example 2: Run specific weekly tier**
```
User: run the weekly security check
Kaya: Running weekly-security workflow...
      [Executes full audit, secret scanning, privacy validation]
      Weekly security audit complete. No issues found.
```

**Example 3: Check maintenance status**
```
User: maintenance status
Kaya: Checking maintenance history...
      Last daily: 2026-02-01 08:00 (success)
      Last weekly-security: 2026-01-26 08:00 (success)
      Last weekly-cleanup: 2026-01-27 08:00 (success)
      Last monthly-workspace: 2026-02-06 08:00 (success)
      System health: Good
```

---

**Last Updated:** 2026-02-06
