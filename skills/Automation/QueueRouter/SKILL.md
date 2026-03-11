---
name: QueueRouter
context: fork
description: Universal task queue and routing system for Kaya. USE WHEN queue task, queue add, queue list, route task, approval queue, approved-work queue, background queue, process queue, queue status, promote queue, spec pipeline, context gathering, reject spec, pipeline status.
---
# QueueRouter

Universal task queue and routing system. Add, list, approve, and process queued items with automatic routing. Uses a **3-queue model**: `spec-pipeline` for autonomous spec generation, `approvals` for reviewing generated specs, and `approved-work` for autonomous execution with validated spec sheets.

**USE WHEN:** queue task, queue add item, queue list items, route task, approval workflow, approved-work queue, queue status, pending approvals, promote to approved, spec pipeline, gather context, reject to pipeline.

## Voice Notification

> Use `notifySync()` from `lib/core/NotificationService.ts`

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
| **ContextGathering** | "/queue context", "gather context", "review awaiting-context" | `Workflows/ContextGathering.md` |

## Complete Flow

```
New item (no spec) --> spec-pipeline
  |-- Has sufficient context? --> auto-advance to "researching"
  \-- Insufficient context?   --> "awaiting-context" (wait for /queue context)

researching --> SpecPipelineRunner auto-researches --> generating-spec
  --> SpecPipelineRunner auto-generates spec
  --> AUTO-TRANSFERS to approvals (WITH draft spec attached)

approvals (has draft spec) --> Jm reviews via /queue review
  |-- Approve spec --> approve item --> AUTO-PROMOTES to approved-work --> execution
  \-- Reject spec --> BACK TO spec-pipeline (revision-needed)
       --> re-research --> re-generate --> approvals again
       --> escalated after 3 rejections (requires manual intervention)

New item WITH --spec flag --> approvals directly (has spec already)
```

## Context Sufficiency Heuristic

When items enter spec-pipeline, the system checks if they have enough context to skip the `awaiting-context` stage and auto-advance to `researching`:

**Auto-advances when ALL of:**
- Description >= 200 characters
- Description contains at least 2 sentences

**Or when ANY of:**
- Caller pre-supplied `notes` AND `researchGuidance` in context

Thin one-liners like "fix login bug" require human context via `/queue context`. Detailed descriptions auto-flow through.

## Customization

- **Queue storage path:** `MEMORY/QUEUES/*.jsonl` — one file per queue
- **Escalation threshold:** 3 rejections before item escalates (hardcoded in `rejectToSpecPipeline()`)
- **Context sufficiency:** Items need >=200 chars or >=2 sentences of context before pipeline processing
- **Routing rules:** `RoutingRules.yaml` — defines queue-to-workflow mappings

## Examples

**Example 1: Add item (default flow)**
```
User: "Add 'implement dark mode' to the queue"
-> Runs AddItem workflow
-> Item added to spec-pipeline queue (awaiting-context)
-> Returns item ID
```

**Example 2: Add item with existing spec**
```
User: "/queue add 'implement dark mode' --spec plans/dark-mode-spec.md"
-> Item added directly to approvals (has spec)
-> Spec must be approved before item can promote
```

**Example 3: Review pipeline-generated specs**
```
User: "/queue review"
-> Lists items in approvals queue with draft specs
-> Review each spec, approve or reject
-> Approved items promote to approved-work
-> Rejected items return to spec-pipeline for revision
```

**Example 4: Gather context for pipeline items**
```
User: "/queue context"
-> Runs ContextGathering workflow
-> Loops through items in awaiting-context status
-> Asks: problem context, research guidance, scope hints
-> Transitions each item to researching status
```

**Example 5: Reject a spec back to pipeline**
```
User: "Reject item abc123 to pipeline - needs JWT research"
-> Calls qm.rejectToSpecPipeline(id, reason)
-> revisionCount increments; escalates at 3 rejections
-> Item transferred from approvals back to spec-pipeline
```

## Quick Reference

**Key Commands:**
- `/queue add "title"` - Add item (routes to spec-pipeline)
- `/queue add "title" --spec path/to/spec.md` - Add item with existing spec (routes to approvals)
- `/queue list --status pending` - List pending items
- `/queue approve-spec <id>` - Approve a draft spec
- `/queue approve <id>` - Approve item (requires approved spec) + promote to approved-work
- `/queue review` - Review draft specs from pipeline
- `/queue transfer <id> --to <queue>` - Move item between queues
- `/queue stats` - Show statistics
- `/queue context` - Gather context for awaiting-context spec-pipeline items
- `/queue pipeline-list [--status <status>]` - List spec-pipeline items by status
- `/queue reject-to-pipeline <id> --reason "..."` - Reject spec back to pipeline

