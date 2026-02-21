---
name: ContextGraph
description: DEPRECATED - Merged into skills/Graph. USE WHEN context graph -> redirect to Graph skill.
version: 1.0.0
deprecated: true
redirect: Graph
---

# ContextGraph [DEPRECATED]

**⚠️ DEPRECATED: This skill has been merged into the unified `Graph` skill.**

**Use `Graph` skill instead:** All ContextGraph functionality is now available in `skills/Graph/` with enhanced capabilities from the DevGraph merge.

**Migration complete:** 2026-02-13
**Data preserved:** Original data remains in `MEMORY/ContextGraph/` for rollback safety.
**New location:** `skills/Graph/`

## ContextGraph

Decision trace graph that extracts decision points from existing Kaya data sources (ratings, work items, learnings, context feedback, ISC transitions), builds a queryable graph with causal/temporal/outcome edges, and visualizes decision chains as Mermaid diagrams.

## Summary

ContextGraph solves the problem of understanding how decisions connect and influence each other across sessions. It:

1. **Extracts** decision signals from 5 existing data sources using heuristic rules (no LLM inference)
2. **Builds** a graph with 6 node types and 8 edge types linking decisions causally and temporally
3. **Queries** the graph for decision chains, goal alignment, full-text search, and outcome-linked analysis
4. **Visualizes** results as Mermaid flowcharts, timelines, and overview diagrams

## Commands

```bash
# Graph Operations
bun skills/ContextGraph/Tools/GraphManager.ts --stats              # Graph statistics
bun skills/ContextGraph/Tools/GraphManager.ts --rebuild            # Rebuild from events
bun skills/ContextGraph/Tools/GraphManager.ts --search "query"     # Search decisions
bun skills/ContextGraph/Tools/GraphManager.ts --trace <nodeId>     # Trace decision chain
bun skills/ContextGraph/Tools/GraphManager.ts --by-goal G25        # Decisions by goal
bun skills/ContextGraph/Tools/GraphManager.ts --node <nodeId>      # Node details

# Extraction
bun skills/ContextGraph/Tools/DecisionExtractor.ts                 # Extract all sources
bun skills/ContextGraph/Tools/DecisionExtractor.ts --since 7d      # Since 7 days ago
bun skills/ContextGraph/Tools/DecisionExtractor.ts --sources ratings,learnings
bun skills/ContextGraph/Tools/DecisionExtractor.ts --dry-run       # Preview only

# Visualization
bun skills/ContextGraph/Tools/TraceVisualizer.ts --overview --period month
bun skills/ContextGraph/Tools/TraceVisualizer.ts --timeline --since 7d
bun skills/ContextGraph/Tools/TraceVisualizer.ts --trace <nodeId>
bun skills/ContextGraph/Tools/TraceVisualizer.ts --goal G25
```

## Tools

| Tool | Purpose | Lines |
|------|---------|-------|
| `Tools/types.ts` | All TypeScript interfaces (6 node types, 8 edge types, graph state, events) | ~230 |
| `Tools/GraphManager.ts` | Core CRUD, queries, BFS trace, search, rebuild, stats | ~400 |
| `Tools/DecisionExtractor.ts` | Heuristic extraction from 5 data sources | ~500 |
| `Tools/TraceVisualizer.ts` | Mermaid diagram generation (trace, overview, timeline) | ~300 |

## Workflows

| Workflow | Frequency | Purpose |
|----------|-----------|---------|
| `Workflows/Capture.md` | Daily | Extract new decisions since last capture |
| `Workflows/Synthesize.md` | Weekly | Capture + detect patterns, create pattern nodes |
| `Workflows/Analyze.md` | Monthly | Synthesize + snapshot + deep analysis + TELOS mapping |
| `Workflows/Query.md` | On-demand | Parse user question, route to query, visualize |

## Data Architecture

### Event Store (Source of Truth)
- `MEMORY/ContextGraph/events.jsonl` - Append-only event log
- All mutations go through `appendEvents()` - never modify events directly

