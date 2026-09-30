#!/bin/bash

# Required parameters:
# @raycast.schemaVersion 1
# @raycast.title Kaya Tasks
# @raycast.mode inline
# @raycast.refreshTime 5m

# Optional parameters:
# @raycast.icon 📋
# @raycast.packageName Kaya

# Documentation:
# @raycast.description Show today's Asana tasks
# @raycast.author Kaya
# @raycast.authorURL https://github.com/danielmiessler/Kaya

# Get task count
task_count=$("$HOME/.claude/bin/kaya-cli" asana tasks --incomplete --json 2>/dev/null | jq 'length')

if [[ -z "$task_count" || "$task_count" == "null" ]]; then
    echo "⚠️ Could not fetch tasks"
else
    echo "📋 $task_count tasks"
fi
