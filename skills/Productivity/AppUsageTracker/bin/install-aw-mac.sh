#!/usr/bin/env bash
# install-aw-mac.sh — install ActivityWatch Mac core (server + window/afk watchers).
# Idempotent. Browser extension and media-player watcher are separate manual steps.
set -euo pipefail

echo "=== ActivityWatch Mac install ==="

if ! command -v brew >/dev/null 2>&1; then
  echo "Error: Homebrew not installed. Install from https://brew.sh first." >&2
  exit 1
fi

if [ -d "/Applications/ActivityWatch.app" ]; then
  echo "ActivityWatch.app already present — skipping brew install."
else
  echo "Installing ActivityWatch via brew cask..."
  brew install --cask activitywatch
fi

echo "Launching ActivityWatch (will start aw-server + watchers)..."
open -a ActivityWatch
sleep 6

echo "Verifying AW server responds on http://localhost:5600 ..."
if ! curl -fsS http://localhost:5600/api/0/info >/dev/null; then
  echo "Error: AW server not responding. Open ActivityWatch.app and re-run." >&2
  exit 1
fi
curl -fsS http://localhost:5600/api/0/info | jq .

echo ""
echo "Buckets registered:"
curl -fsS http://localhost:5600/api/0/buckets/ | jq 'keys'

echo ""
echo "=== Mac core install OK ==="
echo ""
echo "NEXT STEPS (manual, one-time):"
echo "  1. Install browser extension:"
echo "     Chrome:  https://chromewebstore.google.com/detail/activitywatch-web-watcher/nglaklhklhcoonedhgnpgddginnjdadi"
echo "     Firefox: https://addons.mozilla.org/en-US/firefox/addon/aw-watcher-web/"
echo "     After install, open extension options and confirm 'Send data to ActivityWatch' is on."
echo "  2. Visit any site, then re-check buckets:"
echo "     curl -fsS http://localhost:5600/api/0/buckets/ | jq 'keys'"
echo "     A 'aw-watcher-web-chrome' (or -firefox) bucket should appear."
