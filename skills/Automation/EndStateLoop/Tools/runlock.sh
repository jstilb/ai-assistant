#!/bin/bash
# One heavy run at a time on the Mac (16 GB): run a command under a lock folder that only its owner removes.
# Usage: runlock.sh <lock dir> <owner session name> <command> [args...]
# It waits while another owner holds the lock (one check per 30 s, at most RUNLOCK_WAIT_S, default 7200).
# A lock whose owner process is gone is stale and is taken. A lock with no pid line (a hand-made mkdir,
# or another tool) is never taken: it waits. Exit: the command's exit code; 75 when the wait timed out.
# Why: on 2026-11-09 22:28 a session's own cleanup removed another session's Learn RUN.lock (learn-orch-1).
LOCK="$1"
OWNER="$2"
shift 2
if [ -z "$LOCK" ] || [ -z "$OWNER" ] || [ $# -eq 0 ]; then
  echo "usage: runlock.sh <lock dir> <owner session name> <command> [args...]" >&2
  exit 2
fi
WAIT="${RUNLOCK_WAIT_S:-7200}"
START=$(date +%s)
owner_pid() { sed -n 's/^pid=//p' "$LOCK/owner" 2>/dev/null; }
while ! mkdir "$LOCK" 2>/dev/null; do
  pid="$(owner_pid)"
  if [ -n "$pid" ] && ! kill -0 "$pid" 2>/dev/null; then
    echo "runlock: stale lock (owner pid $pid is gone); taking it" >&2
    rm -f "$LOCK/owner"
    rmdir "$LOCK" 2>/dev/null
    continue
  fi
  if [ $(( $(date +%s) - START )) -ge "$WAIT" ]; then
    echo "runlock: $LOCK is still held after $WAIT s: $(tr '\n' ' ' < "$LOCK/owner" 2>/dev/null)" >&2
    exit 75
  fi
  sleep "${RUNLOCK_POLL_S:-30}"
done
printf 'name=%s\npid=%s\nsince=%s\ncmd=%s\n' "$OWNER" "$$" "$(date '+%Y-%m-%dT%H:%M:%S%z')" "$*" > "$LOCK/owner"
release() {
  if [ "$(owner_pid)" = "$$" ]; then
    rm -f "$LOCK/owner"
    rmdir "$LOCK" 2>/dev/null
  fi
}
trap release EXIT
trap 'exit 143' INT TERM
"$@"
