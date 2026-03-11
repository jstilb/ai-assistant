---
name: ProactiveEngine
description: Proactive contact and scheduled automation system. USE WHEN scheduling proactive tasks, setting up cron jobs, creating proactive behaviors, evening summaries, periodic checks, or managing automated outreach.
---
# ProactiveEngine

Enables Kaya to reach out proactively rather than only responding. Provides scheduled automation, periodic checks, and intelligent outreach based on time, events, or conditions.

## Voice Notification

→ Use `notifySync()` from `lib/core/NotificationService.ts`

## Workflow Routing

| Workflow | Trigger | File |
|----------|---------|------|
| **ManageCronJobs** | "set up cron", "schedule task", "daily briefing", "create automation" | `Workflows/ManageCronJobs.md` |
| **SendProactiveMessage** | "send briefing", "notify me about", "check in on" | `Workflows/SendProactiveMessage.md` |

## Quick Reference

- **Cron jobs** stored at: `~/.claude/MEMORY/daemon/cron/jobs/*.yaml`
- **Job format**: id, schedule (cron syntax), type (isolated/main), task, output, enabled
- **Output channels**: voice, text, both, push, discord, silent

**Full Documentation:**
- Architecture: Read `Architecture.md` in this skill directory
- Cron Jobs: Read `CronJobs.md` in this skill directory
- Best Practices: Read `BestPractices.md` in this skill directory

## Examples

### Create a Daily Standup Cron Job

```
User: "Schedule a daily standup summary at 10 AM"

1. Create YAML file at ~/.claude/MEMORY/daemon/cron/jobs/daily-standup.yaml:
   id: daily-standup
   schedule: "0 10 * * *"
   type: isolated
   task: |
     Generate daily standup summary:
     - What I accomplished yesterday
     - What I'm planning today
     - Any blockers or concerns
   output: voice
   enabled: true
   wakeMode: schedule

2. Validate: bun ~/.claude/skills/Automation/ProactiveEngine/Tools/CronValidator.ts --all
3. Confirm: "Daily standup scheduled for 10 AM via voice."
```

### List All Cron Jobs

```
User: "List my cron jobs"

Run: bun ~/.claude/skills/Automation/ProactiveEngine/Tools/CronExecutor.ts list

Output shows each job with ID, schedule, enabled status, output mode, and task preview.
```

### Test a Job Manually

```
User: "Test my evening summary job"

Run: bun ~/.claude/skills/Automation/ProactiveEngine/Tools/CronExecutor.ts run evening-summary

Executes the job immediately and routes output to its configured channel.
Reports success/failure and execution duration.
```

### Check Scheduler Status

```
User: "Is the cron scheduler running?"

Run: bun ~/.claude/skills/Automation/ProactiveEngine/Tools/CronScheduler.ts status

Shows daemon status, total/enabled/disabled job counts, and next run times.
```

## Customization

| Setting | Location | Default |
|---------|----------|---------|
| **Jobs directory** | `~/.claude/MEMORY/daemon/cron/jobs/` | Auto-created on first use |
| **Logs directory** | `~/.claude/MEMORY/daemon/cron/logs/` | Auto-created on first use |
| **Daemon port** | `settings.json` → `daemon.port` | `18000` |
| **Daemon host** | `settings.json` → `daemon.host` | `localhost` |
| **Output channels** | Per-job `output` field | `voice` |

Output channel options: `voice`, `text`, `both`, `push`, `discord`, `silent`

## Integration

### Uses
- **Voice Server**: TTS delivery of briefings
- **NotificationService**: Multi-channel routing
- **Memory System**: Context for personalized content

### Feeds Into
- **User experience**: Proactive assistance
- **Memory System**: Logs of proactive outreach

---

**Last Updated:** 2026-02-06
