# Collect Content Workflow

Run the content collection pipeline: fetch enabled RSS sources, deduplicate, score, and store.

## Steps

1. **Check Sources**
   - Ensure sources are initialized: `bun ~/.claude/skills/ContentAggregator/Tools/SourceManager.ts list --enabled`
   - If no sources, initialize defaults: `bun ~/.claude/skills/ContentAggregator/Tools/SourceManager.ts init`

2. **Run Pipeline**
   - Full pipeline: `bun ~/.claude/skills/ContentAggregator/Tools/Pipeline.ts`
   - All sources: `bun ~/.claude/skills/ContentAggregator/Tools/Pipeline.ts --all-sources`
   - Collect only: `bun ~/.claude/skills/ContentAggregator/Tools/Pipeline.ts --collect-only`

3. **Report Results**
   - Report sources polled, items found, items stored
   - Note any failed sources
   - If digest was generated, note its location

## Troubleshooting

- **No items found**: Check source health with `bun SourceManager.ts --health`
- **All items filtered**: Review topic configuration
- **Source failing**: Check URL is accessible
