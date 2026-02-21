# Graph Query Workflow

**Frequency:** On-demand

## Supported Queries

### Stats
Show overall graph statistics

```bash
bun skills/Graph/Tools/GraphQuerier.ts stats
```

### Trace
Trace backward or forward from a node

```bash
bun skills/Graph/Tools/GraphQuerier.ts trace --from <node-id> --depth 3
```

### Neighbors
Show N-hop neighbors of a node

```bash
bun skills/Graph/Tools/GraphQuerier.ts neighbors --node <node-id> --depth 2
```

### Path
Find shortest path between two nodes

```bash
bun skills/Graph/Tools/GraphQuerier.ts path --from <a> --to <b>
```

### List
List nodes by type with filters

```bash
bun skills/Graph/Tools/GraphQuerier.ts list --type commit --since 7d
```

### Search
Full-text search across nodes

```bash
bun skills/Graph/Tools/GraphQuerier.ts search "query"
```

### By Goal
Query decisions aligned to a TELOS goal

```bash
bun skills/Graph/Tools/GraphQuerier.ts by-goal G25
```
