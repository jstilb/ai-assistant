#!/usr/bin/env bash
# TaskCompleted.sh - Quality gate hook: verify deliverables before task closure
#
# Fires when an agent attempts to mark a task as completed. Checks for:
# 1. FIXME/TODO markers in claimed deliverable files
# 2. Claimed deliverable files/paths actually exist
#
# Exit codes:
#   0 - Allow completion (verification passed or no deliverables to check)
#   1 - Hook error (non-blocking)
#   2 - Block completion + send feedback (verification failed)
#
# Feedback is written to stderr per Claude Code hook protocol.

set -euo pipefail

# Read the hook input from stdin (JSON event data)
INPUT=$(cat)

# Extract deliverables and task context from the event
TASK_DATA=$(echo "$INPUT" | python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
    task = data.get('task', {})
    print(json.dumps({
        'subject': task.get('subject', ''),
        'description': task.get('description', ''),
        'metadata': task.get('metadata', {}),
        'deliverables': task.get('metadata', {}).get('deliverables', [])
    }))
except Exception as e:
    print(json.dumps({'subject': '', 'description': '', 'metadata': {}, 'deliverables': []}))
" 2>/dev/null || echo '{"subject":"","description":"","metadata":{},"deliverables":[]}')

# Check for FIXME/TODO in deliverable files
ISSUES=""
ISSUE_COUNT=0

DELIVERABLES=$(echo "$TASK_DATA" | python3 -c "
import sys, json
data = json.load(sys.stdin)
deliverables = data.get('deliverables', [])
for d in deliverables:
    print(d)
" 2>/dev/null || echo "")

# If explicit deliverables listed, validate each one
if [ -n "$DELIVERABLES" ]; then
    while IFS= read -r deliverable; do
        [ -z "$deliverable" ] && continue

        # Check file exists
        if [ ! -e "$deliverable" ]; then
            ISSUES="${ISSUES}  - MISSING: ${deliverable} (claimed deliverable does not exist)\n"
            ISSUE_COUNT=$((ISSUE_COUNT + 1))
            continue
        fi

        # Check for FIXME/TODO markers in files (not directories)
        if [ -f "$deliverable" ]; then
            FIXME_COUNT=$(grep -c 'FIXME\|TODO' "$deliverable" 2>/dev/null || echo 0)
            if [ "$FIXME_COUNT" -gt 0 ]; then
                ISSUES="${ISSUES}  - INCOMPLETE: ${deliverable} contains ${FIXME_COUNT} FIXME/TODO marker(s)\n"
                ISSUE_COUNT=$((ISSUE_COUNT + 1))
            fi
        fi
    done <<< "$DELIVERABLES"
fi

# Also check any file paths mentioned in the task description
# Look for common deliverable patterns: file paths with extensions
MENTIONED_FILES=$(echo "$TASK_DATA" | python3 -c "
import sys, json, re
data = json.load(sys.stdin)
desc = data.get('description', '') + ' ' + data.get('subject', '')
# Find paths that look like file references
patterns = [
    r'[\w/\-]+\.(?:ts|js|sh|md|json|yaml|yml)\b',
    r'~[\w/\-]+\.(?:ts|js|sh|md|json|yaml|yml)\b',
]
found = set()
for pattern in patterns:
    for match in re.finditer(pattern, desc):
        path = match.group(0).replace('~', '/Users/[user]')
        if len(path) > 5:
            found.add(path)
for f in sorted(found):
    print(f)
" 2>/dev/null || echo "")

# Check mentioned files that start with known base paths (avoid false positives)
if [ -n "$MENTIONED_FILES" ]; then
    while IFS= read -r filepath; do
        [ -z "$filepath" ] && continue

        # Only check paths that exist and are likely deliverables
        if [ -f "$filepath" ] 2>/dev/null; then
            FIXME_COUNT=$(grep -c 'FIXME\|TODO' "$filepath" 2>/dev/null || echo 0)
            if [ "$FIXME_COUNT" -gt 0 ]; then
                ISSUES="${ISSUES}  - INCOMPLETE: ${filepath} contains ${FIXME_COUNT} FIXME/TODO marker(s)\n"
                ISSUE_COUNT=$((ISSUE_COUNT + 1))
            fi
        fi
    done <<< "$MENTIONED_FILES"
fi

# Warning: zero-artifact task (non-blocking)
if [ "$ISSUE_COUNT" -eq 0 ] && [ -z "$DELIVERABLES" ] && [ -z "$MENTIONED_FILES" ]; then
    TASK_SUBJECT_WARN=$(echo "$TASK_DATA" | python3 -c "
import sys, json
data = json.load(sys.stdin)
print(data.get('subject', 'unknown task'))
" 2>/dev/null || echo "unknown task")
    echo "[TaskCompleted] WARNING: '${TASK_SUBJECT_WARN}' completed with zero explicit deliverables and zero file path references. Consider adding deliverables metadata for audit trail." >&2
fi

# If issues found, block completion
if [ "$ISSUE_COUNT" -gt 0 ]; then
    TASK_SUBJECT=$(echo "$TASK_DATA" | python3 -c "
import sys, json
data = json.load(sys.stdin)
print(data.get('subject', 'unknown task'))
" 2>/dev/null || echo "unknown task")

    echo -e "TaskCompleted blocked for '${TASK_SUBJECT}': ${ISSUE_COUNT} verification issue(s) found.\n\nIssues:\n${ISSUES}\nFix these issues before marking the task complete." >&2
    exit 2
fi

# All checks passed — allow completion
exit 0
