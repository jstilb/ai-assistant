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

Assemble a unified context block from all sources. Execute inline — no external script needed:

```
Weave context for: <topic/goal>

Steps:
1. Read USER/TELOS/GOALS.md → extract the 1-3 WIGs most relevant to <topic>
2. Search MEMORY via MemoryStore for related learnings (limit 5, fullText: <topic>)
3. Read MEMORY/LEARNING/SYNTHESIS/<latest month>/*.md → extract top patterns
4. If topic given: use Obsidian search results from Step 1-2 above

Output: unified markdown context block (~300 tokens), sections ordered by relevance:
  - Relevant WIGs and their status
  - Top 3-5 memory learnings with timestamps
  - 1-2 synthesis patterns that connect
  - Related Obsidian notes (if any)

Decision rules:
- Session context (no explicit topic): load WIGs + last 5 learnings + latest synthesis summary
- Deep context (topic provided): all four sources, limit 10 per source
- Goal context (goal ID provided): load that goal + supporting mission + learnings filtered to that goal
- Topic context (topic keyword only): WIGs + learnings filtered by topic + Obsidian search + synthesis patterns
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

When Jm asks "build context for machine learning deployment":
1. Run ExternalEnricher step 1-2 for Obsidian notes on the topic
2. Execute the Weave Context prompt (Step 4) with topic = "machine learning deployment"
3. Present the unified markdown block

### During InformationManager

When session context is needed inline, execute the Weave Context prompt (Step 4) with no explicit topic (defaults to session context: WIGs + last 5 learnings + latest synthesis).

## Obsidian Integration Notes

- Vault must be accessible at configured path
- Supports wiki-style links `[[Note Name]]`
- Extracts tags in `#tag` format
- Searches both file names and content

## Related

- **ExternalEnricher:** `Tools/ExternalEnricher.ts`
- **Fabric Skill:** `skills/Intelligence/Fabric/SKILL.md`
