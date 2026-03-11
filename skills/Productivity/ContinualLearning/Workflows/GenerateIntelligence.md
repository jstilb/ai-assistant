# GenerateIntelligence Workflow

Generate actionable intelligence briefings from synthesized knowledge.

## Purpose

Produce intelligence outputs:
- Daily briefings with quick stats and focus
- Weekly intelligence reports with pattern analysis
- Goal-focused insights
- Topic-centered intelligence

## Trigger Patterns

- "What should I know", "Morning briefing"
- "Weekly intelligence", "Weekly report"
- "What's important", "Status update"
- Morning routine (automated)
- End of week (automated)

## Execution Steps

### 1. Daily Briefing

```bash
# Generate daily intelligence
bun ~/.claude/skills/Productivity/ContinualLearning/Tools/InsightGenerator.ts --daily

# Save to file
bun ~/.claude/skills/Productivity/ContinualLearning/Tools/InsightGenerator.ts --daily --save
```

Output includes:
- Greeting based on time of day
- Quick stats (sessions, ratings, patterns)
- Highlights from synthesis
- Action items
- Goal progress
- Focus recommendation

### 2. Weekly Intelligence

```bash
# Generate weekly report
bun ~/.claude/skills/Productivity/ContinualLearning/Tools/InsightGenerator.ts --weekly

# Save to file
bun ~/.claude/skills/Productivity/ContinualLearning/Tools/InsightGenerator.ts --weekly --save
```

Output includes:
- Week summary
- Pattern analysis (emerging, declining, stable)
- Goal connections with insight counts
- Recommendations
- Next week focus

### 3. Goal-Focused Insights

```bash
# Get insights for specific goal
bun ~/.claude/skills/Productivity/ContinualLearning/Tools/InsightGenerator.ts --goal G28

# Output:
# 🎯 Insights for G28: Become Proficient in AI Tool Usage
#
# Related Learnings: 12
# Patterns: 3
#
# Recommendations:
#   - Good coverage on G28 - consider synthesis
#   - 3 patterns identified - review for optimization
```

### 4. Topic Intelligence

```bash
# Get insights for a topic
bun ~/.claude/skills/Productivity/ContinualLearning/Tools/InsightGenerator.ts --topic "productivity"

# Output:
# 🔍 Insights for: "productivity"
#
# Relevant Goals: G0, G2, G28
# Related Learnings: 8
# Patterns: 2
```

## Daily Briefing Format

```markdown
# Daily Briefing - 2026-02-01

Good morning, Jm!

## Quick Stats

| Metric | Value |
|--------|-------|
| Sessions Yesterday | 5 |
| Avg Rating | 7.2/10 |
| Top Pattern | Quick Resolution |
| Active WIGs | 3 |

## Highlights

- Strong performance: 7.2/10 average rating
- Strength identified: "Good Understanding" consistently succeeds

## Action Items

- [ ] Address recurring issue: Time/Performance Issues
- [ ] Set clearer time expectations

## Focus Recommendation

**Focus on WIG: Decrease Low-Value Media Consumption**

## Goal Progress

- **G0**: Decrease Low-Value Media Consumption - 2 related learning(s)
- **G1**: Make 2 Good Friends - No recent activity
- **G2**: Raise Alignment Goal Score - 1 related learning(s)
```

## Weekly Intelligence Format

```markdown
# Weekly Intelligence Report - 2026-01-25

## Summary

Week of 2026-01-25: 156 data points analyzed across ratings, voice, sessions, memory

## Pattern Analysis

### Emerging Patterns
- ↑ Quick Resolution
- ↑ Good Understanding

### Declining Patterns
- ↓ Time/Performance Issues

### Stable Patterns
- → Clean Implementation

## Goal Connections

- **G28**: Become Proficient in AI Tool Usage (5 insights)
- **G0**: Decrease Low-Value Media Consumption (3 insights)

## Recommendations

1. Capitalize on emerging pattern: Quick Resolution
2. Continue momentum on Become Proficient in AI Tool Usage

## Next Week Focus

- Continue momentum on G28
- Reinforce: Quick Resolution
```

## Voice Integration

For spoken briefings:

```typescript
import { notifySync } from "../../CORE/Tools/NotificationService";
import { generateDailyBriefing } from "./Tools/InsightGenerator";

const briefing = await generateDailyBriefing();
notifySync(`${briefing.greeting}. ${briefing.focusRecommendation}`);
```

## Automation

### Morning Briefing (via launchd)

```bash
# Run at 7 AM
bun ~/.claude/skills/Productivity/ContinualLearning/Tools/InsightGenerator.ts --daily --save
```

### Weekly Report (via AutoMaintenance)

```bash
# Run Sunday evening
bun ~/.claude/skills/Productivity/ContinualLearning/Tools/InsightGenerator.ts --weekly --save
```

## Output Location

Briefings saved to:
- `MEMORY/LEARNING/INSIGHTS/YYYY-MM-DD-daily.md`
- `MEMORY/LEARNING/INSIGHTS/YYYY-MM-DD-weekly.md`

## Integration

### With InformationManager

```typescript
const briefing = await generateDailyBriefing();
// Include in morning context package
```

### With ProactiveEngine

```typescript
// Schedule morning briefing
await scheduleTask({
  name: "morning-briefing",
  cron: "0 7 * * *",
  command: "bun Tools/InsightGenerator.ts --daily --save",
});
```

## Related

- **InsightGenerator:** `Tools/InsightGenerator.ts`
- **SynthesizePatterns:** `Workflows/SynthesizePatterns.md`
- **ProactiveEngine:** `skills/Automation/ProactiveEngine/SKILL.md`
