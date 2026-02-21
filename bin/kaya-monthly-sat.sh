#!/bin/bash
# Kaya Monthly Maintenance - Saturday (Reports)
# Runs first Saturday of month 8am via launchd
# Handles: monthly report generation, aggregation

# Source common library for cleanup functions
source "$(dirname "$0")/kaya-common.sh"

LOG_DIR="${KAYA_HOME}/logs"
LOG_FILE="${LOG_DIR}/monthly-sat-$(date +%Y%m).log"
TIMEOUT=900  # 15 minutes

mkdir -p "${LOG_DIR}"

# Check if this is the first Saturday of the month (day 1-7 AND Saturday)
DAY_OF_MONTH=$(date +%d)
DAY_OF_WEEK=$(date +%u)  # 6 = Saturday

if [ "$DAY_OF_MONTH" -gt 7 ] || [ "$DAY_OF_WEEK" -ne 6 ]; then
    echo "Not the first Saturday of the month (day=$DAY_OF_MONTH, dow=$DAY_OF_WEEK), skipping." >> "${LOG_FILE}"
    exit 0
fi

echo "=== Kaya Monthly Saturday (Reports) ===" >> "${LOG_FILE}"
echo "Started: $(date)" >> "${LOG_FILE}"
echo "PID: $$" >> "${LOG_FILE}"
echo "" >> "${LOG_FILE}"

# Setup cleanup trap for proper process group termination
setup_cleanup_trap "${LOG_FILE}"

# Run the specific workflow tier
run_claude_with_timeout "$TIMEOUT" "${LOG_FILE}" "bun run ~/.claude/skills/AutoMaintenance/Tools/Workflows.ts --tier monthly-reports"
EXIT_CODE=$?

echo "" >> "${LOG_FILE}"
echo "=======================================" >> "${LOG_FILE}"

exit "$EXIT_CODE"
