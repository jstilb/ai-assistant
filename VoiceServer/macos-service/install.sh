#!/bin/bash

# PAIVoice Server Service Installer
# This script installs the voice server as a macOS LaunchAgent

set -e

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
KAYA_DIR="${KAYA_DIR:-$HOME/.claude}"
SERVICE_NAME="com.paivoice.server"
PLIST_FILE="com.paivoice.server.plist"
LAUNCH_AGENTS_DIR="$HOME/Library/LaunchAgents"
VOICE_SERVER_DIR="$KAYA_DIR/VoiceServer"

echo "🚀 PAIVoice Server Service Installer"
echo "==========================================="
echo ""

# Check if bun is installed
if ! command -v bun &> /dev/null; then
    echo "❌ Error: bun is not installed"
    echo "Please install bun first: curl -fsSL https://bun.sh/install | bash"
    exit 1
fi

# Check for ElevenLabs API configuration
echo "🔑 Checking API configuration..."
if [ -f ~/.claude/.env ] && grep -q "ELEVENLABS_API_KEY" ~/.claude/.env 2>/dev/null; then
    echo "✅ ElevenLabs API key found in ~/.claude/.env"
else
    echo "⚠️  No ElevenLabs API key found"
    echo ""
    echo "   The server will use macOS 'say' command for voice."
    echo "   To enable ElevenLabs AI voices:"
    echo ""
    echo "   1. Get a free API key from: https://elevenlabs.io"
    echo "   2. Add to ~/.claude/.env file:"
    echo "      ELEVENLABS_API_KEY=your_api_key_here"
    echo "      ELEVENLABS_VOICE_ID=voice_id_here  # Optional, defaults to default voice"
    echo ""
    read -p "   Continue without ElevenLabs? (y/n): " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        echo "Installation cancelled. Set up ~/.claude/.env and try again."
        exit 1
    fi
fi

# Create logs directory
echo "📁 Creating logs directory..."
mkdir -p "${VOICE_SERVER_DIR}/logs"

# Create LaunchAgents directory if it doesn't exist
echo "📁 Creating LaunchAgents directory..."
mkdir -p "${LAUNCH_AGENTS_DIR}"

# Stop existing service if running
if launchctl list | grep -q "${SERVICE_NAME}"; then
    echo "⏹️  Stopping existing service..."
    launchctl unload "${LAUNCH_AGENTS_DIR}/${PLIST_FILE}" 2>/dev/null || true
    launchctl remove "${SERVICE_NAME}" 2>/dev/null || true
fi

# Copy plist file to LaunchAgents
echo "📝 Installing service configuration..."
cp "${SCRIPT_DIR}/${PLIST_FILE}" "${LAUNCH_AGENTS_DIR}/"

# Load the service
echo "🔧 Loading service..."
launchctl load -w "${LAUNCH_AGENTS_DIR}/${PLIST_FILE}"

# Check if service is running
sleep 2
if launchctl list | grep -q "${SERVICE_NAME}"; then
    echo "✅ Service installed and running successfully!"
    echo ""
    echo "📊 Service Status:"
    launchctl list | grep "${SERVICE_NAME}"
    echo ""
    echo "🔍 Test the service:"
    echo "   curl http://localhost:8888/health"
    echo ""
    echo "📋 Service Management Commands:"
    echo "   Start:   launchctl start ${SERVICE_NAME}"
    echo "   Stop:    launchctl stop ${SERVICE_NAME}"
    echo "   Status:  launchctl list | grep ${SERVICE_NAME}"
    echo "   Logs:    tail -f ${VOICE_SERVER_DIR}/logs/voice-server.log"
    echo ""
    echo "🗑️  To uninstall:"
    echo "   ${SCRIPT_DIR}/uninstall.sh"
else
    echo "❌ Failed to start service. Check logs at:"
    echo "   ${VOICE_SERVER_DIR}/logs/voice-server-error.log"
    exit 1
fi