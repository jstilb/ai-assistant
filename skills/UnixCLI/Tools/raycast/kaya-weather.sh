#!/bin/bash

# Required parameters:
# @raycast.schemaVersion 1
# @raycast.title Kaya Weather
# @raycast.mode inline
# @raycast.refreshTime 30m

# Optional parameters:
# @raycast.icon 🌤️
# @raycast.packageName Kaya

# Documentation:
# @raycast.description Show current weather
# @raycast.author Kaya
# @raycast.authorURL https://github.com/your-username/kaya

# Get weather one-liner
weather=$(bun run "$HOME/.claude/tools/UnixCLI/Weather.ts" --oneline 2>/dev/null)

if [[ -z "$weather" ]]; then
    echo "🌤️ Weather unavailable"
else
    echo "$weather"
fi
