# ApproveItem Workflow

Approve or reject items awaiting human approval.

## Trigger

- "approve item"
- "reject queue item"
- "/queue approve"
- "/queue reject"

## Steps

### Approve
1. **Get item** - Verify item exists and is awaiting approval
2. **Update status** - Set status to "approved"
3. **Record reviewer** - Store reviewer name and notes
4. **Notify** - Confirm approval

### Reject
1. **Get item** - Verify item exists and is awaiting approval
2. **Update status** - Set status to "rejected"
3. **Record reason** - Store rejection reason and reviewer
4. **Notify** - Confirm rejection

## CLI Usage

```bash
# Approve with notes
bun run Tools/QueueManager.ts approve ml18vdlo --notes "Ship it!" --reviewer Jm

# Reject with reason
bun run Tools/QueueManager.ts reject ml18vdlo --reason "Needs more tests" --reviewer Jm

# Quick approve (no notes)
bun run Tools/QueueManager.ts approve ml18vdlo
```

## Programmatic Usage

```typescript
import { QueueManager } from './Tools/QueueManager.ts';

const qm = new QueueManager();

// Approve
await qm.approve("ml18vdlo", {
  notes: "Reviewed and approved",
  reviewer: "Jm"
});

// Reject
await qm.reject("ml18vdlo", {
  reason: "Missing test coverage",
  reviewer: "Jm"
});
```

## Finding Items to Approve

```bash
# List all items awaiting approval
bun run Tools/QueueManager.ts list --queue approvals --status awaiting_approval

# Or check stats
bun run Tools/QueueManager.ts stats
```

## Approval Queue Items

These types automatically route to the approvals queue:
- `spec:*` - Specifications
- `deploy:*` - Deployments
- `publish:*` - Publishing (social, blog)
- `merge:*` - PR merges to main
- `delete:*` - Destructive actions

## Output

```
Approved: ml18vdlo
───────────────────────────────────────
ID:       ml18vdlo-e7nb6l
Title:    Deploy to production
Queue:    approvals
Status:   ✅ approved
Notes:    Ship it!
Reviewer: Jm
───────────────────────────────────────
```
