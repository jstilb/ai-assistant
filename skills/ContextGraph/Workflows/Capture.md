# Capture Workflow

**Frequency:** Daily (via AutoInfoManager daily tier)
**Duration:** ~30 seconds
**Trigger:** Automated daily maintenance or manual `/context-graph capture`

## Purpose

Extract new decision signals from all Kaya data sources since the last capture, add them to the decision graph, and update the extraction state cursor.

## Steps

1. **Run DecisionExtractor** with `--since` based on last capture timestamp
   ```bash
   bun skills/ContextGraph/Tools/DecisionExtractor.ts --since 1d
   ```

2. **Verify extraction** by checking updated graph stats
   ```bash
   bun skills/ContextGraph/Tools/GraphManager.ts --stats
   ```

3. **Report results** - Log the number of new nodes and edges extracted

## Expected Output

```
Extraction complete: N nodes, M edges
  ratings: X nodes, Y edges (Z skipped)
  work_items: X nodes, Y edges (Z skipped)
  learnings: X nodes, Y edges (Z skipped)
  context_feedback: X nodes, Y edges (Z skipped)
  isc: X nodes, Y edges (Z skipped)
```

## Error Handling

- If extraction fails, log the error but do not block other daily tasks
- Stale data (>7 days since last capture) triggers an alert
- Duplicate events are automatically skipped via content hashing

## Voice Notification

On completion: "Daily context graph capture complete with N new decisions"

## Integration

- **Feeds into:** Synthesize workflow (weekly), Analyze workflow (monthly)
- **Uses data from:** ratings.jsonl, context-feedback.jsonl, WORK directories, ALGORITHM learnings
