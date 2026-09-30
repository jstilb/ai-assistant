# Generate Digest Workflow

Generate a Markdown digest from collected content items.

## Steps

1. **Generate Digest from Stored Items**
   ```bash
   bun ~/.claude/skills/Content/ContentAggregator/Tools/Pipeline.ts --digest-only
   ```

2. **Or Run Full Pipeline** (collect + digest)
   ```bash
   bun ~/.claude/skills/Content/ContentAggregator/Tools/Pipeline.ts
   ```

3. **Preview Without Saving** (dry run)
   ```bash
   bun ~/.claude/skills/Content/ContentAggregator/Tools/Pipeline.ts --digest-only --dry-run
   ```

## Output

Digests are saved to `MEMORY/DIGESTS/digest-YYYY-MM-DD.md`

## Options

| Flag | Default | Description |
|------|---------|-------------|
| --limit N | 20 | Maximum items in digest |
| --days N | 1 | Number of days to include |
| --dry-run | false | Preview without saving |

## DailyBriefing Integration

The digest output feeds directly into the DailyBriefing news block.
