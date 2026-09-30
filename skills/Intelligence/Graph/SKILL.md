---
name: Graph
description: Temporal property graph linking sessions, commits, errors, decisions, and goals. USE WHEN system graph, trace error, root cause, decision trace, system graph stats, connections, top nodes, entry points, goal decisions, visualize session graph.
version: 2.3.0
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
   - Top-node ranking (degree centrality) — surfaces the most-connected hub nodes as entry points for exploration

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
~/.kaya/graph/            # shared across worktrees; resolved by lib/core/KayaHome.ts getSharedGraphDir(), override KAYA_GRAPH_DIR
  meta.json               # Graph metadata (via StateManager)
  nodes/                  # Per-type JSONL files (one per node type)
  edges/                  # Per-type JSONL files (one per edge type)
  embeddings/             # index.db + meta.json (EmbeddingEngine / EntityResolver)
  State/                  # ingester cursors
```

### Core Components

- **GraphEngine** - In-memory graph with adjacency lists, BFS/DFS, shortest path
- **GraphPersistence** - JSONL-per-type storage, deduplication, StateManager integration
- **GraphQuerier** - CLI for stats, trace, neighbors, path, list, search, visualize
- **Ingesters** - SessionIngester, GitIngester, TraceIngester, DecisionIngester
- **Analyzers** - RelationInferrer
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

# Top entry-point nodes (ranked by connection count / degree centrality)
# With ~40k nodes across ~19k disconnected fragments, these hubs are the best
# places to START a trace/neighbors/mindmap query.
bun skills/Intelligence/Graph/Tools/GraphQuerier.ts top
bun skills/Intelligence/Graph/Tools/GraphQuerier.ts top --type decision --limit 10
bun skills/Intelligence/Graph/Tools/GraphQuerier.ts top "worktree"   # search over the top nodes

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

# Mindmap — radial hierarchical tree rooted at any node
bun skills/Intelligence/Graph/Tools/Visualizers/MermaidVisualizer.ts --mindmap <node-id>
bun skills/Intelligence/Graph/Tools/Visualizers/MermaidVisualizer.ts --mindmap <node-id> --depth 2 --direction forward --max-children 6
```

**Mindmap mode** renders a Mermaid `mindmap` (a radial spanning tree) from any node.
Unlike the flowchart trace modes, every reachable node appears exactly once (cycles are
broken by first-discovery), giving a clean at-a-glance map of a node's neighborhood. Options:
- `--depth N` — max tree depth (default 3)
- `--direction forward|reverse|both` — follow successors, predecessors, or both (default `both`)
- `--max-children N` — cap children per node; extras collapse to a `… +N more` leaf (default 8)

Node types map to distinct mindmap shapes (commit=circle, session/file=square, error/goal=hexagon,
decision=bang, learning/outcome=rounded, agent_trace/context=cloud); each branch is prefixed with
the edge type that linked it (e.g. `modifies: src/index.ts`).

### Analysis

```bash
# Run relation inference standalone
bun skills/Intelligence/Graph/Tools/Analyzers/RelationInferrer.ts
```

(AgentMetacognitionBridge — `--synthesize`/`--context`/`--analyze` — was deleted
2026-07-10: it never emitted pattern/goal nodes and its MemoryStore insight
writes had no reader. The weekly `learning-weekly-digest` cron that replaced it
was itself deleted 2026-09-30 per Jm.)

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

(The former Weekly/Monthly synthesis workflows — AgentMetacognitionBridge
pattern export and deep-analysis snapshots — were retired 2026-07-10 with the
`graph-weekly-synthesis` cron — its yaml was deleted outright; there is no `jobs.retired/` record.)

## Integration Points

### AgentMetacognition

No scheduled reader: the weekly `learning-weekly-digest` cron that read graph
queries and `MEMORY/LEARNING/SIGNALS/*` was deleted 2026-09-30 per Jm. Run
AgentMetacognition on demand — judgment lives in the agent, not a
deterministic bridge.

### TELOS

Goal alignment is preserved via:
- `goal` nodes created from TELOS goal keywords
- `goal_aligned` edges based on tag overlap
- Query support via `--by-goal` flag

### AutoInfoManager / AutoMaintenance

Register Graph workflows for automated execution:
- **Daily:** Ingest + Capture (`graph-daily-ingest` cron)

## Voice Notification

> Use `notifySync()` from `lib/core/NotificationService.ts`
> Triggers on: Graph staleness (>48hr), ingestion errors, pattern synthesis completion

## Workflow Routing

| Workflow | Trigger | Purpose |
|----------|---------|---------|
| **Ingest All** | `ingest --all`, cron daily 7am | Full ingestion from git, sessions, traces, decisions + relation inference |
| **Search** | `search "query"` | Full-text search across all node titles |
| **Top** | `top ["query"]` | Rank most-connected nodes by degree centrality as graph entry points (optional type/title filter) |
| **Trace** | `trace --from <id>` | BFS backward/forward traversal from a node |
| **Visualize** | `--trace`, `--session`, `--timeline`, `--goal`, `--errors`, `--overview`, `--file`, `--mindmap` | Mermaid diagram generation (8 modes) |

## Dependencies

| Skill | Relationship |
|-------|-------------|
| **AgentMetacognition** | Reads graph + signals on demand (bridge deleted 2026-07-10; weekly digest cron deleted 2026-09-30) |
| **TELOS** | Goal nodes and `goal_aligned` edges preserve TELOS alignment |

## Customization

### Ingestion Sources
Configure in `Data/Sources.yaml`. Each source maps to an ingester class.

### Edge Rules
Configure in `Data/EdgeRules.yaml`. Defines edge types, weights, and temporal windows for automated edge creation.

### Cron Schedule
- Daily ingestion: `MEMORY/daemon/cron/manifests/graph-daily-ingest.yaml` (00:30 daily, `enabled: true` — the directory name is historical; `enabled:` inside each yaml is the switch)
- Weekly synthesis: retired 2026-07-10 (see the note under Workflows)

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
