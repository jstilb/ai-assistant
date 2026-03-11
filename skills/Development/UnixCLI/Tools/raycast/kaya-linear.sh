#!/bin/bash

# Required parameters:
# @raycast.schemaVersion 1
# @raycast.title Kaya Linear
# @raycast.mode inline
# @raycast.refreshTime 5m

# Optional parameters:
# @raycast.icon 🎯
# @raycast.packageName Kaya

# Documentation:
# @raycast.description Show Linear issues assigned to me
# @raycast.author Kaya
# @raycast.authorURL https://github.com/[user]/kaya

# Check if linear CLI is installed
if ! command -v linear &> /dev/null; then
    echo "🎯 Linear CLI not installed"
    exit 0
fi

# Get issue count
issue_count=$("$HOME/.claude/bin/kaya-cli" linear issue list --assignee @me --json 2>/dev/null | jq 'length')

if [[ -z "$issue_count" || "$issue_count" == "null" ]]; then
    echo "🎯 Could not fetch issues"
else
    echo "🎯 $issue_count issues"
fi
