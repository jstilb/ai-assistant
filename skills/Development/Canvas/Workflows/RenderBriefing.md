# RenderBriefing Workflow

> **Trigger:** Daily briefing generation or explicit "show my briefing" request
> **Owner:** ContainerBuilder
> **Priority:** P2

---

## Purpose

Convert BriefingGenerator block output into a multi-container Canvas layout where each briefing section (weather, calendar, tasks, goals, habits) gets its own container.

---

## Steps

### 1. Collect Briefing Blocks
- Receive block results from BriefingGenerator
- Each block has: `{ name, title, content, error? }`
- Expected blocks: weather, calendar, tasks, goals, habits
- Additional blocks may be present

### 2. Map Blocks to Container Types
- Use `inferBriefingBlockType()` mapping:
  - `weather` -> "weather" container
  - `calendar` -> "calendar" container
  - `tasks` / `lucidTasks` -> "table" container
  - `goals` -> "markdown" container
  - `habits` -> "list" container
  - Unknown -> "markdown" container (safe fallback)

### 3. Handle Failed Blocks
- If a block has `error` or `content === null`:
  - Still create a container for it (preserve layout)
  - Set content to error message markdown
  - Type falls back to "markdown" for error display

### 4. Build Layout
- Call `buildBriefingLayout(blocks)` to generate ContainerSpec[]
- Grid positioning ensures non-overlapping arrangement
- Each container gets `dataSource: { type: "briefing-block", ref: blockName }`

### 5. Apply Preferences
- Consult `LayoutIntelligence.consult("briefing")`
- Apply high-confidence preferences for container positions/sizes

### 6. Emit Layout
- Send via `CanvasClient.applyLayout(specs)`
- Voice: "Briefing ready with N sections"

---

## Error Handling

| Error | Recovery |
|-------|----------|
| Single block failure | Render other blocks, show error container |
| All blocks fail | Show single error markdown container |
| BriefingGenerator unavailable | Show placeholder containers with "Loading..." |
| Canvas frontend disconnected | Queue layout.apply for retry |

---

## Example

```
Input:  5 briefing blocks (weather, calendar, tasks, goals, habits)
Output: 5-container grid layout, each with its own container type
Voice:  "Briefing ready with 5 sections"
```