### Materialized Index
- `MEMORY/State/context-graph.json` - Rebuilt from events via StateManager
- Adjacency lists for fast traversal
- Node/edge counts by type

### Extraction State
- `skills/ContextGraph/State/last-capture.json` - Per-source cursors
- Tracks last processed line/timestamp for incremental extraction

### Monthly Snapshots
- `MEMORY/ContextGraph/snapshots/YYYY-MM.json` - Point-in-time graph state

## Graph Schema

### Node Types
| Type | Source | Example |
|------|--------|---------|
| `decision` | Work items, learnings, ISC | "Chose JSONL over SQLite" |
| `context` | Session metadata, effort | "Session was STANDARD effort" |
| `outcome` | Ratings, sentiment | "Rating: 3/10 - Frustrated" |
| `pattern` | Weekly synthesis | "Repeated TypeScript preference" |
| `goal` | TELOS linkage | "G28: AI Proficiency" |
| `session` | Session anchors | "Session 2026-02-10" |

### Edge Types
| Type | Meaning |
|------|---------|
| `caused` | A directly led to B |
| `influenced` | A shaped B |
| `preceded` | Temporal ordering |
| `outcome_of` | Links outcome to decision |
| `context_for` | Background for decision |
| `pattern_member` | Decision belongs to pattern |
| `goal_aligned` | Decision supports a goal |
| `supersedes` | Replaces earlier decision |

## Integration

### Uses (reads from)
- `MEMORY/LEARNING/SIGNALS/ratings.jsonl` - Rating signals (1000+ entries)
- `MEMORY/LEARNING/SIGNALS/context-feedback.jsonl` - Context classification
- `MEMORY/WORK/` - Work item directories
- `MEMORY/LEARNING/ALGORITHM/` - Learning entries
- `MEMORY/WORK/current-isc.json` - ISC criteria

### Feeds Into
- **ContinualLearning** - Weekly synthesis writes `MemoryStore.capture({ type: 'decision' })`
- **TELOS** - Goal alignment queries map decisions to goals
- **KnowledgeGraph** - Future bridge between decision nodes and document nodes

### Orchestration
- **AutoInfoManager** - Daily/Weekly/Monthly workflow tier registration

## Customization

### Adding Data Sources
Edit `Data/Sources.yaml` to add new extraction sources with signal detection rules.

### Modifying Edge Rules
Edit `Data/EdgeRules.yaml` to change automatic edge creation thresholds and conditions.

### Custom Queries
Import `createGraphManager()` from `GraphManager.ts` for programmatic access:
```typescript
import { createGraphManager } from "./Tools/GraphManager";
const gm = createGraphManager();
const results = await gm.search("TypeScript");
const trace = await gm.traceDecisionChain(nodeId, 5);
```

## Voice Notification

Workflows send voice notifications on completion:
- Capture: "Daily context graph capture complete with N new decisions"
- Synthesize: "Weekly decision synthesis found N patterns across M decisions"
- Analyze: "Monthly decision analysis complete, N goals mapped"

## Examples

### Trace a decision chain
```bash
$ bun skills/ContextGraph/Tools/GraphManager.ts --search "frustrated"
# Find a node ID from results
$ bun skills/ContextGraph/Tools/GraphManager.ts --trace ratings-5e1dffea2937a167
$ bun skills/ContextGraph/Tools/TraceVisualizer.ts --trace ratings-5e1dffea2937a167
```

### Monthly overview
```bash
$ bun skills/ContextGraph/Tools/TraceVisualizer.ts --overview --period month
```

### Goal alignment check
```bash
$ bun skills/ContextGraph/Tools/GraphManager.ts --by-goal G28
$ bun skills/ContextGraph/Tools/TraceVisualizer.ts --goal G28
```

### Full extraction and stats
```bash
$ bun skills/ContextGraph/Tools/DecisionExtractor.ts --since 7d
$ bun skills/ContextGraph/Tools/GraphManager.ts --stats
```
