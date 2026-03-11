# Organize-Note Workflow

Integrate a new or updated note into the vault by creating backlinks, updating indexes, and maintaining MOCs.

**Category:** Organize (Route/Move)
**Trigger:** `organize note`, `integrate note`, `add backlinks`, `link new note`

## Purpose

When a note is added or significantly updated, organize it within the vault:
1. Find and create relevant backlinks
2. Add to folder's `_Index.md` if appropriate
3. Update relevant MOCs (Maps of Content)
4. Refresh folder's `_Context.md`

This is an **Organize** workflow: it connects information to proper locations within the vault.

## Input

- **note_path**: Path to the new/updated note
- **is_new**: Boolean - true if newly created, false if updated
- **source**: Where the note came from (manual, scratch-pad, etc.)

## Execution Steps

### 1. Analyze the Note

Read the note and extract:
- **Title**: From H1 or filename
- **Content**: Full text for analysis
- **Tags**: From frontmatter
- **Existing links**: Outgoing wikilinks already present
- **Key concepts**: Main topics/entities mentioned
- **Folder**: Which folder it's in

### 2. Find Backlink Candidates

Search vault for related notes:

```
1. Search by tags - notes with matching tags
2. Search by concepts - grep for key terms in other notes
3. Search by folder - notes in same folder
4. Search by title words - notes with similar names
```

**Scoring:**
- Same folder: +2
- Matching tags: +3 per tag
- Concept mentioned in other note: +2
- Already links to this note: +5 (bidirectional)

**Threshold:** Score >= 4 to suggest backlink

### 3. Create Backlinks

For high-confidence matches, add backlinks to the new note:

```markdown
## Related Notes

- [[Related Note 1]] - Brief context why related
- [[Related Note 2]] - Brief context why related
```

**Rules:**
- Only add if not already linked
- Maximum 5-7 related notes
- Group by relationship type if many
- Add to "Related Notes" or "See Also" section

### 4. Update _Index.md

Check if folder has `_Index.md`:

**If exists:**
1. Read current structure
2. Determine appropriate section for new note
3. Add wikilink in correct location
4. Maintain alphabetical or logical order

**If doesn't exist and folder has 5+ notes:**
1. Consider creating `_Index.md`
2. Or flag for manual review

**Index entry format:**
```markdown
- [[New Note]] - Brief description
```

### 5. Update MOCs

Identify relevant MOCs:
1. Check folder's `_Index.md` (primary MOC)
2. Check parent folder MOCs
3. Check topic-based MOCs (e.g., `Berkeley MIDS.md`)
4. Check VaultContext.md for MOC locations

**For each relevant MOC:**
1. Read current structure
2. Find appropriate section
3. Add link if not present
4. Preserve existing organization

### 6. Refresh Folder Context

After integration, update folder's `_Context.md`:

```
-> Call Refresh-VaultFolder workflow
-> Ensures note inventory is current
-> Updates topic clusters
```

### 7. Optional: Update Related Notes

For bidirectional linking, optionally update related notes:
- Add backlink to new note in their "Related" section
- Only for high-confidence matches (score >= 6)
- Configurable: `bidirectional: true/false`

### 8. Update VaultContext.md

After folder context refresh, update the vault-level context:

```
1. Read VaultContext.md
2. Find the folder's row in the Folder Map tables
3. Update note count if changed
4. Update last_updated date in frontmatter
```

**When to update:**
- New note added (count increases)
- Note deleted (count decreases)
- Note moved between folders (both folders' counts change)

**Skip if:**
- Note was only edited (no count change)
- Folder not listed in VaultContext.md (minor folder)

## Output

Report of actions taken:
```markdown
## Note Integration Complete

**Note:** [[New Note Name]]
**Folder:** Data Science/

### Actions Taken

**Backlinks added:**
- [[Related Note 1]] - Added to Related Notes section
- [[Related Note 2]] - Added to Related Notes section

**Index updates:**
- Data Science/_Index.md - Added under "Concepts" section

**MOC updates:**
- Berkeley MIDS.md - No update needed (not course content)

**Folder context:**
- Data Science/_Context.md - Refreshed

**Vault context:**
- VaultContext.md - Updated Data Science note count (40 -> 41)
```

## Tools Called

- `Refresh-VaultFolder` - To refresh folder context

## Integration Points

**Called by:**
- `Organize-ScratchPad` workflow - After creating new notes
- Manual invocation for existing notes

**Calls:**
- `Refresh-VaultFolder` workflow - To refresh folder context

**Modifies:**
- `VaultContext.md` - Updates note count in folder map

## Configuration

```yaml
backlinks:
  enabled: true
  max_links: 7
  min_score: 4
  bidirectional: false  # Set true to also update related notes

index:
  auto_add: true
  create_if_missing: false  # Only add to existing _Index.md

moc:
  update_folder_moc: true
  update_parent_moc: false
  update_master_moc: false  # Berkeley MIDS.md, etc.

context:
  refresh_folder: true
  update_vault_context: true  # Update VaultContext.md note counts
```

## Example

```
New note created: /Data Science/Gradient Boosting vs Random Forest.md

1. Analyze: Tags [ml, algorithms], concepts [gradient boosting, random forest, ensemble]

2. Backlink candidates:
   - Data Science/Ensemble Methods.md (score: 7) OK
   - Applied Machine Learning/Week 5 Ensemble Learning.md (score: 6) OK
   - Data Science/Decision Trees.md (score: 5) OK
   - Data Science/XGBoost Notes.md (score: 4) OK

3. Add to note:
   ## Related Notes
   - [[Ensemble Methods]] - Parent concept
   - [[Week 5 Ensemble Learning]] - Course material
   - [[Decision Trees]] - Foundational concept
   - [[XGBoost Notes]] - Specific implementation

4. Update Data Science/_Index.md:
   ### Algorithms
   - [[Gradient Boosting vs Random Forest]] - Comparison of ensemble methods

5. MOC: No master MOC update needed

6. Refresh Data Science/_Context.md
```

## Batch Mode

When processing multiple notes (e.g., from Organize-ScratchPad):
1. Collect all new notes
2. Process integration for each
3. Deduplicate folder context refreshes
4. Return consolidated report
