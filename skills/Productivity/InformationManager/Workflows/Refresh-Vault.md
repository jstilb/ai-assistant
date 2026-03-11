# Refresh-Vault Workflow

Generate comprehensive context for the entire vault, including per-folder detail.

**Category:** Refresh (Source → Source)
**Trigger:** `refresh vault`, `update vault context`, `summarize vault`

## Purpose

Orchestrate full vault context generation **in place within the Obsidian vault**:
1. Generate `_Context.md` for each folder (via Refresh-VaultFolder)
2. Aggregate into top-level `VaultContext.md`
3. Provide complete AI-navigable documentation

This is a **Refresh** workflow: it updates context files IN the source (Obsidian vault), not in Kaya's context directory.

## Execution Steps

### 1. Scan Vault Structure

```bash
# Get all content folders (exclude system folders)
find /Users/[user]/Desktop/obsidian -type d \
  -not -path '*/.obsidian*' \
  -not -path '*/_resources*' \
  -not -path '*/.smart-env*' \
  -not -name '.*' \
  | sort
```

### 2. Generate Folder Contexts

**For each major folder, call Refresh-VaultFolder workflow:**

```
-> Refresh-VaultFolder(folder: "Applied Machine Learning")
-> Refresh-VaultFolder(folder: "Data Science")
-> Refresh-VaultFolder(folder: "Cooking")
-> ... (all folders with 3+ notes)
```

**Skip folders:**
- Meta/ (organizational, not content)
- Folders with < 3 notes
- Hidden/system folders

**Parallel processing:**
- Process up to 3 folders in parallel for efficiency
- Collect results for aggregation

### 3. Aggregate Folder Data

From each folder's `_Context.md`, extract:
- Note count
- Primary topics
- Key notes
- Common tags

### 4. Generate VaultContext.md

Create/update `/Users/[user]/Desktop/obsidian/VaultContext.md`:

```markdown
---
tags: [context, vault-summary, ai-context]
last_updated: {{CURRENT_DATE}}
generated_by: Refresh-Vault
folder_contexts: {{count}}
---

# Obsidian Vault Context

AI-readable context for understanding and navigating this vault.

## Quick Reference

| Metric | Value |
|--------|-------|
| **Vault Location** | `/Users/[user]/Desktop/obsidian/` |
| **Total Notes** | {{total_count}} |
| **Folders with Context** | {{folder_count}} |
| **Organization** | Topic-based folders with MOC indexes |

## Folder Map

### Academic (Berkeley MIDS)
| Folder | Notes | Topics | Context |
|--------|-------|--------|---------|
| Applied Machine Learning | {{count}} | ML algorithms, neural networks | [[_Context]] |
| ML at Scale | {{count}} | Spark, distributed computing | [[_Context]] |
| ... | ... | ... | ... |

### Technical References
| Folder | Notes | Topics | Context |
|--------|-------|--------|---------|
| Data Science | {{count}} | Core DS concepts | [[_Context]] |
| Programming | {{count}} | Language references | [[_Context]] |
| ... | ... | ... | ... |

### Personal & Creative
| Folder | Notes | Topics | Context |
|--------|-------|--------|---------|
| Cooking | {{count}} | Recipes, cuisines | [[_Context]] |
| Writing | {{count}} | Creative projects | [[_Context]] |
| ... | ... | ... | ... |

## Navigation Guide

### For Detailed Folder Info
Each folder has a `_Context.md` with:
- Complete note inventory
- Note summaries
- Topic clusters
- Orphan notes needing integration

### Quick Navigation
- **Academic:** Start with `Berkeley MIDS.md` -> Course folder -> `_Index.md`
- **Technical:** Check folder's `_Context.md` for note inventory
- **Personal:** Check `_Index.md` or `_Context.md` in folder

## Tag System
[Aggregated from folder contexts]

## MOC Index
| MOC | Location | Purpose |
|-----|----------|---------|
| Berkeley MIDS | `/Berkeley MIDS.md` | Master academic index |
| Applied ML | `/Applied Machine Learning/_Index.md` | ML course navigation |
| Cooking | `/Cooking/_Index.md` | Recipe navigation |
| ... | ... | ... |

## Context File Locations

### Top-Level
- `VaultContext.md` - This file (vault overview)

### Folder Contexts
- `Applied Machine Learning/_Context.md`
- `Data Science/_Context.md`
- `Cooking/_Context.md`
- [list all generated _Context.md files]
```

### 5. Report Results

```markdown
## Refresh-Vault Complete

**Folders processed:** {{count}}
**Total notes indexed:** {{total}}
**Context files generated:** {{count}}

### Folder Summary
| Folder | Notes | Status |
|--------|-------|--------|
| Applied Machine Learning | 45 | OK _Context.md updated |
| Data Science | 23 | OK _Context.md updated |
| ... | ... | ... |

### Folders Skipped
- Meta/ (organizational)
- Misc/ (< 3 notes)
```

## Options

```yaml
folders:
  min_notes: 3           # Minimum notes to generate _Context.md
  skip: [Meta, .obsidian] # Folders to skip

parallel:
  enabled: true
  max_concurrent: 3

output:
  vault_context: true    # Generate VaultContext.md
  folder_contexts: true  # Generate per-folder _Context.md
```

## Tools Called

- `FolderContextGenerator.ts` - For each folder's _Context.md
- `AggregateContextGenerator.ts` - For VaultContext.md

## Integration

**Calls:**
- `Refresh-VaultFolder` - For each eligible folder

**Called by:**
- Sync-All workflow
- Manual invocation
- Scheduled maintenance

## Maintenance Schedule

Run this workflow:
- After major reorganization
- When new folders added
- Monthly for freshness
- After bulk note imports
