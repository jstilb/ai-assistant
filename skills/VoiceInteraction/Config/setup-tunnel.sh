#!/bin/bash
set -euo pipefail

TUNNEL_NAME="kaya-voice"
TUNNEL_DOMAIN="voice.kayaai.dev"
CONFIG_DIR="$HOME/.cloudflared"
LAUNCHD_DIR="$HOME/Library/LaunchAgents"
PLIST_LABEL="com.pai.cloudflare-tunnel"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "=== Kaya Voice Tunnel Setup ==="

# Step 1: Check cloudflared
if ! command -v cloudflared &>/dev/null; then
    echo "Installing cloudflared..."
    brew install cloudflared
fi
echo "cloudflared version: $(cloudflared --version)"

# Step 2: Auth check
if [ ! -f "$CONFIG_DIR/cert.pem" ]; then
    echo ""
    echo "Cloudflare auth required. A browser window will open."
    echo "Log in and select the domain for the tunnel."
    read -p "Press Enter to continue..."
    cloudflared login
fi

# Step 3: Create tunnel
if ! cloudflared tunnel list | grep -q "$TUNNEL_NAME"; then
    echo "Creating tunnel: $TUNNEL_NAME"
    cloudflared tunnel create "$TUNNEL_NAME"
fi

# Step 4: Get tunnel UUID
TUNNEL_UUID=$(cloudflared tunnel list -o json | jq -r ".[] | select(.name==\"$TUNNEL_NAME\") | .id")
echo "Tunnel UUID: $TUNNEL_UUID"

# Step 5: Write config
mkdir -p "$CONFIG_DIR"
cat > "$CONFIG_DIR/config.yml" << EOF
tunnel: $TUNNEL_NAME
credentials-file: $CONFIG_DIR/$TUNNEL_UUID.json

ingress:
  - hostname: $TUNNEL_DOMAIN
    service: http://localhost:8882
    originRequest:
      connectTimeout: 10s
      tcpKeepAlive: 30s
  - service: http_status:404
EOF
echo "Config written to $CONFIG_DIR/config.yml"

# Step 6: DNS record
echo "Creating DNS record..."
cloudflared tunnel route dns "$TUNNEL_NAME" "$TUNNEL_DOMAIN" || echo "DNS record may already exist"

# Step 7: Install launchd plist
cp "$SCRIPT_DIR/com.pai.cloudflare-tunnel.plist" "$LAUNCHD_DIR/"
launchctl load "$LAUNCHD_DIR/$PLIST_LABEL.plist"
echo "launchd daemon loaded"

# Step 8: Verify
sleep 3
if launchctl list | grep -q "$PLIST_LABEL"; then
    echo ""
    echo "=== Setup Complete ==="
    echo "Tunnel: $TUNNEL_NAME"
    echo "Domain: https://$TUNNEL_DOMAIN"
    echo "Test:   curl https://$TUNNEL_DOMAIN"
else
    echo "WARNING: Daemon may not have started. Check logs at $CONFIG_DIR/tunnel-error.log"
fi
