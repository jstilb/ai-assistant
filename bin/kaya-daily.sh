#!/bin/bash
# Kaya Daily Maintenance Runner
# Runs at 8am daily via launchd
# Invokes /maintenance daily workflow

# Source common library for cleanup functions
source "$(dirname "$0")/kaya-common.sh"

LOG_DIR="${KAYA_HOME}/logs"
LOG_FILE="${LOG_DIR}/daily-$(date +%Y%m%d).log"
TIMEOUT=600  # 10 minutes

mkdir -p "${LOG_DIR}"

echo "=== Kaya Daily Maintenance ===" >> "${LOG_FILE}"
echo "Started: $(date)" >> "${LOG_FILE}"
echo "PID: $$" >> "${LOG_FILE}"
echo "" >> "${LOG_FILE}"

# Setup cleanup trap for proper process group termination
setup_cleanup_trap "${LOG_FILE}"

# Run Claude with timeout
run_claude_with_timeout "$TIMEOUT" "${LOG_FILE}" "/maintenance daily"
EXIT_CODE=$?

echo "" >> "${LOG_FILE}"
echo "==============================" >> "${LOG_FILE}"

exit "$EXIT_CODE"
