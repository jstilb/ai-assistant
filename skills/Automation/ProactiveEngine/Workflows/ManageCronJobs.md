# ManageCronJobs Workflow

**Purpose:** Create, edit, enable, disable, and validate cron job definitions for the ProactiveEngine.

**Triggers:** "set up cron", "schedule task", "create automation", "daily briefing setup", "manage cron jobs", "list cron jobs", "disable cron"

---

## Voice Notification

```typescript
import { notifySync } from '~/.claude/lib/core/NotificationService.ts';
notifySync("Managing ProactiveEngine cron jobs");
```

Running the **ManageCronJobs** workflow from the **ProactiveEngine** skill...

---

## When to Use

- User wants to schedule recurring tasks
- Setting up automated briefings or summaries
- Creating custom periodic checks
- Enabling/disabling existing cron jobs
- Validating cron job syntax
- Listing all configured jobs

---

## Execution

### Step 1: Understand User Intent

Parse the request to determine action:

| User Says | Action |
|-----------|--------|
| "Set up daily briefing" | Create new daily-briefing.yaml (or verify existing) |
| "Schedule X every Y" | Create new custom job |
| "List my cron jobs" | Show all *.yaml files with enabled status |
| "Disable evening summary" | Set enabled: false in evening-summary.yaml |
| "Enable morning briefing" | Set enabled: true in daily-briefing.yaml |
| "Validate cron jobs" | Run CronValidator.ts on all jobs |

### Step 2: List Existing Jobs (if needed)

```bash
ls -1 ~/.claude/MEMORY/daemon/cron/jobs/*.yaml
```

For each file, show:
- Job ID
- Schedule (human-readable: "Daily at 8 AM")
- Enabled status
- Output type

### Step 3: Create New Job (if requested)

**Gather requirements:**
- **What**: What should the job do?
- **When**: How often? (daily, weekly, specific time)
- **Output**: voice, push, discord, silent?
- **Priority**: low, normal, high, urgent?

**Generate cron schedule:**
```typescript
// Example conversions:
"daily at 8am"        → "0 8 * * *"
"every hour"          → "0 * * * *"
"every 30 minutes"    → "*/30 * * * *"
"monday at 9am"       → "0 9 * * 1"
"first of month"      → "0 10 1 * *"
```

**Create YAML file:**
```yaml
id: [job-id]
schedule: "[cron syntax]"
type: isolated  # or main
task: |
  [Detailed task description]
  [Multi-line is fine]
  [Be specific enough for AI to execute]
output: [voice|text|both|push|discord|silent]
enabled: true
priority: [low|normal|high|urgent]
context:  # Optional
  - path/to/context.md
```

**Save to:**
```
~/.claude/MEMORY/daemon/cron/jobs/[job-id].yaml
```

### Step 4: Edit Existing Job (if requested)

```typescript
// Read the existing YAML
const jobPath = `${process.env.HOME}/.claude/MEMORY/daemon/cron/jobs/${jobId}.yaml`;
const currentJob = await Bun.file(jobPath).text();

// Make requested changes (schedule, task, enabled, output, etc.)
// Preserve other fields

// Write back
await Bun.write(jobPath, updatedYaml);
```

### Step 5: Enable/Disable Job

Simply edit the YAML file and change:
```yaml
enabled: true   # or false
```

### Step 6: Validate Job Syntax (always after create/edit)

```bash
bun ~/.claude/skills/Automation/ProactiveEngine/Tools/CronValidator.ts [job-id]
```

Checks:
- Valid cron schedule syntax
- Required fields present (id, schedule, type, task, output, enabled)
- Valid enum values (type, output, priority)
- Context files exist (if specified)

### Step 7: Test Job Execution (optional)

```bash
bun ~/.claude/skills/Automation/ProactiveEngine/Tools/CronExecutor.ts run [job-id]
```

Manually trigger the job to verify it works as expected.

### Step 8: Confirmation

Report back to user:
- What was created/modified
- When it will run (next scheduled time)
- How they'll receive output
- How to disable if needed

---

## Example Interactions

### Example 1: Create Daily Standup

```
User: "Set up a daily standup summary at 10 AM"

→ Workflow creates MEMORY/daemon/cron/jobs/daily-standup.yaml:
  id: daily-standup
  schedule: "0 10 * * *"
  task: |
    Generate daily standup summary:
    - What I accomplished yesterday (from MEMORY/WORK/)
    - What I'm planning today (from LucidTasks)
    - Any blockers or concerns
  output: voice
  enabled: true
  priority: normal

→ Validates syntax
→ Reports: "Daily standup scheduled for 10 AM. You'll hear it via voice."
```

### Example 2: Weekly Review

