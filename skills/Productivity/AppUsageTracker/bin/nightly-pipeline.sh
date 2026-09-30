#!/bin/bash
# nightly-pipeline.sh — AppUsageTracker nightly data pipeline.
#
# Runs every ingest / classify / metric step in dependency order inside ONE
# process, so only one step ever holds the events.db write lock. DuckDB's lock
# is exclusive and process-wide, so the five separate 02:00-03:00 launchd jobs
# this replaces collided constantly — their .err.logs were full of
# "Could not set lock on file ... Conflicting lock is held". Serializing the
# whole pipeline removes that contention by construction.
#
# Every step runs even if an earlier one failed (a Chrome-ingest failure must
# not block MetricCalc), but the script exits non-zero if ANY step failed, so
# cron-health monitors see red on a degraded run rather than a false green.
#
# Every step is wall-clock-bounded via `timeout`. The historical failure mode:
# a single `claude -p` inference call hung indefinitely inside YouTubeClassifier,
# the classifier kept events.db locked, and the parent shell stayed "alive"
# forever — for 2+ days in one observed incident — so launchd never restarted
# it. Per-step timeouts make any hang self-recovering by the next nightly run.

set -uo pipefail

BUN=/opt/homebrew/bin/bun
TIMEOUT_BIN=/opt/homebrew/bin/timeout
TOOLS="$HOME/.claude/skills/Productivity/AppUsageTracker/Tools"

# Run from /tmp: the inference helper spawns `claude -p`, which detects Claude
# Code nesting (and misbehaves) if the working directory is ~/.claude.
cd /tmp || exit 1

fail=0
step() {
  local name="$1"
  local secs="$2"; shift 2
  echo "=== $(date '+%Y-%m-%d %H:%M:%S') ${name} (timeout ${secs}s) ==="
  "$TIMEOUT_BIN" --kill-after=15s "${secs}" "$@"
  local rc=$?
  if [ "$rc" -ne 0 ]; then
    if [ "$rc" -eq 124 ]; then
      echo "!!! STEP TIMED OUT: ${name} after ${secs}s"
    else
      echo "!!! STEP FAILED: ${name} (exit ${rc})"
    fi
    fail=1
  fi
}

# 1. Pull aw-watcher foreground events (Mac window-watcher).
step "AWPoller"            120  "$BUN" run "$TOOLS/AWPoller.ts" --device=mac
# 2. Ingest Chrome history — local Mac SQLite, then any Takeout export zips
#    dropped in youtube-takeout-inbox/ (cross-device, includes phone Chrome).
step "ChromeIngest"        120  "$BUN" run "$TOOLS/ChromeIngest.ts"
# 900s (was 300s): the inbox retains every Takeout zip permanently and
# discoverHistoryPaths() re-ingests ALL of them each night (no file-level skip),
# so the ~172k static rows currently take ~340s and grow ~85s per new export.
# The old 300s cap turned every run DEGRADED once the crash (fixed 2026-07-09:
# @duckdb/node-api 1.5.2→1.5.4-r.1) stopped short-circuiting it at ~2s.
# Follow-up recommended: file-level idempotent skip (match ChromeClassifier's
# "no-op once caught up" design) to remove the growing re-ingest entirely.
step "ChromeTakeoutIngest" 900  "$BUN" run "$TOOLS/ChromeTakeoutIngest.ts"
# 3. Classify Chrome domains (LLM; usually a no-op once caught up).
step "ChromeClassifier"    300  "$BUN" run "$TOOLS/ChromeClassifier.ts"
# 4. Ingest + enrich + classify YouTube watch-history. --limit=300 is sized to
#    FIT the 30-min step cap: classification runs serially at ~3.3s/video, so
#    300 x 3.3s ~= 17 min, comfortably under 1800s. (--limit=800 could never
#    finish in 30 min — 800 x 3.3s ~= 44 min — so it timed out every night and
#    the run always reported DEGRADED, masking real failures.) Recency ordering
#    means today's videos are classified first; the backlog drains ~300/night.
#    The 30-min cap is still the safety valve: any deeper hang gets killed and
#    the rest of the pipeline (incl. MetricCalc) still runs.
step "YouTubeIngest"       300  "$BUN" run "$TOOLS/YouTubeIngest.ts"
step "YouTubeEnrich"       600  "$BUN" run "$TOOLS/YouTubeEnrich.ts"
step "YouTubeClassifier"   1800 "$BUN" run "$TOOLS/YouTubeClassifier.ts" --limit=300
# 5. Classify aw-watcher Tier-2 sessions, then recompute every daily metric.
step "Classifier"          600  "$BUN" run "$TOOLS/Classifier.ts"
step "MetricCalc"          180  "$BUN" run "$TOOLS/MetricCalc.ts" --force

if [ "$fail" -ne 0 ]; then
  echo "=== $(date '+%Y-%m-%d %H:%M:%S') nightly-pipeline finished DEGRADED (>=1 step failed) ==="
  exit 1
fi
echo "=== $(date '+%Y-%m-%d %H:%M:%S') nightly-pipeline finished OK ==="
