# Vault Structure Reference

Actual Obsidian vault folder structure for AutoInfoManager workflows.

## Vault Location

`~/obsidian/`

## Folder Structure

Topic-based organization (not numbered):

```
obsidian/
├── AI/                    # AI and machine learning notes
├── Books/                 # Book notes and summaries
├── Business/              # Business concepts and ideas
├── Career/                # Career development
├── Cooking/               # Recipes and cooking notes
├── Daily/                 # Daily notes
├── Health/                # Health and fitness
├── Learning/              # Learning materials
├── Meta/                  # Vault configuration
│   ├── _Index.md          # Master index
│   └── Templates/         # Note templates
├── People/                # Contact notes
├── Philosophy/            # Philosophy notes
├── Projects/              # Active projects
├── Reading/               # Reading list and notes
├── Reference/             # Reference materials
├── Research/              # Research notes
├── ScratchPad/            # Inbox for quick capture
├── Tech/                  # Technology notes
├── Travel/                # Travel planning and notes
├── Writing/               # Writing projects
└── VaultContext.md        # Generated vault context
```

## Context Files

Each folder may contain:
- `_Context.md` - Folder-level summary and inventory
- `_Index.md` - Navigation index for the folder

## Special Folders

| Folder | Purpose | AutoInfo Action |
|--------|---------|-----------------|
| ScratchPad/ | Quick capture inbox | ProcessScratchPad triages daily |
| Meta/ | Vault configuration | Read-only reference |
| Daily/ | Daily notes | Excluded from orphan detection |
| Templates/ | Note templates | Excluded from processing |

## Generated Files

AutoInfoManager generates/updates:

| File | Location | Frequency |
|------|----------|-----------|
| VaultContext.md | Vault root | Weekly/Monthly |
| _Context.md | Per folder | Monthly |

## Integration Notes

- Topic-based structure replaces old numbered folder system (00_Inbox, 01_Projects, etc.)
- _Context.md files are regenerated during monthly SummarizeVault workflow
- ScratchPad is the primary inbox for quick capture
- Orphan recovery excludes Daily/, Templates/, and Meta/ folders
