#!/bin/bash
# Kaya Monthly Upgrade Runner
# Runs 1st of month 4am via launchd
# Invokes /maintenance monthly workflow

# Source common library for cleanup functions
source "$(dirname "$0")/kaya-common.sh"

LOG_DIR="${KAYA_HOME}/logs"
LOG_FILE="${LOG_DIR}/monthly-$(date +%Y%m).log"
TIMEOUT=900  # 15 minutes

mkdir -p "${LOG_DIR}"

echo "=== Kaya Monthly Upgrade ===" >> "${LOG_FILE}"
echo "Started: $(date)" >> "${LOG_FILE}"
echo "PID: $$" >> "${LOG_FILE}"
echo "" >> "${LOG_FILE}"

# Setup cleanup trap for proper process group termination
setup_cleanup_trap "${LOG_FILE}"

# Run Claude with timeout
run_claude_with_timeout "$TIMEOUT" "${LOG_FILE}" "/maintenance monthly"
EXIT_CODE=$?

echo "" >> "${LOG_FILE}"
echo "============================" >> "${LOG_FILE}"

exit "$EXIT_CODE"
