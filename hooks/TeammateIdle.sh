#!/usr/bin/env bash
# TeammateIdle.sh - Quality gate hook: prevent premature agent idle
#
# Fires on TeammateIdle event. Checks whether unclaimed/unblocked tasks remain
# in the active task list. If work remains, blocks idle with exit code 2.
#
# Exit codes:
#   0 - Allow idle (no remaining work, or error reading task list)
#   1 - Hook error (non-blocking)
#   2 - Block idle + send feedback (unclaimed tasks exist)
#
# Feedback is written to stderr per Claude Code hook protocol.

set -euo pipefail

KAYA_DIR="${KAYA_DIR:-$HOME/.claude}"
TASK_DIR="$HOME/.claude/tasks"

# Read the hook input from stdin (JSON event data)
INPUT=$(cat)

# Extract team_name from the event if available
TEAM_NAME=$(echo "$INPUT" | python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
    print(data.get('team_name', ''))
except:
    print('')
" 2>/dev/null || echo "")

# Determine which task directory to check
if [ -n "$TEAM_NAME" ]; then
    ACTIVE_TASK_DIR="$TASK_DIR/$TEAM_NAME"
else
    # Try to find the most recently modified team task directory
    ACTIVE_TASK_DIR=$(find "$TASK_DIR" -maxdepth 1 -mindepth 1 -type d 2>/dev/null | sort -t/ -k1 | tail -1)
fi

# If no task directory found, allow idle (no team work in progress)
if [ -z "$ACTIVE_TASK_DIR" ] || [ ! -d "$ACTIVE_TASK_DIR" ]; then
    exit 0
fi

# Count unclaimed, unblocked pending tasks
# Task files are JSON with status, owner, and blockedBy fields
UNCLAIMED_COUNT=0
UNCLAIMED_TASKS=""

if [ -d "$ACTIVE_TASK_DIR" ]; then
    while IFS= read -r task_file; do
        if [ ! -f "$task_file" ]; then
            continue
        fi

        RESULT=$(python3 -c "
import sys, json
try:
    with open('$task_file') as f:
        task = json.load(f)
    status = task.get('status', '')
    owner = task.get('owner', '')
    blocked_by = task.get('blockedBy', [])

    # Only care about pending tasks with no owner and no blockers
    if status == 'pending' and not owner and not blocked_by:
        subject = task.get('subject', task.get('id', 'unknown'))
        print(f'UNCLAIMED:{subject}')
    else:
        print('OK')
except Exception as e:
    print('ERROR')
" 2>/dev/null || echo "ERROR")

        if [[ "$RESULT" == UNCLAIMED:* ]]; then
            TASK_SUBJECT="${RESULT#UNCLAIMED:}"
            UNCLAIMED_COUNT=$((UNCLAIMED_COUNT + 1))
            UNCLAIMED_TASKS="${UNCLAIMED_TASKS}  - ${TASK_SUBJECT}\n"
        fi
    done < <(find "$ACTIVE_TASK_DIR" -name "*.json" -maxdepth 1 2>/dev/null)
fi

# If unclaimed tasks exist, block idle
if [ "$UNCLAIMED_COUNT" -gt 0 ]; then
    echo -e "TeammateIdle blocked: ${UNCLAIMED_COUNT} unclaimed task(s) remain.\n\nAvailable work:\n${UNCLAIMED_TASKS}\nClaim the next available task instead of going idle." >&2
    exit 2
fi

# No remaining work — allow idle
exit 0
