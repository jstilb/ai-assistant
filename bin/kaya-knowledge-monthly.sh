#!/bin/bash
# Kaya Monthly Knowledge Runner
# Runs 1st of month 5am via launchd
# Invokes /knowledge monthly workflow

# Source common library for cleanup functions
source "$(dirname "$0")/kaya-common.sh"

LOG_DIR="${KAYA_HOME}/logs"
LOG_FILE="${LOG_DIR}/knowledge-monthly-$(date +%Y%m).log"
TIMEOUT=900  # 15 minutes

mkdir -p "${LOG_DIR}"

echo "=== Kaya Monthly Knowledge ===" >> "${LOG_FILE}"
echo "Started: $(date)" >> "${LOG_FILE}"
echo "PID: $$" >> "${LOG_FILE}"
echo "" >> "${LOG_FILE}"

# Setup cleanup trap for proper process group termination
setup_cleanup_trap "${LOG_FILE}"

# Run Claude with timeout
run_claude_with_timeout "$TIMEOUT" "${LOG_FILE}" "/knowledge monthly"
EXIT_CODE=$?

echo "" >> "${LOG_FILE}"
echo "===============================" >> "${LOG_FILE}"

exit "$EXIT_CODE"
