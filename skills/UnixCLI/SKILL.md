---
name: UnixCLI
description: Unix-style CLI tools for external services. USE WHEN user wants CLI operations, pipe operations, youtube download, calendar via CLI, drive sync, gmail CLI, gemini CLI, tasks CLI, bluesky CLI, OR mentions kaya-cli, unix tools, command-line interface.
version: 1.0.0
---

# UnixCLI - Unix-Style CLI Tools for Kaya

Unix-first approach to integrating external services. Leverage mature, battle-tested CLI tools with pipe composition and shell scripting.

## Philosophy

**Prefer existing tools over custom implementations.** The Unix philosophy: do one thing well, compose via pipes. We integrate mature CLI tools rather than building custom wrappers.

**Why CLI tools?**
- **Composability**: Pipe outputs into jq, awk, grep
- **Scriptability**: Use in bash scripts, cron jobs, automation
- **Reliability**: Battle-tested tools with years of production use
- **Transparency**: See exactly what's executed
- **Efficiency**: Direct tool invocation, no API overhead

## Quick Start

```bash
# YouTube video metadata
kaya-cli youtube --dump-json URL | jq '.title'

# Today's calendar
kaya-cli calendar agenda

# LucidTasks
kaya-cli tasks --json

# Weather
kaya-cli weather "San Francisco"

# GitHub PRs
kaya-cli github pr list

# Interactive mode
kaya-cli repl
```

## Available Services (18 Total)

### Core Services

| Service | Aliases | CLI Tool | Status | Docs |
|---------|---------|----------|--------|------|
| YouTube | `yt` | yt-dlp | ✓ Installed | [Workflow](Workflows/YouTube.md) |
| Calendar | `gcal` | gcalcli | ✓ Installed | [Workflow](Workflows/Calendar.md) |
| Drive | - | rclone | ✓ Installed | [Workflow](Workflows/Drive.md) |
| Gmail | - | gog | ✓ Installed | [Workflow](Workflows/Gmail.md) |
| Gemini | `ai` | gemini-cli | ✓ Installed | [Workflow](Workflows/Gemini.md) |
| Sheets | - | Custom TS | ✓ Available | [Workflow](Workflows/Sheets.md) |
| Places | - | Custom TS | ✓ Available | [Workflow](Workflows/Places.md) |
| Bluesky | `bsky` | bsky | ✓ Installed | [Workflow](Workflows/Bluesky.md) |
| Playwright | `pw`, `browser` | Browse.ts | ✓ Available | Browser skill |
| NotebookLM | `nlm` | NotebookLM.ts | ✓ Available | [Workflow](Workflows/NotebookLM.md) |

### Task & Project Management

| Service | Aliases | CLI Tool | Status | Docs |
|---------|---------|----------|--------|------|
| LucidTasks | `lt`, `tasks` | TaskManager.ts | ✓ Available | [Workflow](../LucidTasks/SKILL.md) |
| Linear | - | linearis | Install needed | [Workflow](Workflows/Linear.md) |

### Code & DevOps

| Service | Aliases | CLI Tool | Status | Docs |
|---------|---------|----------|--------|------|
| GitHub | `gh` | gh + GitHubProfile.ts | ✓ Installed | [Workflow](Workflows/GitHub.md) |
| GitLab | - | glab | Install needed | [Workflow](Workflows/GitLab.md) |

### Communication

| Service | Aliases | CLI Tool | Status | Docs |
|---------|---------|----------|--------|------|
| Slack | - | slackcat | Install needed | [Workflow](Workflows/Slack.md) |

### Utilities

| Service | Aliases | CLI Tool | Status | Docs |
|---------|---------|----------|--------|------|
| Weather | - | Weather.ts | ✓ Available | [Workflow](Workflows/Weather.md) |
| 1Password | `op`, `secrets` | op | Install needed | [Workflow](Workflows/1Password.md) |
| REPL | `i`, `interactive` | repl/index.ts | ✓ Available | Below |

### Cloud Services (Optional)

| Service | Aliases | CLI Tool | Status | Docs |
|---------|---------|----------|--------|------|
| Stripe | - | stripe | Optional | [Workflow](Workflows/Stripe.md) |
| Supabase | - | supabase | Optional | [Workflow](Workflows/Supabase.md) |
| Firebase | - | firebase | Optional | [Workflow](Workflows/Firebase.md) |

