# Daily Maintenance Workflow

**Schedule:** 8am daily via cron
**Duration:** < 5 minutes
**Output:** `MEMORY/AutoMaintenance/daily/YYYY-MM-DD.md`

## Overview

The daily workflow performs comprehensive system health checks, auto-remediates safe issues, and escalates critical findings via NotificationService.

## Workflow Steps

### Pre-Run

1. **PATH Augmentation** - `PathEnv.augmentPath()` prepends known binary directories to PATH for cron context
2. **Gap Detection** - `SelfMonitor.checkForGaps()` detects if last run was > 25 hours ago (bypassed with `--force`)

### Step 1: Integrity Check

Runs in parallel with dependency check.

**Checks:**
- **Critical paths exist** - Verify CLAUDE.md, settings.json, MEMORY/, hooks/ exist
- **Broken symlinks** - Scan for symlinks whose targets don't exist using `find -type l ! -exec test -e {} \;`
- **Disk space** - Check `df -h ~/.claude` usage (WARNING > 85%, CRITICAL > 95%)
- **Git status** - Check for unexpected dirty state in tracked config files
- **Cron daemon health** - Verify `com.pai.cron-scheduler` is running via `launchctl list`

**Auto-Remediation:**
- Broken symlinks are queued for removal (only if `lstat` succeeds but `stat` fails)
- All other findings escalated to AlertManager

### Step 2: Dependency Versions

Runs in parallel with integrity check.

**Checks:**
- `bun --version` - Record bun version
- `claude --version` - Attempt update via `claude update --yes` (60s timeout)
- `node --version` - Record node version

**Alerts:**
- Claude update failures (not "already up to date") trigger WARNING

### Step 3: Process Health

**Checks:**
- Verify key daemons running: `com.pai.cron-scheduler`, `com.pai.telegram-bot`
- Record status from `launchctl list`
- Alert if any expected daemon shows exit code != 0

### Step 4: Remediation

**Actions:**
- Execute queued remediation actions via `Remediator.run()`
- Remove broken symlinks (where target doesn't exist)
- Log all actions to `remediation.jsonl`
- On failure: escalate to AlertManager (do NOT retry)

### Step 5: Alert Evaluation

**Severity Classification:**
- Uses `HealthTracker` to track issue persistence
- Occurrence 1: INFO
- Occurrence 3: WARNING + notification
- Occurrence 7: CRITICAL + notification + daily re-alert

**Escalation:**
- CRITICAL findings fire `NotificationService.notifySync()` immediately
- All unresolved findings written to `alerts.jsonl`

### Step 6: Report Generation

**Report Sections:**
- Summary (checks, remediations, alerts, duration)
- Checks table (status, details)
- Remediations table (action, target, result)
- Open alerts (count, reference to alerts.jsonl)
- ISC results (score, pass/fail criteria)
- Metrics (duration, findings, remediations, alerts)

### Step 7: State Persistence

- Update `lastRunByTier.daily` timestamp in `health-state.json`
- Save `HealthTracker` state
- Save `SelfMonitor` state

### Step 8: Summary Notification

- Fire push notification with ISC score and open alert count
- Voice notification only fires if run interactively (not from cron)

## Check Types

| Check | Purpose | Auto-Remediable | Escalation |
|-------|---------|-----------------|------------|
| **Integrity** | Verify critical paths exist, scan broken symlinks | Broken symlinks | Missing paths: CRITICAL |
| **Disk Space** | Monitor `~/.claude` usage | No | > 85%: WARNING, > 95%: CRITICAL |
| **Git Status** | Detect unexpected dirty state | No | Unexpected changes: WARNING |
| **Process Health** | Verify daemons running | No | Daemon down: CRITICAL |
| **Dependency Versions** | Track bun/claude/node versions | Attempted (claude update) | Update failure: WARNING |

## Flags

| Flag | Effect |
|------|--------|
| `--dry-run` | Preview remediations without executing |
| `--force` | Bypass gap detection (for manual catch-up runs) |

## ISC Verification

Daily workflow must satisfy:
- D-01: Report generated for today's date
- D-02: Completes in under 5 minutes
- D-03: Disk space check present in report
- D-04: Cron daemon health check present in report
- D-05: Broken symlinks removed, not just reported
- D-06: Remediation logged for each removed symlink
- D-07: Git status check present in report
- D-08: ISC score computed and present in report
- D-09: health-state.json updated with new lastRunByTier.daily timestamp

## Error Handling

- All caught exceptions logged to `errors.jsonl`
- Remediation failures escalate to AlertManager (not silent)
- Missing tools (e.g., trufflehog) log WARNING and skip step (not fail)
- Hard timeout: 10 minutes
