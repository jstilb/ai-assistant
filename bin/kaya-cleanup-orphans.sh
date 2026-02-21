#!/bin/bash
# Kaya Orphan Process Cleaner
# Finds and kills orphaned Claude processes and their MCP launchers
# Safe to run anytime - only kills processes that are clearly orphaned

KAYA_HOME="${HOME}/.claude"
LOG_FILE="${KAYA_HOME}/logs/cleanup-$(date +%Y%m%d_%H%M%S).log"

mkdir -p "${KAYA_HOME}/logs"

echo "=== Kaya Orphan Process Cleaner ===" | tee -a "${LOG_FILE}"
echo "Started: $(date)" | tee -a "${LOG_FILE}"
echo "" | tee -a "${LOG_FILE}"

# Find Claude processes
echo "Looking for Claude processes..." | tee -a "${LOG_FILE}"
CLAUDE_PIDS=$(pgrep -x claude 2>/dev/null)

if [ -z "$CLAUDE_PIDS" ]; then
    echo "No Claude processes found." | tee -a "${LOG_FILE}"
else
    echo "Found Claude processes:" | tee -a "${LOG_FILE}"
    for PID in $CLAUDE_PIDS; do
        # Get process info
        INFO=$(ps -o pid=,etime=,tty=,command= -p "$PID" 2>/dev/null)
        TTY=$(ps -o tty= -p "$PID" 2>/dev/null | tr -d ' ')
        ELAPSED=$(ps -o etime= -p "$PID" 2>/dev/null | tr -d ' ')

        echo "  PID $PID: TTY=$TTY, Runtime=$ELAPSED" | tee -a "${LOG_FILE}"

        # Check if orphaned (no controlling terminal or detached from launchd job that completed)
        if [ "$TTY" = "??" ] || [ -z "$TTY" ]; then
            echo "    -> Appears orphaned (no TTY), killing..." | tee -a "${LOG_FILE}"
            kill -TERM "$PID" 2>/dev/null
            sleep 1
            kill -KILL "$PID" 2>/dev/null
        else
            echo "    -> Has terminal $TTY, keeping." | tee -a "${LOG_FILE}"
        fi
    done
fi

echo "" | tee -a "${LOG_FILE}"

# Find orphaned MCP launcher processes
echo "Looking for orphaned MCP launcher processes..." | tee -a "${LOG_FILE}"
MCP_PIDS=$(pgrep -f "bun run.*mcp-launchers" 2>/dev/null)

if [ -z "$MCP_PIDS" ]; then
    echo "No MCP launcher processes found." | tee -a "${LOG_FILE}"
else
    echo "Found MCP launcher processes:" | tee -a "${LOG_FILE}"
    for PID in $MCP_PIDS; do
        PPID=$(ps -o ppid= -p "$PID" 2>/dev/null | tr -d ' ')
        ELAPSED=$(ps -o etime= -p "$PID" 2>/dev/null | tr -d ' ')
        CMD=$(ps -o command= -p "$PID" 2>/dev/null | head -c 60)

        echo "  PID $PID: PPID=$PPID, Runtime=$ELAPSED" | tee -a "${LOG_FILE}"
        echo "    Command: $CMD..." | tee -a "${LOG_FILE}"

        # Check if parent is init (1) or launchd - indicates orphaned
        if [ "$PPID" = "1" ]; then
            echo "    -> Orphaned (PPID=1), killing..." | tee -a "${LOG_FILE}"
            kill -TERM "$PID" 2>/dev/null
            sleep 1
            kill -KILL "$PID" 2>/dev/null
        else
            # Check if parent Claude process exists
            if ! kill -0 "$PPID" 2>/dev/null; then
                echo "    -> Parent $PPID dead, killing..." | tee -a "${LOG_FILE}"
                kill -TERM "$PID" 2>/dev/null
                sleep 1
                kill -KILL "$PID" 2>/dev/null
            else
                echo "    -> Parent $PPID alive, keeping." | tee -a "${LOG_FILE}"
            fi
        fi
    done
fi

echo "" | tee -a "${LOG_FILE}"
echo "Cleanup completed: $(date)" | tee -a "${LOG_FILE}"
echo "Log saved to: ${LOG_FILE}"
