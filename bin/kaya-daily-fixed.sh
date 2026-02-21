#!/bin/bash
# Kaya Daily Maintenance Runner (FIXED)
# Runs at 8am daily via launchd
# Invokes /maintenance daily workflow
# FIX: Properly kills entire process group to prevent orphaned processes

KAYA_HOME="${HOME}/.claude"
LOG_DIR="${KAYA_HOME}/logs"
LOG_FILE="${LOG_DIR}/daily-$(date +%Y%m%d).log"
TIMEOUT=600  # 10 minutes

mkdir -p "${LOG_DIR}"

# Load OAuth token from secrets.json for headless authentication
if [ -f "${KAYA_HOME}/secrets.json" ]; then
    export CLAUDE_CODE_OAUTH_TOKEN=$(grep -o '"CLAUDE_CODE_OAUTH_TOKEN"[[:space:]]*:[[:space:]]*"[^"]*"' "${KAYA_HOME}/secrets.json" | sed 's/.*: *"//' | sed 's/"$//')
fi

echo "=== Kaya Daily Maintenance ===" >> "${LOG_FILE}"
echo "Started: $(date)" >> "${LOG_FILE}"
echo "PID: $$" >> "${LOG_FILE}"
echo "" >> "${LOG_FILE}"

# Cleanup function to kill all child processes
cleanup() {
    local EXIT_CODE=$1
    echo "" >> "${LOG_FILE}"
    echo "Cleanup started at $(date)" >> "${LOG_FILE}"

    # Kill the entire process group (this script and all children)
    # Use negative PID to kill process group
    if [ -n "$CLAUDE_PID" ] && kill -0 "$CLAUDE_PID" 2>/dev/null; then
        # Get the process group ID
        PGID=$(ps -o pgid= -p "$CLAUDE_PID" 2>/dev/null | tr -d ' ')

        if [ -n "$PGID" ]; then
            echo "Killing process group $PGID..." >> "${LOG_FILE}"

            # Send TERM signal first (graceful)
            kill -TERM -"$PGID" 2>/dev/null
            sleep 2

            # Send KILL signal if still running (forceful)
            if ps -g "$PGID" > /dev/null 2>&1; then
                echo "Sending SIGKILL to remaining processes..." >> "${LOG_FILE}"
                kill -KILL -"$PGID" 2>/dev/null
            fi
        else
            # Fallback: kill just the Claude process
            echo "No PGID found, killing Claude PID $CLAUDE_PID..." >> "${LOG_FILE}"
            kill "$CLAUDE_PID" 2>/dev/null
            sleep 2
            kill -9 "$CLAUDE_PID" 2>/dev/null
        fi
    fi

    echo "Cleanup completed at $(date)" >> "${LOG_FILE}"
    echo "Completed: $(date) (exit: $EXIT_CODE)" >> "${LOG_FILE}"
    echo "==============================" >> "${LOG_FILE}"

    exit "$EXIT_CODE"
}

# Set trap to call cleanup on script exit
trap 'cleanup $?' EXIT INT TERM

# Run from /tmp to avoid MCP loading issues in headless mode
cd /tmp

# Start Claude in a new process group
# setsid creates a new session and process group
/opt/homebrew/bin/claude -p --no-session-persistence --dangerously-skip-permissions "/maintenance daily" >> "${LOG_FILE}" 2>&1 &
CLAUDE_PID=$!

echo "Claude PID: $CLAUDE_PID" >> "${LOG_FILE}"

# Wait with timeout
ELAPSED=0
while kill -0 "$CLAUDE_PID" 2>/dev/null && [ "$ELAPSED" -lt "$TIMEOUT" ]; do
    sleep 5
    ELAPSED=$((ELAPSED + 5))
done

# Check if timeout occurred
if kill -0 "$CLAUDE_PID" 2>/dev/null; then
    echo "Timeout after ${TIMEOUT}s" >> "${LOG_FILE}"
    # cleanup will be called by trap
    exit 124  # Standard timeout exit code
fi

# Wait for Claude to finish normally
wait "$CLAUDE_PID" 2>/dev/null
EXIT_CODE=$?

# cleanup will be called by trap with EXIT_CODE
exit "$EXIT_CODE"
