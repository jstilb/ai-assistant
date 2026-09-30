# GitHub Workflow

GitHub operations via `gh` CLI (official GitHub CLI).

## Prerequisites

- GitHub CLI installed (`brew install gh`)
- GitHub account

## Installation

```bash
# Install via Homebrew
brew install gh

# Usually pre-installed - check with:
gh --version
```

## Authentication

```bash
# Login (opens browser)
gh auth login

# Login with token
gh auth login --with-token < ~/.github_token

# Check status
gh auth status
```

## Quick Start

```bash
# List PRs
kaya-cli github pr list

# Create issue
kaya-cli github issue create --title "Bug report"

# View PR
kaya-cli github pr view 123

# Clone repo
kaya-cli github repo clone owner/repo
```

## Profile Management

The `profile` subcommand provides operations not available in the standard `gh` CLI:

```bash
# Full profile overview
kaya-cli gh profile status

# Pinned repos
kaya-cli gh profile pins
kaya-cli gh profile pin repo1 repo2 repo3
kaya-cli gh profile unpin

# Bio
kaya-cli gh profile bio
kaya-cli gh profile bio "New bio text"

# Repository topics
kaya-cli gh profile topics my-repo
kaya-cli gh profile topics my-repo typescript ai ml

# Traffic analytics
kaya-cli gh profile analytics              # Top repos overview
kaya-cli gh profile analytics my-repo      # Detailed traffic
kaya-cli gh profile analytics my-repo --json
```

**Note:** Pin/unpin mutations are not available in GitHub's public GraphQL schema. The tool resolves repo node IDs and provides manual pinning instructions as a fallback.

**Scopes:** Some operations require additional OAuth scopes:
- `pin/unpin`: `user` scope (`gh auth refresh -s user`)
- `analytics`: push access to the repository

## Commands

All `gh` commands are passed through. Common ones:

| Command | Description |
|---------|-------------|
| `pr list` | List pull requests |
| `pr create` | Create a PR |
| `pr view` | View PR details |
| `pr merge` | Merge a PR |
| `pr checkout` | Check out a PR branch |
| `issue list` | List issues |
| `issue create` | Create an issue |
| `issue view` | View issue details |
| `repo clone` | Clone a repository |
| `repo view` | View repo details |
| `workflow list` | List GitHub Actions |
| `workflow run` | Trigger a workflow |
| `release list` | List releases |
| `release create` | Create a release |

## Pull Request Operations

### List PRs

```bash
# All open PRs
kaya-cli github pr list

# My PRs
kaya-cli github pr list --author @me

# Ready for review
kaya-cli github pr list --search "is:open review:required"

# JSON output
kaya-cli github pr list --json number,title,author
```

### Create PR

```bash
# Interactive
kaya-cli github pr create

# With details
kaya-cli github pr create \
    --title "Add new feature" \
    --body "Description here" \
    --base main

# Draft PR
kaya-cli github pr create --draft
```

### Review and Merge

```bash
# View PR
kaya-cli github pr view 123

# Check out PR locally
kaya-cli github pr checkout 123

# Approve
kaya-cli github pr review 123 --approve

# Merge
kaya-cli github pr merge 123 --squash
```

## Issue Operations

### List Issues

```bash
# All open issues
kaya-cli github issue list

# Assigned to me
kaya-cli github issue list --assignee @me

# With labels
kaya-cli github issue list --label bug

# JSON output
kaya-cli github issue list --json number,title,labels
```

### Create Issue

```bash
# Interactive
kaya-cli github issue create

# With details
kaya-cli github issue create \
    --title "Bug: Login fails" \
    --body "Steps to reproduce..." \
    --label bug,priority-high

# From template
kaya-cli github issue create --template bug_report.md
```

## Repository Operations

```bash
# Clone
kaya-cli github repo clone owner/repo

# Fork
kaya-cli github repo fork owner/repo

# Create
kaya-cli github repo create my-new-repo --public

# View
kaya-cli github repo view owner/repo
```

## GitHub Actions

```bash
# List workflows
kaya-cli github workflow list

# Run workflow
kaya-cli github workflow run ci.yml

# View run
kaya-cli github run view 12345

# Watch run
kaya-cli github run watch 12345
```

## Releases

```bash
# List releases
kaya-cli github release list

# Create release
kaya-cli github release create v1.0.0 --generate-notes

# Download assets
kaya-cli github release download v1.0.0
```

## Integration Examples

### PR Automation

```bash
#!/bin/bash
# auto-pr.sh - Create PR from current branch

BRANCH=$(git branch --show-current)
kaya-cli github pr create \
    --title "$BRANCH" \
    --fill \
    --draft
```

### Issue from Template

```bash
#!/bin/bash
# create-bug.sh

kaya-cli github issue create \
    --title "$1" \
    --label bug \
    --assignee @me
```

### CI Status Check

```bash
#!/bin/bash
# Check if CI passed on current PR

pr_number=$(kaya-cli github pr view --json number -q .number)
status=$(kaya-cli github pr checks "$pr_number" --json state -q '.[0].state')

if [[ "$status" == "SUCCESS" ]]; then
    echo "✅ CI passed"
else
    echo "❌ CI status: $status"
fi
```

## JSON Output

Most commands support `--json` with field selection:

```bash
# Get specific fields
kaya-cli github pr list --json number,title,author

# Query with jq syntax
kaya-cli github pr list --json number,title -q '.[].title'

# Complex query
kaya-cli github issue list --json number,labels \
    -q '.[] | select(.labels[].name == "bug") | .number'
```

## Error Handling

```bash
# Check authentication
if ! kaya-cli github auth status &> /dev/null; then
    echo "Not authenticated. Run: gh auth login"
    exit 1
fi

# Check if in repo
if ! kaya-cli github repo view &> /dev/null; then
    echo "Not in a GitHub repository"
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

- gh CLI: https://cli.github.com/manual/
- GitHub API: https://docs.github.com/en/rest
