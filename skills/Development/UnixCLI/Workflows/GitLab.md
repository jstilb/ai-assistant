# GitLab Workflow

GitLab operations via `glab` CLI (official GitLab CLI).

## Prerequisites

- glab installed (`brew install glab`)
- GitLab account

## Installation

```bash
# Install via Homebrew
brew install glab

# Or via install script
bash ~/.claude/tools/UnixCLI/install-cli-tools.sh
```

## Authentication

```bash
# Login (interactive)
glab auth login

# Login to self-hosted
glab auth login --hostname gitlab.company.com

# Check status
glab auth status
```

## Quick Start

```bash
# List merge requests
kaya-cli gitlab mr list

# Create issue
kaya-cli gitlab issue create --title "Feature request"

# View MR
kaya-cli gitlab mr view 123

# Clone project
kaya-cli gitlab repo clone group/project
```

## Commands

All `glab` commands are passed through. Common ones:

| Command | Description |
|---------|-------------|
| `mr list` | List merge requests |
| `mr create` | Create an MR |
| `mr view` | View MR details |
| `mr merge` | Merge an MR |
| `mr checkout` | Check out an MR branch |
| `issue list` | List issues |
| `issue create` | Create an issue |
| `issue view` | View issue details |
| `project list` | List projects |
| `project view` | View project details |
| `pipeline list` | List pipelines |
| `pipeline view` | View pipeline details |
| `ci status` | Show CI status |

## Merge Request Operations

### List MRs

```bash
# All open MRs
kaya-cli gitlab mr list

# My MRs
kaya-cli gitlab mr list --author=@me

# Ready for review
kaya-cli gitlab mr list --reviewer=@me

# JSON output
kaya-cli gitlab mr list --output json
```

### Create MR

```bash
# Interactive
kaya-cli gitlab mr create

# With details
kaya-cli gitlab mr create \
    --title "Add new feature" \
    --description "Description here" \
    --target-branch main

# Draft MR
kaya-cli gitlab mr create --draft
```

### Review and Merge

```bash
# View MR
kaya-cli gitlab mr view 123

# Check out MR locally
kaya-cli gitlab mr checkout 123

# Approve
kaya-cli gitlab mr approve 123

# Merge
kaya-cli gitlab mr merge 123 --squash
```

## Issue Operations

### List Issues

```bash
# All open issues
kaya-cli gitlab issue list

# Assigned to me
kaya-cli gitlab issue list --assignee=@me

# With labels
kaya-cli gitlab issue list --label=bug

# JSON output
kaya-cli gitlab issue list --output json
```

### Create Issue

```bash
# Interactive
kaya-cli gitlab issue create

# With details
kaya-cli gitlab issue create \
    --title "Bug: Login fails" \
    --description "Steps to reproduce..." \
    --label=bug,priority::high

# Confidential
kaya-cli gitlab issue create --confidential
```

## Pipeline Operations

```bash
# List pipelines
kaya-cli gitlab pipeline list

# View pipeline
kaya-cli gitlab pipeline view 12345

# CI status of current branch
kaya-cli gitlab ci status

# Trigger pipeline
kaya-cli gitlab ci run

# View job logs
kaya-cli gitlab ci view --job-id 67890
```

## Project Operations

```bash
# Clone
kaya-cli gitlab repo clone group/project

# Fork
kaya-cli gitlab repo fork group/project

# Create
kaya-cli gitlab repo create my-new-project

# View
kaya-cli gitlab project view
```

## Integration Examples

### MR Automation

```bash
#!/bin/bash
# auto-mr.sh - Create MR from current branch

BRANCH=$(git branch --show-current)
kaya-cli gitlab mr create \
    --title "$BRANCH" \
    --fill \
    --draft
```

### CI Monitoring

```bash
#!/bin/bash
# wait-for-ci.sh

echo "Waiting for CI..."
while true; do
    status=$(kaya-cli gitlab ci status --output json | jq -r '.status')
    case "$status" in
        success)
            echo "✅ CI passed"
            exit 0
            ;;
        failed)
            echo "❌ CI failed"
            exit 1
            ;;
        *)
            echo "⏳ Status: $status"
            sleep 30
            ;;
    esac
done
```

### Deploy Trigger

```bash
#!/bin/bash
# deploy.sh

# Trigger deploy pipeline
kaya-cli gitlab ci run --variables "DEPLOY_ENV=production"

echo "Deploy triggered"
```

## JSON Output

Most commands support `--output json`:

```bash
# Get JSON
kaya-cli gitlab mr list --output json

# Pipe to jq
kaya-cli gitlab mr list --output json | jq '.[].title'

# Filter
kaya-cli gitlab issue list --output json | \
    jq '.[] | select(.labels[] == "bug") | .iid'
```

## Error Handling

```bash
# Check authentication
if ! kaya-cli gitlab auth status &> /dev/null; then
    echo "Not authenticated. Run: glab auth login"
    exit 1
fi

# Check if in repo
if ! kaya-cli gitlab project view &> /dev/null; then
    echo "Not in a GitLab repository"
    exit 1
fi
```

## CLI vs MCP

| Use CLI When | Use MCP When |
|--------------|--------------|
| Scripting | Interactive exploration |
| CI/CD pipelines | Complex queries |
| Quick operations | Multi-step workflows |
| Automation | Conversational |

## Documentation

- glab CLI: https://gitlab.com/gitlab-org/cli
- GitLab API: https://docs.gitlab.com/ee/api/
