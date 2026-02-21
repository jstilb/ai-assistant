#!/bin/bash
# Kaya Task Maintenance - Weekly
# Runs Sunday 8am via launchd
# Full project triage, stale detection, prioritization

# Source common library for cleanup functions
source "$(dirname "$0")/kaya-common.sh"

LOG_DIR="${KAYA_HOME}/logs"
LOG_FILE="${LOG_DIR}/tasks-weekly-$(date +%Y%m%d).log"
TIMEOUT=600  # 10 minutes

mkdir -p "${LOG_DIR}"

echo "=== Kaya Task Maintenance Weekly ===" >> "${LOG_FILE}"
echo "Started: $(date)" >> "${LOG_FILE}"
echo "PID: $$" >> "${LOG_FILE}"
echo "" >> "${LOG_FILE}"

# Setup cleanup trap for proper process group termination
setup_cleanup_trap "${LOG_FILE}"

# Run Claude with timeout
run_claude_with_timeout "$TIMEOUT" "${LOG_FILE}" "/tasks weekly"
EXIT_CODE=$?

echo "" >> "${LOG_FILE}"
echo "====================================" >> "${LOG_FILE}"

exit "$EXIT_CODE"
