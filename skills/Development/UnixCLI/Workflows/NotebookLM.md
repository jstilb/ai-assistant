# NotebookLM Workflow (Native CLI)

Full NotebookLM access via the `nlm` CLI - notebooks, sources, queries, podcasts, and more.

## Prerequisites

- Python 3.10+
- Google Chrome
- nlm CLI: `pipx install notebooklm-cli`

## Authentication

```bash
# First-time setup (opens Chrome for Google login)
kaya-cli nlm login

# Check auth status
kaya-cli nlm auth status

# Use named profile (for multiple accounts)
kaya-cli nlm login --profile work
kaya-cli nlm notebook list --profile work
```

Sessions last ~20 minutes before requiring re-authentication.

## Quick Reference

| Command | Description |
|---------|-------------|
| `nlm login` | Authenticate via Chrome |
| `nlm notebook list` | List all notebooks |
| `nlm notebook query <id> "?"` | Query a notebook |
| `nlm source add <id> --url X` | Add URL source |
| `nlm audio create <id>` | Generate podcast |
| `nlm alias set name <id>` | Create shortcut |

## Notebook Management

### List Notebooks

```bash
# Default table view
kaya-cli nlm notebook list

# JSON output
kaya-cli nlm notebook list --json

# IDs only (for scripting)
kaya-cli nlm notebook list --quiet

# Full details
kaya-cli nlm notebook list --full
```

### Create Notebook

```bash
kaya-cli nlm notebook create "Research Project"
```

### Query Notebook

```bash
# Ask a question
kaya-cli nlm notebook query abc123 "What are the main themes?"

# Using alias
kaya-cli nlm alias set research abc123
kaya-cli nlm notebook query research "Summarize the findings"
```

### Delete Notebook

```bash
kaya-cli nlm notebook delete abc123 --confirm
```

## Source Operations

### List Sources

```bash
kaya-cli nlm source list <notebook-id>
kaya-cli nlm source list <notebook-id> --json
```

### Add Sources

```bash
# Add URL (article, documentation)
kaya-cli nlm source add <notebook-id> --url "https://example.com/article"

# Add YouTube video
kaya-cli nlm source add <notebook-id> --url "https://youtube.com/watch?v=..."

# Add pasted text
kaya-cli nlm source add <notebook-id> --text "Content here..." --title "My Notes"

# Add Google Drive document
kaya-cli nlm source add <notebook-id> --drive <drive-doc-id>
```

### Extract Source Content

```bash
# Get raw text from a source (useful for other tools)
kaya-cli nlm source content <source-id>
```

### Sync Drive Sources

```bash
# Update all Drive sources with latest content
kaya-cli nlm source sync <notebook-id> --confirm
```

## Interactive Chat

```bash
# Start REPL session
kaya-cli nlm chat start <notebook-id>

# In chat:
# /sources - list sources
# /clear   - clear history
# /help    - show commands
# /exit    - quit
```

## Content Generation

All generation commands require `--confirm` flag:

### Audio Podcast

```bash
kaya-cli nlm audio create <notebook-id> --confirm
kaya-cli nlm audio status <notebook-id>
kaya-cli nlm audio download <notebook-id>
```

### Study Materials

```bash
# Report/Study Guide
kaya-cli nlm report create <notebook-id> --confirm

# Quiz Questions
kaya-cli nlm quiz create <notebook-id> --confirm

# Flashcards
kaya-cli nlm flashcards create <notebook-id> --confirm
```

### Visual Content

```bash
# Mind Map
kaya-cli nlm mindmap create <notebook-id> --confirm

# Slides
kaya-cli nlm slides create <notebook-id> --confirm

# Infographic
kaya-cli nlm infographic create <notebook-id> --confirm

# Video Overview
kaya-cli nlm video create <notebook-id> --confirm
```

### Data Tables

```bash
# Extract structured data
kaya-cli nlm data-table create <notebook-id> "Extract all dates and events" --confirm
```

## Research & Discovery

### Web Research

