#!/bin/bash
# One heavy run at a time on the Mac (16 GB): run a command under a lock folder that only its owner removes.
# Usage: [RUNLOCK_FIRST=1] runlock.sh <lock dir>[,<second lock dir>] <owner session name> <command> [args...]
# Waiters queue first come, first served: each one writes a ticket in <lock dir>.queue/, and only the oldest
# live ticket takes the free lock. RUNLOCK_FIRST=1 is for the merge check of a proven unit (a change that
# waits to go live): its ticket goes before every other ticket. One check per RUNLOCK_POLL_S (default 10 s),
# at most RUNLOCK_WAIT_S (default 7200) in all. A lock or a ticket whose process is gone is stale and is removed.
# A lock with no pid line (a hand-made mkdir, or another tool) is never taken: it waits.
# Two locks (a run that needs both, e.g. the memory lock and the model lock): give both in one call, the memory
# lock first: `runlock.sh <board>/RUN.lock,<board>/MODEL.lock <name> <command…>`. The call waits in the first
# queue and holds nothing. When it has the first lock, it takes the second ahead of that lock's other waiters,
# so it holds the first lock idle for one run of the second at most.
# A nested call is refused (exit 2): a call whose ancestor process owns a lock (any folder with an owner file) in the
# folder of its lock dir. A nested call
# holds one lock while it waits in another queue, and that blocks every waiter of the held lock.
# Exit: the command's exit code; 75 when the wait timed out; 2 for a usage error or a nested call.
# Why: on 2026-11-09 22:28 a session's own cleanup removed another session's Learn RUN.lock (learn-orch-1).
# Why the queue: on 2026-11-10 09:53 an examiner that ran back to back took the free lock again at once,
# while 7 waiters (one for 75 min, two proven merges) slept between their checks (learn-orch-4).
# Why one call for two locks: on 2026-11-10 15:14 learn-exam-29 held MODEL.lock (nested: model lock first, then
# runlock on RUN.lock) while it waited behind 5 RUN.lock tickets; 3 pure model batches waited on an idle lock
# (learn-orch-5).
LOCKS="$1"
OWNER="$2"
shift 2
if [ -z "$LOCKS" ] || [ -z "$OWNER" ] || [ $# -eq 0 ]; then
  echo "usage: [RUNLOCK_FIRST=1] runlock.sh <lock dir>[,<second lock dir>] <owner session name> <command> [args...]" >&2
  exit 2
fi
IFS=',' read -r LOCK LOCK2 EXTRA <<< "$LOCKS"
if [ -n "$EXTRA" ] || [ -z "$LOCK" ] || { [ -n "$LOCK2" ] && [ "$LOCK2" = "$LOCK" ]; }; then
  echo "runlock: give one lock dir or two different ones, separated by a comma: $LOCKS" >&2
  exit 2
fi
CMD="$*"
WAIT="${RUNLOCK_WAIT_S:-7200}"
START=$(date +%s)
CLASS=1
[ "${RUNLOCK_FIRST:-0}" = 1 ] && CLASS=0

owner_pid() { sed -n 's/^pid=//p' "$1/owner" 2>/dev/null; }

# Refuse a nested call: an ancestor of this process owns a lock in the folder of either lock dir.
ANCESTORS=" "
p=$$
while [ -n "$p" ] && [ "$p" -gt 1 ] 2>/dev/null; do
  p="$(ps -o ppid= -p "$p" 2>/dev/null | tr -d ' ')"
  [ -n "$p" ] && ANCESTORS="$ANCESTORS$p "
done
for o in "$(dirname "$LOCK")"/*/owner ${LOCK2:+"$(dirname "$LOCK2")"/*/owner}; do
  [ -f "$o" ] || continue
  d="$(dirname "$o")"
  op="$(owner_pid "$d")"
  case "$ANCESTORS" in *" $op "*)
    [ -n "$op" ] || continue
    echo "runlock: refused: a nested call. Process $op, an ancestor of this call, owns $d and would hold it while this call waits for $LOCKS. Give both locks in one call: runlock.sh <memory lock>,<model lock> <name> <command…>" >&2
    exit 2 ;;
  esac
done

TICKETS=""
HELD=""
# A ticket name sorts by class, then arrival time, then pid: <class>-<epoch s, 10 digits>-<pid, 7 digits>.
new_ticket() {   # <lock dir> <class>: writes the ticket and sets TICKET to its path
  local q="$1.queue"
  mkdir -p "$q" || exit 2
  TICKET="$q/$(printf '%s-%010d-%07d' "$2" "$(date +%s)" "$$")"
  printf 'name=%s\npid=%s\ncmd=%s\n' "$OWNER" "$$" "$CMD" > "$TICKET"
  TICKETS="$TICKETS $TICKET"
}
# The oldest ticket in a queue whose process lives; dead tickets are removed on the way.
head_ticket() {   # <queue dir>
  local t pid
  for t in $(ls "$1" 2>/dev/null | sort); do
    case "$t" in [01]-[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]-[0-9][0-9][0-9][0-9][0-9][0-9][0-9]) ;; *) continue ;; esac
    pid=$((10#${t##*-}))
    if kill -0 "$pid" 2>/dev/null; then echo "$t"; return; fi
    rm -f "$1/$t"
  done
}
release() {
  local t l
  for t in $TICKETS; do rm -f "$t"; done
  for l in $HELD; do
    if [ "$(owner_pid "$l")" = "$$" ]; then
      rm -f "$l/owner"
      rmdir "$l" 2>/dev/null
    fi
  done
}
trap release EXIT
trap 'exit 143' INT TERM

acquire() {   # <lock dir> <class>
  local lock="$1" pid
  new_ticket "$lock" "$2"
  while :; do
    if [ "$(head_ticket "$lock.queue")" = "$(basename "$TICKET")" ] && mkdir "$lock" 2>/dev/null; then break; fi
    pid="$(owner_pid "$lock")"
    if [ -n "$pid" ] && ! kill -0 "$pid" 2>/dev/null; then
      echo "runlock: stale lock (owner pid $pid is gone); removing it" >&2
      rm -f "$lock/owner"
      rmdir "$lock" 2>/dev/null
      continue
    fi
    if [ $(( $(date +%s) - START )) -ge "$WAIT" ]; then
      echo "runlock: $lock is still held after $WAIT s: $(tr '\n' ' ' < "$lock/owner" 2>/dev/null)" >&2
      exit 75
    fi
    sleep "${RUNLOCK_POLL_S:-10}"
  done
  rm -f "$TICKET"
  HELD="$HELD $lock"
  printf 'name=%s\npid=%s\nsince=%s\ncmd=%s\n' "$OWNER" "$$" "$(date '+%Y-%m-%dT%H:%M:%S%z')" "$CMD" > "$lock/owner"
}

acquire "$LOCK" "$CLASS"
[ -n "$LOCK2" ] && acquire "$LOCK2" 0
"$@"