**Routing:** All items route to `spec-pipeline` queue by default for spec generation. Items with `--spec` route directly to `approvals`. After spec approval, items promote to `approved-work` for autonomous execution.

**Storage:** `MEMORY/QUEUES/*.jsonl`

## Approved Work Queue

The `approved-work` queue enforces a hard constraint: **nothing enters without an approved spec**.

### Flow
```
Request -> spec-pipeline (research + spec gen) -> approvals (draft spec review) -> Approved -> approved-work -> Autonomous Execution
```

### Tools
| Tool | Purpose | CLI |
|------|---------|-----|
| **QueueManager** | Core queue CRUD operations | `bun run QueueManager.ts <command>` |
| **SpecPipelineRunner** | Research + spec generation | `bun run SpecPipelineRunner.ts <command>` |

## Spec Pipeline

The `spec-pipeline` queue automates spec generation for tasks. Items flow through 5 states:

```
awaiting-context -> researching -> generating-spec -> (approvals with draft spec)
                                                    \-> revision-needed -> researching (loop)
                                                                        \-> escalated (after 3 rejections)
```

### How Items Enter the Pipeline

1. **Default routing** - All new items without `--spec` enter spec-pipeline
2. **LucidTasks weekly triage** - `TriageLucidTasks` step adds tasks tagged `@kaya`
3. **Direct add via CLI** - `bun QueueManager.ts add "My Task"`
4. **Rejection from approvals** - `bun QueueManager.ts reject-to-pipeline <id> --reason "..."`

### Context Gathering (`/queue context`)

Interactive workflow that walks through `awaiting-context` items:
1. Collects problem context (notes)
2. Collects research guidance (what questions to answer)
3. Optionally collects scope hints (constraints, out-of-scope)
4. Transitions item to `researching`

```bash
# CLI alternative (non-interactive)
bun QueueManager.ts context <id> \
  --notes "JWT auth needs replacing with OAuth2" \
  --research "Compare OAuth2 providers, OWASP guidelines" \
  --scope "Must maintain backward compat"
```

### Autonomous Processing (`SpecPipelineRunner`)

Once items are in `researching`, `SpecPipelineRunner.ts` handles the rest:

| Phase | Input Status | Output Status | What Happens |
|-------|-------------|---------------|--------------|
| Research | `researching` | `generating-spec` | Inference.ts synthesizes research into `MEMORY/WORK/{session}/research-{id}.md` |
| Spec Gen | `generating-spec` | `approvals` (transfer) | Generates draft spec; transfers to approvals with `spec.status: "draft"` |
| Revision | `revision-needed` | `researching` | Rejection feedback added as constraints, re-enters research loop |

```bash
# Process all ready items
bun SpecPipelineRunner.ts run

# Process a single item
bun SpecPipelineRunner.ts process <id>
```

### Spec Review Flow

When specs arrive in approvals with `status: "draft"`:
1. Review spec content via `/queue review`
2. `approve-spec <id>` sets spec status to `"approved"`
3. `approve <id>` promotes item to `approved-work`

### Escalation

After 3 rejections, items transition to `escalated` status and are removed from automatic processing. Escalated items require manual intervention.

### Pipeline Status Commands

```bash
bun QueueManager.ts pipeline-list                       # All items
bun QueueManager.ts pipeline-list --status researching  # Filter by status
bun QueueManager.ts approve-spec <id>                   # Approve draft spec
bun QueueManager.ts reject-to-pipeline <id> --reason "needs more detail"
```

## Full Documentation

- Architecture: `Architecture.md`
- API Reference: `API.md`
- Routing Rules: `RoutingRules.yaml`

## Integration

### Uses
- **MEMORY/QUEUES/** - JSONL file persistence
- **NotificationService** - Completion notifications
- **MemoryStore** - Decision capture and learning retrieval

### Tools
- **QueueManager.ts** - Core queue CRUD operations
- **SpecParser.ts** - Spec markdown parsing
- **SpecPipelineRunner.ts** - Orchestrates research and spec generation phases
- **MigrateApprovalsToSpecPipeline.ts** - One-time migration script

### Feeds Into
- **AutonomousWork** - Picks tasks from approved-work queue
- **SessionStart hook** - Shows pending items
- **InformationManager** - Routes Kaya tasks from scratchpad to queue
- **AutoInfoManager** - Weekly `TriageLucidTasks` step adds @kaya tasks to spec-pipeline

### MCPs Used
- None (pure file-based system)

---

**Last Updated:** 2026-02-26
