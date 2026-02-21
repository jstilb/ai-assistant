---
name: Graph
description: Unified knowledge graph linking sessions, commits, errors, decisions, and goals with traversal queries, pattern detection, and Mermaid visualization. USE WHEN graph, devgraph, context graph, trace error, what caused, decision trace, show decisions, root cause, graph stats, session history, show connections, decision patterns, goal decisions.
version: 2.0.0
---

# Graph - Unified Knowledge Graph

**Status:** Phase 1 Complete - Foundation Established
**Created:** 2026-02-13
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
bun skills/Graph/Tools/GraphQuerier.ts ingest --all

# Ingest specific sources
bun skills/Graph/Tools/GraphQuerier.ts ingest --source git
bun skills/Graph/Tools/GraphQuerier.ts ingest --source sessions
bun skills/Graph/Tools/GraphQuerier.ts ingest --source traces
bun skills/Graph/Tools/GraphQuerier.ts ingest --source decisions

# Run relation inference only
bun skills/Graph/Tools/GraphQuerier.ts ingest --infer
```

### Queries

```bash
# Graph statistics
bun skills/Graph/Tools/GraphQuerier.ts stats
bun skills/Graph/Tools/GraphQuerier.ts stats --json

# Traverse from a node
bun skills/Graph/Tools/GraphQuerier.ts trace --from <node-id> --depth 5
bun skills/Graph/Tools/GraphQuerier.ts neighbors --node <node-id> --depth 2

# Find shortest path
bun skills/Graph/Tools/GraphQuerier.ts path --from <a> --to <b>

# List nodes by type
bun skills/Graph/Tools/GraphQuerier.ts list --type commit --since 7d
bun skills/Graph/Tools/GraphQuerier.ts list --type outcome
bun skills/Graph/Tools/GraphQuerier.ts list --type decision

# Search full-text
bun skills/Graph/Tools/GraphQuerier.ts search "TypeScript"
bun skills/Graph/Tools/GraphQuerier.ts search "authentication bug"

# Query by TELOS goal
bun skills/Graph/Tools/GraphQuerier.ts by-goal G25

# Connected components
bun skills/Graph/Tools/GraphQuerier.ts components
```

### Visualization

```bash
# Trace chain from a node
bun skills/Graph/Tools/Visualizers/MermaidVisualizer.ts --trace <node-id>

# Overview diagram
bun skills/Graph/Tools/Visualizers/MermaidVisualizer.ts --overview --period month

# Timeline view
bun skills/Graph/Tools/Visualizers/MermaidVisualizer.ts --timeline --since 7d

# Goal-aligned decisions
bun skills/Graph/Tools/Visualizers/MermaidVisualizer.ts --goal G25

# Session deep-dive
bun skills/Graph/Tools/Visualizers/MermaidVisualizer.ts --session <session-id>

# File history
bun skills/Graph/Tools/Visualizers/MermaidVisualizer.ts --file <file-id>

# Error landscape
bun skills/Graph/Tools/Visualizers/MermaidVisualizer.ts --errors --since 7d
```

### Analysis

```bash
# Synthesize patterns and export to ContinualLearning
bun skills/Graph/Tools/Analyzers/ContinualLearningBridge.ts --synthesize

# Run relation inference standalone
bun skills/Graph/Tools/Analyzers/RelationInferrer.ts
```

### Maintenance

```bash
# Rebuild meta.json from JSONL files
bun skills/Graph/Tools/GraphPersistence.ts --rebuild-meta

# Load graph and show stats
bun skills/Graph/Tools/GraphPersistence.ts --load
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

## Migration Status

### Phase 1: Foundation ✅ COMPLETE
- ✅ Created unified types.ts (13 node types, 19 edge types)
- ✅ Adapted GraphEngine.ts from DevGraph
- ✅ Adapted GraphPersistence.ts from DevGraph
- ✅ Created directory structure
- ✅ Self-tests passing for types, engine, persistence

### Phase 2: Data Migration (NEXT)
- [ ] Write migrate.ts script
- [ ] Copy DevGraph JSONL files to MEMORY/GRAPH/
- [ ] Convert ContextGraph events to GraphNode format
- [ ] Deduplicate session/decision nodes
- [ ] Rebuild meta.json
- [ ] Verify node/edge counts

