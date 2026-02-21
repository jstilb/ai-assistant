#!/usr/bin/env bash
# Kaya Unix CLI Tools - Installation Validation
# Tests all CLI tools and their authentication

set -euo pipefail

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'

PASS=0
FAIL=0
WARN=0

log_header() {
    echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo -e "${CYAN}${1}${NC}"
    echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
}

log_test() {
    echo -e "${BLUE}[TEST]${NC} ${1}"
}

log_pass() {
    echo -e "${GREEN}[PASS]${NC} ${1}"
    ((PASS++))
}

log_fail() {
    echo -e "${RED}[FAIL]${NC} ${1}"
    ((FAIL++))
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} ${1}"
    ((WARN++))
}

# Test individual tool installation
test_tool_installed() {
    local tool=$1
    local display_name=${2:-$tool}

    log_test "Checking if $display_name is installed..."

    if command -v "$tool" &> /dev/null; then
        log_pass "$display_name found: $(which $tool)"
        return 0
    else
        log_fail "$display_name not found in PATH"
        return 1
    fi
}

# Test tool version
test_tool_version() {
    local tool=$1
    local version_cmd=$2
    local display_name=${3:-$tool}

    log_test "Checking $display_name version..."

    if eval "$version_cmd" &> /dev/null; then
        local version=$(eval "$version_cmd" 2>&1 | head -1)
        log_pass "$display_name version: $version"
        return 0
    else
        log_warn "$display_name version check failed"
        return 1
    fi
}

# Test authentication
test_auth() {
    local tool=$1
    local test_cmd=$2
    local display_name=${3:-$tool}

    log_test "Testing $display_name authentication..."

    if eval "$test_cmd" &> /dev/null; then
        log_pass "$display_name authentication working"
        return 0
    else
        log_warn "$display_name authentication not configured or failed"
        return 1
    fi
}

# Test yt-dlp
test_ytdlp() {
    log_header "YouTube-DL (yt-dlp)"

    test_tool_installed "yt-dlp" "yt-dlp"
    test_tool_version "yt-dlp" "yt-dlp --version" "yt-dlp"

    log_test "Testing yt-dlp functionality (metadata extraction)..."
    if yt-dlp --dump-json --no-download "https://www.youtube.com/watch?v=dQw4w9WgXcQ" &> /dev/null; then
        log_pass "yt-dlp can extract metadata"
    else
        log_warn "yt-dlp metadata extraction test failed (may be network issue)"
    fi

    echo ""
}

# Test gcalcli
test_gcalcli() {
    log_header "Google Calendar (gcalcli)"

    if ! test_tool_installed "gcalcli" "gcalcli"; then
        echo ""
        return 1
    fi

    test_tool_version "gcalcli" "gcalcli --version" "gcalcli"
    test_auth "gcalcli" "gcalcli list" "gcalcli"

    echo ""
}

# Test rclone
test_rclone() {
    log_header "Rclone (Google Drive)"

    if ! test_tool_installed "rclone" "rclone"; then
        echo ""
        return 1
    fi

    test_tool_version "rclone" "rclone version | head -1" "rclone"

    # Check if gdrive remote is configured
    log_test "Checking for gdrive remote configuration..."
    if rclone listremotes | grep -q "gdrive:"; then
        log_pass "gdrive remote configured"

        test_auth "rclone" "rclone lsd gdrive:" "rclone (gdrive)"
    else
        log_warn "gdrive remote not configured. Run: rclone config"
    fi

    echo ""
}

# Test gogcli (gog)
test_gogcli() {
    log_header "Google Workspace CLI (gog)"

    if ! test_tool_installed "gog" "gogcli"; then
        echo ""
        return 1
    fi

    test_tool_version "gog" "gog version" "gogcli"

    # Check if credentials are configured
    log_test "Checking gog credentials..."
    if gog auth list &> /dev/null; then
        log_pass "gog has configured accounts"

        # Test Gmail access
        test_auth "gog" "gog gmail inbox --limit 1" "gog (Gmail)"
    else
        log_warn "gog not authenticated. Run: gog auth add"
    fi

    echo ""
}

