# Slack Workflow

Slack messaging via `slackcat` (pipe-friendly) for sending messages.

## Prerequisites

- Homebrew installed
- Slack workspace access

## Installation

```bash
# Install via Homebrew
brew install slackcat

# Or via install script
bash ~/.claude/tools/UnixCLI/install-cli-tools.sh
```

## Authentication

```bash
# Configure slackcat (opens browser)
slackcat --configure

# This creates ~/.slackcat with your token
```

## Quick Start

```bash
# Send a message
echo "Hello from CLI!" | kaya-cli slack send --channel general

# Pipe command output
ls -la | kaya-cli slack send --channel dev

# Send file contents
cat report.txt | kaya-cli slack send --channel reports
```

## Commands

| Command | Description |
|---------|-------------|
| `send` | Send a message or file |
| `channels` | List channels (requires slack CLI) |

## Common Operations

### Send Messages

```bash
# To channel
echo "Hello team!" | kaya-cli slack send --channel general

# To user (DM)
echo "Private message" | kaya-cli slack send --channel @username

# With custom username
echo "Alert!" | kaya-cli slack send --channel alerts --username "Kaya Bot"

# Snippet (code block)
cat script.sh | kaya-cli slack send --channel dev --filetype sh
```

### Send Files

```bash
# Upload file
cat log.txt | kaya-cli slack send --channel logs --filename "server.log"

# With title
cat report.md | kaya-cli slack send --channel reports --title "Weekly Report"
```

### Pipe Operations

```bash
# Build output
make build 2>&1 | kaya-cli slack send --channel ci

# Test results
pytest --tb=short 2>&1 | kaya-cli slack send --channel tests

# System info
uptime && df -h | kaya-cli slack send --channel monitoring
```

## Integration Examples

### Build Notifications

```bash
#!/bin/bash
# notify-build.sh

if make build; then
    echo "✅ Build succeeded" | kaya-cli slack send --channel ci
else
    echo "❌ Build failed" | kaya-cli slack send --channel ci
fi
```

### Daily Reports

```bash
#!/bin/bash
# daily-report.sh

{
    echo "📊 Daily Report - $(date '+%Y-%m-%d')"
    echo ""
    echo "Tasks completed:"
    kaya-cli tasks --completed --json | jq -r '.[].name'
} | kaya-cli slack send --channel standup
```

### Monitoring Alerts

```bash
#!/bin/bash
# alert-on-error.sh

ERROR_COUNT=$(grep -c "ERROR" /var/log/app.log)
if (( ERROR_COUNT > 10 )); then
    echo "⚠️ High error rate: $ERROR_COUNT errors in the last hour" | \
        kaya-cli slack send --channel alerts
fi
```

### Cron Integration

```bash
# In crontab
0 9 * * * kaya-cli weather --oneline | kaya-cli slack send --channel general
0 18 * * 5 echo "🎉 Happy Friday!" | kaya-cli slack send --channel general
```

## Options

| Option | Description |
|--------|-------------|
| `--channel` | Target channel or @user |
| `--username` | Custom bot username |
| `--icon` | Custom icon emoji or URL |
| `--filename` | Name for uploaded file |
| `--filetype` | File type for syntax highlighting |
| `--title` | Title for snippet |

## Error Handling

```bash
# Check if configured
if ! command -v slackcat &> /dev/null; then
    echo "slackcat not installed"
    exit 1
fi

# Check if authenticated
if [[ ! -f ~/.slackcat ]]; then
    echo "Run: slackcat --configure"
    exit 1
fi
```

## CLI vs MCP

| Use CLI When | Use MCP When |
|--------------|--------------|
| Sending output from scripts | Reading messages |
| CI/CD notifications | Interactive conversations |
| Cron/scheduled messages | Channel management |
| Pipe-based workflows | Complex queries |

## Performance

- Message send: < 1s
- File upload: Depends on file size
- Rate limits: Slack API limits apply

## Documentation

- slackcat: https://github.com/bcicen/slackcat
- Slack API: https://api.slack.com/
