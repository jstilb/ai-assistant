# Linear Workflow

Linear issue tracking via `linearis` CLI (Rust-based, actively maintained).

## Prerequisites

- Rust/Cargo installed (for installation)
- Linear account with API key

## Installation

```bash
# Via Cargo (recommended)
cargo install linearis

# Or via install script
kaya-cli linear --help  # Will show install instructions if not found
```

## Authentication

```bash
# Set API key (generate at https://linear.app/settings/api)
export LINEAR_API_KEY="your-api-key"

# Or store in secrets.json
# ~/.claude/secrets.json:
# {
#   "LINEAR_API_KEY": "your-api-key"
# }
```

## Quick Start

```bash
# List issues assigned to me
kaya-cli linear issue list

# Create an issue
kaya-cli linear issue create --title "Bug fix" --team TEAM_ID

# View issue details
kaya-cli linear issue view ISSUE_ID
```

## Commands

| Command | Description |
|---------|-------------|
| `issue list` | List issues |
| `issue create` | Create new issue |
| `issue view` | View issue details |
| `issue update` | Update issue |
| `project list` | List projects |
| `team list` | List teams |

## Common Operations

### List Issues

```bash
# My assigned issues
kaya-cli linear issue list

# All issues in team
kaya-cli linear issue list --team TEAM_ID

# Filter by status
kaya-cli linear issue list --status "In Progress"

# JSON output
kaya-cli linear issue list --json
```

### Create Issue

```bash
# Basic issue
kaya-cli linear issue create --title "New feature request"

# With team and description
kaya-cli linear issue create \
    --title "Fix login bug" \
    --team TEAM_ID \
    --description "Users can't login with SSO"

# With priority
kaya-cli linear issue create \
    --title "Critical fix" \
    --priority urgent
```

### View and Update

```bash
# View issue
kaya-cli linear issue view ABC-123

# Update status
kaya-cli linear issue update ABC-123 --status "Done"

# Assign to user
kaya-cli linear issue update ABC-123 --assignee user@example.com
```

### Projects and Teams

```bash
# List teams
kaya-cli linear team list

# List projects
kaya-cli linear project list

# Filter projects by team
kaya-cli linear project list --team TEAM_ID
```

## Integration Examples

### Daily Standup

```bash
#!/bin/bash
# Get issues I'm working on
echo "My In Progress Issues:"
kaya-cli linear issue list --status "In Progress" --assignee me

echo ""
echo "Completed Yesterday:"
kaya-cli linear issue list --status "Done" --updated-since "24h"
```

### Batch Operations

```bash
# Move all issues from backlog to sprint
kaya-cli linear issue list --status "Backlog" --json | \
    jq -r '.[].id' | \
    xargs -I {} kaya-cli linear issue update {} --status "Todo"
```

### CI/CD Integration

```bash
# Create issue on build failure
if ! make build; then
    kaya-cli linear issue create \
        --title "Build failed: ${GITHUB_SHA:0:7}" \
        --team "Engineering" \
        --priority "high" \
        --labels "bug,ci"
fi
```

## CLI vs MCP

| Use CLI When | Use MCP When |
|--------------|--------------|
| Scripting | Interactive queries |
| CI/CD pipelines | Complex workflows |
| Batch operations | Real-time updates |
| Cron jobs | Conversational |

## Error Handling

```bash
# Check for authentication
if ! kaya-cli linear team list &> /dev/null; then
    echo "Linear authentication failed"
    echo "Set LINEAR_API_KEY environment variable"
    exit 1
fi
```

## Performance

- List operations: < 2s
- Create/Update: < 1s
- Batch operations: Rate limited by Linear API

## Documentation

- Linear API: https://developers.linear.app/docs
- linearis: https://github.com/yourusername/linearis