# Test gemini-cli
test_gemini() {
    log_header "Gemini CLI"

    if ! test_tool_installed "gemini" "gemini-cli"; then
        echo ""
        return 1
    fi

    test_tool_version "gemini" "gemini --version" "gemini-cli"

    log_test "Testing gemini functionality..."
    if gemini --help &> /dev/null; then
        log_pass "gemini-cli functional"
    else
        log_warn "gemini-cli help command failed"
    fi

    echo ""
}

# Test bsky
test_bsky() {
    log_header "Bluesky CLI (bsky)"

    # Check standard location and GOPATH/bin
    if ! command -v bsky &> /dev/null; then
        GOBIN="${GOPATH:-$HOME/go}/bin"
        if [[ -x "$GOBIN/bsky" ]]; then
            log_warn "bsky found in $GOBIN but not in PATH"
            log_warn "Add to PATH: export PATH=\"\$PATH:$GOBIN\""
            echo ""
            return 1
        else
            log_fail "bsky not found"
            echo ""
            return 1
        fi
    fi

    log_pass "bsky found: $(which bsky)"

    # Check version (may not be supported)
    log_test "Checking bsky version..."
    if bsky --version &> /dev/null; then
        local version=$(bsky --version 2>&1)
        log_pass "bsky version: $version"
    else
        log_warn "bsky version check not supported (this is normal)"
    fi

    # Check authentication
    log_test "Testing bsky authentication..."
    if bsky profile show &> /dev/null; then
        log_pass "bsky authentication working"
    else
        log_warn "bsky not authenticated. Run: bsky login [handle]"
    fi

    echo ""
}

# Test Browse.ts (playwright)
test_playwright() {
    log_header "Playwright (Browse.ts)"

    local browse_ts="${HOME}/.claude/skills/Browser/Tools/Browse.ts"

    log_test "Checking Browse.ts..."
    if [[ -f "$browse_ts" ]]; then
        log_pass "Browse.ts found: $browse_ts"

        log_test "Checking if Browse.ts is executable..."
        if [[ -x "$browse_ts" ]]; then
            log_pass "Browse.ts is executable"
        else
            log_warn "Browse.ts not executable (may still work with bun)"
        fi

        # Check bun
        log_test "Checking bun runtime..."
        if command -v bun &> /dev/null; then
            log_pass "bun found: $(bun --version)"
        else
            log_fail "bun not found (required for Browse.ts)"
        fi
    else
        log_fail "Browse.ts not found at $browse_ts"
    fi

    echo ""
}

# Summary
print_summary() {
    log_header "VALIDATION SUMMARY"

    echo -e "${GREEN}PASS:${NC} $PASS"
    echo -e "${YELLOW}WARN:${NC} $WARN"
    echo -e "${RED}FAIL:${NC} $FAIL"
    echo ""

    if [[ $FAIL -eq 0 ]]; then
        if [[ $WARN -eq 0 ]]; then
            echo -e "${GREEN}✓ All tests passed!${NC}"
            echo -e "${GREEN}All CLI tools are installed and configured correctly.${NC}"
        else
            echo -e "${YELLOW}⚠ Some warnings detected${NC}"
            echo -e "${YELLOW}All critical tools are working, but some features may need configuration.${NC}"
        fi
        echo ""
        echo -e "${BLUE}Next step:${NC} Create kaya-cli wrapper (Phase 2)"
        return 0
    else
        echo -e "${RED}✗ Some tests failed${NC}"
        echo -e "${RED}Please fix the issues above before proceeding.${NC}"
        echo ""
        echo -e "${BLUE}To fix:${NC}"
        echo -e "  - Install missing tools: bash ~/.claude/tools/UnixCLI/install-cli-tools.sh"
        echo -e "  - Configure Google auth: bash ~/.claude/tools/UnixCLI/configure-google-auth.sh"
        echo -e "  - Configure Bluesky: bash ~/.claude/tools/UnixCLI/configure-bluesky.sh"
        return 1
    fi
}

# Main execution
main() {
    log_header "KAYA UNIX CLI TOOLS - VALIDATION"
    echo ""

    test_ytdlp
    test_gcalcli
    test_rclone
    test_gogcli
    test_gemini
    test_bsky
    test_playwright

    print_summary
}

main "$@"
