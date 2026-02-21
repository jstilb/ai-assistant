# /queue - Queue Management Command

Universal task queue management for Kaya. Add, list, approve, and review queued items. Uses a 2-queue model: `approvals` for intake and `approved-work` for autonomous execution.

## Usage

```
/queue [command] [args]
```

## Commands

| Command | Description |
|---------|-------------|
| `list` | List all queues and pending items |
| `list <queue>` | List items in specific queue |
| `add <title>` | Add task to queue (routes to approvals) |
| `get <id>` | Get details of specific item |
| `approve <id>` | Approve an item awaiting approval |
| `reject <id>` | Reject an item with reason |
| `review` | Review and create specs for items |
| `transfer <id> --to <queue>` | Move item between queues |
| `stats` | Show queue statistics |

## Examples

### List items
```
/queue list                    # List all queues
/queue list approvals          # List approval queue only
/queue list --status pending   # Filter by status
```

### Add items
```
/queue add "Review PR #42"                           # Routes to approvals
/queue add "Deploy v2.0" --type deploy               # Routes to approvals
/queue add "Fix login bug"                           # Routes to approvals
```

### Approve/Reject
```
/queue approve abc123                        # Approve item
/queue approve abc123 --notes "Ship it!"     # With notes
/queue reject abc123 --reason "Needs tests"  # Reject with reason
```

### Review specs
```
/queue review                  # Review and create specs for items
```

### Statistics
```
/queue stats                   # Overall statistics
/queue stats --queue approvals # Stats for specific queue
```

## Execution

When this command is invoked, route to the QueueRouter skill:

```
Read and execute: ~/.claude/skills/QueueRouter/SKILL.md
```

The skill provides the full implementation. For direct CLI access:

```bash
# QueueManager - Core operations
bun run ~/.claude/skills/QueueRouter/Tools/QueueManager.ts <command> [args]
```

## Routing

All items route to the `approvals` queue. After spec review and approval, items promote to `approved-work` for autonomous execution.

## Queue Locations

All queue data stored in: `~/.claude/MEMORY/QUEUES/`

| File | Purpose |
|------|---------|
| `state.json` | Queue metadata |
| `approvals.jsonl` | Items awaiting review and spec generation |
| `approved-work.jsonl` | Work with approved specs, ready for execution |

## Integration

The QueueRouter integrates with:
- **AutonomousWork** - Picks tasks from approved-work queue
- **SessionStart hook** - Shows pending items summary
- **Notification system** - Alerts on completion
