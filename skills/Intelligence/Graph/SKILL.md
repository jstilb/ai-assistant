---
name: Graph
description: Temporal property graph linking sessions, commits, errors, decisions, and goals. USE WHEN system graph, trace error, root cause, decision trace, system graph stats, connections, goal decisions, visualize work graph.
version: 2.1.0
---

# Graph - Unified Knowledge Graph

**Status:** All Phases Complete
**Created:** 2026-02-13
**Updated:** 2026-02-27
**Replaces:** DevGraph + ContextGraph

## Overview

The Graph skill merges DevGraph and ContextGraph into a single unified knowledge graph system. It links development artifacts (sessions, commits, errors, files, skills) with decision intelligence (decisions, outcomes, context, patterns, goals) in a queryable temporal property graph.

### Key Capabilities

1. **Graph Ingestion** - Extract nodes/edges from:
   - Git commits and file changes
   - Kaya session logs
   - Agent workflow traces
   - Ratings, feedback, learnings, ISC decisions
   - TELOS goal alignments

2. **Graph Queries** - Traverse and search:
   - BFS/DFS traversal with depth limits
   - Shortest path between nodes
   - Backward tracing (what caused X?)
   - Forward tracing (what did X produce?)
   - Connected components analysis
   - Full-text search across nodes

3. **Pattern Detection** - Automated inference:
   - Temporal relationships (within 1hr)
   - File overlap patterns
   - Error-fix chains
   - Tag overlap similarities
   - Goal alignment detection

4. **Visualization** - Mermaid diagrams:
   - Decision chains
   - Session overviews
   - Timeline views
   - Goal-aligned decisions
   - Error landscapes

## Architecture

### Type System

- **13 Node Types:** session, agent_trace, error, commit, learning, skill_change, file, issue, decision, outcome, context, pattern, goal
- **19 Edge Types:** produced, caused, fixed_by, learned_from, references, depends_on, blocks, modifies, spawned, contains, implements, relates_to, influenced, preceded, outcome_of, context_for, pattern_member, goal_aligned, supersedes

### Data Storage

```
MEMORY/GRAPH/
  meta.json           # Graph metadata (via StateManager)
  nodes/              # Per-type JSONL files (13 files)
  edges/              # Per-type JSONL files (19 files)
  events.jsonl        # Optional audit log
```

### Core Components

- **GraphEngine** - In-memory graph with adjacency lists, BFS/DFS, shortest path
- **GraphPersistence** - JSONL-per-type storage, deduplication, StateManager integration
- **GraphQuerier** - CLI for stats, trace, neighbors, path, list, search, visualize
- **Ingesters** - SessionIngester, GitIngester, TraceIngester, DecisionIngester
- **Analyzers** - RelationInferrer, ContinualLearningBridge
- **Visualizers** - MermaidVisualizer (trace, overview, timeline, goal modes)

## Commands

### Ingestion

```bash
# Ingest from all sources
bun skills/Intelligence/Graph/Tools/GraphQuerier.ts ingest --all

# Ingest specific sources
bun skills/Intelligence/Graph/Tools/GraphQuerier.ts ingest --source git
bun skills/Intelligence/Graph/Tools/GraphQuerier.ts ingest --source sessions
bun skills/Intelligence/Graph/Tools/GraphQuerier.ts ingest --source traces
bun skills/Intelligence/Graph/Tools/GraphQuerier.ts ingest --source decisions

# Run relation inference only
bun skills/Intelligence/Graph/Tools/GraphQuerier.ts ingest --infer
```

### Queries

