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
│  │ - All items │    │  approvals ──► spec review ──► approved   │   │
│  │   route to  │    │                                   │       │   │
│  │   approvals │    │                       promote ◄───┘       │   │
│  │             │    │                          │                 │   │
│  └─────────────┘    │                          ▼                 │   │
│                     │                    approved-work           │   │
│                     │                    (autonomous exec)       │   │
│                     └──────────────────────────────────────────┘   │
│                                                                     │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │                      PERSISTENCE                             │   │
│  │  MEMORY/QUEUES/                                              │   │
│  │  ├── state.json           # Active queue metadata            │   │
│  │  ├── approvals.jsonl      # Items awaiting review            │   │
│  │  └── approved-work.jsonl  # Work with approved specs         │   │
│  └─────────────────────────────────────────────────────────────┘   │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

## Components

### QueueManager (QueueManager.ts)

Core CRUD operations for queue items. Includes inline routing logic.

**Responsibilities:**
- Add items to queues (all items route to approvals)
- List/filter items across queues
- Update item status
- Complete/fail items
- Approve/reject items
- Transfer items between queues
- Generate statistics
- Cleanup old items
- Auto-enrich + spec generation on intake

### ItemEnricher (ItemEnricher.ts)

AI-powered metadata enrichment for new items.

**Responsibilities:**
- Classify task type (feature, bug, refactor, etc.)
- Estimate complexity and effort
- Generate clarifying questions
- Suggest spec template

### SpecReviewManager (SpecReviewManager.ts)

Manages the spec generation and review pipeline.

**Responsibilities:**
- Generate draft specs from item descriptions + enrichment
- Phase-aware spec generation for multi-phase work
- List items needing specs

### SpecValidator (SpecValidator.ts)

Validates grounded specs meet quality criteria.

### WorkPromoter (WorkPromoter.ts)

Handles the promotion flow from approvals to approved-work.

**Responsibilities:**
- Validate spec is approved before promotion
- Transfer item with all metadata preserved

## Data Model

### QueueItem

```typescript
interface QueueItem {
  id: string;                    // Unique identifier (timestamp-random)
  created: string;               // ISO timestamp
  updated: string;               // Last update timestamp
  source: string;                // Which skill/workflow added it
  priority: 1 | 2 | 3;           // 1=high, 2=normal, 3=low
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

  spec?: QueueItemSpec;          // Spec linkage (required for approved-work)
  enrichment?: QueueItemEnrichment;  // AI enrichment metadata
  progress?: QueueItemProgress;  // Multi-phase progress tracking
}
```

### Status Flow

```
pending ─────────────────┬──► in_progress ──► completed
                         │                 └──► failed
                         │
                         └──► awaiting_approval ──► approved
                                                └──► rejected

Any status ──► transfer(id, {targetQueue}) ──► Same item in new queue
              (preserves ID, metadata, spec, enrichment)
```

## File Storage

### JSONL Format

Each queue is stored as a JSONL file (one JSON object per line):

```
MEMORY/QUEUES/approvals.jsonl
MEMORY/QUEUES/approved-work.jsonl
```

```jsonl
{"id":"ml18vdlo","created":"2026-01-30T18:56:46Z","status":"pending",...}
{"id":"ml18vdke","created":"2026-01-30T19:00:00Z","status":"completed",...}
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
  "lastUpdated": "2026-01-30T19:00:00Z",
  "queues": ["approvals", "approved-work"],
  "stats": {
    "totalItems": 42,
    "totalProcessed": 35,
    "lastProcessedAt": "2026-01-30T18:55:00Z"
  }
}
```

## Integration Points

### Hook Integration (Planned)

`QueueSummary.hook.ts` is planned but not yet implemented. When built, it will run at SessionStart to:
- Show pending item count
- Highlight approval items
- Display quick commands

### AutonomousWork Integration

The AutonomousWork skill picks up items from approved-work:
```typescript
const qm = new QueueManager();
const item = await qm.next("approved-work");
// Process item with spec context...
await qm.complete(item.id, { output: result });
```
