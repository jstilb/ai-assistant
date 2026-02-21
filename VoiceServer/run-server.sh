#!/usr/bin/env bash
# Voice Server Launcher Script

# Use current user's HOME if not set
export HOME="${HOME:-$(eval echo ~$USER)}"
export PATH="$HOME/.bun/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
export PORT=8888

# Use KAYA_DIR for the Kaya configuration directory
KAYA_DIR="${KAYA_DIR:-$HOME/.claude}"

cd "${KAYA_DIR}/Voice-In-The-Cloud"
exec "$HOME/.bun/bin/bun" run server.ts