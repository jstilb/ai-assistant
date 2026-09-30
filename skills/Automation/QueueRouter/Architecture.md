# QueueRouter Architecture

Detailed architecture documentation for the QueueRouter system.

## System Overview

```
┌────────────────────────────────────────────────────────────────────────┐
│                          QUEUEROUTER SYSTEM                            │
├────────────────────────────────────────────────────────────────────────┤
│                                                                        │
│  ┌──────────────────────┐   ┌──────────────────────────────────────┐  │
│  │  ROUTING / INTAKE    │──▶│             QUEUES                    │  │
│  │                      │   │                                        │  │
│  │ LucidTasks 3-way     │   │  spec-pipeline                        │  │
│  │ clarity judge:       │   │    awaiting-context                   │  │
│  │  clear → researching │   │       │  ▲                            │  │
│  │  needs-grill →       │   │       │  └── /queue context (human)   │  │
│  │    needs-grilling    │   │       ▼                               │  │
│  │  not-executable →    │   │    researching ──► generating-spec    │  │
│  │    discard           │   │       │                    │          │  │
│  │                      │   │       │              ┌─────┘          │  │
│  │ Manual add (no       │   │  needs-grilling       ▼              │  │
│  │ verdict):            │   │  (/queue grill   approvals            │  │
│  │  heuristic fallback  │   │   HUMAN ONLY)     (draft spec)        │  │
│  │  decides awaiting-   │   │       │               │               │  │
│  │  context vs research │   │       │         ┌─────┤               │  │
│  │                      │   │       │         │     │               │  │
│  │ With --spec:         │   │  revision-needed│  approve            │  │
│  │  → approvals direct  │   │  / escalated    │     ▼              │  │
│  └──────────────────────┘   │                 │  approved-work      │  │
│                              │  ◄──────────────┘  (autonomous exec) │  │
│                              │  (reject loop)                        │  │
│                              └──────────────────────────────────────┘  │
│                                                                        │
│  ┌──────────────────────────────────────────────────────────────────┐  │
│  │                        PERSISTENCE                                │  │
│  │  MEMORY/QUEUES/                                                   │  │
│  │  ├── state.json              # Active queue metadata              │  │
│  │  ├── spec-pipeline.jsonl     # Items being spec'd                 │  │
│  │  ├── approvals.jsonl         # Items with draft specs             │  │
│  │  ├── approved-work.jsonl     # Work with approved specs           │  │
│  │  └── archive/                # Archived completed items           │  │
│  └──────────────────────────────────────────────────────────────────┘  │
│                                                                        │
└────────────────────────────────────────────────────────────────────────┘
```

## Components

### QueueManager (QueueManager.ts)

Core CRUD operations for queue items. Includes inline routing logic.

**Responsibilities:**
- Add items to queues (default: spec-pipeline; with --spec: approvals)
- Spec-pipeline delegation with context sufficiency auto-advance
- Approvals guard (rejects spec-less items)
- List/filter items across queues
- Update item status
- Complete/fail items
- Approve/reject items
- Approve draft specs (approveSpec)
- Transfer items between queues
- Reject items to spec-pipeline with revision tracking
- Generate statistics
- Cleanup old items

### SpecPipelineRunner (SpecPipelineRunner.ts)

Orchestrates the autonomous spec generation pipeline.

**Responsibilities:**
- Research phase: synthesize research findings via Inference.ts
- Research short-circuit: grill-provided findings (`_meta.grillFindingsProvided`) bypass the claude -p spawn — verdict dispatched directly from the artifact (ADR 0002)
- Grilled-item skip guard: a skip verdict on a grill-stamped item holds at awaiting-context + escalates, never archives
- Spec generation: complexity-adaptive spec writing
- UX/UI stage (browser/native surfaces): runs each designer agent step as a single-shot inference() call with inlined context docs (SpecSheet ADR 0007) — no tool-capable subprocess spawns remain in the pipeline
- Transfer to approvals with draft spec attached
- Revision handling: re-research with rejection feedback (short-circuit disabled; prior findings injected as context)
- Escalation after 3 rejections (terminal `escalated` status)
- Research-wedge disposition (grill-aware, `handleWedgedItem`): an item that wedges in research (`researchTimeouts >= 2`) routes by grill state — un-grilled → `parkForGrill()` (route to a human grill; the `clear` routing was likely wrong), grilled → `escalateItem()` with a grill-aware reason. The `manual-<itemId>` escalation auto-closes when the spec reaches approvals (`closeEscalationIfOpen`), not only on completion, so it never lingers as a stale duplicate of the approvals item.

