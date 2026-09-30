---
name: AutoMaintenance
description: Autonomous system maintenance workflows (v2). USE WHEN maintenance daily, maintenance weekly, maintenance monthly, system health, automated cleanup, cron scheduling, system integrity, security audit, log cleanup, workspace cleanup, kaya health, auto-remediation, gap detection.
---

# AutoMaintenance Skill (v2)

Autonomous system maintenance that fixes-not-reports, escalates critical findings, and self-monitors to catch gaps within 24 hours.

**USE WHEN:** maintenance daily, maintenance weekly, maintenance monthly, system health check, automated cleanup, cron scheduled jobs, Kaya system maintenance, auto-remediation, gap detection.

**Key Principle:** These workflows run headlessly via cron scheduling. They maintain system health, auto-remediate safe issues, escalate critical findings, and ensure Kaya operates at peak performance.

## Voice Notification

→ Uses `notifySync()` from `lib/core/NotificationService.ts`

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
launchd (com.kaya.cron.<id>) → bin/run-cron-job.ts → bun Workflows.ts → AutoMaintenance v2 → NotificationService
```

Per ADR-005 ("launchd Is the Only Scheduler"), launchd is the sole trigger for
every tier below except `weekly-cleanup`. Job definitions live as manifest
yaml in `MEMORY/daemon/cron/manifests/` and execute via `bin/run-cron-job.ts`.

`kaya-daily.sh` was deleted in remediation slice C1 (2026-07-03): daily
maintenance now runs solely via `com.kaya.cron.maintenance-daily`
(`manifests/maintenance-daily.yaml`). `kaya-weekly-sun.sh`,
`kaya-weekly-tue.sh`, and `kaya-monthly-{thu,fri,sat}.sh` were deleted in
Failure-Signal Integrity Remediation slice D1 (2026-07-07): each was a
raw-crontab duplicate of work already triggered by a surviving launchd
manifest job (full coverage proof in
`MEMORY/daemon/cron/jobs.retired/README.md`'s dated D1 section).

**Live triggers by tier:**

| Tier | Trigger | Manifest / crontab |
|------|---------|---------------------|
| `daily` | launchd, 02:30 daily | `com.kaya.cron.maintenance-daily` |
| `weekly-security` | launchd, Sun 08:00 | `com.kaya.cron.maintenance-weekly-security` |
| `weekly-cleanup` | **raw crontab**, Mon 08:00 | `crontab -l` → `bin/kaya-weekly-mon.sh` (no launchd twin — verified clean in D1) |
| `weekly-reports` | launchd, Tue 08:00 | `com.kaya.cron.maintenance-weekly-reports` (added in D1 to preserve this tier's coverage) |
| `monthly-workspace` | launchd, first Thursday 08:00 | `com.kaya.cron.maintenance-monthly-workspace` |
| `monthly-skills` | launchd, first Friday 08:00 | `com.kaya.cron.maintenance-monthly-skills` |
| `monthly-reports` | launchd, first Saturday 08:00 | `com.kaya.cron.maintenance-monthly-reports` |

Weekly wisdom synthesis (formerly `kaya-weekly-tue.sh`'s second step) no
longer exists: the deterministic wisdom-frame pipeline was deleted
2026-07-09 (frames were retired 2026-05-02; CLAUDE.md and auto-memory are
the canonical home for behavioral rules). `graph-weekly-synthesis`
(Tue 09:00) still runs the Graph bridge and learning-context refresh.

**Verification:**
```bash
launchctl list | grep com.kaya.cron
crontab -l   # should show only the weekly-mon line
```

### Runner Scripts (~/.claude/bin/)

The one surviving raw shell runner exports PATH before invoking bun to
ensure binaries are found in cron context:
```bash
export PATH="/Users/[user]/.bun/bin:/opt/homebrew/bin:/opt/homebrew/sbin:/Users/[user]/.local/bin:$PATH"
```

| Script | Invokes |
|--------|---------|
| `kaya-weekly-mon.sh` | `Workflows.ts --tier weekly-cleanup` |

All other tiers invoke `Workflows.ts` directly from the launchd manifest
(`execute.command: bun`, no intermediate shell wrapper) — see the table
above.

## Manual workflows

The `Workflows/` notes are manual procedures, not scheduled AutoMaintenance tiers: `DocumentRecent.md`, `DocumentSession.md`, `IntegrityCheck.md`, `PrivacyCheck.md`, `PrivateSystemAudit.md`, `SecretScanning.md`, and `WorkContextRecall.md`. Run them only when requested; the launchd schedule above does not invoke them.

The tech-debt registry, auditor, promoter, and CLI live in `Tools/` and retain their existing command behavior.

## Tools

| Tool | Purpose |
|------|---------|
| `Tools/Workflows.ts` | Main workflow execution engine |

## CLI Usage

```bash
# Execute full workflow tiers
bun run ~/.claude/skills/Automation/AutoMaintenance/Tools/Workflows.ts --tier daily
bun run ~/.claude/skills/Automation/AutoMaintenance/Tools/Workflows.ts --tier weekly
bun run ~/.claude/skills/Automation/AutoMaintenance/Tools/Workflows.ts --tier monthly

