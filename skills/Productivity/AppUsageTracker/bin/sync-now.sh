#!/usr/bin/env bash
# sync-now.sh — interactive force-sync.
#
# Lean fast path: poll all aw-watcher devices (Mac + connected phone/tablet),
# ingest Chrome history (Mac local + new Takeout zips), recompute daily
# metrics, report Freshness.
#
# Deliberately excludes the slow LLM step (YouTubeClassifier). Newly-ingested
# YouTube events are counted in the next nightly run; interactive freshness on
# tier-1 / total-low-value is the win here.
#
# Every step is wall-clock-bounded by `timeout` so a hung child (commonly a
# stuck `claude -p` inference call) can't lock the events.db pipeline. A
# previous incident left events.db locked for 2+ days because YouTubeClassifier
# hung on a single `claude -p` call and nothing detected it.
set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TIMEOUT_BIN=/opt/homebrew/bin/timeout

fail=0
step() {
  local name="$1"
  local secs="$2"; shift 2
  "$TIMEOUT_BIN" --kill-after=10s "${secs}" "$@"
  local rc=$?
  if [ "$rc" -ne 0 ]; then
    if [ "$rc" -eq 124 ]; then
      echo "[WARN] ${name} TIMED OUT after ${secs}s — continuing"
    else
      echo "[WARN] ${name} failed (exit ${rc}) — continuing"
    fi
    fail=1
  fi
}

step "AWPoller"            60  bun "$DIR/Tools/AWPoller.ts"
step "ChromeIngest"        30  bun "$DIR/Tools/ChromeIngest.ts"
step "ChromeTakeoutIngest" 60  bun "$DIR/Tools/ChromeTakeoutIngest.ts"
step "ChromeClassifier"    90  bun "$DIR/Tools/ChromeClassifier.ts"
step "YouTubeIngest"       120 bun "$DIR/Tools/YouTubeIngest.ts"
step "YouTubeEnrich"       180 bun "$DIR/Tools/YouTubeEnrich.ts"
step "Classifier"          120 bun "$DIR/Tools/Classifier.ts"

# MetricCalc is load-bearing for Freshness. If it fails we still report status
# but exit non-zero so cron wrappers see degradation.
if ! "$TIMEOUT_BIN" --kill-after=10s 60 bun "$DIR/Tools/MetricCalc.ts" --force; then
  echo "[ERR] MetricCalc failed — running Freshness for visibility then exiting non-zero"
  "$TIMEOUT_BIN" --kill-after=5s 15 bun "$DIR/Tools/Freshness.ts" "$@" || true
  exit 1
fi
exec "$TIMEOUT_BIN" --kill-after=5s 15 bun "$DIR/Tools/Freshness.ts" "$@"
