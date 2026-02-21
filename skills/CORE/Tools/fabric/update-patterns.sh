#!/bin/bash
# Update Fabric patterns from upstream
# This script pulls the latest patterns using the fabric CLI
# and copies them to Kaya's local patterns directory

set -e

KAYA_DIR="${KAYA_DIR:-$HOME/.claude}"
FABRIC_PATTERNS_SOURCE="$HOME/.config/fabric/patterns"
PAI_PATTERNS_DIR="$KAYA_DIR/skills/CORE/Tools/fabric/patterns"

echo "🔄 Updating Fabric patterns..."

# First, update patterns using fabric CLI
echo "📥 Pulling latest patterns from fabric..."
fabric -U

# Then sync to Kaya's local copy
echo "📁 Syncing to Kaya patterns directory..."
rsync -av --delete "$FABRIC_PATTERNS_SOURCE/" "$PAI_PATTERNS_DIR/"

# Count patterns
PATTERN_COUNT=$(ls -1 "$PAI_PATTERNS_DIR" | wc -l | tr -d ' ')

echo "✅ Updated $PATTERN_COUNT patterns in $PAI_PATTERNS_DIR"
echo ""
echo "Patterns are now available for native Kaya usage."
echo "No need to call 'fabric -p' - just use the pattern prompts directly."
