#!/bin/bash
# Kaya Autonomous Work Runner
# Runs at 2pm daily via launchd
# Invokes /work next to pick up and execute tasks from Asana queue
#
# This script enables hands-off autonomous execution:
# 1. Picks up highest priority task from Kaya project
# 2. Executes task using appropriate workflow (dev/research/content)
# 3. Creates feature branch and PR if code changes
# 4. Adds to approval queue for user review
# 5. Reports results to Asana task

# Source common library for cleanup functions
source "$(dirname "$0")/kaya-common.sh"

LOG_DIR="${KAYA_HOME}/logs"
LOG_FILE="${LOG_DIR}/work-daily-$(date +%Y%m%d).log"
TIMEOUT=1800  # 30 minutes for complex work

mkdir -p "${LOG_DIR}"

echo "=== Kaya Autonomous Work ===" >> "${LOG_FILE}"
echo "Started: $(date)" >> "${LOG_FILE}"
echo "PID: $$" >> "${LOG_FILE}"
echo "" >> "${LOG_FILE}"

# Setup cleanup trap for proper process group termination
setup_cleanup_trap "${LOG_FILE}"

# Run Claude with timeout
run_claude_with_timeout "$TIMEOUT" "${LOG_FILE}" "/work next"
EXIT_CODE=$?

echo "" >> "${LOG_FILE}"
echo "==============================" >> "${LOG_FILE}"

exit "$EXIT_CODE"
