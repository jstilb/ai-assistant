#!/usr/bin/env bash
# Kaya Unix CLI Tools Installation Script
# Installs: gcalcli, rclone, gogcli (gog), bsky, linearis, glab, slackcat, 1password-cli
# Optionally: stripe, supabase, firebase
# Already installed: yt-dlp, gemini-cli, playwright (via Browse.ts), gh

set -euo pipefail

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Logging
LOG_DIR="${HOME}/.claude/logs"
mkdir -p "$LOG_DIR"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
LOG_FILE="${LOG_DIR}/unix-cli-install-${TIMESTAMP}.log"

log() {
    echo -e "${1}" | tee -a "$LOG_FILE"
}

log_info() {
    log "${BLUE}[INFO]${NC} ${1}"
}

log_success() {
    log "${GREEN}[SUCCESS]${NC} ${1}"
}

log_warning() {
    log "${YELLOW}[WARNING]${NC} ${1}"
}

log_error() {
    log "${RED}[ERROR]${NC} ${1}"
}

# Check prerequisites
check_prerequisites() {
    log_info "Checking prerequisites..."

    if ! command -v brew &> /dev/null; then
        log_error "Homebrew not found. Please install Homebrew first: https://brew.sh"
        exit 1
    fi
    log_success "Homebrew found"

    if ! command -v go &> /dev/null; then
        log_warning "Go not found. Will attempt to install via Homebrew"
        brew install go >> "$LOG_FILE" 2>&1
        log_success "Go installed"
    else
        log_success "Go found: $(go version)"
    fi
}

# Install individual tools
install_gcalcli() {
    log_info "Installing gcalcli..."
    if command -v gcalcli &> /dev/null; then
        log_warning "gcalcli already installed: $(gcalcli --version)"
        return 0
    fi

    brew install gcalcli >> "$LOG_FILE" 2>&1
    log_success "gcalcli installed: $(gcalcli --version)"
}

install_rclone() {
    log_info "Installing rclone..."
    if command -v rclone &> /dev/null; then
        log_warning "rclone already installed: $(rclone version | head -1)"
        return 0
    fi

    brew install rclone >> "$LOG_FILE" 2>&1
    log_success "rclone installed: $(rclone version | head -1)"
}

install_gogcli() {
    log_info "Installing gogcli (gog)..."
    if command -v gog &> /dev/null; then
        log_warning "gog already installed: $(gog version)"
        return 0
    fi

    # Add the tap if not already added
    brew tap steipete/tap >> "$LOG_FILE" 2>&1 || true
    brew install steipete/tap/gogcli >> "$LOG_FILE" 2>&1
    log_success "gogcli installed: $(gog version)"
}

install_bsky() {
    log_info "Installing bsky CLI..."
    if command -v bsky &> /dev/null; then
        log_warning "bsky already installed: $(bsky --version 2>&1 || echo 'version unknown')"
        return 0
    fi

    # Install via go
    go install github.com/mattn/bsky@latest >> "$LOG_FILE" 2>&1

    # Verify GOPATH/bin is in PATH
    GOBIN="${GOPATH:-$HOME/go}/bin"
    if [[ ":$PATH:" != *":$GOBIN:"* ]]; then
        log_warning "Go bin directory ($GOBIN) not in PATH"
        log_warning "Add this to your ~/.zshrc or ~/.bashrc:"
        log_warning "  export PATH=\"\$PATH:$GOBIN\""
    fi

    if command -v bsky &> /dev/null; then
        log_success "bsky installed"
    else
        log_error "bsky installation may have succeeded but not found in PATH"
        log_error "Try: export PATH=\"\$PATH:$GOBIN\" and run this script again"
        return 1
    fi
}

install_glab() {
    log_info "Installing glab (GitLab CLI)..."
    if command -v glab &> /dev/null; then
        log_warning "glab already installed: $(glab --version 2>&1 | head -1)"
        return 0
    fi

    brew install glab >> "$LOG_FILE" 2>&1
    log_success "glab installed: $(glab --version 2>&1 | head -1)"
}

install_slackcat() {
    log_info "Installing slackcat..."
    if command -v slackcat &> /dev/null; then
        log_warning "slackcat already installed"
        return 0
    fi

    brew install slackcat >> "$LOG_FILE" 2>&1
    log_success "slackcat installed"
}

install_1password_cli() {
    log_info "Installing 1Password CLI..."
    if command -v op &> /dev/null; then
        log_warning "1Password CLI already installed: $(op --version 2>&1)"
        return 0
    fi

    brew install --cask 1password-cli >> "$LOG_FILE" 2>&1
    log_success "1Password CLI installed"
}

install_stripe_cli() {
    log_info "Installing Stripe CLI..."
    if command -v stripe &> /dev/null; then
        log_warning "Stripe CLI already installed: $(stripe --version 2>&1)"
        return 0
    fi

    brew install stripe/stripe-cli/stripe >> "$LOG_FILE" 2>&1
    log_success "Stripe CLI installed"
}

install_supabase_cli() {
    log_info "Installing Supabase CLI..."
    if command -v supabase &> /dev/null; then
        log_warning "Supabase CLI already installed: $(supabase --version 2>&1)"
        return 0
    fi

    brew install supabase/tap/supabase >> "$LOG_FILE" 2>&1
    log_success "Supabase CLI installed"
}

install_firebase_cli() {
    log_info "Installing Firebase CLI..."
    if command -v firebase &> /dev/null; then
        log_warning "Firebase CLI already installed: $(firebase --version 2>&1)"
        return 0
    fi

    # Prefer npm for firebase-tools
    if command -v npm &> /dev/null; then
        npm install -g firebase-tools >> "$LOG_FILE" 2>&1
    else
        log_error "npm not found. Install Node.js first."
        return 1
    fi
    log_success "Firebase CLI installed"
}

