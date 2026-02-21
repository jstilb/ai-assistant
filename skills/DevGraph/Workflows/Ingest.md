# Workflow: Ingest

Auto-ingest from all available data sources into the DevGraph.

## Trigger
- Manual: `devgraph ingest`, `ingest graph`, `update devgraph`
- Automated: Part of maintenance workflows

## Steps

1. **Run full ingestion**
   ```bash
   bun skills/DevGraph/Tools/GraphQuerier.ts ingest --all
   ```

2. **Review results**
   - Check node and edge counts
   - Verify no critical errors
   - Note new patterns detected

3. **Update meta**
   - Meta.json auto-updated after ingestion
   - Stats reflect current graph state

## Source Priority
1. Git commits (most reliable, structured data)
2. Session logs (rich but noisy)
3. Agent traces (if available)
4. Relation inference (always run last)

## Incremental Mode
The ingester deduplicates by node/edge ID. Running multiple times is safe and will only add new data.

## Voice Notification
```
DevGraph ingestion complete with N new nodes and M new edges
```
