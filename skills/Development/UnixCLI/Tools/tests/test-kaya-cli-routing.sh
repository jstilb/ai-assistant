#!/usr/bin/env bash
# Integration tests for kaya-cli routing

set -euo pipefail

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

PASS=0
FAIL=0

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

# Test kaya-cli exists
test_kayacli_exists() {
    echo ""
    echo "=== Testing kaya-cli existence ==="

    log_test "Check kaya-cli exists"
    if [[ -f "$KAYA_CLI" ]]; then
        log_pass "kaya-cli found at $KAYA_CLI"
    else
        log_fail "kaya-cli not found at $KAYA_CLI"
        return 1
    fi

    log_test "Check kaya-cli is executable"
    if [[ -x "$KAYA_CLI" ]]; then
        log_pass "kaya-cli is executable"
    else
        log_fail "kaya-cli is not executable"
        return 1
    fi
}

# Test help and version
test_kayacli_basic() {
    echo ""
    echo "=== Testing kaya-cli basic commands ==="

    log_test "Test kaya-cli --help"
    if "$KAYA_CLI" --help | grep -q "Usage:"; then
        log_pass "kaya-cli --help works"
    else
        log_fail "kaya-cli --help failed"
    fi

    log_test "Test kaya-cli --version"
    if "$KAYA_CLI" --version | grep -q "version"; then
        log_pass "kaya-cli --version works"
    else
        log_fail "kaya-cli --version failed"
    fi

    log_test "Test kaya-cli with no args"
    if "$KAYA_CLI" | grep -q "Usage:"; then
        log_pass "kaya-cli with no args shows help"
    else
        log_fail "kaya-cli with no args failed"
    fi
}

# Test service routing
test_youtube_routing() {
    echo ""
    echo "=== Testing YouTube routing ==="

    log_test "Route to yt-dlp via 'youtube'"
    if "$KAYA_CLI" youtube --version &> /dev/null; then
        log_pass "youtube → yt-dlp routing works"
    else
        log_fail "youtube routing failed"
    fi

    log_test "Route to yt-dlp via 'yt'"
    if "$KAYA_CLI" yt --version &> /dev/null; then
        log_pass "yt → yt-dlp routing works"
    else
        log_fail "yt routing failed"
    fi
}

test_calendar_routing() {
    echo ""
    echo "=== Testing Calendar routing ==="

    log_test "Route to gcalcli via 'calendar'"
    if "$KAYA_CLI" calendar --help | grep -q "usage:"; then
        log_pass "calendar → gcalcli routing works"
    else
        log_fail "calendar routing failed"
    fi

    log_test "Route to gcalcli via 'gcal'"
    if "$KAYA_CLI" gcal --help | grep -q "usage:"; then
        log_pass "gcal → gcalcli routing works"
    else
        log_fail "gcal routing failed"
    fi
}

test_drive_routing() {
    echo ""
    echo "=== Testing Drive routing ==="

    log_test "Route to rclone via 'drive'"
    if "$KAYA_CLI" drive --help | grep -q "Usage:"; then
        log_pass "drive → rclone routing works"
    else
        log_fail "drive routing failed"
    fi
}

test_gmail_routing() {
    echo ""
    echo "=== Testing Gmail routing ==="

    log_test "Route to gog via 'gmail'"
    if "$KAYA_CLI" gmail --help 2>&1 | grep -q "Gmail"; then
        log_pass "gmail → gog routing works"
    else
        log_fail "gmail routing failed"
    fi
}

test_gemini_routing() {
    echo ""
    echo "=== Testing Gemini routing ==="

    log_test "Route to gemini-cli via 'gemini'"
    if "$KAYA_CLI" gemini --help &> /dev/null; then
        log_pass "gemini → gemini-cli routing works"
    else
        log_fail "gemini routing failed"
    fi

    log_test "Route to gemini-cli via 'ai'"
    if "$KAYA_CLI" ai --help &> /dev/null; then
        log_pass "ai → gemini-cli routing works"
    else
        log_fail "ai routing failed"
    fi
}

test_bluesky_routing() {
    echo ""
    echo "=== Testing Bluesky routing ==="

    log_test "Route to bsky via 'bluesky'"
    if "$KAYA_CLI" bluesky --version &> /dev/null; then
        log_pass "bluesky → bsky routing works"
    else
        log_fail "bluesky routing failed"
    fi

    log_test "Route to bsky via 'bsky'"
    if "$KAYA_CLI" bsky --version &> /dev/null; then
        log_pass "bsky → bsky routing works"
    else
        log_fail "bsky routing failed"
    fi
}

test_invalid_service() {
    echo ""
    echo "=== Testing error handling ==="

    log_test "Invalid service returns error"
    if ! "$KAYA_CLI" invalid-service 2>&1 | grep -q "Unknown service"; then
        log_fail "Invalid service should show error"
    else
        log_pass "Invalid service shows correct error"
    fi
}

# Summary
print_summary() {
    echo ""
    echo "================================"
    echo "Integration Test Summary"
    echo "================================"
    echo -e "${GREEN}PASS:${NC} $PASS"
    echo -e "${RED}FAIL:${NC} $FAIL"
    echo ""

    if [[ $FAIL -eq 0 ]]; then
        echo -e "${GREEN}✓ All integration tests passed!${NC}"
        return 0
    else
        echo -e "${RED}✗ Some integration tests failed${NC}"
        return 1
    fi
}

# Main
main() {
    echo "================================"
    echo "Kaya Unix CLI - Integration Tests"
    echo "================================"

    test_kayacli_exists
    test_kayacli_basic
    test_youtube_routing
    test_calendar_routing
    test_drive_routing
    test_gmail_routing
    test_gemini_routing
    test_bluesky_routing
    test_invalid_service

    print_summary
}

main "$@"
