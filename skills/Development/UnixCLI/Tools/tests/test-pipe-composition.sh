#!/usr/bin/env bash
# Test Unix pipe composition with CLI tools

set -euo pipefail

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

PASS=0
FAIL=0
SKIP=0

KAYA_CLI="$HOME/.claude/bin/kaya-cli"

log_test() {
    echo -e "${BLUE}[TEST]${NC} $1"
}

log_pass() {
    echo -e "${GREEN}[PASS]${NC} $1"
    ((PASS++))
}

log_fail() {
    echo -e "${RED}[FAIL]${NC} $1"
    ((FAIL++))
}

log_skip() {
    echo -e "${YELLOW}[SKIP]${NC} $1"
    ((SKIP++))
}

# Test jq availability
check_jq() {
    if ! command -v jq &> /dev/null; then
        echo -e "${YELLOW}Warning:${NC} jq not installed. Some pipe tests will be skipped."
        echo "Install with: brew install jq"
        return 1
    fi
    return 0
}

# Test YouTube + jq
test_youtube_jq() {
    echo ""
    echo "=== Testing YouTube + jq ==="

    if ! check_jq; then
        log_skip "jq not available"
        return 0
    fi

    log_test "Extract video title with jq"
    local test_url="https://www.youtube.com/watch?v=dQw4w9WgXcQ"

    if title=$("$KAYA_CLI" youtube --dump-json --no-download "$test_url" 2>/dev/null | jq -r '.title' 2>/dev/null); then
        if [[ -n "$title" && "$title" != "null" ]]; then
            log_pass "YouTube + jq pipe works: $title"
        else
            log_fail "YouTube + jq returned empty/null"
        fi
    else
        log_fail "YouTube + jq pipe failed"
    fi
}

# Test Calendar + awk
test_calendar_awk() {
    echo ""
    echo "=== Testing Calendar + awk ==="

    if ! command -v awk &> /dev/null; then
        log_skip "awk not available"
        return 0
    fi

    log_test "Parse calendar with awk"
    if "$KAYA_CLI" calendar list &> /dev/null; then
        if result=$("$KAYA_CLI" calendar agenda --tsv 2>/dev/null | awk -F'\t' '{print $1}' 2>/dev/null | head -1); then
            log_pass "Calendar + awk pipe works"
        else
            log_skip "Calendar + awk pipe (no events or not authenticated)"
        fi
    else
        log_skip "Calendar not authenticated"
    fi
}

# Test Gmail + grep + jq
test_gmail_grep_jq() {
    echo ""
    echo "=== Testing Gmail + grep + jq ==="

    if ! check_jq; then
        log_skip "jq not available"
        return 0
    fi

    log_test "Filter and parse emails"
    if "$KAYA_CLI" gmail inbox --limit 1 &> /dev/null; then
        if subjects=$("$KAYA_CLI" gmail inbox --limit 5 --format json 2>/dev/null | jq -r '.[].subject' 2>/dev/null | head -1); then
            if [[ -n "$subjects" ]]; then
                log_pass "Gmail + jq pipe works"
            else
                log_skip "Gmail + jq (no emails)"
            fi
        else
            log_fail "Gmail + jq pipe failed"
        fi
    else
        log_skip "Gmail not authenticated"
    fi
}

# Test Drive + jq
test_drive_jq() {
    echo ""
    echo "=== Testing Drive + jq ==="

    if ! check_jq; then
        log_skip "jq not available"
        return 0
    fi

    log_test "Parse Drive info with jq"
    if "$KAYA_CLI" drive lsd gdrive: &> /dev/null; then
        if info=$("$KAYA_CLI" drive about gdrive: --json 2>/dev/null | jq -r '.total' 2>/dev/null); then
            log_pass "Drive + jq pipe works"
        else
            log_fail "Drive + jq pipe failed"
        fi
    else
        log_skip "Drive not configured"
    fi
}