```bash
# Graph statistics
bun skills/Intelligence/Graph/Tools/GraphQuerier.ts stats
bun skills/Intelligence/Graph/Tools/GraphQuerier.ts stats --json

# Traverse from a node
bun skills/Intelligence/Graph/Tools/GraphQuerier.ts trace --from <node-id> --depth 5
bun skills/Intelligence/Graph/Tools/GraphQuerier.ts neighbors --node <node-id> --depth 2

# Find shortest path
bun skills/Intelligence/Graph/Tools/GraphQuerier.ts path --from <a> --to <b>

# List nodes by type
bun skills/Intelligence/Graph/Tools/GraphQuerier.ts list --type commit --since 7d
bun skills/Intelligence/Graph/Tools/GraphQuerier.ts list --type outcome
bun skills/Intelligence/Graph/Tools/GraphQuerier.ts list --type decision

# Search full-text
bun skills/Intelligence/Graph/Tools/GraphQuerier.ts search "TypeScript"
bun skills/Intelligence/Graph/Tools/GraphQuerier.ts search "authentication bug"

# Query by TELOS goal
bun skills/Intelligence/Graph/Tools/GraphQuerier.ts by-goal G25

# Connected components
bun skills/Intelligence/Graph/Tools/GraphQuerier.ts components
```

### Visualization

```bash
# Trace chain from a node
bun skills/Intelligence/Graph/Tools/Visualizers/MermaidVisualizer.ts --trace <node-id>

# Overview diagram
bun skills/Intelligence/Graph/Tools/Visualizers/MermaidVisualizer.ts --overview --period month

# Timeline view
bun skills/Intelligence/Graph/Tools/Visualizers/MermaidVisualizer.ts --timeline --since 7d

# Goal-aligned decisions
bun skills/Intelligence/Graph/Tools/Visualizers/MermaidVisualizer.ts --goal G25

# Session deep-dive
bun skills/Intelligence/Graph/Tools/Visualizers/MermaidVisualizer.ts --session <session-id>

# File history
bun skills/Intelligence/Graph/Tools/Visualizers/MermaidVisualizer.ts --file <file-id>

# Error landscape
bun skills/Intelligence/Graph/Tools/Visualizers/MermaidVisualizer.ts --errors --since 7d
```

### Analysis

```bash
# Synthesize patterns and export to ContinualLearning
bun skills/Intelligence/Graph/Tools/Analyzers/ContinualLearningBridge.ts --synthesize

# Run relation inference standalone
bun skills/Intelligence/Graph/Tools/Analyzers/RelationInferrer.ts
```

### Maintenance

```bash
# Rebuild meta.json from JSONL files
bun skills/Intelligence/Graph/Tools/GraphPersistence.ts --rebuild-meta

# Load graph and show stats
bun skills/Intelligence/Graph/Tools/GraphPersistence.ts --load
```

## Workflows

### Daily Workflow (Auto-scheduled)

1. Run DecisionIngester (extract new decisions from ratings, learnings, feedback, ISC)
2. Run SessionIngester (parse new session directories)
3. Run GitIngester (recent commits)
4. Run RelationInferrer (detect implicit edges)
5. Rebuild meta.json
6. Report stats via voice notification

### Weekly Workflow (Auto-scheduled)

1. Run pattern synthesis
2. Detect decision patterns
3. Identify error clusters
4. Export insights to ContinualLearning
5. Generate weekly summary

### Monthly Workflow (Auto-scheduled)

1. Deep TELOS mapping
2. Goal alignment analysis
3. Create monthly snapshot
4. Archive old data

## Integration Points

### ContinualLearning

The ContinualLearningBridge detects patterns from both development and decision data:

- **From DevGraph data:** Recurring error clusters, error-prone files, high-error sessions, hot files
- **From ContextGraph data:** Decision patterns, goal alignment trends, course correction frequency, context shift patterns

All patterns exported via `MemoryStore.capture()` with tag `graph`.

### TELOS

Goal alignment is preserved via:
- `goal` nodes created from TELOS goal keywords
- `goal_aligned` edges based on tag overlap
- Query support via `--by-goal` flag

### AutoInfoManager / AutoMaintenance

Register Graph workflows for automated execution:
- **Daily:** Ingest + Capture
- **Weekly:** Synthesize (pattern detection, ContinualLearning export)
- **Monthly:** Analyze (deep analysis, TELOS mapping, snapshot)

