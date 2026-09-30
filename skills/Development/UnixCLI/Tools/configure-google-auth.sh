#!/usr/bin/env bash
# Kaya Unix CLI Tools - Google OAuth2 Configuration
# Configures authentication for: gcalcli (Google Calendar), rclone (Google Drive), gog (Gmail)

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

# Check if tools are installed
check_tools() {
    log_info "Checking installed tools..."

    for tool in gcalcli rclone gog; do
        if ! command -v "$tool" &> /dev/null; then
            log_error "$tool not found. Run install-cli-tools.sh first"
            exit 1
        fi
    done

    log_success "All required tools found"
}

# Configure gcalcli
configure_gcalcli() {
    echo ""
    log_info "Configuring gcalcli (Google Calendar)..."
    echo ""

    log_info "gcalcli uses OAuth2 authentication. You'll need to:"
    log_info "  1. Visit Google Cloud Console to create OAuth2 credentials (or use existing)"
    log_info "  2. Download the client_secret.json file"
    log_info "  3. A browser will open for you to authorize access"
    echo ""

    read -p "Have you downloaded client_secret.json for gcalcli? (y/n) " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        log_warning "Please download OAuth2 credentials first:"
        log_warning "  1. Go to: https://console.cloud.google.com/apis/credentials"
        log_warning "  2. Create OAuth 2.0 Client ID (Desktop app)"
        log_warning "  3. Download JSON file"
        log_warning "  4. Run this script again"
        return 1
    fi

    read -p "Enter path to client_secret.json: " client_secret_path
    if [[ ! -f "$client_secret_path" ]]; then
        log_error "File not found: $client_secret_path"
        return 1
    fi

    # Copy to gcalcli config directory
    mkdir -p ~/.local/share/gcalcli/oauth
    cp "$client_secret_path" ~/.local/share/gcalcli/oauth/client_secret.json
    log_success "Client secret copied to gcalcli config directory"

    log_info "Running gcalcli authentication (browser will open)..."
    gcalcli list || {
        log_error "gcalcli authentication failed"
        return 1
    }

    log_success "gcalcli configured successfully!"
}

# Configure rclone
configure_rclone() {
    echo ""
    log_info "Configuring rclone (Google Drive)..."
    echo ""

    log_info "rclone requires OAuth2 authentication. You'll need to:"
    log_info "  1. Create a new remote named 'gdrive'"
    log_info "  2. Select Google Drive as the storage type"
    log_info "  3. Follow the OAuth flow in your browser"
    echo ""

    read -p "Configure rclone now? (y/n) " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        log_warning "Skipping rclone configuration"
        log_warning "Configure later with: rclone config"
        return 0
    fi

    log_info "Starting rclone configuration..."
    log_info "When prompted:"
    log_info "  - Name: gdrive"
    log_info "  - Storage: drive (Google Drive)"
    log_info "  - Scope: 1 (full access) or as needed"
    log_info "  - Use auto config: y"
    echo ""

    rclone config || {
        log_error "rclone configuration failed"
        return 1
    }

    # Test the configuration
    if rclone lsd gdrive: &> /dev/null; then
        log_success "rclone configured successfully!"
    else
        log_warning "rclone configured but test failed. Try: rclone lsd gdrive:"
    fi
}

# Configure gogcli (gog)
configure_gogcli() {
    echo ""
    log_info "Configuring gogcli (Gmail, Calendar, Drive)..."
    echo ""

    log_info "gogcli requires OAuth2 credentials. You'll need to:"
    log_info "  1. Download client_secret JSON from Google Cloud Console"
    log_info "  2. Import credentials into gog"
    log_info "  3. Add an account via browser OAuth flow"
    log_info "  4. Set a default account"
    echo ""

    read -p "Have you downloaded client_secret.json for gog? (y/n) " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        log_warning "Please download OAuth2 credentials first:"
        log_warning "  1. Go to: https://console.cloud.google.com/apis/credentials"
        log_warning "  2. Create OAuth 2.0 Client ID (Desktop app)"
        log_warning "  3. Enable Gmail, Calendar, Drive APIs"
        log_warning "  4. Download JSON file"
        log_warning "  5. Run this script again"
        return 1
    fi

    read -p "Enter path to client_secret.json for gog: " gog_client_secret_path
    if [[ ! -f "$gog_client_secret_path" ]]; then
        log_error "File not found: $gog_client_secret_path"
        return 1
    fi

    log_info "Importing credentials to gog..."
    gog auth credentials "$gog_client_secret_path" || {
        log_error "Failed to import credentials"
        return 1
    }
    log_success "Credentials imported"

    log_info "Adding account (browser will open for OAuth)..."
    gog auth add || {
        log_error "Failed to add account"
        return 1
    }
    log_success "Account added"

    # Ask for default account
    log_info "Getting account list..."
    gog auth list

    echo ""
    read -p "Enter email to set as default account: " default_email
    export GOG_ACCOUNT="$default_email"

    log_info "Add this to your ~/.zshrc or ~/.bashrc:"
    log_info "  export GOG_ACCOUNT=\"$default_email\""
    echo ""

    # Test gog
    if gog gmail inbox --limit 1 &> /dev/null; then
        log_success "gogcli configured successfully!"
    else
        log_warning "gogcli configured but test failed. Try: gog gmail inbox --limit 5"
    fi
}

# Main execution
main() {
    log_info "Kaya Unix CLI Tools - Google OAuth2 Configuration"
    echo ""

    check_tools
    echo ""

    log_info "This script will configure authentication for:"
    log_info "  - gcalcli (Google Calendar)"
    log_info "  - rclone (Google Drive)"
    log_info "  - gogcli/gog (Gmail, Calendar, Drive)"
    echo ""

    log_warning "You will need OAuth2 credentials from Google Cloud Console"
    log_warning "Visit: https://console.cloud.google.com/apis/credentials"
    echo ""

    read -p "Continue? (y/n) " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        log_info "Configuration cancelled"
        exit 0
    fi

    # Configure each tool
    configure_gcalcli
    configure_rclone
    configure_gogcli

    echo ""
    log_success "Google OAuth2 configuration complete!"
    log_info "Next step: Configure Bluesky (bash ~/.claude/tools/UnixCLI/configure-bluesky.sh)"
}

main "$@"
