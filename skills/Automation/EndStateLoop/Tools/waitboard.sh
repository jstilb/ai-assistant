#!/bin/bash
# Keep a waiting session alive, and wake it when the board changes.
# Usage: waitboard.sh <board> [cap seconds, default 3000]   (start it with run_in_background: true)
# Why: the Claude Code daemon retires a background session that sits idle at its prompt with no work in
# flight after about 60 min ("bg retire <id>: idle-prompt, idle 61m" in ~/.claude/daemon.log). It retired
# learn-orch-2 this way on 2026-11-10 05:56 PST while it waited on builders with only notify_when_idle
# subscriptions, and two results waited 40 min for an orchestrator. A background shell is work in flight.
# Output: one line, exit 0: "BOARD CHANGED: ..." when the board file's mtime changes; "CAP: ..." at the cap.
# Exit 2: bad arguments or a missing board. Poll: WAITBOARD_POLL_S (default 30).
BOARD="$1"
CAP="${2:-3000}"
if [ -z "$BOARD" ] || [ ! -f "$BOARD" ]; then
  echo "usage: waitboard.sh <board> [cap seconds]  (the board file must exist)" >&2
  exit 2
fi
case "$CAP" in
  '' | *[!0-9]*) echo "waitboard: the cap must be whole seconds, got '$CAP'" >&2; exit 2 ;;
esac
POLL="${WAITBOARD_POLL_S:-30}"
M0="$(stat -f %m "$BOARD")"
START=$(date +%s)
while true; do
  sleep "$POLL"
  m="$(stat -f %m "$BOARD" 2>/dev/null)"
  if [ "$m" != "$M0" ]; then
    echo "BOARD CHANGED: $BOARD at $(date '+%Y-%m-%dT%H:%M:%S%z')"
    exit 0
  fi
  if [ $(( $(date +%s) - START )) -ge "$CAP" ]; then
    echo "CAP: no board change in $CAP s; check the board and the sessions, then start the wait again"
    exit 0
  fi
done
