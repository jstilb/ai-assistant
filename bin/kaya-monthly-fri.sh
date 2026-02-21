#!/bin/bash
# Kaya Monthly Maintenance - Friday (Skill Audit)
# Runs first Friday of month 8am via launchd
# Handles: skill audit, health review

# Source common library for cleanup functions
source "$(dirname "$0")/kaya-common.sh"

LOG_DIR="${KAYA_HOME}/logs"
LOG_FILE="${LOG_DIR}/monthly-fri-$(date +%Y%m).log"
TIMEOUT=900  # 15 minutes

mkdir -p "${LOG_DIR}"

# Check if this is the first Friday of the month (day 1-7 AND Friday)
DAY_OF_MONTH=$(date +%d)
DAY_OF_WEEK=$(date +%u)  # 5 = Friday

if [ "$DAY_OF_MONTH" -gt 7 ] || [ "$DAY_OF_WEEK" -ne 5 ]; then
    echo "Not the first Friday of the month (day=$DAY_OF_MONTH, dow=$DAY_OF_WEEK), skipping." >> "${LOG_FILE}"
    exit 0
fi

echo "=== Kaya Monthly Friday (Skill Audit) ===" >> "${LOG_FILE}"
echo "Started: $(date)" >> "${LOG_FILE}"
echo "PID: $$" >> "${LOG_FILE}"
echo "" >> "${LOG_FILE}"

# Setup cleanup trap for proper process group termination
setup_cleanup_trap "${LOG_FILE}"

# Run the specific workflow tier
run_claude_with_timeout "$TIMEOUT" "${LOG_FILE}" "bun run ~/.claude/skills/AutoMaintenance/Tools/Workflows.ts --tier monthly-skills"
EXIT_CODE=$?

echo "" >> "${LOG_FILE}"
echo "=========================================" >> "${LOG_FILE}"

exit "$EXIT_CODE"
