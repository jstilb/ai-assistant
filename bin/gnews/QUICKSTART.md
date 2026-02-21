# gnews Quick Start

**The 30-second guide to using gnews**

## Setup

```bash
# 1. Get free API key from https://gnews.io/

# 2. Add to ~/.claude/secrets.json:
#    "GNEWS_API_KEY": "your_key_here"

# 3. Make executable
chmod +x ~/.claude/Bin/gnews/gnews.ts

# 4. Create alias (optional)
alias gnews="bun ~/.claude/Bin/gnews/gnews.ts"
```

## Most Common Commands

```bash
# Search for news
gnews search "AI startups"

# Get tech headlines
gnews headlines --category technology

# US business news
gnews headlines --category business --country us

# Search with date range
gnews search "climate" --from 2024-01-01 --max 20
```

## Piping to jq

```bash
# Just titles
gnews search "AI" | jq '.articles[].title'

# Title + URL
gnews headlines | jq '.articles[] | {title, url}'

# First 5 URLs
gnews search "startup" | jq -r '.articles[:5][].url'
```

## Categories

`general` | `world` | `nation` | `business` | `technology` | `entertainment` | `sports` | `science` | `health`

## Help

```bash
gnews --help
```

## Full Documentation

See: `~/.claude/Bin/gnews/README.md`