# Test Bluesky + jq
test_bluesky_jq() {
    echo ""
    echo "=== Testing Bluesky + jq ==="

    if ! check_jq; then
        log_skip "jq not available"
        return 0
    fi

    log_test "Parse Bluesky timeline with jq"
    if "$KAYA_CLI" bluesky profile show &> /dev/null; then
        if posts=$("$KAYA_CLI" bluesky timeline --limit 5 --json 2>/dev/null | jq -r '.feed[].post.record.text' 2>/dev/null | head -1); then
            if [[ -n "$posts" && "$posts" != "null" ]]; then
                log_pass "Bluesky + jq pipe works"
            else
                log_skip "Bluesky + jq (no posts or empty timeline)"
            fi
        else
            log_fail "Bluesky + jq pipe failed"
        fi
    else
        log_skip "Bluesky not authenticated"
    fi
}

# Test multiple pipes
test_multi_pipe() {
    echo ""
    echo "=== Testing Multi-stage Pipes ==="

    if ! check_jq; then
        log_skip "jq not available"
        return 0
    fi

    log_test "YouTube → jq → grep → wc"
    local test_url="https://www.youtube.com/watch?v=dQw4w9WgXcQ"

    if count=$("$KAYA_CLI" youtube --dump-json --no-download "$test_url" 2>/dev/null | \
                jq -r '.title' 2>/dev/null | \
                grep -o "." 2>/dev/null | \
                wc -l 2>/dev/null | \
                tr -d ' '); then
        if [[ $count -gt 0 ]]; then
            log_pass "Multi-stage pipe works ($count characters)"
        else
            log_fail "Multi-stage pipe returned 0"
        fi
    else
        log_fail "Multi-stage pipe failed"
    fi
}

# Test output redirection
test_output_redirect() {
    echo ""
    echo "=== Testing Output Redirection ==="

    log_test "Redirect YouTube metadata to file"
    local test_url="https://www.youtube.com/watch?v=dQw4w9WgXcQ"
    local temp_file=$(mktemp)

    if "$KAYA_CLI" youtube --get-title "$test_url" > "$temp_file" 2>/dev/null; then
        if [[ -s "$temp_file" ]]; then
            log_pass "Output redirection works"
        else
            log_fail "Output file is empty"
        fi
    else
        log_fail "Output redirection failed"
    fi

    rm -f "$temp_file"
}

# Test command substitution
test_command_substitution() {
    echo ""
    echo "=== Testing Command Substitution ==="

    log_test "Use command output in variable"
    local test_url="https://www.youtube.com/watch?v=dQw4w9WgXcQ"

    if title=$("$KAYA_CLI" youtube --get-title "$test_url" 2>/dev/null); then
        if [[ -n "$title" ]]; then
            log_pass "Command substitution works: $title"
        else
            log_fail "Command substitution returned empty"
        fi
    else
        log_fail "Command substitution failed"
    fi
}

# Summary
print_summary() {
    echo ""
    echo "================================"
    echo "Pipe Composition Test Summary"
    echo "================================"
    echo -e "${GREEN}PASS:${NC} $PASS"
    echo -e "${YELLOW}SKIP:${NC} $SKIP"
    echo -e "${RED}FAIL:${NC} $FAIL"
    echo ""

    if [[ $FAIL -eq 0 ]]; then
        echo -e "${GREEN}✓ All pipe composition tests passed${NC}"
        if [[ $SKIP -gt 0 ]]; then
            echo ""
            echo "Some tests were skipped. To enable:"
            echo "  - Install jq: brew install jq"
            echo "  - Configure authentication for services"
        fi
        return 0
    else
        echo -e "${RED}✗ Some pipe composition tests failed${NC}"
        return 1
    fi
}

# Main
main() {
    echo "================================"
    echo "Kaya Unix CLI - Pipe Composition Tests"
    echo "================================"
    echo ""

    test_youtube_jq
    test_calendar_awk
    test_gmail_grep_jq
    test_drive_jq
    test_bluesky_jq
    test_multi_pipe
    test_output_redirect
    test_command_substitution

    print_summary
}

main "$@"
