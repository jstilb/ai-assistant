#!/bin/bash

# Required parameters:
# @raycast.schemaVersion 1
# @raycast.title Kaya Calendar
# @raycast.mode inline
# @raycast.refreshTime 10m

# Optional parameters:
# @raycast.icon 📅
# @raycast.packageName Kaya

# Documentation:
# @raycast.description Show today's calendar events
# @raycast.author Kaya
# @raycast.authorURL https://github.com/your-username/kaya

# Get today's events
events=$("$HOME/.claude/bin/kaya-cli" calendar agenda --nostarted 2>/dev/null | head -3)

if [[ -z "$events" ]]; then
    echo "📅 No upcoming events"
else
    # Count events and show first one
    event_count=$(echo "$events" | wc -l | tr -d ' ')
    first_event=$(echo "$events" | head -1 | cut -c1-40)
    echo "📅 $event_count events | $first_event..."
fi
