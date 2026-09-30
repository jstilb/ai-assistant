#!/usr/bin/env bash
# Unit tests for individual CLI tools

set -euo pipefail

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

PASS=0
FAIL=0

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

# Test yt-dlp
test_ytdlp() {
    echo ""
    echo "=== Testing yt-dlp ==="

    log_test "Check yt-dlp installation"
    if command -v yt-dlp &> /dev/null; then
        log_pass "yt-dlp installed"
    else
        log_fail "yt-dlp not found"
        return 1
    fi

    log_test "Check yt-dlp version"
    if yt-dlp --version &> /dev/null; then
        local version=$(yt-dlp --version)
        log_pass "yt-dlp version: $version"
    else
        log_fail "yt-dlp version check failed"
    fi

    log_test "Check yt-dlp help"
    if yt-dlp --help | grep -q "Usage:"; then
        log_pass "yt-dlp help works"
    else
        log_fail "yt-dlp help failed"
    fi
}

# Test gcalcli
test_gcalcli() {
    echo ""
    echo "=== Testing gcalcli ==="

    log_test "Check gcalcli installation"
    if command -v gcalcli &> /dev/null; then
        log_pass "gcalcli installed"
    else
        log_fail "gcalcli not found"
        return 1
    fi

    log_test "Check gcalcli version"
    if gcalcli --version &> /dev/null; then
        local version=$(gcalcli --version)
        log_pass "gcalcli version: $version"
    else
        log_fail "gcalcli version check failed"
    fi

    log_test "Check gcalcli help"
    if gcalcli --help | grep -q "usage:"; then
        log_pass "gcalcli help works"
    else
        log_fail "gcalcli help failed"
    fi
}

# Test rclone
test_rclone() {
    echo ""
    echo "=== Testing rclone ==="

    log_test "Check rclone installation"
    if command -v rclone &> /dev/null; then
        log_pass "rclone installed"
    else
        log_fail "rclone not found"
        return 1
    fi

    log_test "Check rclone version"
    if rclone version | head -1 | grep -q "rclone"; then
        local version=$(rclone version | head -1)
        log_pass "rclone version: $version"
    else
        log_fail "rclone version check failed"
    fi

    log_test "Check rclone help"
    if rclone --help | grep -q "Usage:"; then
        log_pass "rclone help works"
    else
        log_fail "rclone help failed"
    fi
}

# Test gog
test_gog() {
    echo ""
    echo "=== Testing gog ==="

    log_test "Check gog installation"
    if command -v gog &> /dev/null; then
        log_pass "gog installed"
    else
        log_fail "gog not found"
        return 1
    fi

    log_test "Check gog version"
    if gog version | grep -q "v[0-9]"; then
        local version=$(gog version)
        log_pass "gog version: $version"
    else
        log_fail "gog version check failed"
    fi

    log_test "Check gog help"
    if gog --help | grep -q "Usage:"; then
        log_pass "gog help works"
    else
        log_fail "gog help failed"
    fi
}

# Test gemini
test_gemini() {
    echo ""
    echo "=== Testing gemini-cli ==="

    log_test "Check gemini installation"
    if command -v gemini &> /dev/null; then
        log_pass "gemini installed"
    else
        log_fail "gemini not found"
        return 1
    fi

    log_test "Check gemini version"
    if gemini --version &> /dev/null; then
        local version=$(gemini --version 2>&1 | grep -v "DeprecationWarning" | head -1)
        log_pass "gemini version: $version"
    else
        log_fail "gemini version check failed"
    fi

    log_test "Check gemini help"
    if gemini --help &> /dev/null; then
        log_pass "gemini help works"
    else
        log_fail "gemini help failed"
    fi
}

# Test bsky
test_bsky() {
    echo ""
    echo "=== Testing bsky ==="

    # Update PATH to include go/bin
    export PATH="$PATH:$HOME/go/bin"

    log_test "Check bsky installation"
    if command -v bsky &> /dev/null; then
        log_pass "bsky installed"
    else
        log_fail "bsky not found (check PATH: $HOME/go/bin)"
        return 1
    fi

    log_test "Check bsky version"
    if bsky --version &> /dev/null; then
        local version=$(bsky --version 2>&1)
        log_pass "bsky version: $version"
    else
        log_fail "bsky version check failed (may not be supported)"
    fi
}

# Test bun (for Browse.ts and Asana tools)
test_bun() {
    echo ""
    echo "=== Testing bun runtime ==="

    log_test "Check bun installation"
    if command -v bun &> /dev/null; then
        log_pass "bun installed"
    else
        log_fail "bun not found"
        return 1
    fi

    log_test "Check bun version"
    if bun --version &> /dev/null; then
        local version=$(bun --version)
        log_pass "bun version: $version"
    else
        log_fail "bun version check failed"
    fi
}

# Test Browse.ts
test_browse() {
    echo ""
    echo "=== Testing Browse.ts (playwright) ==="

    local browse_ts="$HOME/.claude/skills/Browser/Tools/Browse.ts"

    log_test "Check Browse.ts exists"
    if [[ -f "$browse_ts" ]]; then
        log_pass "Browse.ts found"
    else
        log_fail "Browse.ts not found at $browse_ts"
        return 1
    fi

    log_test "Check Browse.ts is executable"
    if [[ -x "$browse_ts" ]] || command -v bun &> /dev/null; then
        log_pass "Browse.ts can be executed (via bun)"
    else
        log_fail "Browse.ts not executable and bun not found"
    fi
}

# Summary
print_summary() {
    echo ""
    echo "================================"
    echo "Unit Test Summary"
    echo "================================"
    echo -e "${GREEN}PASS:${NC} $PASS"
    echo -e "${RED}FAIL:${NC} $FAIL"
    echo ""

    if [[ $FAIL -eq 0 ]]; then
        echo -e "${GREEN}✓ All unit tests passed!${NC}"
        return 0
    else
        echo -e "${RED}✗ Some unit tests failed${NC}"
        return 1
    fi
}

# Main
main() {
    echo "================================"
    echo "Kaya Unix CLI - Unit Tests"
    echo "================================"

    test_ytdlp
    test_gcalcli
    test_rclone
    test_gog
    test_gemini
    test_bsky
    test_bun
    test_browse

    print_summary
}

main "$@"
