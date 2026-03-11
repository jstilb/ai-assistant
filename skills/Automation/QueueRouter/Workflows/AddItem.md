# AddItem Workflow

Add an item to the queue system with automatic routing.

## Trigger

- "add to queue"
- "queue task"
- "/queue add"

## Steps

1. **Parse input** - Extract title, description, type from user request
2. **Determine routing** - Items route to spec-pipeline by default (or approvals if `--spec` provided)
3. **Add item** - Call QueueManager.add() with routing result
4. **Context sufficiency check** - If description is detailed enough (>=200 chars, 2+ sentences), auto-advances to `researching`
5. **Notify** - Confirm item added with ID and queue name

## CLI Usage

```bash
# Basic add (routes to spec-pipeline, awaiting-context)
bun run Tools/QueueManager.ts add "Task title" --desc "Details"

# Detailed add (auto-advances to researching if sufficient)
bun run Tools/QueueManager.ts add "Task title" --desc "Long detailed description with multiple sentences..."

# With type (triggers routing rules)
bun run Tools/QueueManager.ts add "Deploy v2" --type deploy

# Skip spec-pipeline — attach existing spec (routes to approvals directly)
bun run Tools/QueueManager.ts add "My Feature" --desc "Details" --spec plans/my-feature-spec.md

# Direct to specific queue (approvals requires --spec)
bun run Tools/QueueManager.ts add "Quick task" --queue spec-pipeline
```

## Routing Rules

Items are routed based on patterns in `RoutingRules.yaml`:

| Pattern | Queue | Notes |
|---------|-------|-------|
| `spec:*` | spec-pipeline | Direct pipeline entry |
| `*` (default) | spec-pipeline | All items go through spec generation first |
| `--spec <path>` | approvals | Items with existing specs bypass pipeline |

## Context Sufficiency Heuristic

When an item enters spec-pipeline, it checks if the description is detailed enough to skip the `awaiting-context` stage:

**Auto-advances to `researching` when ALL of:**
- Description >= 200 characters
- Description contains 2+ sentences

**Or when ANY of:**
- Caller pre-supplied `notes` AND `researchGuidance` in context

**Otherwise:** Item stays at `awaiting-context`. Use `/queue context` to provide structured guidance.

## Programmatic Usage

```typescript
import { QueueManager } from './Tools/QueueManager.ts';

const qm = new QueueManager();

// Default: routes to spec-pipeline
const id = await qm.add(
  { title: "Review PR #42", description: "Auth refactor" },
  { type: "approval", source: "GitHub" }
);

// With existing spec: routes to approvals directly
const id2 = await qm.add(
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

## Output

Returns the item ID and confirms the target queue:

```
Added item: ml18vdke-n06t58
Queue: spec-pipeline (awaiting-context)
```

Or if auto-advanced:
```
Added item: ml18vdke-n06t58
Queue: spec-pipeline (researching)
[spec-pipeline] Auto-advanced ml18vdke-n06t58 to researching (sufficient context)
```
