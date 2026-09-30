# InboxReview Workflow

Review and triage tasks in the inbox queue.

## Trigger

- "review inbox"
- "triage"
- "/lt inbox"
- "/lt triage"

## Purpose

Process inbox tasks and classify them into `next`, `someday`, `scheduled`, or `waiting` queues. This is a manual, Kaya-assisted workflow — there is no automated triage command. Kaya helps by suggesting classifications and running the `edit` commands on your behalf.

## Steps

1. **List inbox tasks** - Load all tasks with status `inbox`
2. **For each task** - Decide classification manually or with AI assistance
3. **Update status** - Run `edit <id> --status <new_status>`
4. **Repeat** - Continue until inbox is empty or triage session ends
5. **Voice notification** - Summary via `notifySync()` in TaskManager

## CLI Usage

```bash
# List inbox tasks (text)
bun skills/Productivity/LucidTasks/Tools/TaskManager.ts inbox

# List inbox tasks as JSON (pipe-friendly)
bun skills/Productivity/LucidTasks/Tools/TaskManager.ts inbox --json

# List with status filter (alias via list command)
bun skills/Productivity/LucidTasks/Tools/TaskManager.ts list --status inbox

# Move to next actions
bun skills/Productivity/LucidTasks/Tools/TaskManager.ts edit t-abc123 --status next

# Move to someday
bun skills/Productivity/LucidTasks/Tools/TaskManager.ts edit t-def456 --status someday

# Schedule for specific date (status stays inbox until manually changed)
bun skills/Productivity/LucidTasks/Tools/TaskManager.ts edit t-ghi789 --status scheduled --due +1w

# Schedule with explicit scheduled date
bun skills/Productivity/LucidTasks/Tools/TaskManager.ts edit t-ghi789 --due +1w

# View task details before triaging
bun skills/Productivity/LucidTasks/Tools/TaskManager.ts view t-abc123
```

### Flags for `inbox` command

| Flag | Description | Status |
|------|-------------|--------|
| `--json` | Output tasks as JSON array | Implemented |

### Flags for `edit` command (used during triage)

| Flag | Description | Status |
|------|-------------|--------|
| `--status <status>` | Set task status | Implemented |
| `--due <date>` | Set due date | Implemented |
| `--priority <1-3>` | Set priority | Implemented |
| `--goal <id>` | Link to TELOS goal | Implemented |
| `--project <name\|id>` | Assign to project | Implemented |
| `--energy low\|medium\|high` | Set energy level | Implemented |
| `--estimate <minutes>` | Set time estimate | Implemented |

## AI-Assisted Triage

For batch classification, pipe inbox JSON to the Inference tool:

```bash
# Get inbox tasks as JSON
bun skills/Productivity/LucidTasks/Tools/TaskManager.ts inbox --json > /tmp/inbox.json

# Use AI to classify (manual review of output, then apply)
echo "Classify these tasks as next/someday/scheduled/waiting with brief reasoning" | \
  bun ~/.claude/tools/Inference.ts fast < /tmp/inbox.json

# Apply classifications one by one
bun skills/Productivity/LucidTasks/Tools/TaskManager.ts edit <id> --status <classification>
```

Note: AI triage is manual — Kaya reads the output and applies classifications on your behalf. There is no automated bulk-apply command.

## Status Lifecycle

```
inbox -> next       (actionable, should work on soon)
inbox -> someday    (not actionable now, review later)
inbox -> scheduled  (tied to specific future date)
inbox -> waiting    (blocked on someone/something external)
inbox -> cancelled  (not going to do)
```

## Voice Notification

Manual notification via `notifySync()` can be called after triage session with summary counts.

## Integration

- GTD inbox processing methodology
- Moves tasks through the status lifecycle
- Use `view <id>` to inspect task details before triaging
- Use `stats` after triage to confirm inbox is clear

## Output

Inbox listing:

```
Inbox (3 items):

  [ ] !!  t-abc123-xyz  Review Q1 reports
  [ ] !!! t-def456-uvw  Follow up with vendor
  [ ] !!  t-ghi789-rst  Update dependencies
```

After triage (check stats):

```
LucidTasks Dashboard
====================

Total Tasks:         47
By Status:
  inbox             0
  next              12
  someday           8
  scheduled         5
```
