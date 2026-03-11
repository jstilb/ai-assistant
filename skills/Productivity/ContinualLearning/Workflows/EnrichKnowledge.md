# EnrichKnowledge Workflow

Enrich knowledge with external sources (Obsidian vault, Fabric patterns).

## Purpose

Add depth to knowledge by:
- Querying Obsidian vault for related notes
- Applying Fabric patterns for analysis
- Finding connections between Kaya learnings and personal knowledge
- Building enriched context packages

## Trigger Patterns

- "Enrich with context", "Add research"
- "What does Obsidian say about...", "Check my notes"
- "Apply Fabric pattern", "Use extract_wisdom"
- "Build context for...", "Deep context"

## Execution Steps

### 1. Search Obsidian

```bash
# Search vault for related content
bun ~/.claude/skills/Productivity/ContinualLearning/Tools/ExternalEnricher.ts --search "productivity"

# Output:
# 🔍 Obsidian Search: "productivity"
#
# Found 5 notes:
#
# 📝 Getting Things Done
#    Path: .../Books/GTD.md
#    Tags: #productivity, #systems
#    Links: [[PKM]], [[Habits]]
```

### 2. Enrich Topic

```bash
# Get full enrichment for a topic
bun ~/.claude/skills/Productivity/ContinualLearning/Tools/ExternalEnricher.ts --enrich "AI tools"

# Output includes:
# - Related Obsidian notes
# - Connections between notes (shared tags, links)
# - Enriched context markdown
```

### 3. Apply Fabric Patterns (Optional)

```bash
# List available patterns
bun ~/.claude/skills/Productivity/ContinualLearning/Tools/ExternalEnricher.ts --list-patterns

# Recommended patterns for enrichment:
# ★ extract_wisdom
# ★ summarize
# ★ extract_ideas
# ★ extract_insights
# ★ find_connections
```

### 4. Weave Context

```bash
# Build comprehensive context
bun ~/.claude/skills/Productivity/ContinualLearning/Tools/ContextWeaver.ts --topic "AI tools" --deep

# Combines:
# - TELOS goals (from GoalConnector)
# - Memory learnings (from MemoryStore)
# - Obsidian notes (from ExternalEnricher)
# - Synthesis patterns (from KnowledgeSynthesizer)
```

### 5. Present Enriched Context

Format for user:

```markdown
# Enriched Context: {{topic}}

## Related Notes from Obsidian ({{count}})

### {{note_name}}
Tags: {{tags}}
Links: {{links}}
{{content_preview}}

## Connections
- {{note_a}} → {{note_b}}: Shared tags: {{tags}}
- {{note_b}} → {{note_c}}: Direct link

## From Memory Store
{{related_learnings}}

## Goal Connections
{{connected_goals}}
```

## Enrichment Sources

### Obsidian Vault

Location: `/Users/[user]/Desktop/obsidian/`

Searched files:
- All `.md` files (excluding hidden, templates)
- Extracts: content, tags, wiki links

### Fabric Patterns

Location: `~/.config/fabric/patterns/` or `skills/Intelligence/Fabric/patterns/`

Useful patterns:
| Pattern | Use Case |
|---------|----------|
| `extract_wisdom` | Extract key insights |
| `summarize` | Condense long content |
| `extract_ideas` | Pull out concepts |
| `find_connections` | Identify relationships |
| `analyze_claims` | Evaluate assertions |

## Integration Examples

### Before Research Task

```typescript
import { enrichTopic } from "./Tools/ExternalEnricher";
import { weaveDeepContext } from "./Tools/ContextWeaver";

const topic = "machine learning deployment";

// Get Obsidian context
const enrichment = await enrichTopic(topic);

// Build full context package
const context = await weaveDeepContext(topic, 10);

// Present to user or use in session
console.log(context.markdown);
```

### During InformationManager

```typescript
import { weaveTopicContext } from "./Tools/ContextWeaver";

// Build topic-specific context
const context = await weaveTopicContext("authentication patterns");

// Include in context package for session
```

## Obsidian Integration Notes

- Vault must be accessible at configured path
- Supports wiki-style links `[[Note Name]]`
- Extracts tags in `#tag` format
- Searches both file names and content

## Related

- **ExternalEnricher:** `Tools/ExternalEnricher.ts`
- **ContextWeaver:** `Tools/ContextWeaver.ts`
- **Fabric Skill:** `skills/Intelligence/Fabric/SKILL.md`
- **Obsidian Skill:** `skills/Content/Obsidian/SKILL.md`
