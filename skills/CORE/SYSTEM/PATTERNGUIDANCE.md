# Deterministic vs Intelligent Pattern Selection

**Guide for choosing between CLI-first (deterministic) and AI inference (intelligent) approaches.**

---

## The Decision Framework

| Pattern | Characteristics | Examples |
|---------|-----------------|----------|
| **Deterministic** | Same input → same output, testable, scriptable | File ops, API CRUD, state management |
| **Intelligent** | Requires semantic understanding, classification | Content analysis, summarization |
| **Hybrid** | Structured extraction + intelligent analysis | Extract → Analyze → Store |

---

## Use Deterministic (CLI-First) When

1. **Same input should always produce same output**
   - File operations, API calls, state updates
   - Scheduled tasks, maintenance scripts

2. **Operation needs to be testable independently**
   - Can write unit tests without mocking AI
   - Reproducible results for debugging

3. **User might want to script/automate**
   - Pipeline composition (`tool1 | tool2`)
   - Cron jobs, launchd tasks

4. **Debugging matters**
   - Need to see exact command executed
   - Logs should show deterministic steps

5. **Performance is critical**
   - No inference latency
   - Predictable execution time

### Examples

```bash
# File operations - always deterministic
bun StateManager.ts set --path state.json --data '{"count": 5}'

# API CRUD - always deterministic
bun TaskManager.ts add "Task name"  # LucidTasks

# Notifications - always deterministic
bun NotificationService.ts send "Task complete"

# Cache operations - always deterministic
bun CachedHTTPClient.ts fetch "https://api.example.com"
```

---

## Use Intelligent (Inference) When

1. **Output depends on semantic understanding**
   - Interpreting user intent
   - Understanding context

2. **Classification or categorization needed**
   - Sentiment analysis
   - Topic detection
   - Priority assignment

3. **Natural language generation required**
   - Summaries, reports
   - Explanations, recommendations

4. **Pattern recognition across content**
   - Finding similar items
   - Anomaly detection

### Examples

```bash
# Classification - needs inference
echo "Is this email spam or important?" | bun Inference.ts fast

# Summarization - needs inference
echo "Summarize: $CONTENT" | bun Inference.ts standard

# Complex reasoning - needs inference
echo "Analyze trade-offs of microservices vs monolith" | bun Inference.ts smart
```

---

## Use Hybrid When

Best of both worlds: structured extraction + intelligent analysis.

### Pattern

```
CLI Tool (deterministic) → Extract data
     ↓
Inference.ts (intelligent) → Analyze/classify
     ↓
CLI Tool (deterministic) → Store/act on results
```

### Example: Content Processing Pipeline

```typescript
// Step 1: Deterministic extraction
const data = await cachedFetch('https://api.example.com/article');

// Step 2: Intelligent classification
const classification = await runInference('fast', `
  Classify this article into: tech, business, science, other.
  Article: ${data.content}
`);

// Step 3: Deterministic storage
await memoryStore.capture({
  type: 'artifact',
  category: classification.result,
  content: data.content,
});
```

### Example: Research Workflow

```typescript
// Step 1: Deterministic API calls (cached)
const sources = await Promise.all([
  cachedFetch('https://api1.com/data'),
  cachedFetch('https://api2.com/data'),
]);

// Step 2: Intelligent synthesis
const synthesis = await runInference('standard', `
  Synthesize findings from these sources:
  ${sources.map(s => s.content).join('\n---\n')}
`);

// Step 3: Deterministic output
await Bun.write(outputPath, synthesis.result);
notifySync("Research complete");
```

---

## Inference Level Selection

| Level | Model | Use Case | Latency | Cost |
|-------|-------|----------|---------|------|
| `fast` | Haiku | Classification, extraction, simple analysis | ~10-15s | Low |
| `standard` | Sonnet | General analysis, summarization, moderate reasoning | ~15-30s | Medium |
| `smart` | Opus | Complex reasoning, nuanced decisions, creative work | ~60-90s | High |

### Selection Rules

1. **Default to `fast`** - Most tasks don't need Opus
2. **Use `standard` when:**
   - Fast gives shallow results
   - Need balanced quality/speed
   - Multi-step reasoning required
3. **Use `smart` when:**
   - Complex trade-off analysis
   - Nuanced judgment calls
   - Creative or strategic work

### Anti-Pattern: Always Using Smart

```typescript
// WRONG: Wasting resources on simple classification
const category = await runInference('smart', 'Is this email spam?');

// RIGHT: Fast is sufficient for binary classification
const category = await runInference('fast', 'Is this email spam?');
```

---

## Tool-Specific Guidance

### StateManager - Always Deterministic

```typescript
// State operations are always deterministic
await manager.get();           // Same state file → same result
await manager.set(newState);   // Same input → same file written
await manager.transaction(fn); // Atomic, predictable
```

### NotificationService - Always Deterministic

```typescript
// Notifications don't require inference
notifySync("Message");  // Just sends, no AI
```

### MemoryStore - Hybrid

```typescript
// Capture is deterministic
await memoryStore.capture({ type: 'learning', content: '...' });

// Search may use inference for semantic matching
const similar = await memoryStore.findSimilar(content, 0.85);
```

### AgentOrchestrator - Intelligent

```typescript
// Agents are inherently intelligent
const results = await orchestrator.spawn([...], 'Research topic');

// But aggregation strategy affects determinism:
// - 'first', 'merge' → more deterministic
// - 'synthesis', 'best' → more intelligent
```

---

## Decision Checklist

Before implementing, ask:

| Question | If Yes → | If No → |
|----------|----------|---------|
| Does output depend on content meaning? | Intelligent | Deterministic |
| Could a regex/parser handle this? | Deterministic | Intelligent |
| Need same output for same input? | Deterministic | Intelligent |
| Will this run in automation/cron? | Deterministic | Either |
| Is latency critical? | Deterministic | Either |
| Need to explain reasoning? | Intelligent | Either |

---

## Common Patterns in Kaya Skills

| Skill | Pattern | Rationale |
|-------|---------|-----------|
| **QueueRouter** | Deterministic | Queue operations must be predictable |
| **Browser** | Deterministic | DOM operations are exact |
| **Research** | Intelligent | Synthesis requires understanding |
| **ContinualLearning** | Hybrid | Extract signals → Synthesize patterns |
| **Fabric** | Intelligent | Pattern application needs context |
| **Evals** | Hybrid | Run tests (det) → Grade results (int) |

---

**Remember:** Start deterministic. Add intelligence only where semantic understanding is required.
