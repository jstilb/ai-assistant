# SynthesizePatterns Workflow

Aggregate signals from multiple sources into actionable patterns.

## Purpose

Transform raw data (ratings, sessions, voice events) into synthesized knowledge:
- Detect recurring frustration and success patterns
- Track pattern trends over time
- Generate recommendations based on patterns
- Store synthesis for future reference

## Trigger Patterns

- "Find patterns", "What patterns have you noticed"
- "Analyze my sessions", "Show me trends"
- "What have I learned", "Learning summary"
- Daily maintenance (automated)
- Weekly maintenance (automated, full analysis)

## Execution Steps

### 1. Determine Scope

```
If "daily" or light synthesis:
  → period = "week"
  → sources = ["ratings"]

If "weekly" or full synthesis:
  → period = "week"
  → sources = ["ratings", "voice", "sessions", "memory"]

If "monthly" or deep analysis:
  → period = "month"
  → sources = ["ratings", "voice", "sessions", "memory"]
```

### 2. Run KnowledgeSynthesizer

```bash
# Full weekly synthesis
bun ~/.claude/skills/ContinualLearning/Tools/KnowledgeSynthesizer.ts --week

# Light daily synthesis
bun ~/.claude/skills/ContinualLearning/Tools/KnowledgeSynthesizer.ts --week --source ratings

# Deep monthly synthesis
bun ~/.claude/skills/ContinualLearning/Tools/KnowledgeSynthesizer.ts --month
```

### 3. Process Results

```typescript
import { synthesize } from "./Tools/KnowledgeSynthesizer";

const result = await synthesize({
  period: "week",
  sources: ["ratings", "voice", "sessions", "memory"],
});

// Result contains:
// - patterns: Pattern[] (frustration, success, behavior, preference)
// - insights: string[]
// - recommendations: string[]
// - ratingsSummary, voiceSummary, sessionsSummary
```

### 4. Present Findings

Format for user:

```markdown
## Pattern Synthesis - {{period}}

**Data Points:** {{totalDataPoints}}
**Sources:** {{sources}}

### Key Insights
{{insights}}

### Top Patterns

**Frustrations:**
{{frustration_patterns}}

**Successes:**
{{success_patterns}}

### Recommendations
{{recommendations}}
```

### 5. Store Results

Synthesis is automatically stored to:
- `MEMORY/LEARNING/SYNTHESIS/YYYY-MM/YYYY-MM-DD-period-synthesis.md`
- MemoryStore as an `insight` entry with tag `synthesis`

### 6. Update State

The tool updates `State/last-synthesis.json` with:
- Timestamp of last run
- Pattern history for trend detection

## Output Examples

### Pattern Report

```
📊 Synthesis Complete
   Data points: 156
   Patterns found: 8
   Insights: 4

💡 Key Insights:
   - Strong performance: 7.2/10 average rating across 23 sessions
   - Top recurring issue: "Time/Performance Issues" detected 5 times
   - Strength identified: "Quick Resolution" consistently succeeds

📌 Recommendations:
   - Set clearer time expectations and provide progress updates
   - Continue current patterns - no major issues detected
```

## Integration

### With AutoMaintenance

```yaml
# Daily (light)
- run: bun Tools/KnowledgeSynthesizer.ts --week --source ratings

# Weekly (full)
- run: bun Tools/KnowledgeSynthesizer.ts --week
```

### With InsightGenerator

Synthesis results feed into daily/weekly briefings:

```typescript
const synthesis = await synthesize({ period: "week", sources: ["ratings", "sessions"] });
const briefing = await generateDailyBriefing(); // Uses synthesis internally
```

## Related

- **KnowledgeSynthesizer:** `Tools/KnowledgeSynthesizer.ts`
- **AnalyzePatterns:** (deprecated, use this workflow)
- **ConsolidateLearnings:** Merged into synthesis process