```bash
# Start web research
kaya-cli nlm research start "machine learning trends 2026" --notebook-id <id>

# Deep research (more thorough, ~5 min)
kaya-cli nlm research start "quantum computing applications" --mode deep

# Check progress
kaya-cli nlm research status <notebook-id>

# Import results as sources
kaya-cli nlm research import <notebook-id> <task-id>
```

### Drive Research

```bash
# Search your Google Drive
kaya-cli nlm research start "project notes" --source drive --notebook-id <id>
```

## Aliases (Shortcuts)

```bash
# Create alias for long UUID
kaya-cli nlm alias set myproject abc123-def456-ghi789

# Use alias anywhere
kaya-cli nlm notebook query myproject "Summarize"
kaya-cli nlm source list myproject
kaya-cli nlm audio create myproject --confirm

# List all aliases
kaya-cli nlm alias list

# Delete alias
kaya-cli nlm alias delete myproject
```

## Artifact Management

```bash
# List generated content (podcasts, reports, etc.)
kaya-cli nlm studio status <notebook-id>

# Delete artifact
kaya-cli nlm studio delete <notebook-id> <artifact-id> --confirm
```

## Configuration

```bash
# Show all settings
kaya-cli nlm config show

# Get specific value
kaya-cli nlm config get default_output_format

# Set value
kaya-cli nlm config set default_output_format json
```

## Multiple Profiles

```bash
# Create work profile
kaya-cli nlm login --profile work

# List profiles
kaya-cli nlm auth list

# Use specific profile
kaya-cli nlm notebook list --profile work

# Delete profile
kaya-cli nlm auth delete work --confirm
```

## Integration Examples

### Export Notebook to Markdown

```bash
notebook_id=$(kaya-cli nlm alias get research)
kaya-cli nlm notebook query "$notebook_id" "Create a comprehensive summary" > summary.md
```

### Batch Add URLs

```bash
while read url; do
  kaya-cli nlm source add myproject --url "$url"
done < urls.txt
```

### Daily Research Automation

```bash
#!/bin/bash
# Add to cron for daily research

# Start research
kaya-cli nlm research start "AI news $(date +%Y-%m-%d)" --notebook-id myproject --mode deep

# Wait for completion (check periodically)
sleep 300

# Import results
task_id=$(kaya-cli nlm research status myproject --json | jq -r '.tasks[0].id')
kaya-cli nlm research import myproject "$task_id"
```

### Generate Study Materials

```bash
notebook="abc123"

# Generate all study materials
kaya-cli nlm flashcards create "$notebook" --confirm
kaya-cli nlm quiz create "$notebook" --confirm
kaya-cli nlm mindmap create "$notebook" --confirm
kaya-cli nlm report create "$notebook" --confirm
```

## Error Handling

```bash
# Check if authenticated
if ! kaya-cli nlm auth status --quiet 2>/dev/null; then
  echo "Please authenticate: kaya-cli nlm login"
  exit 1
fi

# Verify notebook exists
if ! kaya-cli nlm notebook get "$notebook_id" --quiet 2>/dev/null; then
  echo "Notebook not found: $notebook_id"
  exit 1
fi
```

## Common Issues

| Issue | Solution |
|-------|----------|
| "Profile not found" | Run `kaya-cli nlm login` |
| "Session expired" | Re-run `kaya-cli nlm login` |
| "Chrome not found" | Install Google Chrome |
| "Rate limited" | Wait a few minutes |
| Source add fails | Check URL is accessible |

## Performance

- List operations: < 1s
- Query: 2-5s (depends on response)
- Audio generation: 1-3 minutes
- Deep research: ~5 minutes
- Video generation: 2-5 minutes

## CLI vs MCP

This CLI **replaces** the MCP server approach:
- No browser automation overhead
- Direct API calls (reverse-engineered)
- Faster response times
- Works standalone (no Claude needed)

## Documentation

- GitHub: https://github.com/jacob-bd/notebooklm-cli
- NotebookLM: https://notebooklm.google
- CLI source: `~/.claude/tools/UnixCLI/NotebookLM.ts` (thin wrapper)