## Voice Notification

> Use `notifySync()` from `lib/core/NotificationService.ts`
> Triggers on: Graph staleness (>48hr), ingestion errors, pattern synthesis completion

## Workflow Routing

| Workflow | Trigger | Purpose |
|----------|---------|---------|
| **Ingest All** | `ingest --all`, cron daily 7am | Full ingestion from git, sessions, traces, decisions + relation inference |
| **Search** | `search "query"` | Full-text search across all node titles |
| **Trace** | `trace --from <id>` | BFS backward/forward traversal from a node |
| **Visualize** | `--trace`, `--session`, `--timeline`, `--goal`, `--errors`, `--overview`, `--file` | Mermaid diagram generation (7 modes) |
| **Synthesize** | `ContinualLearningBridge.ts --synthesize`, cron weekly Tue 9am | Pattern detection and ContinualLearning export |

## Dependencies

| Skill | Relationship |
|-------|-------------|
| **ContinualLearning** | Graph exports detected patterns via ContinualLearningBridge |
| **DailyBriefing** | GraphInsightsBlock provides node/edge counts and staleness in briefings |
| **InformationManager** | Graph stats loaded as context via `config/graph.json` |
| **TELOS** | Goal nodes and `goal_aligned` edges preserve TELOS alignment |

## Customization

### Ingestion Sources
Configure in `Data/Sources.yaml`. Each source maps to an ingester class.

### Edge Rules
Configure in `Data/EdgeRules.yaml`. Defines edge types, weights, and temporal windows for automated edge creation.

### Staleness Threshold
GraphInsightsBlock warns when graph data is >48 hours old (configurable in `GraphInsightsBlock.ts`).

### Cron Schedule
- Daily ingestion: `MEMORY/daemon/cron/jobs/graph-daily-ingest.yaml` (7:00 AM)
- Weekly synthesis: `MEMORY/daemon/cron/jobs/graph-weekly-synthesis.yaml` (Tuesday 9:00 AM)

## Examples

**Example 1: Root Cause Analysis**
```bash
# What caused this error?
bun skills/Intelligence/Graph/Tools/GraphQuerier.ts trace --from error:001 --depth 3
# Visualize the chain
bun skills/Intelligence/Graph/Tools/Visualizers/MermaidVisualizer.ts --trace error:001
```

**Example 2: TELOS Goal Decisions**
```bash
# All decisions aligned to goal G25
bun skills/Intelligence/Graph/Tools/GraphQuerier.ts by-goal G25
# Mermaid diagram of goal alignment
bun skills/Intelligence/Graph/Tools/Visualizers/MermaidVisualizer.ts --goal G25
```

**Example 3: Session Deep-Dive**
```bash
# What did this session produce?
bun skills/Intelligence/Graph/Tools/GraphQuerier.ts trace --from session:20260213-071322 --depth 2
# Visual session map
bun skills/Intelligence/Graph/Tools/Visualizers/MermaidVisualizer.ts --session session:20260213-071322
```

**Example 4: Full-Text Search**
```bash
# Find all nodes mentioning "browser"
bun skills/Intelligence/Graph/Tools/GraphQuerier.ts search "browser"
# Filter decisions by tags
bun skills/Intelligence/Graph/Tools/GraphQuerier.ts list --type decision --tags security,api
```

## Future Enhancements

- [ ] Weighted path finding (use edge weights)
- [ ] Temporal queries (valid_from/valid_to ranges)
- [ ] Graph diff (compare snapshots)
- [ ] Export to Neo4j or other graph databases
- [ ] GraphQL API for external tools
- [ ] Merge with KnowledgeGraph (Obsidian integration)

## References

- **Type definitions:** skills/Intelligence/Graph/Tools/types.ts
- **Edge rules:** skills/Intelligence/Graph/Data/EdgeRules.yaml
- **Source config:** skills/Intelligence/Graph/Data/Sources.yaml