```
User: "Schedule a weekly review every Monday at 9 AM"

→ Workflow creates MEMORY/daemon/cron/jobs/weekly-review.yaml:
  id: weekly-review
  schedule: "0 9 * * 1"
  task: |
    Generate weekly review:
    - Last week's accomplishments
    - This week's priorities
    - Upcoming commitments
  output: voice
  enabled: true
  priority: high

→ Reports: "Weekly review scheduled for Mondays at 9 AM."
```

### Example 3: Website Health Check

```
User: "Check my website every 30 minutes"

→ Workflow creates MEMORY/daemon/cron/jobs/website-health.yaml:
  id: website-health
  schedule: "*/30 * * * *"
  task: |
    Check website health:
    - HTTP status code
    - Response time
    - SSL certificate expiry
    - Only alert if issue detected
  output: push  # Only sends if problem
  enabled: true
  priority: urgent

→ Reports: "Website health check running every 30 minutes.
          Push notification only if issues found."
```

### Example 4: List All Jobs

```
User: "List my cron jobs"

→ Workflow reads all MEMORY/daemon/cron/jobs/*.yaml files
→ Outputs table:

  | Job ID           | Schedule        | Enabled | Output |
  |------------------|-----------------|---------|--------|
  | daily-briefing   | Daily at 8 AM   | ✓       | voice  |
  | evening-summary  | Daily at 8 PM   | ✓       | voice  |
  | weekly-review    | Mon at 9 AM     | ✓       | voice  |
  | website-health   | Every 30 min    | ✓       | push   |
```

### Example 5: Disable Job

```
User: "Disable the morning briefing for this week"

→ Workflow edits MEMORY/daemon/cron/jobs/daily-briefing.yaml:
  enabled: false

→ Reports: "Morning briefing disabled. Re-enable anytime with:
          'Enable daily briefing'"
```

---

## Validation Rules

### Schedule Validation

```typescript
// Valid cron expression: 5 fields
// minute (0-59)
// hour (0-23)
// day of month (1-31)
// month (1-12)
// day of week (0-6, 0=Sunday)

// Valid examples:
"0 8 * * *"      ✓
"*/30 * * * *"   ✓
"0 9 * * 1-5"    ✓  (weekdays)
"0 0 1 * *"      ✓  (first of month)

// Invalid:
"60 8 * * *"     ✗  (minute > 59)
"0 25 * * *"     ✗  (hour > 23)
"0 8 * *"        ✗  (only 4 fields)
```

### Required Fields

Every job must have:
- `id`: Unique identifier (slug format)
- `schedule`: Valid cron expression
- `type`: "isolated" or "main"
- `task`: Non-empty string
- `output`: "voice", "text", "both", "push", "discord", or "silent"
- `enabled`: boolean

### Optional Fields

- `priority`: "low", "normal", "high", "urgent" (default: normal)
- `context`: Array of file paths (must exist)

---

## Common Cron Patterns

| Pattern | Cron Syntax | Human Readable |
|---------|-------------|----------------|
| Every minute | `* * * * *` | Every minute |
| Every 5 minutes | `*/5 * * * *` | Every 5 minutes |
| Every 30 minutes | `*/30 * * * *` | Every 30 minutes |
| Every hour | `0 * * * *` | Top of every hour |
| Daily at 8 AM | `0 8 * * *` | 8:00 AM daily |
| Daily at midnight | `0 0 * * *` | Midnight daily |
| Monday at 9 AM | `0 9 * * 1` | 9:00 AM Mondays |
| Weekdays at 9 AM | `0 9 * * 1-5` | 9:00 AM weekdays |
| First of month | `0 10 1 * *` | 10:00 AM 1st of month |
| Every Sunday | `0 10 * * 0` | 10:00 AM Sundays |

---

## Error Handling

### Invalid Schedule

```
Error: Invalid cron syntax "0 8 * *"
Expected: 5 fields (minute hour day month weekday)
Received: 4 fields

Fix: Add the missing weekday field: "0 8 * * *"
```

### Missing Required Field

```
Error: Job "custom-task" missing required field: output
Required fields: id, schedule, type, task, output, enabled

Fix: Add "output: voice" (or push/discord/silent)
```

### Context File Not Found

```
Warning: Context file not found: "path/to/missing.md"
Job will run but without this context.

Fix: Create the file or remove from context array.
```

---

## File Locations

| File Type | Location |
|-----------|----------|
| Job definitions | `~/.claude/MEMORY/daemon/cron/jobs/*.yaml` |
| Validation script | `~/.claude/skills/Automation/ProactiveEngine/Tools/CronValidator.ts` |
| Execution logs | `~/.claude/MEMORY/daemon/cron/logs/` |

---

## Next Steps After Creating Job

```
ManageCronJobs → Test execution → Enable → Monitor logs
```

---

## Related Workflows

- `SendProactiveMessage.md` - Manually trigger proactive messages
- `System/IntegrityCheck.md` - Validate cron job references
- `System/DocumentSession.md` - Document cron job changes

---

**Last Updated:** 2026-02-06
