# Graph Ingest Workflow

**Frequency:** Daily (automated)

## Steps

1. Run SessionIngester - Parse new MEMORY/WORK/ directories
2. Run GitIngester - Ingest recent commits (limit: 20)
3. Run TraceIngester - Parse agent traces
4. Run DecisionIngester - Extract decisions from ratings, learnings, feedback, ISC
5. Run RelationInferrer - Detect implicit edges (temporal, file-overlap, error-fix, tag-overlap, goal-alignment)
6. Rebuild meta.json
7. Report stats via voice notification

## Command

```bash
bun skills/Intelligence/Graph/Tools/GraphQuerier.ts ingest --all
```

## Output

- Nodes added/skipped per source
- Edges added/skipped per source
- Inferred relation counts
- Updated graph statistics
