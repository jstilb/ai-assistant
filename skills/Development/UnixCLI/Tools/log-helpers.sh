#!/usr/bin/env bash
# Shared colour + log_* helpers for the UnixCLI setup scripts
# (install-cli-tools.sh, configure-google-auth.sh, configure-bluesky.sh).
# Source it:  source "$(dirname "${BASH_SOURCE[0]}")/log-helpers.sh"
# If LOG_FILE is set before sourcing (or before a call), output is also
# appended to it.

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

log() {
    if [[ -n "${LOG_FILE:-}" ]]; then
        echo -e "${1}" | tee -a "$LOG_FILE"
    else
        echo -e "${1}"
    fi
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
