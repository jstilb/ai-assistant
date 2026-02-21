# AddItem Workflow

Add an item to the queue system with automatic routing.

## Trigger

- "add to queue"
- "queue task"
- "/queue add"

## Steps

1. **Parse input** - Extract title, description, type from user request
2. **Determine routing** - All items route to approvals queue
3. **Add item** - Call QueueManager.add() with routing result
4. **Notify** - Confirm item added with ID and queue name

## CLI Usage

```bash
# Basic add (auto enrichment + spec generation)
bun run Tools/QueueManager.ts add --title "Task title" --description "Details"

# With type (triggers routing rules)
bun run Tools/QueueManager.ts add --title "Deploy v2" --type deploy

# To specific queue
bun run Tools/QueueManager.ts add --title "Research AI" --queue research --priority 1

# Skip auto enrichment and spec generation
bun run Tools/QueueManager.ts add --title "Quick task" --desc "Details" --no-spec

# Attach an existing spec/plan file (skips auto spec generation)
bun run Tools/QueueManager.ts add --title "My Feature" --desc "Details" --spec plans/my-feature-spec.md
```

## Skipping Spec Generation

Use `--no-spec` to add an item without triggering the SpecSheet enrichment + spec generation pipeline. Useful when:
- You already have a plan/spec written elsewhere
- The item is simple and doesn't need a spec
- You want to manually attach a spec later

Use `--spec <path>` to attach an existing spec/plan file directly. The file is linked as an approved spec on the queue item, and auto enrichment + spec generation is skipped. The file must exist on disk.

## Programmatic Usage

```typescript
import { QueueManager } from './Tools/QueueManager.ts';

const qm = new QueueManager();

// Auto-routed based on type
const id = await qm.add(
  { title: "Review PR #42", description: "Auth refactor" },
  { type: "approval", source: "GitHub" }
);

// To specific queue
const id2 = await qm.add(
  { title: "Research competitors", description: "Top 5 analysis" },
  { queue: "research", priority: 2 }
);

// Skip auto spec generation
const id3 = await qm.add(
  { title: "Quick fix", description: "Small change" },
  { autoSpec: false }
);

// Attach an existing spec file
const id4 = await qm.add(
  { title: "My Feature", description: "Details" },
  {
    spec: {
      id: "my-feature-spec",
      path: "/absolute/path/to/my-feature-spec.md",
      status: "approved",
      approvedAt: new Date().toISOString(),
    }
  }
);
```

## Routing Rules

Items are routed based on patterns in `RoutingRules.yaml`:

| Pattern | Queue | Approval Required |
|---------|-------|-------------------|
| `*` | approvals | Yes |

## Output

Returns the item ID and confirms the target queue:

```
Added item: ml18vdke-n06t58
Queue: approvals (awaiting_approval)
```
