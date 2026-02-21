# Analyze Workflow

**Frequency:** Monthly (via AutoInfoManager monthly tier)
**Duration:** ~5 minutes
**Trigger:** Automated monthly maintenance or manual `/context-graph analyze`

## Purpose

Run weekly synthesis, create a full graph snapshot, perform deep analysis, map decisions to TELOS goals, and identify decision contradictions or drift.

## Steps

1. **Run Synthesize** - Capture + pattern detection
   ```bash
   # Runs internally via Synthesize workflow
   ```

2. **Create Monthly Snapshot**
   ```bash
   bun skills/ContextGraph/Tools/GraphManager.ts --snapshot 2026-02
   ```

3. **Deep Analysis** - Analyze graph structure:
   - Calculate graph density and connectivity metrics
   - Identify decision clusters with weak or missing connections
   - Find orphan decisions (no edges)
   - Detect contradiction patterns (opposing decisions in close proximity)

4. **TELOS Goal Mapping** - For each active TELOS goal:
   ```bash
   bun skills/ContextGraph/Tools/GraphManager.ts --by-goal G25
   bun skills/ContextGraph/Tools/GraphManager.ts --by-goal G28
   ```
   - Count decisions aligned with each goal
   - Identify goals with declining decision alignment
   - Flag goals with no recent decisions

5. **Generate Monthly Report** - Create comprehensive visualization:
   ```bash
   bun skills/ContextGraph/Tools/TraceVisualizer.ts --overview --period month
   bun skills/ContextGraph/Tools/TraceVisualizer.ts --timeline --since 30d
   ```

6. **Write Analysis to MemoryStore**
   ```typescript
   await memoryStore.capture({
     type: 'decision',
     title: 'Monthly Decision Analysis: [month]',
     content: '[comprehensive analysis]',
     tags: ['monthly-analysis', 'decision-graph', 'telos-mapping'],
     tier: 'warm',
   });
   ```

## Expected Output

- Monthly snapshot saved to `MEMORY/ContextGraph/snapshots/YYYY-MM.json`
- Graph metrics and TELOS mapping report
- Monthly overview and timeline Mermaid diagrams
- MemoryStore entry with analysis

## Voice Notification

On completion: "Monthly decision analysis complete, N goals mapped, M contradictions found"

## Integration

- **Requires:** Synthesize workflow (runs as step 1)
- **Feeds into:** ContinualLearning (via MemoryStore)
- **Feeds into:** TELOS goal tracking
- **Snapshots enable:** Point-in-time graph comparison across months
