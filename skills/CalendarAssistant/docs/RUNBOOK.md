# CalendarAssistant Runbook — Milestone 1

> **Version:** 1.0.0
> **Last Updated:** 2026-02-05
> **Owner:** User

---

## 1. Installation

### Prerequisites
- Bun runtime installed (`bun --version`)
- Kaya system operational (`pai status`)
- Google Calendar account with OAuth credentials

### OAuth Setup
1. Ensure `gcalcli` is installed: `brew install gcalcli`
2. Authenticate: `gcalcli init`
3. Follow browser OAuth flow to authorize access
4. Credentials stored at: `~/Library/Application Support/gcalcli/`

### Skill Registration
CalendarAssistant registers automatically when present in `skills/CalendarAssistant/`.
Verify with: `pai skills list | grep Calendar`

---

## 2. Configuration Reference

### Production Config (`config/production.json`)

| Parameter | Type | Default | Valid Range | Description |
|-----------|------|---------|-------------|-------------|
| `logging.level` | string | `info` | debug, info, warn, error | Minimum log level |
| `logging.maxFileSizeMB` | number | `100` | 10-1000 | Max log file size before rotation |
| `logging.retentionDays` | number | `7` | 1-365 | Days to keep old logs |
| `cache.calendarReadTTLMs` | number | `300000` | 60000-600000 | Cache TTL for reads (5 min) |
| `cache.intentCacheTTLMs` | number | `600000` | 60000-1200000 | Intent parse cache (10 min) |
| `calendar.retryMaxAttempts` | number | `3` | 1-10 | Max API retry attempts |
| `calendar.retryBackoffMs` | number | `1000` | 100-10000 | Initial retry backoff |
| `calendar.offlineModeEnabled` | boolean | `true` | true/false | Enable offline mode |
| `calendar.writeQueueMaxSize` | number | `50` | 10-500 | Max queued writes |
| `approval.attendeeThreshold` | number | `3` | 1-100 | Attendees requiring approval |
| `approval.confidenceThreshold` | number | `0.75` | 0.5-0.99 | Min confidence to skip approval |
| `breaks.defaultFramework` | string | `52-17` | pomodoro, 52-17, custom | Break framework |
| `breaks.coverageWarningThreshold` | number | `0.6` | 0.3-0.9 | Break coverage warning |
| `performance.maxLatencyMs` | number | `6000` | 3000-10000 | Max p95 latency |
| `performance.maxCostPerOperation` | number | `0.005` | 0.001-0.05 | Max cost per op |

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `NODE_ENV` | `development` | Config environment selector |
| `LOG_LEVEL` | `info` | Override log level |
| `CALENDAR_CACHE_TTL_MS` | `300000` | Override cache TTL |
| `OFFLINE_MODE_ENABLED` | `true` | Override offline mode |

---

## 3. Common Failures

### F1: OAuth Token Expired (EAUTH002)
**Symptoms:** "401 Unauthorized" errors, `pai calendar` commands fail
**Cause:** Google OAuth refresh token expired (90 days) or revoked
**Fix:** `gcalcli init` → re-authenticate via browser
**Verify:** `pai calendar health`

### F2: Calendar API Forbidden (EAUTH001)
**Symptoms:** "403 Forbidden" on all API calls
**Cause:** Google Calendar API access revoked or scope insufficient
**Fix:** Remove credentials: `rm -rf ~/Library/Application\ Support/gcalcli/` → `gcalcli init`
**Verify:** `gcalcli list` shows events

### F3: Rate Limited (ENET002)
**Symptoms:** "429 Too Many Requests" errors
**Cause:** Exceeded Google Calendar API quota (500k queries/day, 2500/100sec)
**Fix:** Wait 60 seconds. If persistent, check for runaway scripts.
**Verify:** `pai calendar health`

### F4: Network Timeout (ENET003)
**Symptoms:** Commands hang then timeout, "ETIMEDOUT" errors
**Cause:** Network issues, VPN problems, DNS resolution failure
**Fix:** Check internet. If intermittent, offline mode handles gracefully.
**Verify:** `curl -s https://www.googleapis.com/calendar/v3/colors -o /dev/null -w "%{http_code}"`

### F5: State File Corrupted (ESTATE001)
**Symptoms:** JSON parse errors, goals/preferences lost
**Cause:** Disk full, interrupted write, concurrent access
**Fix:** `rm ~/.claude/state/calendar-assistant/*.json` — state rebuilds from Google Calendar
**Verify:** `pai calendar health` shows StateManager healthy

### F6: Inference Unavailable (EINF001)
**Symptoms:** Natural language commands fail, "Inference not responding"
**Cause:** Bun process crash, Anthropic API issue, token exhaustion
**Fix:** Check `bun --version`. Test: `echo "test" | bun ~/.claude/tools/Inference.ts fast`
**Verify:** Response within 5 seconds

### F7: Event Not Found (ECAL001)
**Symptoms:** Modify/delete commands fail with "Event not found"
**Cause:** Event deleted externally, event ID stale, wrong calendar
**Fix:** Refresh: `pai calendar query "today"` — reloads from Google Calendar
**Verify:** Event visible in Google Calendar web UI

