#!/bin/bash
# Kaya Weekly Maintenance - Monday (State & Log Cleanup)
# Runs Monday 8am via launchd
# Handles: state cleanup, log rotation

# Source common library for cleanup functions
source "$(dirname "$0")/kaya-common.sh"

LOG_DIR="${KAYA_HOME}/logs"
LOG_FILE="${LOG_DIR}/weekly-mon-$(date +%Y%V).log"
TIMEOUT=1800  # 30 minutes

mkdir -p "${LOG_DIR}"

echo "=== Kaya Weekly Monday (State & Logs) ===" >> "${LOG_FILE}"
echo "Started: $(date)" >> "${LOG_FILE}"
echo "PID: $$" >> "${LOG_FILE}"
echo "" >> "${LOG_FILE}"

# Setup cleanup trap for proper process group termination
setup_cleanup_trap "${LOG_FILE}"

# Run the specific workflow tier
run_claude_with_timeout "$TIMEOUT" "${LOG_FILE}" "bun run ~/.claude/skills/AutoMaintenance/Tools/Workflows.ts --tier weekly-cleanup"
EXIT_CODE=$?

echo "" >> "${LOG_FILE}"
echo "=========================================" >> "${LOG_FILE}"

exit "$EXIT_CODE"
