#!/usr/bin/env bash
# install-plists.sh — re-runs the canonical Kaya plist regenerator.
# The actual write_plist blocks for com.kaya.aw-poller and com.kaya.aw-metric-calc
# live in ~/.claude/bin/rebuild-plists.sh (single source of truth for all Kaya plists).
set -euo pipefail
exec bash "$HOME/.claude/bin/rebuild-plists.sh" "$@"