### F8: Disk Full — Log Rotation Failure
**Symptoms:** Log file grows unbounded, write errors
**Cause:** Log rotation failed due to disk full
**Fix:** `rm ~/.claude/logs/calendar-assistant.log.1` — remove old rotated log
**Verify:** `df -h ~` shows >1GB free

### F9: Conflicting Events Unresolved (ECAL003)
**Symptoms:** Scheduling fails with conflict warning
**Cause:** Overlapping events in target time slot
**Fix:** `pai calendar query "conflicts"` — shows all conflicts. Resolve manually or: `pai calendar optimize`
**Verify:** No overlapping events in time range

### F10: Break Insertion Not Working
**Symptoms:** Breaks not appearing after scheduling long events
**Cause:** Break framework disabled, event too short (<90 min), coverage threshold not met
**Fix:** Check config: `breaks.defaultFramework` should be `52-17`. Events must be >=90 min for breaks.
**Verify:** Schedule 3-hour event, verify breaks appear

---

## 4. Rollback Procedure

### Step 1: Revert Code
```bash
cd ~/.claude
git log --oneline -5  # Find commit before CalendarAssistant merge
git revert HEAD        # Revert merge commit
git push origin main
```

### Step 2: Disable Skill
```bash
# Rename to prevent auto-loading
mv skills/CalendarAssistant skills/CalendarAssistant.disabled
```

### Step 3: Clear State
```bash
rm -rf ~/.claude/state/calendar-assistant/
rm -f ~/.claude/logs/calendar-assistant.log*
```

### Step 4: Verify Rollback
```bash
pai status            # No errors
pai skills list       # CalendarAssistant absent
```

### Step 5: Document Incident
Create entry in `MEMORY/WORK/` with:
- What happened
- When rollback occurred
- Root cause (if known)
- Plan for fix

---

## 5. Log Interpretation Guide

### Log Location
`~/.claude/logs/calendar-assistant.log`

### Log Format
Each line is a JSON object:
```json
{
  "timestamp": "2026-02-05T15:30:00.000Z",
  "level": "info",
  "component": "CalendarOrchestrator",
  "user_id": "jm",
  "event_id": "evt_abc123",
  "action_type": "create",
  "confidence_score": 0.92,
  "rationale_summary": "Goal-aligned: supports 'Launch Product X'",
  "message": "Event created successfully"
}
```

### Log Levels

| Level | Meaning | Action |
|-------|---------|--------|
| `debug` | Internal detail | Ignore in production |
| `info` | Normal operation | No action needed |
| `warn` | Degraded but functional | Monitor, may self-resolve |
| `error` | Operation failed | Investigate promptly |

### Common Log Queries
```bash
# View recent errors
jq 'select(.level == "error")' ~/.claude/logs/calendar-assistant.log | tail -10

# Count operations by type
jq '.action_type' ~/.claude/logs/calendar-assistant.log | sort | uniq -c | sort -rn

# Find low-confidence operations
jq 'select(.confidence_score != null and .confidence_score < 0.7)' ~/.claude/logs/calendar-assistant.log

# Check for PII leaks (should return nothing)
grep -i '"title"' ~/.claude/logs/calendar-assistant.log | head -5
```

### PII Sanitization
Event titles, attendee names, and email addresses are automatically hashed in logs.
Example: `"Doctor Appointment"` appears as `[REDACTED:a3f8b2c1]`

---

## 6. Incident Response Checklist

### Severity Levels

| Level | Definition | Response Time |
|-------|-----------|---------------|
| P0 | Data loss, security breach, silent deletion | Immediate |
| P1 | All commands broken, user blocked | < 30 minutes |
| P2 | Specific feature broken, workaround exists | < 4 hours |
| P3 | Cosmetic, minor inconvenience | Next session |

### Triage Steps

1. **Identify:** What is broken? Which error code? Which component?
2. **Contain:** If P0/P1, disable skill immediately: `mv skills/CalendarAssistant skills/CalendarAssistant.disabled`
3. **Diagnose:** Check logs: `jq 'select(.level == "error")' ~/.claude/logs/calendar-assistant.log | tail -20`
4. **Fix:** Apply fix from Common Failures section above
5. **Verify:** Run health check: `pai calendar health`
6. **Document:** Log incident in `MEMORY/WORK/` directory

### Emergency Contacts
- Google Calendar API status: https://www.google.com/appsstatus/dashboard/
- Kaya issues: Check `MEMORY/MONITORING/` for system-wide problems

---

## 7. Monitoring

### Daily Checks
- [ ] Review error count: `jq 'select(.level == "error")' ~/.claude/logs/calendar-assistant.log | wc -l`
- [ ] Verify OAuth still valid: `pai calendar health`
- [ ] Check log file size: `ls -lh ~/.claude/logs/calendar-assistant.log`

### Weekly Checks
- [ ] Review performance trends (latency)
- [ ] Check token usage / cost
- [ ] Verify log rotation occurred

### Monthly Checks
- [ ] Re-run security audit
- [ ] Review and update this runbook
- [ ] Check for CalendarAssistant updates