## Installation

### Quick Setup

```bash
# Install core tools
bash ~/.claude/skills/UnixCLI/Tools/install-cli-tools.sh

# Install with optional cloud tools
bash ~/.claude/skills/UnixCLI/Tools/install-cli-tools.sh --all

# Validate all tools
bash ~/.claude/skills/UnixCLI/Tools/validate-installations.sh
```

### Tab Completion

After installation, restart your terminal or:

```bash
# Zsh
source ~/.zshrc

# Bash
source ~/.bashrc
```

Completions support all services and subcommands.

## Workflow Routing

| Trigger | Route To | Purpose |
|---------|----------|---------|
| youtube download, yt-dlp | [YouTube](Workflows/YouTube.md) | Download videos, extract metadata |
| calendar CLI, gcalcli | [Calendar](Workflows/Calendar.md) | View events, create appointments |
| drive sync, rclone | [Drive](Workflows/Drive.md) | Sync files, backup data |
| gmail CLI, gog | [Gmail](Workflows/Gmail.md) | Search emails, send messages |
| gemini CLI, AI query | [Gemini](Workflows/Gemini.md) | AI queries, content generation |
| sheets CLI, spreadsheet | [Sheets](Workflows/Sheets.md) | Read/write Google Sheets |
| places CLI, nearby | [Places](Workflows/Places.md) | Discover places, business info |
| lucidtasks CLI, tasks | [LucidTasks](../LucidTasks/SKILL.md) | Full CRUD task management |
| bluesky CLI, bsky | [Bluesky](Workflows/Bluesky.md) | Social media operations |
| weather | [Weather](Workflows/Weather.md) | Current conditions, forecast |
| linear issues | [Linear](Workflows/Linear.md) | Issue tracking |
| github pr, gh | [GitHub](Workflows/GitHub.md) | PRs, issues, repos |
| gitlab mr | [GitLab](Workflows/GitLab.md) | MRs, pipelines |
| slack send | [Slack](Workflows/Slack.md) | Send messages |
| op secrets | [1Password](Workflows/1Password.md) | Secret management |
| stripe events | [Stripe](Workflows/Stripe.md) | Payment operations |
| supabase db | [Supabase](Workflows/Supabase.md) | Database, functions |
| firebase deploy | [Firebase](Workflows/Firebase.md) | Hosting, functions |
| notebooklm, nlm ask | [NotebookLM](Workflows/NotebookLM.md) | Query notebooks, manage library |

## Pipe Composition Examples

### LucidTasks + jq
```bash
# Get incomplete task names
kaya-cli tasks --incomplete --json | jq -r '.[].name'

# Count tasks by project
kaya-cli tasks --json | jq 'group_by(.project) | map({project: .[0].project, count: length})'
```

### Weather + Scripts
```bash
# Weather in prompt
temp=$(kaya-cli weather --quiet | tr -d '+°C')
echo "Current: ${temp}°C"

# Notification on rain
rain=$(kaya-cli weather --json | jq -r '.weather[0].hourly[8].chanceofrain')
[[ "$rain" -gt 50 ]] && echo "🌧️ Bring umbrella!"
```

### GitHub + Automation
```bash
# List my open PRs
kaya-cli github pr list --author @me --json number,title | jq -r '.[] | "#\(.number): \(.title)"'

# Check CI status
kaya-cli github pr checks --json state -q '.[0].state'
```

### Cross-Service Workflows
```bash
# Create LucidTask from GitHub issue
issue=$(kaya-cli github issue view 123 --json title,body)
title=$(echo "$issue" | jq -r '.title')
kaya-cli tasks add "$title"
```

## Interactive REPL

Start an interactive session:

```bash
kaya-cli repl

# In REPL:
kaya> tasks --json
kaya> weather "New York"
kaya> github pr list
kaya> help
kaya> exit
```

Features:
- Tab completion for services and subcommands
- Command history (stored in `~/.claude/.kaya-cli-history`)
- Built-in commands: `help`, `services`, `history`, `clear`, `exit`

## Raycast Integration

Raycast scripts for quick access:

| Script | Description |
|--------|-------------|
| `kaya-tasks.sh` | LucidTasks task count |
| `kaya-calendar.sh` | Today's events |
| `kaya-weather.sh` | Current weather |
| `kaya-linear.sh` | Linear issue count |

