# QueueRouter Architecture

Detailed architecture documentation for the QueueRouter system.

## System Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                        QUEUEROUTER SYSTEM                          │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  ┌─────────────┐    ┌──────────────────────────────────────────┐   │
│  │  ROUTING    │───▶│             QUEUES                        │   │
│  │             │    │                                            │   │
│  │ - Default:  │    │  spec-pipeline ──► research ──► gen spec  │   │
│  │   spec-     │    │       │                          │        │   │
│  │   pipeline  │    │       │    ┌─────────────────────┘        │   │
│  │             │    │       │    ▼                               │   │
│  │ - With spec:│    │       │  approvals (draft spec review)    │   │
│  │   approvals │    │       │    │                               │   │
│  └─────────────┘    │       │    ├── approve spec + item        │   │
│                     │       │    │         ▼                     │   │
│                     │       │    │   approved-work               │   │
│                     │       │    │   (autonomous exec)           │   │
│                     │       │    │                               │   │
│                     │       │    └── reject spec                 │   │
│                     │       │         │                          │   │
│                     │       ◄─────────┘ (revision loop)         │   │
│                     └──────────────────────────────────────────┘   │
│                                                                     │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │                      PERSISTENCE                             │   │
│  │  MEMORY/QUEUES/                                              │   │
│  │  ├── state.json             # Active queue metadata          │   │
│  │  ├── spec-pipeline.jsonl    # Items being spec'd             │   │
│  │  ├── approvals.jsonl        # Items with draft specs         │   │
│  │  ├── approved-work.jsonl    # Work with approved specs       │   │
│  │  └── archive/               # Archived completed items       │   │
│  └─────────────────────────────────────────────────────────────┘   │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
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
- Spec generation: complexity-adaptive spec writing
- Transfer to approvals with draft spec attached
- Revision handling: re-research with rejection feedback
- Escalation after 3 rejections

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
── spec-pipeline ──────────────────────────────────────────────
awaiting-context ──► researching ──► generating-spec ──► [transfer to approvals]
     ▲                                                        │
     └─── revision-needed ◄────── [reject from approvals] ───┘
                │
                └──► escalated (after 3 rejections)

── approvals ─────────────────────────────────────────────────
awaiting_approval (with draft spec) ──► approve-spec ──► approve ──► [transfer to approved-work]

── approved-work ─────────────────────────────────────────────
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
