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
# List all goals grouped by mission
bun ~/.claude/skills/Productivity/ContinualLearning/Tools/GoalConnector.ts --list-goals

# List all missions
bun ~/.claude/skills/Productivity/ContinualLearning/Tools/GoalConnector.ts --list-missions
```

### 2. Score Connections (LLM Judgment)

Use this prompt to score relevance. You are the LLM — reason over the goal list
and return scored connections. The script handles goal metadata enrichment.

**Prompt:**
```
Given this text: "<input text>"

And these TELOS goals:
<paste output of: bun GoalConnector.ts --list-goals>

Return the 1-5 most relevant goal IDs with relevance scores.
Rules:
- Score 0.0–1.0 (1.0 = exact match, 0.0 = irrelevant)
- Only include goals with score >= 0.4
- Return empty array [] if nothing is relevant
- "reason" = one sentence explaining the connection

Return JSON only:
[{"goalId": "G28", "relevanceScore": 0.85, "reason": "Text focuses on AI tooling which maps directly to G28"}]
```

### 3. Enrich with Goal Metadata

Pass the LLM JSON result to the script for deterministic enrichment:

```bash
bun ~/.claude/skills/Productivity/ContinualLearning/Tools/GoalConnector.ts \
  --llm-result '[{"goalId":"G28","relevanceScore":0.85,"reason":"AI focus"}]'
```

Output: full `GoalConnection[]` with goalTitle, missionId, missionName populated.

### 4. Present Connections

Format for user:

```markdown
## Goal Connections for: "<input>"

**G28: Become Proficient in AI Tool Usage** (85%)
- Mission: M5 - Professional
- Why: Text focuses on AI tooling which maps directly to G28

**G25: Launch beta application** (60%)
- Mission: M5 - Professional
- Why: Startup/product focus aligns with app launch goal
```

## Quick Lookup (No LLM)

For fast keyword-only lookup without LLM scoring:

```bash
# Keyword fallback — instant, no inference call
bun ~/.claude/skills/Productivity/ContinualLearning/Tools/GoalConnector.ts \
  --connect "AI productivity improvements"
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

## Programmatic Usage

`connectToGoals()` (library function) handles LLM + keyword fallback internally
and is the correct path for programmatic callers:

```typescript
import { connectToGoals, loadTelosContext } from "./Tools/GoalConnector";

const ctx = await loadTelosContext();
const connections = await connectToGoals("learning TypeScript patterns", ctx);
// Returns GoalConnection[] sorted by relevance
```

## Related

- **GoalConnector:** `Tools/GoalConnector.ts`
- **TELOS:** `USER/TELOS/`
- **enrichLlmConnections():** exported from GoalConnector.ts for scripted enrichment
