# QueueRouter API Reference

Complete API documentation for programmatic queue operations.

## QueueManager Class

### Constructor

```typescript
import { QueueManager } from '~/.claude/skills/QueueRouter/Tools/QueueManager.ts';

const qm = new QueueManager();
```

### Methods

#### add(payload, options?)

Add a new item to a queue.

```typescript
const id = await qm.add(
  {
    title: string;           // Required
    description: string;     // Required
    context?: Record<string, unknown>;
  },
  {
    queue?: string;          // Override auto-routing
    priority?: 1 | 2 | 3;    // Default: 2
    type?: string;           // For routing, default: "task"
    source?: string;         // Who added it, default: "manual"
  }
);
// Returns: string (item ID)
```

#### get(id)

Get a specific item by ID.

```typescript
const item = await qm.get("ml18vdlo-e7nb6l");
// Returns: QueueItem | null
```

#### list(filter?)

List items with optional filtering.

```typescript
const items = await qm.list({
  queue?: string;            // Filter by queue
  status?: QueueItemStatus;  // Filter by status
  priority?: 1 | 2 | 3;      // Filter by priority
  type?: string;             // Filter by type
});
// Returns: QueueItem[] (sorted by priority, then created date)
```

#### next(queueName?)

Get the next pending item from a queue.

```typescript
const item = await qm.next("research");
// Returns: QueueItem | null
```

#### update(id, updates)

Update an item's status or metadata.

```typescript
const item = await qm.update("ml18vdlo", {
  status?: QueueItemStatus;
  assignedAgent?: string;
  output?: unknown;
  error?: string;
});
// Returns: QueueItem | null
```

#### complete(id, result?)

Mark an item as completed.

```typescript
const item = await qm.complete("ml18vdlo", {
  output?: unknown;
  completedBy?: string;
});
// Returns: QueueItem | null
```

#### fail(id, error)

Mark an item as failed.

```typescript
const item = await qm.fail("ml18vdlo", "Connection timeout");
// Returns: QueueItem | null
```

#### approve(id, options?)

Approve an item awaiting approval.

```typescript
const item = await qm.approve("ml18vdlo", {
  notes?: string;
  reviewer?: string;
});
// Returns: QueueItem | null
```

#### reject(id, options?)

Reject an item awaiting approval.

```typescript
const item = await qm.reject("ml18vdlo", {
  reason?: string;
  reviewer?: string;
});
// Returns: QueueItem | null
```

#### transfer(id, options)

Transfer an item to another queue, preserving its ID and all metadata.

```typescript
const item = await qm.transfer("ml18vdlo", {
  targetQueue: string;         // Required: destination queue
  status?: QueueItemStatus;    // Override status (default: keep current)
  notes?: string;              // Transfer notes (stored in result.reviewNotes)
  transferredBy?: string;      // Who transferred (stored in result.reviewer)
  priority?: 1 | 2 | 3;        // Override priority (default: keep current)
});
// Returns: QueueItem | null (null if not found)
// Throws: Error if item is already in target queue
```

**Behavior:**
- Finds item across all queues by ID
- Deep copies item, updates `queue`, `routing.sourceQueue`, `routing.targetQueue`, `updated`
- Removes from source queue, appends to target queue (auto-creates JSONL if needed)
- Updates `state.json` if target queue is new

#### remove(id)

Remove an item from its queue.

```typescript
const removed = await qm.remove("ml18vdlo");
// Returns: boolean
```

#### stats(queueName?)

Get queue statistics.

```typescript
const stats = await qm.stats("approvals");
// Returns: QueueStats
```

```typescript
interface QueueStats {
  total: number;
  pending: number;
  inProgress: number;
  awaitingApproval: number;
  completed: number;
  failed: number;
  byQueue: Record<string, number>;
  byPriority: Record<1 | 2 | 3, number>;
}
```

#### cleanup(daysOld?)

Remove old completed/failed items.

```typescript
const result = await qm.cleanup(30);
// Returns: { removed: number }
```

#### persist()

Persist state (called by hooks).

```typescript
await qm.persist();
// Returns: void
```

---

## Types

### QueueItemStatus

```typescript
type QueueItemStatus =
  | "pending"           // Ready to be processed
  | "in_progress"       // Currently being worked on
  | "awaiting_approval" // Needs human approval
  | "completed"         // Successfully completed
  | "approved"          // Approved by human
  | "rejected"          // Rejected by human
  | "failed";           // Failed with error
```

### Priority

```typescript
type Priority = 1 | 2 | 3;  // 1=high, 2=normal, 3=low
```

### QueueItem

```typescript
interface QueueItem {
  id: string;
  created: string;
  updated: string;
  source: string;
  priority: Priority;
  status: QueueItemStatus;
  type: string;
  queue: string;
  payload: {
    title: string;
    description: string;
    context?: Record<string, unknown>;
  };
  routing?: {
    sourceQueue?: string;
    targetQueue?: string;
    assignedAgent?: string;
    approver?: string;
  };
  result?: {
    completedAt?: string;
    completedBy?: string;
    output?: unknown;
    error?: string;
    reviewNotes?: string;
    reviewer?: string;
  };
}
```
