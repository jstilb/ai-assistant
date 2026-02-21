# Refresh-Drive Workflow

Refresh context.md files across all Google Drive folders.

**Category:** Refresh (Source → Source)
**Trigger:** `refresh drive`, `update drive context`, `refresh google drive`

## Purpose

Maintain individual `context.md` files **in each Google Drive folder** for AI navigation:
1. Create/update `context.md` in each Drive folder
2. Generate aggregate `GoogleDriveContext.md` for Kaya

This is a **Refresh** workflow: it primarily updates context files IN the source (Google Drive), with a secondary sync to Kaya's context.

## Tool Integration

This workflow uses reusable InformationManager tools:
- **`FolderContextGenerator.ts`** - Generates context.md for each folder
- **`AggregateContextGenerator.ts`** - Creates GoogleDriveContext.md
- **`GatheringOrchestrator.ts`** - Orchestrates the gather process (includes `drive` source)

## Quick Execution

```bash
# Run via GatheringOrchestrator (recommended)
bun ~/.claude/skills/InformationManager/Tools/GatheringOrchestrator.ts --sources drive

# Or run just the drive source with JSON output
bun ~/.claude/skills/InformationManager/Tools/GatheringOrchestrator.ts --sources drive --json
```

## Excluded Folders

Skip these system/utility folders:
- .Trash
- Backups (automated backup folders)
- Folders starting with `.`
- Google Docs native folders (Colab Notebooks if system-managed)

## Execution Steps

### 1. Discover All Folders

```bash
# Get complete folder tree
kaya-cli drive lsd gdrive: --recursive

# Filter out system folders
# Skip: .Trash, folders starting with ".", Backups
```

### 2. Process Each Folder

For each folder (including root `gdrive:`):

#### a. List folder contents
```bash
kaya-cli drive lsf gdrive:"{{folder_path}}"  # Files
kaya-cli drive lsd gdrive:"{{folder_path}}"  # Subfolders
```

#### b. Check for existing context.md
```bash
kaya-cli drive lsf gdrive:"{{folder_path}}" --include "context.md"
```

#### c. Download existing context.md (if exists)
```bash
kaya-cli drive copy gdrive:"{{folder_path}}/context.md" {{scratchpad}}/
```

#### d. Generate updated context.md

Create/update with this structure:
```markdown
---
last_updated: {{CURRENT_DATE}}
generated_by: Refresh-Drive
file_count: {{count}}
subfolder_count: {{count}}
---

# {{Folder Name}} - Context

## Overview
[AI-generated summary of folder purpose based on contents]

## Contents

### Files ({{count}})
| File | Type | Size | Modified |
|------|------|------|----------|
| file.pdf | PDF | 2.3MB | 2024-01-15 |
| ... | ... | ... | ... |

### Subfolders ({{count}})
| Folder | Description |
|--------|-------------|
| Projects/ | [inferred from subfolder context] |
| ... | ... |

## Purpose
[Inferred purpose based on file types and names]

## Navigation
- Parent: {{parent_folder}}
- Key files: {{notable_files}}
```

#### e. Upload refreshed context.md
```bash
kaya-cli drive copy {{scratchpad}}/context.md gdrive:"{{folder_path}}/"
```

### 3. Generate Aggregate GoogleDriveContext.md

After processing all folders, create `~/.claude/context/GoogleDriveContext.md`:

```markdown
---
tags: [context, google-drive, ai-context]
last_updated: {{CURRENT_DATE}}
generated_by: Refresh-Drive
total_folders: {{count}}
---

# Google Drive Context

AI-navigable map of Google Drive structure.

## Quick Reference

| Metric | Value |
|--------|-------|
| **Total Folders** | {{count}} |
| **Folders with Context** | {{count}} |
| **Last Sync** | {{date}} |

## Folder Structure

### Root Level
| Folder | Files | Subfolders | Purpose |
|--------|-------|------------|---------|
| Documents/ | 45 | 3 | Personal documents |
| Projects/ | 12 | 8 | Active project files |
| ... | ... | ... | ... |

### Full Hierarchy
[Tree view of complete folder structure]

## Navigation Guide

For any folder, check its `context.md` for:
- Complete file inventory
- Subfolder descriptions
- Inferred purpose
```

### 4. Parallel Processing

- Process up to 3 folders concurrently
- Use scratchpad for temp files: `{{scratchpad}}/drive-context/`
- Track: created, updated, skipped, errors

### 5. Report Results

```markdown
## Refresh-Drive Complete

**Folders processed:** {{count}}
**Context files created:** {{new_count}}
**Context files updated:** {{updated_count}}
**Folders skipped:** {{skip_count}} (system folders)

### Summary by Folder
| Folder | Status | Files |
|--------|--------|-------|
| gdrive: (root) | Updated | 15 |
| Documents/ | Created | 45 |
| .Trash/ | Skipped | - |
| ... | ... | ... |

### Aggregate
Updated: context/GoogleDriveContext.md
```

## Tools Called

- `FolderContextGenerator.ts` - For each folder's context.md
- `AggregateContextGenerator.ts` - For GoogleDriveContext.md

## Integration

**Called by:**
- Sync-All workflow
- Manual invocation
- Scheduled maintenance (weekly)

**Related:**
- Refresh-Vault (similar pattern for Obsidian)
- Sync-Telos (similar Drive CLI usage)

## CLI Commands Reference

| Operation | Command |
|-----------|---------|
| List all folders | `kaya-cli drive lsd gdrive: --recursive` |
| List folder contents | `kaya-cli drive lsf gdrive:"Folder/"` |
| List subfolders | `kaya-cli drive lsd gdrive:"Folder/"` |
| Download file | `kaya-cli drive copy gdrive:"Folder/context.md" /tmp/` |
| Upload file | `kaya-cli drive copy /tmp/context.md gdrive:"Folder/"` |

## Verification

1. Run `kaya-cli drive lsd gdrive:` to verify Drive access
2. Execute workflow with `--dry-run` first (report what would happen)
3. Check a sample context.md in Drive after execution
4. Verify `context/GoogleDriveContext.md` contains aggregate summary
