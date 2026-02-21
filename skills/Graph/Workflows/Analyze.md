# Graph Analyze Workflow

**Frequency:** Monthly (automated)

## Steps

1. Deep TELOS mapping - align decisions to goals
2. Goal alignment analysis - which goals get most attention
3. Decision pattern detection - recurring choice patterns
4. Context shift analysis - profile changes over time
5. Create monthly snapshot in MEMORY/GRAPH/snapshots/
6. Archive old data if needed

## Command

```bash
bun skills/Graph/Tools/Analyzers/ContinualLearningBridge.ts --analyze --period month
```

## Output

- Monthly analysis report
- Goal alignment metrics
- Decision pattern summary
- Snapshot file created
