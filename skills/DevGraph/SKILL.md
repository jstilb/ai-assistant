---
name: DevGraph
description: DEPRECATED - Merged into skills/Graph. USE WHEN devgraph -> redirect to Graph skill.
deprecated: true
redirect: Graph
---

# DevGraph [DEPRECATED]

**⚠️ DEPRECATED: This skill has been merged into the unified `Graph` skill.**

**Use `Graph` skill instead:** All DevGraph functionality is now available in `skills/Graph/` with enhanced capabilities from the ContextGraph merge.

**Migration complete:** 2026-02-13
**Data preserved:** Original data remains in `MEMORY/DEVGRAPH/` for rollback safety.
**New location:** `skills/Graph/`

## DevGraph

Development knowledge graph that automatically links sessions, agent traces, errors, commits, learnings, and skill changes -- then feeds relationship-aware insights into ContinualLearning.

## Summary

DevGraph fills the gap between flat, disconnected Kaya data stores. It ingests from git history, session logs, and agent traces to build a temporal property graph. The graph supports traversal queries (what caused this error?), neighborhood exploration (what did this session touch?), and automated pattern detection (which files keep breaking?).

## Commands

| Command | Description |
|---------|-------------|
| `devgraph ingest` | Ingest from all sources (git, sessions, traces) |
| `devgraph stats` | Show graph statistics |
| `devgraph trace <id>` | Trace backward from an error/node |
| `devgraph neighbors <id>` | Show N-hop neighbors |
| `devgraph path <a> <b>` | Find shortest path between nodes |
| `devgraph list <type>` | List nodes by type |
| `devgraph synthesize` | Export insights to ContinualLearning |

## Tools

| Tool | Purpose |
|------|---------|
| `Tools/types.ts` | Node, edge, and state type definitions |
| `Tools/GraphEngine.ts` | In-memory graph with BFS/DFS, shortest path, components |
| `Tools/GraphPersistence.ts` | JSONL storage with StateManager-backed metadata |
| `Tools/SessionIngester.ts` | Parse MEMORY/WORK/ sessions into nodes |
| `Tools/TraceIngester.ts` | Ingest AgentMonitor traces |
| `Tools/GitIngester.ts` | Parse git log/diff into commit/file nodes |
| `Tools/RelationInferrer.ts` | Infer implicit edges (temporal, file overlap, error-fix) |
| `Tools/GraphQuerier.ts` | CLI entry point for all queries |
| `Tools/ContinualLearningBridge.ts` | Export graph insights to MemoryStore |

## Workflows

| Workflow | Trigger | Purpose |
|----------|---------|---------|
| `Ingest` | `devgraph ingest`, maintenance | Auto-ingest from all sources |
| `Query` | `devgraph stats`, `show graph` | Interactive graph querying |
| `Trace` | `trace error`, `what caused` | Trace error to root cause |
| `Synthesize` | `devgraph synthesize`, weekly | Generate insights for ContinualLearning |

## Workflow Routing

```
User says "devgraph ingest" OR "update graph"
  -> Workflows/Ingest.md

User says "devgraph stats" OR "graph status" OR "show graph"
  -> Workflows/Query.md

User says "trace error" OR "what caused" OR "root cause"
  -> Workflows/Trace.md

User says "devgraph synthesize" OR "graph insights" OR "find patterns in graph"
  -> Workflows/Synthesize.md
```

## Integration

### Uses
- `CORE/Tools/StateManager.ts` - meta.json persistence
- `CORE/Tools/MemoryStore.ts` - Export insights to ContinualLearning
- `AgentMonitor/Tools/TraceCollector.ts` - Agent trace format

### Feeds Into
- `ContinualLearning` - Pattern insights via MemoryStore with tag `devgraph`
- `KnowledgeGraph` - Compatible node/edge types for potential future merge

## Customization

### Configuration
- `TEMPORAL_WINDOW_MS` in RelationInferrer.ts - Time window for co-occurrence (default: 1 hour)
- `limit` parameter in GitIngester - Number of commits to ingest (default: 100)
- Edge weight thresholds in RelationInferrer.ts

### Storage
- `MEMORY/DEVGRAPH/nodes/{type}.jsonl` - Node storage by type
- `MEMORY/DEVGRAPH/edges/{type}.jsonl` - Edge storage by type
- `MEMORY/DEVGRAPH/meta.json` - Graph metadata

## Voice Notification

```
DevGraph [action] complete with [count] nodes and [count] edges
```

## Examples

### Ingest all data
```bash
bun skills/DevGraph/Tools/GraphQuerier.ts ingest --all
```

### Show graph stats
```bash
bun skills/DevGraph/Tools/GraphQuerier.ts stats
```

### Trace an error
```bash
bun skills/DevGraph/Tools/GraphQuerier.ts list --type error --since 7d
bun skills/DevGraph/Tools/GraphQuerier.ts trace --from error:session-001:abc --depth 3
```

### Find what a session produced
```bash
bun skills/DevGraph/Tools/GraphQuerier.ts neighbors --node session:20260210-131115 --depth 2
```

### Export patterns
```bash
bun skills/DevGraph/Tools/ContinualLearningBridge.ts --synthesize
```
