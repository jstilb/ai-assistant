# Orphan Recovery Workflow

**⚠️ STATUS: NOT YET IMPLEMENTED ⚠️**
**STATUS: IMPLEMENTED** (Tools/OrphanRecovery.ts)

Scans MEMORY/ directories for orphaned files not referenced by any session, work item, or other MEMORY artifact. Reports findings with metrics.

## Trigger

**Invoked by:** Monthly workflow step 13
**Trigger:** `/autoinfo orphan-recovery` (manual)

## Purpose

Identify notes with no incoming links (orphans) and suggest or create connections to improve vault connectivity.

## Algorithm

### 1. Build Link Graph

Construct a directed graph of all notes:

```
Note A → [Note B, Note C]  (A links to B and C)
Note B → [Note D]          (B links to D)
Note C → []                (C has no outgoing links)
Note D → [Note A]          (D links back to A)
```

### 2. Calculate Incoming Links

For each note, count incoming links:

```
Note A: 1 incoming (from D)
Note B: 1 incoming (from A)
Note C: 1 incoming (from A)
Note D: 1 incoming (from B)
Note E: 0 incoming ← ORPHAN
```

### 3. Identify Orphans

Notes with 0 incoming links are orphans, excluding:
- Index files (`_Index.md`, `_Context.md`)
- Daily notes
- Template files
- Files in `_Archive/` folders

### 4. Analyze Content

For each orphan:
- Extract key terms and concepts
- Identify potential parent notes
- Calculate similarity scores

### 5. Suggest Connections

Generate suggestions:
- Which notes should link to this orphan
- Confidence score (0-100)
- Suggested link text

### 6. Auto-Link (Optional)

For high-confidence matches (>80%):
- Add backlink to parent note
- Update both files atomically
- Log all changes

## Output

### Recovery Report

```markdown
## Orphan Recovery Results

**Vault:** ~/obsidian/
**Date:** 2026-02-01
**Notes Scanned:** 1,247
**Orphans Found:** 15
**Orphans Recovered:** 8
**Suggestions Generated:** 12

### Recovered Orphans

| Orphan | Linked From | Confidence |
|--------|-------------|------------|
| Machine Learning Basics.md | AI/Overview.md | 92% |
| Python Decorators.md | Programming/Python.md | 87% |

### Remaining Orphans

| Orphan | Suggested Parent | Confidence |
|--------|-----------------|------------|
| Random Note.md | No match found | - |
```

## Implementation

### Graph Builder

```typescript
interface NoteGraph {
  nodes: Map<string, NoteNode>;
  edges: Map<string, string[]>; // source → targets
  reverseEdges: Map<string, string[]>; // target → sources
}

interface NoteNode {
  path: string;
  title: string;
  tags: string[];
  incomingCount: number;
  outgoingCount: number;
}
```

### Link Pattern Detection

Recognizes:
- `[[wiki links]]`
- `[[links|with aliases]]`
- `[markdown](links.md)`
- Embedded links `![[embeds]]`

### Similarity Scoring

Uses:
- Tag overlap
- Folder proximity
- Term frequency
- Semantic similarity (via inference)

## Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| autoLinkThreshold | 80 | Confidence threshold for auto-linking |
| excludeFolders | `['_Archive', 'Templates']` | Folders to skip |
| excludePatterns | `['_Index.md', '_Context.md']` | Files to skip |
| maxSuggestions | 3 | Max suggestions per orphan |

## Error Handling

- File read errors are logged but don't stop scan
- Malformed links are counted and reported
- Auto-link failures are rolled back
- All changes are logged for reversal

## Metrics

| Metric | Description |
|--------|-------------|
| notesScanned | Total notes in vault |
| orphansFound | Notes with 0 incoming links |
| orphansRecovered | Notes successfully linked |
| suggestionsGenerated | Link suggestions created |
| autoLinksCreated | Links created automatically |
| errors | File processing errors |

## CLI Usage

```bash
# Run standalone orphan recovery
bun ~/.claude/skills/AutoInfoManager/Tools/OrphanRecovery.ts

# Dry run (no changes)
bun ~/.claude/skills/AutoInfoManager/Tools/OrphanRecovery.ts --dry-run

# With custom threshold
bun ~/.claude/skills/AutoInfoManager/Tools/OrphanRecovery.ts --threshold 90
```

## Integration

### With Monthly Workflow

Orphan recovery is step 13 of the monthly workflow:

```typescript
createSimpleStep("OrphanRecovery", "Detect and recover orphan notes", async () => {
  // Orphan detection logic
  return {
    success: true,
    message: "Orphan recovery complete",
    metrics: { orphansFound: 15, orphansRecovered: 8 },
  };
});
```

### With Obsidian

Works with any Obsidian vault:
- Respects `.obsidian/` configuration
- Ignores system files
- Preserves frontmatter

## Future Enhancements

- [ ] Semantic clustering for better suggestions
- [ ] Integration with Graph View
- [ ] Automatic tag-based linking
- [ ] Cross-vault orphan detection
