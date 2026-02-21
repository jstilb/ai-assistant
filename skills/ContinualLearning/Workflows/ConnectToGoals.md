# ConnectToGoals Workflow

Link insights and learnings to TELOS goals for goal-aware intelligence.

## Purpose

Connect knowledge to life goals:
- Map learnings to relevant goals (G0-G36)
- Identify which missions (M0-M6) are being served
- Track goal-related activity over time
- Surface goal-connected insights during work

## Trigger Patterns

- "Connect to goals", "How does this relate to my goals"
- "Goal progress", "Which goals are active"
- "What insights connect to G28", "G28 status"
- TELOS file changes (proactive)
- During synthesis (automated)

## Execution Steps

### 1. Load TELOS Context

```bash
# List all goals
bun ~/.claude/skills/ContinualLearning/Tools/GoalConnector.ts --list-goals

# List all missions
bun ~/.claude/skills/ContinualLearning/Tools/GoalConnector.ts --list-missions
```

### 2. Connect Content to Goals

```bash
# Find goals related to text
bun ~/.claude/skills/ContinualLearning/Tools/GoalConnector.ts --connect "AI productivity improvements"

# Output:
# 🔗 Goal Connections for: "AI productivity improvements"
#
#   G28 (90%): Become Proficient in AI Tool Usage
#     Mission: M5 - Professional
#     Keywords: ai, productivity
```

### 3. Get Goal-Focused Insights

```bash
# Get insights for a specific goal
bun ~/.claude/skills/ContinualLearning/Tools/InsightGenerator.ts --goal G28

# Output includes:
# - Related learnings count
# - Pattern count
# - Recommendations for this goal
```

### 4. Present Connections

Format for user:

```markdown
## Goal Connections

### Primary Goal
**{{goalId}}: {{goalTitle}}**
- Mission: {{missionId}} - {{missionName}}
- Relevance: {{score}}%
- Keywords: {{matchedKeywords}}

### Related Activity
- {{n}} learnings connected to this goal
- {{m}} patterns identified

### Recommendations
{{goal-specific recommendations}}
```

## Goal ID Reference

### WIGs (Wildly Important Goals)

| ID | Title | Mission |
|----|-------|---------|
| G0 | Decrease Low-Value Media Consumption | M6 (Self) |
| G1 | Make 2 Good Friends | M4 (Friend) |
| G2 | Raise Alignment Goal Score | M6 (Self) |

### Mission Categories

| ID | Name | Theme |
|----|------|-------|
| M0 | Adventurer | Travel & Exploration |
| M1 | Community Member | Local & Global Engagement |
| M2 | Creative | Writing & Music |
| M3 | Family Man | Partner & Family |
| M4 | Friend | Friendships |
| M5 | Professional | Career & AI |
| M6 | Self | Health & Growth |

## Integration Examples

### During Learning Capture

```typescript
import { connectToGoals } from "./Tools/GoalConnector";
import { memoryStore } from "../../CORE/Tools/MemoryStore";

// When capturing a learning, find goal connections
const learning = "Learned that setting clearer prompts improves AI output quality";
const connections = connectToGoals(learning);

if (connections.length > 0) {
  await memoryStore.capture({
    type: "learning",
    title: "AI prompting improvement",
    content: learning,
    tags: ["ai", connections[0].goalId], // Tag with goal
    metadata: {
      goalConnections: connections.map(c => c.goalId),
    },
  });
}
```

### During Synthesis

```typescript
import { synthesize } from "./Tools/KnowledgeSynthesizer";
import { connectToGoals } from "./Tools/GoalConnector";

const result = await synthesize({ period: "week", sources: ["sessions"] });

// Connect patterns to goals
for (const pattern of result.patterns) {
  const connections = connectToGoals(pattern.name + " " + pattern.examples.join(" "));
  // Store goal-connected patterns
}
```

## Proactive Triggers

### TELOS File Changes

When TELOS files are modified (detected by ChangeDetector):

1. Re-parse goals and missions
2. Re-connect recent learnings to updated goals
3. Notify if significant connections changed

### During Daily Briefing

```typescript
const briefing = await generateDailyBriefing();
// Includes goal progress section with activity metrics
```

## Related

- **GoalConnector:** `Tools/GoalConnector.ts`
- **TELOS:** `skills/CORE/USER/TELOS/`
- **InsightGenerator:** `Tools/InsightGenerator.ts --goal`
