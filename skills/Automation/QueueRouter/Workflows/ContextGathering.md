# ContextGathering Workflow

**Trigger:** `/queue context` or when Kaya needs to walk through `awaiting-context` spec-pipeline items

## Purpose

Walk through all spec-pipeline items in `awaiting-context` status. For each item, collect:
1. **Problem context** — What is the problem? Why does it matter?
2. **Research guidance** — What should be researched? What questions need answering?
3. **Scope hints** — Any known constraints, preferences, or out-of-scope areas.

Then transition each item to `researching` status.

## Trigger

```
User: /queue context
User: "gather context for spec pipeline"
User: "review awaiting-context items"
```

## Workflow Steps

### Step 1: Load Items

```typescript
const qm = new QueueManager();
const awaitingItems = await qm.listSpecPipeline("awaiting-context");

if (awaitingItems.length === 0) {
  notifySync("No items awaiting context in spec pipeline");
  return;
}
notifySync(`${awaitingItems.length} items need context in spec pipeline`);
```

### Step 2: Interactive Loop

For each item, use AskUserQuestion to collect context:

```typescript
for (const item of awaitingItems) {
  // Question 1: Problem context
  const notesAnswer = await AskUserQuestion({
    question: `[${item.id}] "${item.payload.title}"\n\nWhat is the problem this should solve? What context should the spec capture?`,
    options: ["Skip this item"]
  });

  if (notesAnswer === "Skip this item") continue;

  // Question 2: Research guidance
  const researchAnswer = await AskUserQuestion({
    question: `Research guidance for "${item.payload.title}":\n\nWhat should be researched? What questions need answering before writing the spec?`,
    options: ["Skip research (use description only)"]
  });

  const researchGuidance = researchAnswer === "Skip research (use description only)"
    ? item.payload.description
    : researchAnswer;

  // Question 3: Scope hints (optional)
  const scopeAnswer = await AskUserQuestion({
    question: `Scope hints for "${item.payload.title}" (optional):\n\nAny constraints, preferences, or out-of-scope areas?`,
    options: ["No scope hints"]
  });

  const scopeHints = scopeAnswer === "No scope hints" ? undefined : scopeAnswer;

  // Attach context and transition to researching
  await qm.attachContext(item.id, notesAnswer, researchGuidance, scopeHints);
  notifySync(`Context attached for: ${item.payload.title}`);
}
```

### Step 3: Summary

After processing all items:

```typescript
notifySync(`Context gathering complete. ${processedCount} items now researching.`);
```

## CLI Alternative

Instead of the interactive workflow, use the CLI:

```bash
bun QueueManager.ts context <id> \
  --notes "JWT auth system needs to be replaced with OAuth2" \
  --research "Compare OAuth2 providers, check OWASP guidelines, research migration strategies" \
  --scope "Must maintain backward compatibility with existing sessions"
```

## Output

- Each processed item transitions from `awaiting-context` to `researching`
- `payload.context.notes` contains the problem context
- `payload.context.researchGuidance` contains the research questions
- `payload.context.scopeHints` contains optional scope constraints (if provided)
- `payload.context.contextAttachedAt` contains the timestamp

## Integration with SpecPipelineRunner

After context is attached, items in `researching` status are picked up by
`SpecPipelineRunner.ts` which:
1. Spawns parallel research agents based on `researchGuidance`
2. Collects findings to `MEMORY/WORK/{session}/research-{item-id}.md`
3. Transitions item to `generating-spec`
4. Invokes SpecSheet with complexity-adaptive routing
5. Transfers completed spec to `approvals` queue
