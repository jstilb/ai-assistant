# Graph Synthesize Workflow

**Frequency:** Weekly (automated)

## Steps

1. Run RelationInferrer to detect new patterns
2. Run ContinualLearningBridge to extract insights:
   - Recurring error clusters
   - Error-prone files
   - High-error sessions
   - Hot files (high churn)
   - Decision patterns
   - Goal alignment trends
   - Course correction frequency
3. Export patterns to ContinualLearning via MemoryStore.capture()
4. Tag with 'graph' for retrieval

## Command

```bash
bun skills/Intelligence/Graph/Tools/Analyzers/ContinualLearningBridge.ts --synthesize
```

## Output

- Pattern nodes created in graph
- Insights captured in ContinualLearning
- Weekly summary report