### Phase 3: Ingesters
- [ ] Move SessionIngester, GitIngester, TraceIngester
- [ ] Adapt DecisionExtractor → DecisionIngester
- [ ] Move Data/Sources.yaml and Data/EdgeRules.yaml
- [ ] Test all ingesters independently

### Phase 4: Query + Visualization
- [ ] Expand GraphQuerier with search, by-goal, visualize commands
- [ ] Adapt TraceVisualizer → MermaidVisualizer
- [ ] Add node shapes for all 13 types
- [ ] Add new visualization modes (session, file, errors)

### Phase 5: Analyzers + Integration
- [ ] Expand RelationInferrer with tag-overlap and goal-alignment
- [ ] Expand ContinualLearningBridge with decision patterns
- [ ] Write workflow markdown files
- [ ] Register with AutoInfoManager

### Phase 6: Cleanup
- [ ] Mark ContextGraph/DevGraph as deprecated
- [ ] Update all references to point to Graph
- [ ] Regenerate skill index
- [ ] After 1 week: delete old skill directories

## Implementation Notes

### Design Decisions

- **DevGraph's GraphEngine as base** - Proper class-based engine with BFS/DFS/shortest-path
- **DevGraph's GraphPersistence as storage** - JSONL-per-type is cleaner than monolithic events.jsonl
- **ContextGraph's event-sourcing as audit layer** - Optional events.jsonl for replay/audit
- **ContextGraph's DecisionExtractor as ingester** - Same pluggable pattern as other ingesters
- **YAML configs preserved** - Sources.yaml and EdgeRules.yaml for declarative configuration

### Data Migration Notes

- DevGraph → Graph: Direct copy (field names are 1:1)
- ContextGraph → Graph: Transform DecisionNode fields
  - `DecisionNode.content` → `GraphNode.metadata.content`
  - `DecisionNode.confidence` → `GraphNode.metadata.confidence`
  - `DecisionNode.recordedAt` → `GraphNode.metadata.recordedAt`
  - `DecisionNode.timestamp` → `GraphNode.valid_from`

### Rollback Plan

- Original MEMORY/DEVGRAPH/ and MEMORY/ContextGraph/ untouched during migration
- Old skill directories marked deprecated but not deleted for 1 week
- Can revert by removing deprecated flags

## Examples

### Find what caused an error

```bash
# Trace backward from error node
bun skills/Graph/Tools/GraphQuerier.ts trace --from error:001 --depth 3

# Visualize the error chain
bun skills/Graph/Tools/Visualizers/MermaidVisualizer.ts --trace error:001
```

### Show decisions for a TELOS goal

```bash
# Query by goal
bun skills/Graph/Tools/GraphQuerier.ts by-goal G25

# Visualize goal-aligned decisions
bun skills/Graph/Tools/Visualizers/MermaidVisualizer.ts --goal G25
```

### Trace session artifacts

```bash
# List what a session produced
bun skills/Graph/Tools/GraphQuerier.ts trace --from session:20260213-071322 --depth 2

# Visualize session deep-dive
bun skills/Graph/Tools/Visualizers/MermaidVisualizer.ts --session session:20260213-071322
```

### Find related decisions

```bash
# Search for decisions about authentication
bun skills/Graph/Tools/GraphQuerier.ts search "authentication"

# Find decisions with specific tags
bun skills/Graph/Tools/GraphQuerier.ts list --type decision --tags security,api
```

## Future Enhancements

- [ ] Weighted path finding (use edge weights)
- [ ] Temporal queries (valid_from/valid_to ranges)
- [ ] Graph diff (compare snapshots)
- [ ] Export to Neo4j or other graph databases
- [ ] GraphQL API for external tools
- [ ] Merge with KnowledgeGraph (Obsidian integration)

## References

- **Spec:** MEMORY/WORK/specs/graph-merge-spec.md
- **DevGraph origin:** skills/DevGraph/
- **ContextGraph origin:** skills/ContextGraph/
- **Type definitions:** skills/Graph/Tools/types.ts
