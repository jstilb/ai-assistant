# ListItems Workflow

List and filter items across queues.

## Trigger

- "list queue"
- "show pending"
- "/queue list"

## Steps

1. **Parse filters** - Extract queue name, status, priority from request
2. **Load items** - Call QueueManager.list() with filters
3. **Format output** - Display items sorted by priority then date
4. **Show stats** - Include summary counts

## CLI Usage

```bash
# List all items
bun run Tools/QueueManager.ts list

# Filter by queue
bun run Tools/QueueManager.ts list --queue approvals

# Filter by status
bun run Tools/QueueManager.ts list --status pending

# Filter by priority
bun run Tools/QueueManager.ts list --priority 1

# Combined filters
bun run Tools/QueueManager.ts list --queue development --status pending
```

## Programmatic Usage

```typescript
import { QueueManager } from './Tools/QueueManager.ts';

const qm = new QueueManager();

// All items
const all = await qm.list();

// Filtered
const pending = await qm.list({ status: "pending" });
const approvals = await qm.list({ queue: "approvals" });
const urgent = await qm.list({ priority: 1 });
```

## Status Values

| Status | Meaning |
|--------|---------|
| `pending` | Ready to be processed |
| `in_progress` | Currently being worked on |
| `awaiting_approval` | Needs human approval |
| `completed` | Successfully finished |
| `approved` | Approved by human |
| `rejected` | Rejected by human |
| `failed` | Failed with error |

## Output Format

```
Found 3 items:

───────────────────────────────────────
ID:       ml18vdke-n06t58
Title:    Deploy to production
Queue:    approvals
Status:   ⚠️ awaiting_approval
Priority: HIGH
Type:     deploy
Created:  2026-01-30T18:56:46.236Z
───────────────────────────────────────
```
