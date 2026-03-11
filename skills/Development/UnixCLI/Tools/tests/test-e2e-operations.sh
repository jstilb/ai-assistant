#!/usr/bin/env bash
# End-to-end tests with real operations
# NOTE: These tests require authentication and network access

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

# Test YouTube metadata extraction
test_youtube_e2e() {
    echo ""
    echo "=== Testing YouTube E2E ==="

    log_test "Extract metadata from public video"
    # Using a well-known public video URL
    local test_url="https://www.youtube.com/watch?v=dQw4w9WgXcQ"

    if "$KAYA_CLI" youtube --dump-json --no-download "$test_url" &> /dev/null; then
        log_pass "YouTube metadata extraction works"

        # Check if we can extract specific fields
        local title=$("$KAYA_CLI" youtube --get-title "$test_url" 2>/dev/null)
        if [[ -n "$title" ]]; then
            log_pass "YouTube title extraction works: $title"
        else
            log_fail "YouTube title extraction failed"
        fi
    else
        log_fail "YouTube metadata extraction failed (network issue?)"
    fi
}

# Test Calendar access
test_calendar_e2e() {
    echo ""
    echo "=== Testing Calendar E2E ==="

    log_test "List calendars"
    if "$KAYA_CLI" calendar list &> /dev/null; then
        log_pass "Calendar list works (authenticated)"

        log_test "Get agenda"
        if "$KAYA_CLI" calendar agenda --days 1 &> /dev/null; then
            log_pass "Calendar agenda works"
        else
            log_fail "Calendar agenda failed"
        fi
    else
        log_skip "Calendar not authenticated (run configure-google-auth.sh)"
    fi
}

# Test Drive access
test_drive_e2e() {
    echo ""
    echo "=== Testing Drive E2E ==="

    log_test "List Drive directories"
    if "$KAYA_CLI" drive lsd gdrive: &> /dev/null; then
        log_pass "Drive list works (authenticated)"

        log_test "Get Drive info"
        if "$KAYA_CLI" drive about gdrive: &> /dev/null; then
            log_pass "Drive info works"
        else
            log_fail "Drive info failed"
        fi
    else
        log_skip "Drive not configured (run configure-google-auth.sh)"
    fi
}

# Test Gmail access
test_gmail_e2e() {
    echo ""
    echo "=== Testing Gmail E2E ==="

    log_test "Get inbox"
    if "$KAYA_CLI" gmail inbox --limit 1 2>&1 | grep -qv "error"; then
        log_pass "Gmail inbox works (authenticated)"
    else
        log_skip "Gmail not authenticated (run configure-google-auth.sh)"
    fi
}

# Test Gemini query
test_gemini_e2e() {
    echo ""
    echo "=== Testing Gemini E2E ==="

    log_test "Simple Gemini query"
    # Only test if API key is set
    if [[ -n "${GEMINI_API_KEY:-}" ]]; then
        if "$KAYA_CLI" gemini "What is 2+2?" 2>&1 | grep -qi "4"; then
            log_pass "Gemini query works"
        else
            log_fail "Gemini query failed or returned unexpected result"
        fi
    else
        log_skip "Gemini API key not set (export GEMINI_API_KEY=...)"
    fi
}

# Test Bluesky access
test_bluesky_e2e() {
    echo ""
    echo "=== Testing Bluesky E2E ==="

    log_test "Get Bluesky profile"
    if "$KAYA_CLI" bluesky profile show &> /dev/null; then
        log_pass "Bluesky profile works (authenticated)"

        log_test "Get Bluesky timeline"
        if "$KAYA_CLI" bluesky timeline --limit 5 &> /dev/null; then
            log_pass "Bluesky timeline works"
        else
            log_fail "Bluesky timeline failed"
        fi
    else
        log_skip "Bluesky not authenticated (run configure-bluesky.sh)"
    fi
}

# Test Browse.ts (if available)
test_browse_e2e() {
    echo ""
    echo "=== Testing Browse.ts E2E ==="

    log_test "Browse.ts basic functionality"
    if command -v bun &> /dev/null && [[ -f "$HOME/.claude/skills/Browser/Tools/Browse.ts" ]]; then
        # Simple test - just check if the script runs without error
        if bun run "$HOME/.claude/skills/Browser/Tools/Browse.ts" --help &> /dev/null; then
            log_pass "Browse.ts runs successfully"
        else
            log_fail "Browse.ts execution failed"
        fi
    else
        log_skip "Browse.ts or bun not available"
    fi
}

# Summary
print_summary() {
    echo ""
    echo "================================"
    echo "E2E Test Summary"
    echo "================================"
    echo -e "${GREEN}PASS:${NC} $PASS"
    echo -e "${YELLOW}SKIP:${NC} $SKIP"
    echo -e "${RED}FAIL:${NC} $FAIL"
    echo ""

    if [[ $FAIL -eq 0 ]]; then
        echo -e "${GREEN}✓ All E2E tests passed (${SKIP} skipped due to auth)${NC}"
        echo ""
        if [[ $SKIP -gt 0 ]]; then
            echo "To enable skipped tests:"
            echo "  - Google services: bash ~/.claude/tools/UnixCLI/configure-google-auth.sh"
            echo "  - Bluesky: bash ~/.claude/tools/UnixCLI/configure-bluesky.sh"
            echo "  - Gemini: export GEMINI_API_KEY=your-key"
        fi
        return 0
    else
        echo -e "${RED}✗ Some E2E tests failed${NC}"
        return 1
    fi
}

# Main
main() {
    echo "================================"
    echo "Kaya Unix CLI - E2E Tests"
    echo "================================"
    echo ""
    echo "NOTE: These tests require:"
    echo "  - Network access"
    echo "  - Authentication for some services"
    echo "  - May be rate-limited"
    echo ""

    test_youtube_e2e
    test_calendar_e2e
    test_drive_e2e
    test_gmail_e2e
    test_gemini_e2e
    test_bluesky_e2e
    test_browse_e2e

    print_summary
}

main "$@"
