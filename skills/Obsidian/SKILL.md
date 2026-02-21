---
name: Obsidian
description: Transform unstructured Obsidian notes into structured templates with frontmatter and tags. USE WHEN obsidian template, note template, structure note, transform note, analyze note, tag suggestion, frontmatter, obsidian vault, note classification.
---

# Obsidian

Transform unstructured Obsidian notes into optimized, structured templates tailored to each note's content type.
## Voice Notification

**When executing a workflow, do BOTH:**

1. **Send voice notification**:
   ```bash
   curl -s -X POST http://localhost:8888/notify \
     -H "Content-Type: application/json" \
     -d '{"message": "Running the WORKFLOWNAME workflow in the Obsidian skill to ACTION"}' \
     > /dev/null 2>&1 &
   ```

2. **Output text notification**:
   ```
   Running the **WorkflowName** workflow in the **Obsidian** skill to ACTION...
   ```

**Full documentation:** `~/.claude/skills/CORE/SYSTEM/THENOTIFICATIONSYSTEM.md`

## Workflow Routing

| Workflow | Trigger | File |
|----------|---------|------|
| **Transform** | "transform note", "structure note", "template note" | `Workflows/Transform.md` |
| **Analyze** | "analyze note", "detect note type", "what type is this note" | `Workflows/Analyze.md` |

## Supported Template Types

| Type | Signals | Folder Bias |
|------|---------|-------------|
| **Learning Note** | Concepts, explanations, examples, exercises | Applied Machine Learning, Programming, etc. |
| **Reference** | API docs, configs, commands, cheat sheets | Programming, SQL, Python |
| **Recipe** | Ingredients, steps, timing, servings | Cooking |
| **Journal** | Date entries, reflections, mood, events | Meta |
| **Project** | Goals, milestones, status, tasks | Career, Data Science & Programming Projects |
| **Meeting Notes** | Date, attendees, agenda, decisions, action items | Career |
| **Book Notes** | Title, author, summary, takeaways, quotes | Book Summaries & Takeaways |
| **Troubleshooting** | Problem, environment, steps tried, solution | Programming |
| **Concept Map** | Central concept, relationships, definitions | Statistics, Linear Algebra |
| **Resource List** | Curated links, annotations, categories | Research, Skills |
| **Lecture Notes** | Course info, topic, key points, assignments | Berkeley MIDS, Calculus |

## Tools

| Tool | Purpose | CLI |
|------|---------|-----|
| **NoteAnalyzer.ts** | Classify note content type via fast inference | `bun Tools/NoteAnalyzer.ts --path "/path/to/note.md"` |
| **TemplateEngine.ts** | Restructure content into template sections | `bun Tools/TemplateEngine.ts --path "/path/to/note.md" --type recipe` |
| **FrontmatterGenerator.ts** | Generate/merge YAML frontmatter | `bun Tools/FrontmatterGenerator.ts --path "/path/to/note.md" --type recipe` |
| **TagSuggester.ts** | Suggest tags from vault taxonomy | `bun Tools/TagSuggester.ts --path "/path/to/note.md"` |
| **QualityValidator.ts** | Score transformed notes against template | `bun Tools/QualityValidator.ts --path "/path/to/note.md"` |

## Template Library

Templates are JSON config files in `Templates/`. Each defines:
- Required and optional sections
- Frontmatter fields (required and optional)
- Content signals for detection (keywords, folder bias)

Add new templates by dropping a JSON file in `Templates/` -- no code changes required.

## Safety

- **Dry-run is default** for batch operations
- **Zero data loss** -- every word from original appears in transformed output
- **Preview diff** before writing changes
- **Obsidian syntax preserved** -- wikilinks, embeds, callouts, Dataview, tasks, code blocks

## Configuration

| Setting | Value |
|---------|-------|
| Vault Path | `~/obsidian/` |
| Inference | `fast` for detection and tagging |
| Templates | `skills/Obsidian/Templates/*.json` |
| Tag Cache | `~/.claude/MEMORY/cache/.tag-taxonomy-cache.json` |

> **Note:** The vault path defaults to `~/obsidian/` (user-specific). Override it with the `--vault` flag on any tool CLI, e.g. `bun NoteAnalyzer.ts --path "note.md" --vault "/path/to/vault/"`.

## Examples

**Example 1: Transform a single note**
```
User: "Transform my chicken tikka note"
-> Invokes Transform workflow
-> NoteAnalyzer detects Recipe (confidence: 0.92)
-> TemplateEngine restructures into Ingredients/Instructions/Notes
-> FrontmatterGenerator adds type, tags, source metadata
-> TagSuggester suggests: cooking, indian, chicken
-> QualityValidator scores: 87/100
-> Preview diff shown, user approves, note written
```

**Example 2: Analyze a note type**
```
User: "What type of note is Applied Machine Learning/gradient-descent.md?"
-> Invokes Analyze workflow
-> NoteAnalyzer reads content, detects Learning Note (confidence: 0.88)
-> Reports: "Learning Note (88% confidence). Contains concepts, code examples, and explanations."
```

**Example 3: Suggest tags for a note**
```
User: "Suggest tags for my Python decorators note"
-> TagSuggester scans vault taxonomy (450+ existing tags)
-> Suggests: programming/python, decorators, functions, reference
-> All tags exist in vault taxonomy
```

## Integration

### Uses
- **Inference.ts** (`tools/Inference.ts`) -- Fast inference for classification and tagging
- **InformationManager** -- Vault context, folder structure

### Feeds Into
- **Obsidian vault** -- Structured notes with frontmatter and consistent templates
- **InformationManager** -- Better structured notes improve context gathering
- **ContinualLearning** -- Structured notes enable better Dataview queries

### MCPs Used
- None
