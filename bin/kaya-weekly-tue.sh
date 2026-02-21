#!/bin/bash
# Kaya Weekly Maintenance - Tuesday (Memory & Reports)
# Runs Tuesday 8am via launchd
# Handles: memory consolidation, weekly report generation

# Source common library for cleanup functions
source "$(dirname "$0")/kaya-common.sh"

LOG_DIR="${KAYA_HOME}/logs"
LOG_FILE="${LOG_DIR}/weekly-tue-$(date +%Y%V).log"
TIMEOUT=600  # 10 minutes

mkdir -p "${LOG_DIR}"

echo "=== Kaya Weekly Tuesday (Memory & Reports) ===" >> "${LOG_FILE}"
echo "Started: $(date)" >> "${LOG_FILE}"
echo "PID: $$" >> "${LOG_FILE}"
echo "" >> "${LOG_FILE}"

# Setup cleanup trap for proper process group termination
setup_cleanup_trap "${LOG_FILE}"

# Run the specific workflow tier
run_claude_with_timeout "$TIMEOUT" "${LOG_FILE}" "bun run ~/.claude/skills/AutoMaintenance/Tools/Workflows.ts --tier weekly-reports"
EXIT_CODE=$?

echo "" >> "${LOG_FILE}"
echo "=============================================" >> "${LOG_FILE}"

exit "$EXIT_CODE"
