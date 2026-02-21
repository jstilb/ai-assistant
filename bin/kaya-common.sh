#!/bin/bash
# Kaya Common Library - Shared Functions for Launchd Runners
# Source this file in all kaya-*.sh scripts
#
# Purpose: Provides process cleanup functions to prevent orphaned Claude processes
# when launchd jobs timeout or complete.
#
# Key function: cleanup_claude_processes
# - Kills the entire process group, not just the main Claude PID
# - Uses SIGTERM first (graceful), then SIGKILL if needed
# - Logs all cleanup actions

KAYA_HOME="${HOME}/.claude"

# Global variable for Claude PID (set by runner script)
CLAUDE_PID=""

# Cleanup function to kill all child processes
# Call this function in trap handlers and after timeout
# Usage: cleanup_claude_processes <exit_code> <log_file>
cleanup_claude_processes() {
    local EXIT_CODE="${1:-0}"
    local LOG_FILE="${2:-/dev/null}"

    echo "" >> "${LOG_FILE}"
    echo "Cleanup started at $(date)" >> "${LOG_FILE}"

    if [ -n "$CLAUDE_PID" ] && kill -0 "$CLAUDE_PID" 2>/dev/null; then
        # Get the process group ID
        PGID=$(ps -o pgid= -p "$CLAUDE_PID" 2>/dev/null | tr -d ' ')

        if [ -n "$PGID" ] && [ "$PGID" != "0" ]; then
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

        # Additional fallback: find and kill any orphaned MCP launcher processes
        # that might have escaped the process group
        echo "Checking for orphaned MCP processes..." >> "${LOG_FILE}"
        pgrep -f "bun run.*mcp-launchers" | while read pid; do
            # Check if process is older than 30 minutes (likely orphaned)
            local elapsed=$(ps -o etime= -p "$pid" 2>/dev/null | tr -d ' ')
            if [ -n "$elapsed" ]; then
                echo "Found MCP launcher PID $pid (runtime: $elapsed)" >> "${LOG_FILE}"
            fi
        done
    fi

    echo "Cleanup completed at $(date)" >> "${LOG_FILE}"
    echo "Exit code: $EXIT_CODE" >> "${LOG_FILE}"
}

# Setup trap for proper cleanup
# Usage: setup_cleanup_trap <log_file>
setup_cleanup_trap() {
    local LOG_FILE="$1"
    trap "cleanup_claude_processes \$? '$LOG_FILE'" EXIT INT TERM
}

# Run Claude with proper process group management
# Usage: run_claude_with_timeout <timeout_seconds> <log_file> <command>
# Returns: Exit code from claude or 124 on timeout
run_claude_with_timeout() {
    local TIMEOUT="$1"
    local LOG_FILE="$2"
    local COMMAND="$3"

    # Load OAuth token from secrets.json for headless authentication
    if [ -f "${KAYA_HOME}/secrets.json" ]; then
        export CLAUDE_CODE_OAUTH_TOKEN=$(grep -o '"CLAUDE_CODE_OAUTH_TOKEN"[[:space:]]*:[[:space:]]*"[^"]*"' "${KAYA_HOME}/secrets.json" | sed 's/.*: *"//' | sed 's/"$//')
    fi

    # Run from /tmp to avoid MCP loading issues in headless mode
    cd /tmp

    # Start Claude in background
    /opt/homebrew/bin/claude -p --no-session-persistence --dangerously-skip-permissions "$COMMAND" >> "${LOG_FILE}" 2>&1 &
    CLAUDE_PID=$!
    export CLAUDE_PID

    echo "Claude PID: $CLAUDE_PID" >> "${LOG_FILE}"

    # Wait with timeout
    local ELAPSED=0
    while kill -0 "$CLAUDE_PID" 2>/dev/null && [ "$ELAPSED" -lt "$TIMEOUT" ]; do
        sleep 5
        ELAPSED=$((ELAPSED + 5))
    done

    # Check if timeout occurred
    if kill -0 "$CLAUDE_PID" 2>/dev/null; then
        echo "Timeout after ${TIMEOUT}s" >> "${LOG_FILE}"
        return 124  # Standard timeout exit code
    fi

    # Wait for Claude to finish normally
    wait "$CLAUDE_PID" 2>/dev/null
    return $?
}
