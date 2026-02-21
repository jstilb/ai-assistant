# CreateLayout Workflow

> **Trigger:** User requests a new layout (e.g., "show me a dashboard", "create a layout for...")
> **Owner:** ContainerBuilder
> **Priority:** P1

---

## Purpose

Build a multi-container Canvas layout from natural language intent. Classifies the intent, negotiates content types for available data, consults learned preferences, and emits positioned ContainerSpec[] to the Canvas frontend.

---

## Steps

### 1. Classify Intent
- Parse user request through `classifyIntent()` (keyword matching)
- If confidence < 0.8, escalate to `classifyIntentWithInference()` (Haiku fast tier)
- Output: `IntentClassification { category, confidence, entities }`

### 2. Select Layout Template
- `dashboard` -> `buildDefaultDashboard()`
- `briefing` -> `buildBriefingLayout(blocks)` (requires context.blocks)
- `custom` -> Analyze context data via `negotiateContainerType()` per data source
- If intent ambiguous (confidence < 0.5), ask user for clarification

### 3. Consult Preferences
- Load preferences from `LayoutIntelligence.consult(intentCategory)`
- Apply preferences with confidence >= 0.7 automatically (override default positions/sizes)
- Log preferences with confidence 0.4-0.7 as suggestions (don't override)
- Ignore preferences below 0.4

### 4. Position Containers
- Run `positionContainersGrid()` to ensure non-overlapping layout
- Clamp all positions to grid bounds
- Enforce max 12 containers

### 5. Emit Layout
- Send ContainerSpec[] via `CanvasClient.applyLayout()`
- Store proposed layout snapshot for later feedback comparison

### 6. Announce (Optional)
- Voice notification: "Built N-container [type] layout"

---

## Error Handling

| Error | Recovery |
|-------|----------|
| Inference.ts timeout | Fall back to keyword classification |
| No data sources | Inform user what data is needed |
| Layout > 12 containers | Truncate to 12 highest-priority |
| Preferences corrupt | Use defaults, log to LEARNING/FAILURES |

---

## Example

```
Input:  "show me a dashboard"
Intent: { category: "dashboard", confidence: 0.85 }
Output: ContainerSpec[] with weather, calendar, tasks, goals, stats
Voice:  "Built 5-container dashboard layout"
```
