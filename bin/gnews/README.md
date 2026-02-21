# gnews - GNews API Command-Line Interface

**Version:** 1.0.0
**Last Updated:** 2026-01-29

---

## Overview

gnews is a clean, deterministic command-line interface for searching and browsing news articles from 60,000+ worldwide sources via the [GNews API](https://gnews.io/).

### Philosophy

gnews follows **CLI-First Architecture**:

1. **Deterministic** - Same input always produces same output
2. **Clean** - Single responsibility (news search and headlines)
3. **Composable** - JSON output pipes to jq, grep, other tools
4. **Documented** - Comprehensive help and examples
5. **Testable** - Predictable, verifiable behavior

---

## Installation

### 1. Get API Key

1. Create a free account at [gnews.io](https://gnews.io/)
2. Verify your email
3. Copy your API key from the dashboard

### 2. Configure

Add your API key to `~/.claude/secrets.json`:

```json
{
  "GNEWS_API_KEY": "your_api_key_here"
}
```

Or set as environment variable (for CI/testing):

```bash
export GNEWS_API_KEY=your_api_key_here
```

### 3. Make Executable

```bash
chmod +x ~/.claude/Bin/gnews/gnews.ts
```

### 4. Add to PATH (optional)

```bash
# Add to ~/.zshrc or ~/.bashrc
alias gnews="bun ~/.claude/Bin/gnews/gnews.ts"
```

---

## Usage

### Search for Articles

```bash
# Basic search
gnews search "artificial intelligence"

# Search with filters
gnews search "climate change" --lang en --country us --max 20

# Search with date range
gnews search "election" --from 2024-01-01 --to 2024-06-30

# Sort by relevance instead of date
gnews search "startup funding" --sortby relevance
```

### Top Headlines

```bash
# Get general headlines
gnews headlines

# Get category-specific headlines
gnews headlines --category technology
gnews headlines --category business --country us

# Filter headlines by keyword
gnews headlines --category sports --query "championship"
```

### Reference Commands

```bash
# List available categories
gnews categories

# List available language codes
gnews languages

# List available country codes
gnews countries
```

---

## Options Reference

### Search Options

| Option | Description | Example |
|--------|-------------|---------|
| `--lang <code>` | Filter by language | `--lang en` |
| `--country <code>` | Filter by country | `--country us` |
| `--max <n>` | Number of articles (1-100) | `--max 20` |
| `--from <date>` | Start date (ISO 8601) | `--from 2024-01-01` |
| `--to <date>` | End date (ISO 8601) | `--to 2024-12-31` |
| `--sortby <field>` | Sort by: publishedAt, relevance | `--sortby relevance` |
| `--in <fields>` | Search in: title, description, content | `--in title` |

### Headlines Options

| Option | Description | Example |
|--------|-------------|---------|
| `--category <name>` | News category | `--category technology` |
| `--lang <code>` | Filter by language | `--lang en` |
| `--country <code>` | Filter by country | `--country gb` |
| `--max <n>` | Number of articles (1-100) | `--max 15` |
| `--query <q>` | Filter by keyword | `--query "AI"` |

### Available Categories

- `general` (default)
- `world`
- `nation`
- `business`
- `technology`
- `entertainment`
- `sports`
- `science`
- `health`

---

## Examples with jq

gnews outputs JSON, making it perfect for piping to jq:

```bash
# Get just article titles
gnews search "AI" | jq '.articles[].title'

# Get titles and URLs
gnews headlines --category tech | jq '.articles[] | {title, url}'

# Get first 3 article URLs
gnews search "startup" | jq -r '.articles[:3][].url'

# Count total articles
gnews search "climate" | jq '.totalArticles'

# Get articles from specific source
gnews headlines | jq '.articles[] | select(.source.name == "BBC")'

# Export to CSV-like format
gnews search "election" | jq -r '.articles[] | [.publishedAt, .source.name, .title] | @tsv'
```

---

## Response Format

All commands return JSON:

```json
{
  "totalArticles": 1234,
  "articles": [
    {
      "title": "Article headline",
      "description": "Brief summary of the article",
      "content": "Article content (may be truncated on free plan)",
      "url": "https://source.com/full-article",
      "image": "https://source.com/image.jpg",
      "publishedAt": "2024-01-15T10:30:00Z",
      "source": {
        "name": "Source Name",
        "url": "https://source.com"
      }
    }
  ]
}
```

---

## Rate Limits

| Plan | Requests/Day | Articles/Request | Data Delay |
|------|--------------|------------------|------------|
| Free | 100 | 10 | 12 hours |
| Essential | 1,000 | 25 | Real-time |
| Business | 5,000 | 50 | Real-time |
| Enterprise | 25,000 | 100 | Real-time |

---

## Error Handling

gnews provides clear error messages:

```
Error: Invalid API key
Check your GNEWS_API_KEY and try again

Error: API rate limit exceeded or plan limit reached
Free plan: 100 requests/day

Error: Invalid category 'invalid'
Valid categories: general, world, nation, business, technology, entertainment, sports, science, health
```

Exit codes:
- `0` - Success
- `1` - Error (invalid input, API error, network failure)

---

## Why This CLI Exists

GNews provides excellent news data but no official CLI. gnews fills that gap with:

- **No dependencies** - Pure TypeScript/Bun, no frameworks
- **Instant usability** - Works immediately after API key setup
- **Unix philosophy** - JSON output, composable with other tools
- **Comprehensive help** - Full documentation built-in

---

## Troubleshooting

### "GNEWS_API_KEY not found"

Add the API key to `~/.claude/secrets.json`:
```json
{
  "GNEWS_API_KEY": "your_key_here"
}
```

### "API rate limit exceeded"

Free plan is limited to 100 requests/day. Wait until UTC midnight or upgrade at [gnews.io](https://gnews.io/).

### "Network request failed"

Check your internet connection and try again.

---

## Links

- [GNews API Documentation](https://docs.gnews.io/)
- [Get API Key](https://gnews.io/)
- [Pricing](https://gnews.io/#pricing)

---

**Built with CLI-First Architecture principles.**
