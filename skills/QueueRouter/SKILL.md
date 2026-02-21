---
name: QueueRouter
description: Universal task queue and routing system for Kaya. USE WHEN queue task, add to queue, list queues, route task, approval queue, approved work, work queue, background queue, process queue, queue status, promote work.
---
# QueueRouter

Universal task queue and routing system. Add, list, approve, and process queued items with automatic routing. Uses a **2-queue model**: `approvals` for intake/review and `approved-work` for autonomous execution with validated spec sheets.

**USE WHEN:** queue task, add to queue, list queues, route task, approval workflow, approved work, work queue, queue status, pending approvals, promote to approved.

## Voice Notification

> Use `notifySync()` from `skills/CORE/Tools/NotificationService.ts`

## Workflow Routing

**When executing a workflow, output this notification:**

```
Running the **WorkflowName** workflow from the **QueueRouter** skill...
```

| Workflow | Trigger | File |
|----------|---------|------|
| **AddItem** | "add to queue", "/queue add" | `Workflows/AddItem.md` |
| **ListItems** | "list queue", "/queue list" | `Workflows/ListItems.md` |
| **ApproveItem** | "approve item", "/queue approve" | `Workflows/ApproveItem.md` |
| **ReviewSpecs** | "review specs", "/queue review" | `Workflows/ReviewSpecs.md` |

## Examples

**Example 1: Add item to approval queue**
```
User: "Add 'implement dark mode' to the queue"
-> Runs AddItem workflow
-> Item added to approvals queue with AI enrichment
-> Returns item ID and enrichment metadata
```

**Example 2: Promote approved work**
```
User: "Promote item abc123 to approved-work with spec DarkMode-grounded"
-> Validates grounded spec is approved
-> Moves item from approvals -> approved-work queue
-> Ready for autonomous execution
```

**Example 3: Review specs for approval items**
```
User: "/queue review"
-> Lists items in approvals queue needing specs
-> Generates draft specs from descriptions + enrichment
-> Interactive review and approval
-> Items with approved specs ready for promotion
```

## Quick Reference

**Key Commands:**
- `/queue add "title"` - Add item (routes to approvals)
- `/queue add "title" --no-spec` - Add item without auto spec generation
- `/queue add "title" --spec path/to/spec.md` - Add item with existing spec attached
- `/queue list --status pending` - List pending items
- `/queue approve <id>` - Approve awaiting item
- `/queue review` - Review and create specs for items
- `/queue transfer <id> --to <queue>` - Move item between queues (preserves metadata)
- `/queue stats` - Show statistics

**Routing:** All items route to `approvals` queue for review. After spec approval, items promote to `approved-work` for autonomous execution.

**Storage:** `MEMORY/QUEUES/*.jsonl`

## Approved Work Queue

The `approved-work` queue enforces a hard constraint: **nothing enters without an approved grounded spec**.

### Flow
```
Request -> approvals queue (AI enrichment) -> Review -> Spec Iteration -> Approved -> approved-work -> Autonomous Execution
```

### Tools
| Tool | Purpose | CLI |
|------|---------|-----|
| **QueueManager** | Core queue CRUD operations | `bun run QueueManager.ts <command>` |

## Full Documentation

- Architecture: `Architecture.md`
- API Reference: `API.md`
- Routing Rules: `RoutingRules.yaml`

## Integration

### Uses
- **MEMORY/QUEUES/** - JSONL file persistence
- **NotificationService** - Completion notifications
- **StateManager** - Type-safe worker state persistence

### Tools
- **QueueManager.ts** - Core queue CRUD operations
- **SpecParser.ts** - Spec markdown parsing

### Feeds Into
- **AutonomousWork** - Picks tasks from approved-work queue
- **SessionStart hook** - Shows pending items (planned: `QueueSummary.hook.ts`)
- **InformationManager** - Routes Kaya tasks from scratchpad to approvals

### MCPs Used
- None (pure file-based system)

---

**Last Updated:** 2026-02-05