**Install:**
```bash
# Symlink to Raycast scripts folder
ln -s ~/.claude/skills/UnixCLI/Tools/raycast/*.sh ~/Library/Scripts/Raycast/
```

## Authentication

### Google Services
```bash
# Configure Calendar, Drive, Gmail
bash ~/.claude/skills/UnixCLI/Tools/configure-google-auth.sh
```

### Bluesky
```bash
# Configure Bluesky
bash ~/.claude/skills/UnixCLI/Tools/configure-bluesky.sh
```

### Other Services
```bash
# LucidTasks: Local SQLite (no external auth needed)
# GitHub: gh auth login
# GitLab: glab auth login
# Slack: slackcat --configure
# 1Password: op signin
# Stripe: stripe login
# Supabase: supabase login
# Firebase: firebase login
```

## Output Formats

Most tools support JSON output for programmatic use:

| Tool | JSON Flag |
|------|-----------|
| yt-dlp | `--dump-json` |
| gcalcli | `--tsv` |
| gog | `--format json` |
| bsky | `--json` |
| tasks | `--json` |
| weather | `--json` |
| gh | `--json` |
| glab | `--output json` |

**JSON output is preferred** for piping to `jq`.

## Error Handling

```bash
# Check if service available
if ! kaya-cli github auth status &> /dev/null; then
    echo "GitHub not authenticated"
    exit 1
fi

# Handle command failure
if ! kaya-cli tasks --json > /tmp/tasks.json; then
    echo "Failed to fetch tasks"
    exit 1
fi
```

## Performance

CLI tools are fast - direct invocation without API overhead:
- yt-dlp metadata: < 1s
- gcalcli agenda: < 500ms
- tasks (LucidTasks): < 500ms
- weather: < 1s
- github pr list: < 1s

## When to Use CLI vs MCP

| Use CLI When | Use MCP When |
|--------------|--------------|
| Scripting and automation | Interactive workflows |
| Pipe composition | Complex multi-step flows |
| Batch operations | Real-time operations |
| Cron jobs | Conversational interface |
| CI/CD pipelines | Rich error handling |

**Both are valid.** Choose based on context.

## Troubleshooting

### Validation
```bash
bash ~/.claude/skills/UnixCLI/Tools/validate-installations.sh
```

### Check Individual Tools
```bash
which kaya-cli gh glab op stripe supabase firebase
kaya-cli --version
```

### Common Issues

1. **Tool not found**: Run install script
2. **Auth expired**: Re-authenticate with tool
3. **Rate limited**: Add delays between operations
4. **Completion not working**: Restart terminal

## Documentation

- **Installation**: `~/.claude/skills/UnixCLI/Tools/README.md`
- **Workflows**: Individual files in `Workflows/`
- **Completions**: `~/.claude/bin/completions/`
- **Raycast**: `~/.claude/skills/UnixCLI/Tools/raycast/`

## Customization

### Adding New Services
1. Install the CLI tool via Homebrew or Go
2. Create a workflow file in `Workflows/<ServiceName>.md`
3. Add routing entry to the Workflow Routing table above
4. Update `install-cli-tools.sh` and `validate-installations.sh`

### Custom Tools (TypeScript)
For services without mature CLI tools, create a TypeScript file in `Tools/`:
- Follow the pattern of `Weather.ts` or `Places.ts`
- Use `CachedHTTPClient` for HTTP requests
- Use `StateManager` for persistent state
- Support `--json` output and `--help` flags

### Configuration
- Secrets: `~/.claude/secrets.json` (API keys, tokens)
- Google OAuth: `~/.config/google/credentials.json`
- Task DB: `skills/LucidTasks/Data/tasks.db` (local SQLite)

## Voice Notification

When performing CLI operations that complete asynchronously or take more than a few seconds, notify the user via voice:

```bash
curl -X POST http://localhost:8888/notify \
  -H "Content-Type: application/json" \
  -d '{"message":"CLI operation completed successfully","title":"UnixCLI"}'
```

Recommended notification points:
- After batch task operations complete
- After long-running data imports/exports
- When scheduled maintenance tasks finish

---

**Version**: 1.0.0
**Last Updated**: 2026-01-29
**Maintainer**: Kaya System
