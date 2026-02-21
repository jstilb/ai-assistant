# ProactiveEngine Cron Jobs

## Job Definition Format

Cron jobs are defined in YAML files at `~/.claude/MEMORY/daemon/cron/jobs/*.yaml`:

```yaml
id: job-identifier
schedule: "0 8 * * *"  # Standard cron syntax
type: isolated          # isolated | main
task: |
  Description of what this job does.
  Can be multi-line.
  Specific enough for AI to execute.
output: voice          # voice | text | both | push | discord | silent
enabled: true
wakeMode: schedule     # schedule | now
context:               # Optional context for execution
  - path/to/context.md
priority: normal       # low | normal | high | urgent
```

---

## Cron Schedule Format

Standard cron syntax: `minute hour day month weekday`

**Common Patterns:**
- `0 8 * * *` - Daily at 8 AM
- `0 20 * * *` - Daily at 8 PM
- `0 9 * * 1` - Weekly on Monday at 9 AM
- `0 10 1 * *` - Monthly on 1st at 10 AM
- `*/30 * * * *` - Every 30 minutes

---

## Job Types

**Isolated**: Spawn independent agent that doesn't block
**Main**: Run in current session context

---

## Output Routing

**voice**: Send to voice server for TTS
**text**: Written output only (log, display)
**both**: Voice + text output
**push**: Send push notification (mobile)
**discord**: Post to Discord channel
**silent**: Execute without notification (log only)

---

## Provided Cron Jobs

### Daily Briefing (`daily-briefing.yaml`)

**Schedule**: 8 AM daily
**Purpose**: Morning context and priorities
**Contents**:
- Calendar events for today
- Top 3 priority tasks from LucidTasks
- Important unread emails
- Weather forecast
- Relevant news or updates

### Evening Summary (`evening-summary.yaml`)

**Schedule**: 8 PM daily
**Purpose**: Day reflection and tomorrow prep
**Contents**:
- What was accomplished today
- Incomplete tasks
- Tomorrow's calendar preview
- Unresolved items needing attention

### Hourly Check (`hourly-check.yaml`)

**Schedule**: Every hour during business hours
**Purpose**: Urgent item monitoring
**Contents**:
- Check for urgent emails
- Monitor critical task status

### Weekly Review (`weekly-review.yaml`)

**Schedule**: Sunday 9 AM
**Purpose**: Week reflection and planning
**Contents**:
- Last week's accomplishments
- This week's priorities
- Upcoming commitments

---

## Creating New Cron Jobs

### Step 1: Define the Job

Create a YAML file in `~/.claude/MEMORY/daemon/cron/jobs/`:

```yaml
id: weekly-review
schedule: "0 9 * * 0"  # Sunday 9 AM
type: isolated
task: |
  Generate weekly review:
  - Last week's accomplishments from MEMORY
  - This week's priorities from LucidTasks
  - Upcoming commitments from calendar
  - Recommended focus areas
output: voice
enabled: true
priority: high
```

### Step 2: Test the Job

```bash
# Manually trigger to verify
bun ~/.claude/skills/ProactiveEngine/Tools/CronExecutor.ts run weekly-review
```

### Step 3: Enable

Set `enabled: true` in the YAML file.

---

## CLI Tools

| Tool | Purpose | Usage |
|------|---------|-------|
| **CronExecutor.ts** | Execute jobs | `bun Tools/CronExecutor.ts run <job-id>` |
| **CronValidator.ts** | Validate YAML | `bun Tools/CronValidator.ts <yaml-file>` |
| **CronScheduler.ts** | Daemon lifecycle | `bun Tools/CronScheduler.ts start\|stop\|status` |

---

## Output Locations

| Output | Location |
|--------|----------|
| Cron job definitions | `~/.claude/MEMORY/daemon/cron/jobs/*.yaml` |
| Execution logs | `~/.claude/MEMORY/daemon/cron/logs/YYYY-MM-DD.log` |
| Job state | `~/.claude/MEMORY/daemon/cron/state.json` |
