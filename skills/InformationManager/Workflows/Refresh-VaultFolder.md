# Refresh-VaultFolder Workflow

Generate a detailed context file for a specific folder, cataloging all notes and their contents.

**Category:** Refresh (Source → Source)
**Trigger:** `refresh folder {path}`, `summarize folder`, `folder context`

## Purpose

Create and maintain `_Context.md` files **in place within the Obsidian vault** that:
- List all notes in the folder
- Summarize what each note contains
- Track tags and themes
- Provide detailed navigation for AI agents

This is a **Refresh** workflow: it updates context files IN the source (Obsidian vault), not in Kaya's context directory.

## Input

- **folder**: Path to folder (relative to vault root or absolute)
- **depth**: How deep to scan (default: current folder only)

## Execution Steps

### 1. Scan Folder Contents

```bash
# List all markdown files in folder
find "{{folder_path}}" -maxdepth 1 -name "*.md" -type f | sort
```

### 2. Analyze Each Note

For each `.md` file in the folder:

1. **Read the file** - Get full content
2. **Extract metadata**:
   - Title (from H1 or filename)
   - Tags (from frontmatter)
   - Created/modified dates
   - Word count estimate
3. **Generate summary**:
   - First 2-3 sentences or key heading structure
   - Main topics/concepts covered
   - Links to other notes (outgoing)

### 3. Identify Patterns

Analyze the folder as a whole:
- Common tags used
- Topic clusters
- Orphan notes (no links in/out)
- Key hub notes (many links)

### 4. Generate _Context.md

Create/update `{{folder_path}}/_Context.md`:

```markdown
---
generated: {{CURRENT_DATE}}
type: folder-context
note_count: {{count}}
---

# {{Folder Name}} - Context

Auto-generated context for AI navigation.

## Overview

**Notes:** {{count}}
**Primary topics:** {{topics}}
**Common tags:** {{tags}}

## Note Inventory

| Note | Summary | Tags | Links |
|------|---------|------|-------|
| [[Note Name]] | Brief description of content | #tag1 #tag2 | 3 outgoing |
| [[Another Note]] | What this note covers | #tag3 | 1 outgoing |
| ... | ... | ... | ... |

## Topic Clusters

### {{Topic 1}}
- [[Related Note 1]]
- [[Related Note 2]]

### {{Topic 2}}
- [[Related Note 3]]

## Key Notes

**Hub notes** (most connected):
- [[Hub Note]] - 10 links

**Entry points** (start here):
- [[_Index.md]] - Main navigation
- [[Overview Note]] - Conceptual overview

## Orphan Notes

Notes with no links (may need integration):
- [[Orphan Note 1]]
- [[Orphan Note 2]]

## AI Navigation Guide

When searching this folder:
1. Start with `_Index.md` for structure
2. Check `_Context.md` (this file) for note inventory
3. Use topic clusters to find related content
4. Key concepts: {{concept_list}}
```

### 5. Handle Subfolders

If `depth > 1` or folder has subfolders:
- List subfolders with note counts
- Optionally recurse into subfolders
- Reference subfolder `_Context.md` files

### 6. Skip Patterns

Do not process:
- `_Context.md` itself
- `_Index.md` (separate MOC purpose)
- Hidden files (starting with `.`)
- Resource folders (`_resources/`, `.obsidian/`)

## Output

- Primary: `{{folder_path}}/_Context.md`
- Returns: Summary of what was generated

## Tools Called

- `FolderContextGenerator.ts` - Generates the _Context.md content

## Integration

This workflow is called by:
- **Refresh-Vault** - Iterates through all folders
- **Organize-Note** - After adding new note, refresh folder context
- Manual invocation for specific folder

## Example Invocation

```
User: "Refresh the Data Science folder"
-> Scans ~/obsidian/Data Science/
-> Analyzes all notes
-> Creates/updates Data Science/_Context.md
-> Reports summary
```

## Batch Mode

When called by Refresh-Vault:
1. Receive list of folders to process
2. Process in parallel where possible
3. Return aggregated results
4. Folder contexts feed into VaultContext.md
