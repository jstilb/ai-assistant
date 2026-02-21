# Synthesize Workflow

**Frequency:** Weekly (via AutoInfoManager weekly tier)
**Duration:** ~2 minutes
**Trigger:** Automated weekly maintenance or manual `/context-graph synthesize`

## Purpose

Run a full capture, then detect recurring patterns across decisions, create pattern nodes, and write synthesis insights to MemoryStore for ContinualLearning integration.

## Steps

1. **Run Capture** - Extract any decisions since last capture
   ```bash
   bun skills/ContextGraph/Tools/DecisionExtractor.ts
   ```

2. **Pattern Detection** - Analyze the graph for recurring patterns:
   - Group decisions by tags and identify clusters of 3+ decisions sharing tags
   - Detect repeated failure-correction cycles (low rating -> course correction)
   - Find decisions that frequently co-occur within sessions

3. **Create Pattern Nodes** - For each detected pattern:
   - Create a `pattern` type node with description
   - Link member decisions via `pattern_member` edges
   - Assign confidence based on cluster size

4. **Write to MemoryStore** - Persist pattern insights for ContinualLearning:
   ```typescript
   import { memoryStore } from "../../CORE/Tools/MemoryStore";
   await memoryStore.capture({
     type: 'decision',
     title: 'Pattern: [pattern description]',
     content: '[full pattern analysis]',
     tags: ['pattern', 'weekly-synthesis', ...patternTags],
     tier: 'warm',
   });
   ```

5. **Generate overview visualization**
   ```bash
   bun skills/ContextGraph/Tools/TraceVisualizer.ts --overview --period week
   ```

## Expected Output

- New pattern nodes added to graph
- MemoryStore entries created with `type: 'decision'`
- Weekly overview Mermaid diagram generated

## Voice Notification

On completion: "Weekly decision synthesis found N patterns across M decisions"

## Integration

- **Requires:** Capture workflow (runs as step 1)
- **Feeds into:** ContinualLearning (via MemoryStore `type: 'decision'`)
- **Feeds into:** Analyze workflow (monthly)
