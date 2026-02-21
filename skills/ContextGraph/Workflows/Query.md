# Query Workflow

**Frequency:** On-demand
**Duration:** ~5 seconds
**Trigger:** User asks about decisions, traces, patterns, or decision history

## Purpose

Parse a user's natural language question about decisions, route to the appropriate GraphManager query, and generate a Mermaid visualization of the results.

## Routing Rules

| User Intent | Tool | Command |
|-------------|------|---------|
| "What caused X?" | GraphManager | `--trace <nodeId>` |
| "Show decision history" | TraceVisualizer | `--timeline --since 30d` |
| "What decisions relate to [goal]?" | GraphManager | `--by-goal <goalId>` |
| "Search for decisions about X" | GraphManager | `--search "X"` |
| "Show the decision graph" | TraceVisualizer | `--overview --period month` |
| "What went wrong with X?" | GraphManager | `--search "X"` then `--trace` |
| "Show patterns" | TraceVisualizer | `--overview --period all` |
| "Graph stats" | GraphManager | `--stats` |

## Steps

1. **Parse user question** - Identify intent and key terms
2. **Route to appropriate tool**:
   - Search queries -> `GraphManager.search(query)`
   - Trace requests -> `GraphManager.traceDecisionChain(nodeId)`
   - Goal queries -> `GraphManager.decisionsByGoal(goalId)`
   - Overview requests -> `TraceVisualizer.generateOverview()`
   - Timeline requests -> `TraceVisualizer.generateTimeline()`

3. **Generate visualization** if results found:
   ```bash
   bun skills/ContextGraph/Tools/TraceVisualizer.ts --trace <nodeId>
   ```

4. **Present results** with:
   - Summary of findings
   - Mermaid diagram (rendered in supported viewers)
   - Key statistics

## Example Queries

```
User: "What caused the rating drop on Feb 5?"
-> Search for rating drops around Feb 5
-> Find the matching outcome node
-> Trace backward to find causal decisions
-> Generate Mermaid trace diagram

User: "Show decisions related to AI proficiency"
-> Map to TELOS goal G28
-> Query decisionsByGoal("G28")
-> Generate goal-aligned visualization

User: "What patterns have emerged this month?"
-> Generate monthly overview
-> Highlight pattern nodes and their members
```

## Voice Notification

On completion: "Found N decisions matching your query"

## Integration

- **Uses:** GraphManager for queries, TraceVisualizer for visualization
- **Context:** Leverages existing graph state (no new extraction needed)
