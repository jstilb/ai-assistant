# Refresh-Learnings Workflow

Generate comprehensive context for learning memory, including per-category detail.

**Category:** Refresh (Source → Source)
**Trigger:** `refresh learnings`, `update learning contexts`

## Purpose

Orchestrate full learnings context generation **in place within MEMORY/LEARNING**:
1. Generate `_Context.md` for each learning category
2. Aggregate into top-level `LearningsAggregateContext.md`
3. Provide complete AI-navigable documentation of captured insights

This is a **Refresh** workflow: it updates context files IN the source (MEMORY/LEARNING), not in Kaya's context directory.

## Config

Reads from `config/learnings.json`:
- `memoryDir`: Root memory directory
- `ratingsFile`: Path to ratings JSONL
- `synthesisDir`: Path to synthesis documents
- `recentRatingsCount`: Number of recent ratings to summarize

## Execution Steps

### 1. Load Config and Scan Categories

```bash
# Load config
cat ~/.claude/skills/Productivity/InformationManager/config/learnings.json

# Get all learning categories
find ~/.claude/MEMORY/LEARNING -maxdepth 1 -type d \
  -not -name '.*' \
  -not -name 'SIGNALS' \
  | sort
```

### 2. For Each Category, Gather Data

Learning categories:
- `ALGORITHM` - Algorithmic execution patterns
- `SYNTHESIS` - Synthesized insights
- `SYSTEM` - System-level learnings
- (other categories as they exist)

For each category:

1. **Scan time-based subfolders**:
   - Format: `YYYY-MM/`
   - List all `.md` files

2. **Extract patterns**:
   - Parse frontmatter tags
   - Extract rating from filename (e.g., `sentiment-rating-5`)
   - Identify common themes

3. **Count metrics**:
   - Total learnings
   - Recent learnings (last 30 days)
   - Rating distribution

### 3. Generate Per-Category _Context.md

Create/update `MEMORY/LEARNING/{category}/_Context.md` using this template:

```markdown
---
tags: [context, learning, ai-context]
last_updated: {{CURRENT_DATE}}
generated_by: Refresh-Learnings
category: {{category_name}}
---

# {{category_name}} Learning Context

AI-readable context for this learning category.

## Quick Reference

| Metric | Value |
|--------|-------|
| **Category** | {{category_name}} |
| **Location** | {{category_path}} |
| **Total Learnings** | {{total_count}} |
| **Recent (30d)** | {{recent_count}} |

## Purpose

{{category_purpose}}

## Time Distribution

| Month | Count | Key Themes |
|-------|-------|------------|
{{#each months}}
| {{this.month}} | {{this.count}} | {{this.themes}} |
{{/each}}

## Rating Distribution

| Rating | Count | Percentage |
|--------|-------|------------|
{{#each ratings}}
| {{this.rating}} | {{this.count}} | {{this.pct}}% |
{{/each}}

## Common Themes

{{#each themes}}
- **{{this.name}}** - {{this.count}} learnings
{{/each}}

## Recent Learnings

### Last 10 Captures
{{#each recent_learnings}}
- `{{this.date}}` - {{this.title}} (Rating: {{this.rating}})
{{/each}}

## AI Navigation Guide

When working with this category:
1. Check recent learnings for current patterns
2. Look at high-rated (5) learnings for successful patterns
3. Look at low-rated learnings for anti-patterns
4. Check synthesis documents for aggregated insights
```

### 4. Process Ratings Signal

Parse `MEMORY/LEARNING/SIGNALS/ratings.jsonl`:

```bash
# Get recent ratings
tail -n 50 ~/.claude/MEMORY/LEARNING/SIGNALS/ratings.jsonl | jq -s '.'
```

Extract:
- Rating trends
- Common session types
- Successful patterns

### 5. Aggregate All Categories

Create/update `~/.claude/MEMORY/LEARNING/LearningsAggregateContext.md`:

```markdown
---
tags: [context, learnings-summary, ai-context]
last_updated: {{CURRENT_DATE}}
generated_by: Refresh-Learnings
category_count: {{count}}
---

# Learnings Aggregate Context

AI-readable overview of all captured learning patterns.

## Quick Reference

| Metric | Value |
|--------|-------|
| **Learnings Directory** | `~/.claude/MEMORY/LEARNING/` |
| **Total Categories** | {{category_count}} |
| **Total Learnings** | {{total_count}} |
| **Recent (30d)** | {{recent_count}} |
| **Average Rating** | {{avg_rating}} |

## Categories Overview

| Category | Total | Recent | Avg Rating | Context |
|----------|-------|--------|------------|---------|
{{#each categories}}
| {{this.name}} | {{this.total}} | {{this.recent}} | {{this.avg_rating}} | [[_Context]] |
{{/each}}

## Rating Signal Summary

### Recent Ratings (Last 20)
| Date | Rating | Session Type |
|------|--------|--------------|
{{#each recent_ratings}}
| {{this.date}} | {{this.rating}} | {{this.type}} |
{{/each}}

### Rating Trends
- **This Week:** {{week_avg}} avg
- **This Month:** {{month_avg}} avg
- **Overall:** {{overall_avg}} avg

## High-Value Patterns (Rating 5)

Recent successful patterns:
{{#each high_value}}
- **{{this.title}}** ({{this.date}}) - {{this.summary}}
{{/each}}

## Areas for Improvement (Rating ≤2)

Recent challenges:
{{#each low_value}}
- **{{this.title}}** ({{this.date}}) - {{this.summary}}
{{/each}}

## Synthesis Documents

| Document | Purpose | Last Updated |
|----------|---------|--------------|
{{#each synthesis}}
| {{this.name}} | {{this.purpose}} | {{this.updated}} |
{{/each}}

## Context File Locations

### Aggregate
- `LearningsAggregateContext.md` - This file

### Per-Category
{{#each categories}}
- `{{this.name}}/_Context.md`
{{/each}}

### Signals
- `SIGNALS/ratings.jsonl` - Raw rating data
```

### 6. Report Results

```markdown
## Refresh-Learnings Complete

**Categories processed:** {{count}}
**Total learnings indexed:** {{total}}
**Context files generated:** {{count}}

### Category Summary
| Category | Learnings | Recent | Status |
|----------|-----------|--------|--------|
| ALGORITHM | 45 | 12 | ✅ _Context.md updated |
| SYNTHESIS | 8 | 2 | ✅ _Context.md updated |
| SYSTEM | 23 | 5 | ✅ _Context.md updated |

### Skipped
- SIGNALS/ (data only, no context needed)
```

## Options

```yaml
categories:
  skip: [SIGNALS]          # Don't generate context for data folders
  include_empty: false     # Skip categories with 0 learnings

ratings:
  recent_count: 20         # Recent ratings to include in summary
  high_threshold: 5        # Rating for "high value"
  low_threshold: 2         # Rating for "needs improvement"

parallel:
  enabled: true
  max_concurrent: 3

output:
  aggregate: true
  per_category: true
```

## Tools Called

- `FolderContextGenerator.ts --template local` - For each category's _Context.md
- `AggregateContextGenerator.ts --source-type local` - For LearningsAggregateContext.md

## Integration

**Called by:**
- Sync-Learnings workflow (generates context, then syncs to Kaya)
- Manual invocation
- Weekly maintenance

## Maintenance Schedule

Run this workflow:
- Weekly for freshness
- After synthesis generation
- After bulk rating sessions
- When investigating patterns
