# Graph Capture Workflow

**Frequency:** Daily (automated)

## Purpose

Extract new decision nodes from all Kaya data sources since last capture.

## Steps

1. Load last-capture.json cursors
2. Extract from each source:
   - ratings.jsonl - outcome and decision nodes
   - MEMORY/WORK/ directories - decision and context nodes
   - MEMORY/LEARNING/ALGORITHM/ - learning and decision nodes
   - context-feedback.jsonl - context nodes
   - current-isc.json - decision nodes with TELOS goal links
3. Create edges based on EdgeRules.yaml
4. Deduplicate via content hash
5. Update cursors in last-capture.json

## Command

```bash
bun skills/Intelligence/Graph/Tools/Ingesters/DecisionIngester.ts --since 24h
```

## Output

- Decision nodes added
- Outcome nodes added
- Context nodes added
- Goal-aligned edges created
- Updated extraction state
