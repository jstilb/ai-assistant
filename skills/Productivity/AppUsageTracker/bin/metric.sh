#!/usr/bin/env bash
# metric.sh — print today's metric + rolling avg (read-only, fast).
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
exec bun "$DIR/Tools/Freshness.ts" "$@"
