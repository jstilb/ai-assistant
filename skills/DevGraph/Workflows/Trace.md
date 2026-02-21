# Workflow: Trace

Trace an issue or error backward to find its root cause.

## Trigger
- `trace error`, `what caused`, `root cause`, `trace back`
- `devgraph trace --from <errorId>`

## Steps

1. **Identify the target node**
   - Get the error/issue ID
   - If not known, list recent errors:
     ```bash
     bun skills/DevGraph/Tools/GraphQuerier.ts list --type error --since 7d
     ```

2. **Run backward trace**
   ```bash
   bun skills/DevGraph/Tools/GraphQuerier.ts trace --from <errorId> --depth 5
   ```

3. **Analyze the chain**
   - What session produced this error?
   - What files were being modified?
   - Were there related commits before/after?
   - Is this part of a recurring pattern?

4. **Check for fixes**
   - Look for `fixed_by` edges
   - Check if any subsequent commits touched the same files

5. **Report findings**
   - Root cause identification
   - Chain of events
   - Related nodes and patterns
   - Recommended actions

## Example
```bash
# Find the error
bun skills/DevGraph/Tools/GraphQuerier.ts list --type error --since 1d

# Trace it
bun skills/DevGraph/Tools/GraphQuerier.ts trace --from error:session-001:abc123 --depth 3

# Check what else the session touched
bun skills/DevGraph/Tools/GraphQuerier.ts neighbors --node session:session-001 --depth 2
```

## Voice Notification
```
Root cause trace complete, found N related nodes in the chain
```
