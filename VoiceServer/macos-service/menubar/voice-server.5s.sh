#!/bin/bash

# PAIVoice Server SwiftBar Plugin
# Filename must end in .Xs.sh where X is refresh interval (5s = 5 seconds)
# 
# To install:
# 1. Install SwiftBar from https://swiftbar.app
# 2. Copy this file to your SwiftBar plugins folder
# 3. Make it executable: chmod +x voice-server.5s.sh

export PATH="/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

# Configuration
KAYA_DIR="${KAYA_DIR:-$HOME/.claude}"
SERVICE_NAME="com.paivoice.server"
SERVER_URL="http://localhost:8888"
VOICE_SERVER_DIR="$KAYA_DIR/VoiceServer"

# Check if server is running
if curl -s "${SERVER_URL}/health" > /dev/null 2>&1; then
    # Server is running - show active icon
    echo "🎙️"
    echo "---"
    echo "✅ Voice Server Active | color=green"
    
    # Get server info
    HEALTH=$(curl -s "${SERVER_URL}/health" 2>/dev/null || echo "{}")
    PORT=$(echo "$HEALTH" | grep -o '"port":[0-9]*' | grep -o '[0-9]*' || echo "8888")
    
    echo "📡 Port: $PORT | color=#666666"
    
    # Check if using ElevenLabs
    if [ -f ~/.claude/.env ] && grep -q "ELEVENLABS_API_KEY=" ~/.claude/.env 2>/dev/null; then
        API_KEY=$(grep "ELEVENLABS_API_KEY=" ~/.claude/.env | cut -d'=' -f2)
        if [[ "$API_KEY" != "your_api_key_here" ]] && [[ -n "$API_KEY" ]]; then
            echo "🤖 AI Voice: Enabled | color=#666666"
        else
            echo "🔊 Voice: macOS Say | color=#666666"
        fi
    else
        echo "🔊 Voice: macOS Say | color=#666666"
    fi
    
    # Check service status
    if launchctl list | grep -q "${SERVICE_NAME}"; then
        PID=$(launchctl list | grep "${SERVICE_NAME}" | awk '{print $1}')
        if [ "$PID" != "-" ]; then
            echo "🚀 Service: Running (PID: $PID) | color=#666666"
        else
            echo "⚠️ Service: Loaded but stopped | color=orange"
        fi
    else
        echo "⚠️ Running manually (not as service) | color=orange"
    fi
    
    echo "---"
    echo "📢 Test Notification | bash='${VOICE_SERVER_DIR}/macos-service/voice-server-ctl.sh' param1=test terminal=false"
    echo "🔄 Restart Server | bash='${VOICE_SERVER_DIR}/macos-service/voice-server-ctl.sh' param1=restart terminal=false refresh=true"
    echo "⏹️ Stop Server | bash='${VOICE_SERVER_DIR}/macos-service/voice-server-ctl.sh' param1=stop terminal=false refresh=true"
    
else
    # Server is not running - show inactive icon
    echo "🔇"
    echo "---"
    echo "❌ Voice Server Offline | color=red"
    
    # Check if service is installed
    if [ -f ~/Library/LaunchAgents/${SERVICE_NAME}.plist ]; then
        echo "Service installed but not running | color=#666666"
        echo "---"
        echo "▶️ Start Server | bash='${VOICE_SERVER_DIR}/macos-service/voice-server-ctl.sh' param1=start terminal=false refresh=true"
    else
        echo "Service not installed | color=#666666"
        echo "---"
        echo "📦 Install Service | bash='cd ${VOICE_SERVER_DIR}/macos-service && ./install.sh' terminal=true refresh=true"
    fi
fi

echo "---"
echo "📋 View Logs | bash='${VOICE_SERVER_DIR}/macos-service/voice-server-ctl.sh' param1=logs terminal=true"
echo "🔍 Check Setup | bash='cd ${VOICE_SERVER_DIR}/macos-service && ./validate-setup.sh' terminal=true"
echo "---"
echo "📁 Open Voice Server Folder | bash='open' param1='${VOICE_SERVER_DIR}' terminal=false"
echo "📄 View README | bash='open' param1='${VOICE_SERVER_DIR}/macos-service/README.md' terminal=false"
echo "---"
echo "🔄 Refresh | refresh=true"