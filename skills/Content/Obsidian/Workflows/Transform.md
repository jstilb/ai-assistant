# Transform Workflow

Transform a single Obsidian note into a structured template.

## Triggers
- `transform note`, `structure note`, `template note`
- `transform note "path/to/note.md"`

## Steps

### 1. Analyze Note Type
```bash
bun skills/Content/Obsidian/Tools/NoteAnalyzer.ts --path "<note_path>" --json
```

If confidence is HIGH (>0.85), proceed automatically.
If confidence is MEDIUM (0.6-0.85), show detected type and ask for confirmation.
If confidence is LOW (<0.6), show top 3 candidates and ask user to choose.

### 2. Transform Content (Dry Run)
```bash
bun skills/Content/Obsidian/Tools/TemplateEngine.ts --path "<note_path>" --type "<detected_type>" --dry-run
```

Show the user:
- Sections that will be added
- Sections that already exist
- Any content that will be moved to "Other"

### 3. Generate Frontmatter (Dry Run)
```bash
bun skills/Content/Obsidian/Tools/FrontmatterGenerator.ts --path "<note_path>" --type "<detected_type>" --tags "<suggested_tags>"
```

Show the generated YAML frontmatter for approval.

### 4. Suggest Tags
```bash
bun skills/Content/Obsidian/Tools/TagSuggester.ts --path "<note_path>"
```

Present suggested tags. User can accept, modify, or skip.

### 5. Apply Changes
Only after user approval:
```bash
bun skills/Content/Obsidian/Tools/TemplateEngine.ts --path "<note_path>" --type "<detected_type>" --write
bun skills/Content/Obsidian/Tools/FrontmatterGenerator.ts --path "<note_path>" --type "<detected_type>" --tags "<approved_tags>" --write
```

### 6. Validate Result
```bash
bun skills/Content/Obsidian/Tools/QualityValidator.ts --path "<note_path>" --json
```

Report quality score and any issues.

## Safety
- Steps 2 and 3 are always dry-run first
- User must approve before --write
- Original content preserved (no data loss)
- Obsidian syntax (wikilinks, embeds, callouts, Dataview, tasks) preserved
