#!/bin/bash
# Kaya Weekly Maintenance - Orchestrated (Unified Sunday Run)
# Runs Sunday 8am via launchd
#
# Replaces the staggered Sun/Mon/Tue pattern with a single orchestrated workflow
# that ensures proper ordering: learning processes memory BEFORE cleanup deletes it.
#
# Execution Order:
#   Phase 1 (parallel): Security audit + Memory consolidation/learning
#   Phase 2 (sequential): State cleanup, log rotation (AFTER learning)
#   Phase 3: Generate weekly report

# Source common library for cleanup functions
source "$(dirname "$0")/kaya-common.sh"

LOG_DIR="${KAYA_HOME}/logs"
LOG_FILE="${LOG_DIR}/weekly-$(date +%Y%V).log"
TIMEOUT=2700  # 45 minutes for full orchestrated run

mkdir -p "${LOG_DIR}"

echo "=== Kaya Weekly (Orchestrated) ===" >> "${LOG_FILE}"
echo "Started: $(date)" >> "${LOG_FILE}"
echo "PID: $$" >> "${LOG_FILE}"
echo "" >> "${LOG_FILE}"
echo "Phase 1: Security + Learning (parallel)" >> "${LOG_FILE}"
echo "Phase 2: Cleanup (after learning completes)" >> "${LOG_FILE}"
echo "Phase 3: Generate report" >> "${LOG_FILE}"
echo "" >> "${LOG_FILE}"

# Setup cleanup trap for proper process group termination
setup_cleanup_trap "${LOG_FILE}"

# Run the orchestrated workflow
run_claude_with_timeout "$TIMEOUT" "${LOG_FILE}" "bun run ~/.claude/skills/AutoMaintenance/Tools/Workflows.ts --tier weekly-orchestrated"
EXIT_CODE=$?

echo "" >> "${LOG_FILE}"
echo "===========================================" >> "${LOG_FILE}"
echo "Completed: $(date)" >> "${LOG_FILE}"
echo "Exit code: $EXIT_CODE" >> "${LOG_FILE}"

exit "$EXIT_CODE"