### SpecParser (SpecParser.ts)

Parses spec markdown files into structured data.

## Data Model

### QueueItem

```typescript
interface QueueItem {
  id: string;                    // Unique identifier (timestamp-random)
  created: string;               // ISO timestamp
  updated: string;               // Last update timestamp
  source: string;                // Which skill/workflow added it
  priority: 1 | 2 | 3;          // 1=high, 2=normal, 3=low
  status: QueueItemStatus;       // Current state
  type: string;                  // Item type
  queue: string;                 // Which queue it's in

  payload: {
    title: string;               // Short description
    description: string;         // Full details
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

  spec?: QueueItemSpec;          // Spec linkage (draft or approved)
  enrichment?: QueueItemEnrichment;  // AI enrichment metadata
  progress?: QueueItemProgress;  // Multi-phase progress tracking
}
```

### QueueItemSpec

```typescript
interface QueueItemSpec {
  id: string;
  path: string;
  status: "draft" | "approved";  // Draft specs need review first
  approvedAt?: string;           // Only set when approved
  approvedBy?: string;
}
```

### Status Flow

```
── spec-pipeline ──────────────────────────────────────────────────────────────
awaiting-context ──► researching ──► generating-spec ──► [transfer to approvals]
     ▲                   ▲                                        │
     │                   │                                        │
     │           needs-grilling ◄── parkForGrill()               │
     │           (HUMAN-GATE:    [/queue grill only]              │
     │            SpecPipelineRunner never touches this)          │
     │                   │                                        │
     │    ┌──────────────┤ grill finalize ──► researching        │
     │    │              │   (--findings: research spawn skipped, │
     │    │              │    verdict from grill artifact, ADR 0002)
     │    │              └ grill defer   ──► awaiting-context     │
     │    │              └ grill kill    ──► archived             │
     │    │              └ grill split   ──► new LucidTasks       │
     │    │                                                        │
     └─── revision-needed ◄──── [reject caveat/spec-fix] ────────┘
                │
                └──► escalated (after 3 rejections)

     Also: rejectToGrill() ◄── [reject intent-change from approvals]
           │
           └──► needs-grilling (re-grill before fresh spec)

── approvals ──────────────────────────────────────────────────────────────────
awaiting_approval (with draft spec)
  ──► approve-spec ──► approve ──► [transfer to approved-work]
  ──► reject (caveat/spec-fix) ──► spec-pipeline (revision-needed)
  ──► reject (intent-change)  ──► spec-pipeline (needs-grilling)

── approved-work ──────────────────────────────────────────────────────────────
pending ──► in_progress ──► completed
                         └──► failed
```

## File Storage

### JSONL Format

Each queue is stored as a JSONL file (one JSON object per line):

```
MEMORY/QUEUES/spec-pipeline.jsonl
MEMORY/QUEUES/approvals.jsonl
MEMORY/QUEUES/approved-work.jsonl
```

**Why JSONL:**
- Append-only is fast
- Git-friendly (line-level diffs)
- Human-readable
- No need for Redis/database

### State File

Global state stored in `state.json`:

```json
{
  "lastUpdated": "2026-02-22T19:00:00Z",
  "queues": ["spec-pipeline", "approvals", "approved-work"],
  "stats": {
    "totalItems": 42,
    "totalProcessed": 35,
    "lastProcessedAt": "2026-02-22T18:55:00Z"
  }
}
```

## Integration Points

### AutonomousWork Integration

The AutonomousWork skill picks up items from approved-work:
```typescript
const qm = new QueueManager();
const item = await qm.next("approved-work");
// Process item with spec context...
await qm.complete(item.id, { output: result });
```

### Spec Pipeline Integration

Items enter spec-pipeline by default. SpecPipelineRunner processes them:
```typescript
import { processAll } from "./SpecPipelineRunner.ts";
const result = await processAll();
// Items auto-transfer to approvals with draft specs
```
