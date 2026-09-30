#!/usr/bin/env bash
# Kaya Unix CLI Tools - Bluesky Authentication Configuration
# Configures authentication for: bsky CLI

set -euo pipefail

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log_info() {
    echo -e "${BLUE}[INFO]${NC} ${1}"
}

log_success() {
    echo -e "${GREEN}[SUCCESS]${NC} ${1}"
}

log_warning() {
    echo -e "${YELLOW}[WARNING]${NC} ${1}"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} ${1}"
}

# Check if bsky is installed
check_bsky() {
    log_info "Checking for bsky CLI..."

    if ! command -v bsky &> /dev/null; then
        # Check if it's in GOPATH/bin
        GOBIN="${GOPATH:-$HOME/go}/bin"
        if [[ -x "$GOBIN/bsky" ]]; then
            log_warning "bsky found in $GOBIN but not in PATH"
            log_warning "Add to your ~/.zshrc or ~/.bashrc:"
            log_warning "  export PATH=\"\$PATH:$GOBIN\""
            log_warning "Then restart your shell and run this script again"
            exit 1
        fi

        log_error "bsky not found. Run install-cli-tools.sh first"
        exit 1
    fi

    log_success "bsky CLI found"
}

# Configure bsky authentication
configure_bsky() {
    echo ""
    log_info "Configuring bsky CLI (Bluesky Social)..."
    echo ""

    log_info "You'll need your Bluesky credentials:"
    log_info "  - Handle (e.g., username.bsky.social)"
    log_info "  - App password (NOT your main password)"
    echo ""

    log_warning "Create an app password at: https://bsky.app/settings/app-passwords"
    echo ""

    read -p "Do you have an app password ready? (y/n) " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        log_warning "Please create an app password first:"
        log_warning "  1. Go to: https://bsky.app/settings/app-passwords"
        log_warning "  2. Create a new app password (e.g., 'Kaya CLI')"
        log_warning "  3. Copy the password"
        log_warning "  4. Run this script again"
        exit 0
    fi

    echo ""
    read -p "Enter your Bluesky handle (e.g., user.bsky.social): " bsky_handle

    log_info "Running bsky login (you'll be prompted for app password)..."
    echo ""

    # Run bsky login
    if bsky login "$bsky_handle"; then
        log_success "Bluesky authentication successful!"

        # Test the connection
        log_info "Testing connection..."
        if bsky profile show "$bsky_handle" &> /dev/null; then
            log_success "Connection test passed!"
        else
            log_warning "Authentication succeeded but profile test failed"
            log_warning "Try manually: bsky profile show $bsky_handle"
        fi
    else
        log_error "Bluesky authentication failed"
        log_error "Please check your handle and app password"
        return 1
    fi

    echo ""
    log_info "Session token stored in ~/.config/bsky/"
    log_success "Bluesky configuration complete!"
}

# Main execution
main() {
    log_info "Kaya Unix CLI Tools - Bluesky Authentication"
    echo ""

    check_bsky
    configure_bsky

    echo ""
    log_success "Bluesky authentication configuration complete!"
    log_info "Next step: Validate all installations (bash ~/.claude/tools/UnixCLI/validate-installations.sh)"
}

main "$@"
