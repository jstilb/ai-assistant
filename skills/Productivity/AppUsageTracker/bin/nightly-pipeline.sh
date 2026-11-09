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
#
# `timeout` alone did not bound wall time: runs still took 12-33 h (2026-09/10)
# against a 2 h budget. So step() also polls the timeout child against its own
# wall-clock hard ceiling (secs + HARD_CEILING_GRACE). On a breach it SIGKILLs
# the child's process group, marks the run failed and moves on, without waiting
# on a child that will not die. Each step appends one JSON row (UTC start/end,
# rc, timedOutHard, durationSec) to STEPS_LOG, so a long run shows which step
# took the time. The poll runs about once per awake second, so a durationSec
# far above the ceiling means the Mac slept during that step; a real hang ends
# near the ceiling.

set -uo pipefail

# Prefer the Homebrew binaries (Apple-silicon Mac), then PATH (gtimeout on a Mac with coreutils, timeout on Linux).
BUN="${BUN:-$([ -x /opt/homebrew/bin/bun ] && echo /opt/homebrew/bin/bun || command -v bun || echo /opt/homebrew/bin/bun)}"
TIMEOUT_BIN="${TIMEOUT_BIN:-$([ -x /opt/homebrew/bin/timeout ] && echo /opt/homebrew/bin/timeout || command -v timeout || command -v gtimeout || echo /opt/homebrew/bin/timeout)}"
TOOLS="$HOME/.claude/skills/Productivity/AppUsageTracker/Tools"
STEPS_LOG="$HOME/.claude/MEMORY/AppUsage/nightly-pipeline-steps.jsonl"
# Seconds past a step's own timeout before step() stops waiting on it. Covers
# timeout's --kill-after=15s plus reaping, with margin.
HARD_CEILING_GRACE=60

# Run from /tmp: the inference helper spawns `claude -p`, which detects Claude
# Code nesting (and misbehaves) if the working directory is ~/.claude.
cd /tmp || exit 1

fail=0
step() {
  local name="$1"
  local secs="$2"; shift 2
  local ceiling=$((secs + HARD_CEILING_GRACE))
  local started_at t0 pid rc tries timed_out_hard=false
  started_at="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  t0=$SECONDS
  echo "=== $(date '+%Y-%m-%d %H:%M:%S') ${name} (timeout ${secs}s, hard ceiling ${ceiling}s) ==="
  "$TIMEOUT_BIN" --kill-after=15s "${secs}" "$@" &
  pid=$!
  while kill -0 "$pid" 2>/dev/null; do
    if [ $((SECONDS - t0)) -ge "$ceiling" ]; then
      timed_out_hard=true
      break
    fi
    sleep 1
  done
  if [ "$timed_out_hard" = true ]; then
    echo "!!! STEP HIT HARD CEILING: ${name} still running after ${ceiling}s wall; SIGKILL to pid ${pid} and its process group"
    # GNU timeout leads its own process group, so -pid also kills the step
    # under it. Fall back to the pid alone when no such group exists.
    kill -KILL -- "-${pid}" 2>/dev/null || kill -KILL "$pid"
    tries=0
    while kill -0 "$pid" 2>/dev/null && [ "$tries" -lt 5 ]; do
      sleep 1
      tries=$((tries + 1))
    done
    if kill -0 "$pid" 2>/dev/null; then
      echo "!!! STEP DID NOT DIE AFTER SIGKILL: ${name} (pid ${pid}); proceeding without waiting further"
      rc=null
    else
      wait "$pid"
      rc=$?
    fi
    fail=1
  else
    wait "$pid"
    rc=$?
    if [ "$rc" -ne 0 ]; then
      if [ "$rc" -eq 124 ]; then
        echo "!!! STEP TIMED OUT: ${name} after ${secs}s"
      else
        echo "!!! STEP FAILED: ${name} (exit ${rc})"
      fi
      fail=1
    fi
  fi
  if ! { mkdir -p "${STEPS_LOG%/*}" &&
    printf '{"step":"%s","startedAt":"%s","finishedAt":"%s","rc":%s,"timedOutHard":%s,"durationSec":%d}\n' \
      "$name" "$started_at" "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$rc" "$timed_out_hard" "$((SECONDS - t0))" \
      >> "$STEPS_LOG"; }; then
    echo "!!! STEP LOG WRITE FAILED: ${name} -> ${STEPS_LOG}"
    fail=1
  fi
}

# Sourced (tests): stop after the definitions, before any step runs.
[ "${BASH_SOURCE[0]}" = "$0" ] || return 0

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
