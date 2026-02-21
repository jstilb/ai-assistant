# Manage Sources Workflow

Add, remove, enable, disable, and monitor content sources.

## Commands

### List Sources
```bash
bun ~/.claude/skills/ContentAggregator/Tools/SourceManager.ts list [--json] [--enabled]
```

### Add Source
```bash
bun ~/.claude/skills/ContentAggregator/Tools/SourceManager.ts add --name "Source Name" --url "https://example.com/feed.xml" --type rss --topics "ai,tech" --trust-score 80
```

### Remove Source
```bash
bun ~/.claude/skills/ContentAggregator/Tools/SourceManager.ts remove --id "source-id"
```

### Enable/Disable Source
```bash
bun ~/.claude/skills/ContentAggregator/Tools/SourceManager.ts enable --id "source-id"
bun ~/.claude/skills/ContentAggregator/Tools/SourceManager.ts disable --id "source-id"
```

### Check Health
```bash
bun ~/.claude/skills/ContentAggregator/Tools/SourceManager.ts --health
```

## Health Status

- **healthy**: No recent failures
- **degraded**: 3+ consecutive failures (still enabled)
- **failing**: 5+ consecutive failures (auto-disabled)