# Execute staggered sub-tiers
bun run ~/.claude/skills/Automation/AutoMaintenance/Tools/Workflows.ts --tier weekly-security
bun run ~/.claude/skills/Automation/AutoMaintenance/Tools/Workflows.ts --tier weekly-cleanup
bun run ~/.claude/skills/Automation/AutoMaintenance/Tools/Workflows.ts --tier weekly-reports
bun run ~/.claude/skills/Automation/AutoMaintenance/Tools/Workflows.ts --tier monthly-workspace
bun run ~/.claude/skills/Automation/AutoMaintenance/Tools/Workflows.ts --tier monthly-skills
bun run ~/.claude/skills/Automation/AutoMaintenance/Tools/Workflows.ts --tier monthly-reports

# Resume from checkpoint
bun run ~/.claude/skills/Automation/AutoMaintenance/Tools/Workflows.ts --tier weekly --resume

# Check live triggers
launchctl list | grep com.kaya.cron
crontab -l   # weekly-mon only
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
- [ ] All triggers verified with `launchctl list | grep com.kaya.cron` + `crontab -l`
- [ ] Reports written to correct paths
- [ ] Voice notification on completion
- [ ] Errors logged to errors.jsonl

## Integration

### Uses
- **Tools/Workflows.ts** - Step execution and report writing (self-contained runner; Remediator + AlertManager for findings/alerts)
- **lib/core/NotificationService** - Voice and push notifications

### Feeds Into
- **MEMORY/AutoMaintenance/** - All maintenance reports and error log
- **System** - Health status for system overview

## Customization

| Parameter | Default | Location | Description |
|-----------|---------|----------|-------------|
| `KAYA_HOME` | `~/.claude` | env var / `Workflows.ts` | Base path for all Kaya directories |
| `MAINTENANCE_DIR` | `MEMORY/AutoMaintenance` | `Workflows.ts` | Report and error output directory |
| `checkpointDir` | `.checkpoints/` | `Workflows.ts` | Checkpoint files for resume support |
| Schedule times | 8am | launchd manifest yaml (`manifests/*.yaml`) + `crontab` (weekly-mon only) | Edit manifest `schedule:` + regenerate plist, or `crontab -e` for weekly-mon |
| Work item retention | 7 days | `stateCleanup()` | Days before completed items are archived |
| Debug log retention | 14 days | `logRotation()` | Days before debug logs are deleted |
| File history retention | 30 days | `logRotation()` | Days before file-history is cleaned |
| Secret scan timeout | 120s | `secretScanning()` | TruffleHog scan timeout in ms |
| Staggered schedule | Sun/Mon/Tue + Thu/Fri/Sat | launchd manifest `schedule:` (weekly-mon: crontab) | Weekly and monthly day assignments |

To customize schedules, edit the manifest yaml's `schedule:` field and regenerate its plist (`bin/migrate-crons-to-launchd.ts --regen --only <id>`); weekly-mon is the sole exception, still edited via `crontab -e`.

---

## What This Skill Does NOT Handle

These concerns are handled by other skills:

| Concern | Handled By |
|---------|------------|
| Context refresh | InformationManager |
| Daily briefing | AutoInfoOrg (future) |
| Signal synthesis | AgentMetacognition |
| Learning consolidation | AgentMetacognition |

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
