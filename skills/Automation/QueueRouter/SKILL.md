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
| **GrillTask** | "/queue grill", "grill parked items", "interactive grill" | `Workflows/GrillTask.md` |

> `/queue grill` is **human-present only** — never invoke headless, from cron, or via `claude -p`.

## Complete Flow

```
LucidTasks triage (KayaTaskClassifier — 3-way judge)
  |-- clear       --> addSpecPipelineItem (rich context) --> auto-advance to "researching"
  |-- needs-grill --> parkForGrill()                     --> "needs-grilling"
  \-- not-executable --> discarded (not added to queue)

Manual add (no classifier verdict — heuristic fallback applies)
  --> spec-pipeline
        |-- hassufficientContext()? --> auto-advance to "researching"
        \-- insufficient context    --> "awaiting-context"
                                          |-- /queue context (context added) --> "researching"
                                          \-- Needs human clarity --> parkForGrill() --> "needs-grilling"

needs-grilling --> /queue grill (HUMAN-PRESENT ONLY — never headless/cron)
  |-- Socratic interview resolved --> grill finalize --> "researching" --> pipeline continues
  |-- Item obsolete / duplicate  --> grill kill      --> archived
  |-- Item too broad             --> grill split     --> new LucidTasks created, parent archived
  \-- Needs more time            --> grill defer     --> back to "awaiting-context" with deferUntil

researching --> SpecPipelineRunner auto-researches --> generating-spec
  --> SpecPipelineRunner auto-generates spec
  --> AUTO-TRANSFERS to approvals (WITH draft spec attached)

approvals (has draft spec) --> Jm reviews via /queue review
  |-- Approve spec + item --> AUTO-PROMOTES to approved-work --> autonomous /work execution
  |-- Reject spec (caveat/spec-fix) --> BACK TO spec-pipeline (revision-needed)
  |     --> re-research --> re-generate --> approvals again
  |     --> escalated after 3 rejections (requires manual intervention)
  \-- Reject spec (intent-change) --> rejectToGrill() --> "needs-grilling"
        --> /queue grill re-establishes intent --> "researching" --> fresh spec

New item WITH --spec flag --> approvals directly (has spec already, bypasses pipeline)
```

## Context Sufficiency Heuristic (Heuristic Fallback Only)

This heuristic applies **only to items added without a classifier verdict** (manual adds via CLI, `/queue add`, etc.). Items routed by the LucidTasks 3-way clarity judge are pre-routed at enqueue time and skip this check.

When a manually-added item enters spec-pipeline, `hassufficientContext()` decides whether to skip `awaiting-context` and auto-advance to `researching`:

**Auto-advances when ANY of:**
- Caller pre-supplied `notes` AND `researchGuidance` in context (structured context already provided)
- Description >= 400 chars AND has >= 2 ISC-derivable signals:
  - Enumerated deliverables: `(1)`, `(2)`, or numbered lists
  - Specific artifacts: file paths, function names, repo refs
  - Measurable targets: percentages, version numbers, counts
  - Explicit constraints: must/never/only/gate/require

Thin one-liners like "fix login bug" require human context via `/queue context`. Detailed, well-structured descriptions auto-flow through.

## Customization

- **Queue storage path:** `MEMORY/QUEUES/*.jsonl` — one file per queue
- **Escalation threshold:** 3 rejections before item escalates (hardcoded in `rejectToSpecPipeline()`)
- **Context sufficiency:** Items need >=200 chars or >=2 sentences of context before pipeline processing
- **Routing rules:** hardcoded in `Tools/QueueManager.ts` (`loadRoutingConfig`) — every item routes to `approvals` with `requiresApproval: true`, priority 2

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

**Storage:** `MEMORY/QUEUES/*.jsonl`. Spec files live at `Plans/Specs/Queue/{item-id}-spec.md`.

### Clickable Spec Links

Whenever you reference a spec (in `/queue list`, `review`, `pipeline-list`, or any summary), surface it as a **clickable link to the spec file** so Jm can click it open in a text editor / markdown viewer:

- The CLI's `formatItem`/`finalize` output already does this via `specLink()` — a terminal OSC 8 `file://` hyperlink when interactive, or the plain **absolute** path when piped (which Claude Code renders as a clickable file link).
- When you mention a spec in your own prose, **always include its absolute path** (e.g. `~/.claude/Plans/Specs/Queue/<id>-spec.md`) so it renders clickable. Don't shorten to a relative path — relative paths are not reliably clickable when relayed.

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
                |                                   \-> revision-needed -> researching (loop)
                |                                                       \-> escalated (after 3 rejections)
                \-> needs-grilling (/queue grill — HUMAN-PRESENT ONLY)
                      |-> researching  (grill finalize; with --findings the research
                      |                 spawn is SHORT-CIRCUITED — verdict dispatched
                      |                 from the grill-written artifact, see ADR 0002)
                      |-> awaiting-context (grill defer)
                      |-> archived (grill kill)
                      \-> subtasks created (grill split)
```

**Research short-circuit (ADR 0002):** `grill finalize --findings <path>` records a grill-written findings artifact; `runResearchPhase` dispatches its `VERDICT` directly instead of spawning the 15–30 min autonomous research subagent. The item still passes through `researching` (state machine unchanged). `--deep-research` opts back into the spawn; revision re-entry always re-researches. A `skip` verdict on a grill-stamped item never archives — it holds at `awaiting-context` and escalates to "Kaya — Needs Jm".

### How Items Enter the Pipeline

1. **LucidTasks 3-way clarity judge** (`KayaTaskClassifier`) — **hourly** triage over active tasks:
   - Runs every hour via `com.kaya.cron.kaya-triage` launchd job (plist: `StartCalendarInterval.Minute=0`).
   - The `queue_item_id` filter makes hourly runs cheap — only tasks with no existing queue item are sent to the LLM.
   - **Reconcile-before-triage**: at the start of each run, `reconcileQueueWithLucidTasks()` is called first to archive queue items whose source LucidTask has been closed/cancelled/iced. Failure is non-fatal — triage proceeds regardless.
   - **Triage stamps** (replaced the old pre-LLM staleness guard, 2026-06-10): skipped tasks get a `tasks.kaya_triage` stamp (verdict + content hash over project+title+description), so each task is judged at most once per content change. Old tasks are classified like any other — visibility beats silent dropping.
   - **clear** → `addSpecPipelineItem` with rich context (notes+researchGuidance pre-supplied) → auto-advances to `researching`
   - **needs-grill** → `parkForGrill()` → lands at `needs-grilling` (awaits `/queue grill`)
   - **not-executable / low-confidence clear, Kaya project** → also parked at `needs-grilling` with a verdict-carrying brief — Kaya-project tasks NEVER silently skip
   - **not-executable / below-threshold, non-Kaya** → stamped on the task (`kaya_triage`), not queued
2. **Default routing** - Manual adds without `--spec` enter spec-pipeline at `awaiting-context` (heuristic fallback decides auto-advance)
3. **Direct add via CLI** - `bun QueueManager.ts add "My Task"`
4. **Rejection from approvals (caveat/spec-fix)** - `bun QueueManager.ts reject-to-pipeline <id> --reason "..."` → `revision-needed`
5. **Rejection from approvals (intent-change)** - `rejectToGrill(id, feedback)` → `needs-grilling`

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

There are two distinct escalation paths — keep them separate when debugging the "Kaya — Needs Jm" board:

1. **3-rejection escalation** — after 3 approvals rejections an item transitions to the terminal `escalated` status and is removed from automatic processing. Requires manual intervention.

2. **Research-wedge escalation (grill-AWARE)** — when an item wedges in the research phase (`researchTimeouts >= 2`), the pre-pass disposes of it by grill state (`handleWedgedItem`):
   - **Un-grilled** (auto-routed `clear`) → `parkForGrill()` → `needs-grilling`. A `clear` item that still wedged was likely under-scoped, so route it to a human grill rather than dump a generic escalation on Jm.
   - **Grilled** → `escalateItem()` → a `manual-<itemId>` task on "Kaya — Needs Jm" + Telegram page. The reason is grill-aware (`buildEscalationReason`): it names the grill date and states the wedge is in the *research* phase, not grilling — so Jm isn't asked to grill something already grilled.

   These `manual-<itemId>` tasks **auto-close when the item's spec reaches approvals** (`closeEscalationIfOpen`, called on transfer to `awaiting_approval`), not only on full completion — otherwise the escalation lingers as a stale duplicate of the same item now in the approvals queue. `QueueSyncBridge` still closes on completion as a backstop.

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

**Last Updated:** 2026-06-07
