#!/usr/bin/env bash
# Quick OAuth Setup for Google Services
# Run this when you're ready to authenticate

set -euo pipefail

CLIENT_ID="${GOOGLE_CLIENT_ID:?Set GOOGLE_CLIENT_ID in your environment or secrets.json}"
CLIENT_SECRET="${GOOGLE_CLIENT_SECRET:?Set GOOGLE_CLIENT_SECRET in your environment or secrets.json}"

echo "=== Google Calendar (gcalcli) Setup ==="
echo ""
echo "This will open a browser window for OAuth authorization."
echo "Please:"
echo "  1. Select your Google account"
echo "  2. Click 'Allow' to grant calendar access"
echo "  3. Return to this terminal"
echo ""
read -p "Press Enter to continue..." -r

echo "Opening browser for gcalcli authorization..."
gcalcli --client-id "$CLIENT_ID" --client-secret "$CLIENT_SECRET" list

if [ $? -eq 0 ]; then
    echo "✓ Calendar authenticated successfully!"
else
    echo "✗ Calendar authentication failed"
fi

echo ""
echo "=== Gmail & Google Workspace (gog) Setup ==="
echo ""
echo "Adding your Google account to gog..."
echo "Browser will open again for authorization."
echo ""
read -p "Press Enter to continue..." -r

gog auth add

if [ $? -eq 0 ]; then
    echo "✓ Gmail authenticated successfully!"
    echo ""
    echo "Set default account:"
    gog auth list
    read -p "Enter email to use as default: " email
    echo "export GOG_ACCOUNT=\"$email\"" >> ~/.zshrc
    echo "✓ Default account set: $email"
else
    echo "✗ Gmail authentication failed"
fi

echo ""
echo "=== Google Drive (rclone) Setup ==="
echo ""
echo "Configuring rclone for Google Drive..."
echo "When prompted:"
echo "  - n (new remote)"
echo "  - name: gdrive"
echo "  - storage: 15 (Google Drive)"
echo "  - client_id: $CLIENT_ID"
echo "  - client_secret: $CLIENT_SECRET"
echo "  - scope: 1 (full access)"
echo "  - Use auto config: y"
echo ""
read -p "Press Enter to continue..." -r

rclone config

echo ""
echo "=== Setup Complete ==="
echo ""
echo "Test your services:"
echo "  kaya-cli calendar agenda"
echo "  kaya-cli gmail inbox --limit 5"
echo "  kaya-cli drive lsd gdrive:"
