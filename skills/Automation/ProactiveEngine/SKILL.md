---
name: ProactiveEngine
description: Create, list, test and disable scheduled jobs, and send proactive outreach. USE WHEN scheduling proactive tasks, setting up cron jobs, creating proactive behaviors, evening summaries, periodic checks, or managing automated outreach.
---
# ProactiveEngine

Kaya reaches out on a schedule instead of only answering. This skill is a short procedure for scheduled jobs and proactive messages. It has no code of its own.

launchd is the only scheduler (`docs/decisions/005-launchd-is-the-only-scheduler.md`). The old daemon and its port and host settings no longer exist.

For job internals read `lib/cron/README.md` and `MEMORY/daemon/cron/manifests/README.md`. For system health jobs use `AutoMaintenance`.

## Voice Notification

Use `notifySync()` from `lib/core/NotificationService.ts`.

## How a job runs

1. A launchd plist `~/Library/LaunchAgents/com.kaya.cron.<id>.plist` fires at the schedule.
2. The plist runs `bin/run-cron-job.ts <id>`.
3. The runner reads `MEMORY/daemon/cron/manifests/<id>.yaml`. The field `enabled:` gates the run.
4. The runner routes the output (`silent`, `voice`, `text`, `push`, `both`, `discord`, `telegram`) through MessageQueue and AlertGate.

A manifest without a plist does not run. The schema is `lib/cron/JobSpec.ts` (`JobSpecSchema`).

## Create a job

1. Write `MEMORY/daemon/cron/jobs/<id>.yaml`. This is the staging folder. Create it if it does not exist.

```yaml
id: daily-standup
schedule: "0 10 * * *"
type: isolated
task: |
  Summarize what I did yesterday, what is planned today, and any blockers.
output: voice
enabled: true
```

2. Preview: `bun bin/migrate-crons-to-launchd.ts --plan`
3. Install: `bun bin/migrate-crons-to-launchd.ts --apply --only <id>`. This writes the plist, loads it, and moves the yaml to `manifests/`.
4. Validate: `bun bin/lint-jobs-manifest.ts`
5. Tell Jm the schedule and the output channel.

For a script job, use `execute: {command, args}` instead of `task:`.

## List jobs

- Defined: `ls MEMORY/daemon/cron/manifests/*.yaml`
- Loaded: `launchctl list | grep com.kaya.cron`
- Ran: `MEMORY/daemon/cron/run-ledger.jsonl`

## Test a job

Run `bun bin/run-cron-job.ts <id>`. The job runs now and sends its output to its channel.

## Disable a job

1. Set `enabled: false` in `manifests/<id>.yaml`.
2. To stop the trigger as well, run `launchctl bootout gui/$UID/com.kaya.cron.<id>`.
3. To retire the job for good, move the yaml to `MEMORY/daemon/cron/jobs.retired/` and remove the plist.

If you change a schedule, edit the yaml and run `bun bin/migrate-crons-to-launchd.ts --regen --only <id>`.

## Proactive outreach

- Add an `output:` channel to a job. Use `silent` if the job must not message Jm.
- For a one-off message from code, call `notifySync()`.
- For voice pings that are due, use `skills/Communication/VoiceInteraction/Tools/ProactivePinger.ts`.
- Respect the contact rules in the `kaya` skill about when Kaya may message Jm.
