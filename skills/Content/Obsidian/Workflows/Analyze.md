# Analyze Workflow

Classify an Obsidian note's content type without transforming it.

## Triggers
- `analyze note`, `detect note type`, `what type is this note`
- `analyze note "path/to/note.md"`

## Steps

### 1. Run NoteAnalyzer
```bash
bun skills/Content/Obsidian/Tools/NoteAnalyzer.ts --path "<note_path>"
```

For higher accuracy on ambiguous notes:
```bash
bun skills/Content/Obsidian/Tools/NoteAnalyzer.ts --path "<note_path>" --use-inference
```

### 2. Report Results

Present to user:
- Detected template type with confidence level
- Top 3 candidate types with scores
- Matched keywords and patterns
- Folder context signal
- Existing frontmatter (if any)
- Whether note is a stub (<50 words)
- Whether note already has structure

### 3. Optional: Validate Current State
```bash
bun skills/Content/Obsidian/Tools/QualityValidator.ts --path "<note_path>" --type "<detected_type>"
```

Show quality score against the detected template -- this reveals how much work a transformation would do.

## Use Cases
- Quick triage: "What type are my unstructured notes?"
- Pre-transform check: see what the analyzer thinks before committing
- Audit: batch analyze a folder to see type distribution
