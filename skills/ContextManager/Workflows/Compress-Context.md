# Compress-Context Workflow

**Trigger:** Manual via CLI

## Usage

```bash
# Compress all files defined in compression-rules.json
bun skills/ContextManager/Tools/ContextCompressor.ts --all

# Compress a specific file
bun skills/ContextManager/Tools/ContextCompressor.ts --file CLAUDE.md
```

## When to Run

- After major updates to SKILL.md, TELOS files, or context files
- Weekly as part of maintenance
- Before enabling ContextManager for first time

## What It Does

1. Reads compression-rules.json for target sizes
2. Uses Haiku inference to summarize each file
3. Preserves: key facts, dates, numbers, statuses, file paths
4. Outputs .compressed.md alongside originals
5. Skips files under 30 lines