install_completions() {
    log_info "Installing kaya-cli tab completions..."

    local completions_dir="${HOME}/.claude/bin/completions"

    if [[ ! -d "$completions_dir" ]]; then
        log_error "Completions directory not found: $completions_dir"
        return 1
    fi

    # Zsh completions (check SHELL, not ZSH_VERSION since we're in bash)
    if [[ "$SHELL" == *"zsh"* ]]; then
        log_info "Setting up Zsh completions..."
        local zshrc="${HOME}/.zshrc"

        # Check if already configured
        if ! grep -q "/.claude/bin/completions" "$zshrc" 2>/dev/null; then
            echo '' >> "$zshrc"
            echo '# Kaya CLI completions' >> "$zshrc"
            echo 'fpath=(~/.claude/bin/completions $fpath)' >> "$zshrc"
            echo 'autoload -Uz compinit && compinit' >> "$zshrc"
            log_success "Added Zsh completion config to ~/.zshrc"
            log_warning "Run 'source ~/.zshrc' or restart terminal to activate"
        else
            log_warning "Zsh completions already configured in ~/.zshrc"
        fi
    fi

    # Bash completions
    if [[ "$SHELL" == *"bash"* ]]; then
        log_info "Setting up Bash completions..."
        local bashrc="${HOME}/.bashrc"

        # Check if already configured
        if ! grep -q "/.claude/bin/completions/_kaya-cli.bash" "$bashrc" 2>/dev/null; then
            echo '' >> "$bashrc"
            echo '# Kaya CLI completions' >> "$bashrc"
            echo 'source ~/.claude/bin/completions/_kaya-cli.bash' >> "$bashrc"
            log_success "Added Bash completion config to ~/.bashrc"
            log_warning "Run 'source ~/.bashrc' or restart terminal to activate"
        else
            log_warning "Bash completions already configured in ~/.bashrc"
        fi
    fi

    log_success "Completions installed"
}

# Verify installations
verify_installations() {
    log_info "Verifying installations..."
    local all_good=true

    # Already installed tools
    for tool in yt-dlp gemini gh; do
        if command -v "$tool" &> /dev/null; then
            log_success "$tool: ✓"
        else
            log_warning "$tool: not found (expected to be pre-installed)"
        fi
    done

    # Core installed tools
    for tool in gcalcli rclone gog; do
        if command -v "$tool" &> /dev/null; then
            log_success "$tool: ✓"
        else
            log_error "$tool: ✗ (installation failed)"
            all_good=false
        fi
    done

    # Phase 2+ tools (may need PATH update)
    for tool in bsky glab slackcat op; do
        if command -v "$tool" &> /dev/null; then
            log_success "$tool: ✓"
        else
            log_warning "$tool: not in PATH (may need shell restart or installation)"
        fi
    done

    # Optional cloud tools
    for tool in stripe supabase firebase; do
        if command -v "$tool" &> /dev/null; then
            log_success "$tool: ✓ (optional)"
        else
            log_warning "$tool: not installed (optional)"
        fi
    done

    # Browse.ts (not a CLI tool but used for playwright)
    if [[ -f "${HOME}/.claude/skills/Browser/Tools/Browse.ts" ]]; then
        log_success "Browse.ts (playwright): ✓"
    else
        log_warning "Browse.ts: not found"
    fi

    # Custom TypeScript tools
    for tool in Weather.ts Places.ts Sheets.ts; do
        if [[ -f "${HOME}/.claude/tools/UnixCLI/${tool}" ]]; then
            log_success "$tool: ✓"
        else
            log_warning "$tool: not found"
        fi
    done

    # Completions
    if [[ -f "${HOME}/.claude/bin/completions/_kaya-cli" ]]; then
        log_success "completions (_kaya-cli): ✓"
    else
        log_warning "completions: not found"
    fi

    if $all_good; then
        log_success "All critical tools installed successfully!"
        return 0
    else
        log_error "Some tools failed to install. Check log: $LOG_FILE"
        return 1
    fi
}

# Main execution
main() {
    local install_optional=false

    # Parse arguments
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --all|--optional)
                install_optional=true
                shift
                ;;
            *)
                shift
                ;;
        esac
    done

    log_info "Kaya Unix CLI Tools Installation"
    log_info "Log file: $LOG_FILE"
    echo ""

    check_prerequisites
    echo ""

    log_info "Installing core tools..."
    install_gcalcli
    install_rclone
    install_gogcli
    install_bsky
    echo ""

    log_info "Installing additional tools..."
    install_glab
    install_slackcat
    install_1password_cli
    echo ""

    if $install_optional; then
        log_info "Installing optional cloud tools..."
        install_stripe_cli
        install_supabase_cli
        install_firebase_cli
        echo ""
    else
        log_info "Skipping optional cloud tools (stripe, supabase, firebase)"
        log_info "To install them, run: $0 --all"
        echo ""
    fi

    log_info "Installing completions..."
    install_completions
    echo ""

    verify_installations
    echo ""

    log_info "Installation complete!"
    log_info "Next steps:"
    log_info "  1. Restart your terminal (or source your rc file) for completions"
    log_info "  2. Configure Google OAuth2: bash ~/.claude/tools/UnixCLI/configure-google-auth.sh"
    log_info "  3. Configure Bluesky: bash ~/.claude/tools/UnixCLI/configure-bluesky.sh"
    log_info "  4. Configure 1Password: op signin"
    log_info "  5. Validate all tools: bash ~/.claude/tools/UnixCLI/validate-installations.sh"
}

main "$@"
