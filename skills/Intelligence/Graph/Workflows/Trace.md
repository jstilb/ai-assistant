# Graph Trace Workflow

**Frequency:** On-demand

## Purpose

Trace backward from an error/issue to find root cause, or forward from a session to see what it produced.

## Backward Trace (Root Cause Analysis)

```bash
bun skills/Intelligence/Graph/Tools/GraphQuerier.ts trace --from error:001 --depth 5
```

Shows:
- What session contained the error
- What commit may have caused it
- Related files modified
- Previous errors in the same area

## Forward Trace (Impact Analysis)

```bash
bun skills/Intelligence/Graph/Tools/GraphQuerier.ts trace --from session:20260213 --depth 3
```

Shows:
- Commits produced by the session
- Files modified
- Errors encountered
- Skills changed
- Learnings captured
