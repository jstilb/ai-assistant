---
description: Run autonomous knowledge management workflows (daily, weekly, monthly)
argument-hint: <daily|weekly|monthly|status>
allowed-tools: [Read, Glob, Grep, Bash, Task, Write, mcp__readwise__search_readwise_highlights, mcp__anki__batch_create_notes, mcp__anki__list_decks, mcp__notebooklm__list_notebooks]
---

# Knowledge Command

Autonomous knowledge management workflows for Obsidian vault, Readwise, NotebookLM, and Anki.

## Arguments

The user invoked: `/knowledge $ARGUMENTS`

## Routing

Based on the argument, invoke the appropriate workflow from the KnowledgeMaintenance skill:

| Argument | Action |
|----------|--------|
| `daily` | Run `~/.claude/skills/KnowledgeMaintenance/Workflows/DailyKnowledge.md` |
| `weekly` | Run `~/.claude/skills/KnowledgeMaintenance/Workflows/WeeklyKnowledge.md` |
| `monthly` | Run `~/.claude/skills/KnowledgeMaintenance/Workflows/MonthlyKnowledge.md` |
| `status` | Show last run times and vault health |
| (none) | Show usage help |

## Usage

```
/knowledge daily     # Inbox processing, backlinks, Readwise sync
/knowledge weekly    # Vault summarization, context rebuild, orphan detection
/knowledge monthly   # Learning patterns, NotebookLM sync, Anki generation
/knowledge status    # Show last run times and vault health
```

## Execution

1. Read the appropriate workflow file
2. Execute according to workflow instructions
3. Write report to `MEMORY/KNOWLEDGE/{daily,weekly,monthly}/`
4. Send voice notification on completion

## Status Command

When `status` is specified, check:
- Last daily run: `ls -la ~/.claude/MEMORY/KNOWLEDGE/daily/ | tail -1`
- Last weekly run: `ls -la ~/.claude/MEMORY/KNOWLEDGE/weekly/ | tail -1`
- Last monthly run: `ls -la ~/.claude/MEMORY/KNOWLEDGE/monthly/ | tail -1`
- Obsidian vault health: Note count, inbox items, orphan count

Format output as a knowledge health summary.

## Dependencies

**Skills:**
- Obsidian - Vault operations
- InformationManager - Context aggregation
- ContinualLearning - Pattern extraction
- NotesToAnki - Card generation

**MCPs:**
- Readwise - Highlight sync
- NotebookLM - Research notebooks
- Anki - Flashcard creation
