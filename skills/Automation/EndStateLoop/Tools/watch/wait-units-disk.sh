#!/bin/bash
# Wake when free disk < LIMIT GiB, when closed units grow by STEP, when a session waits on a permission prompt
# (or is otherwise blocked) for >= 10 min, or at the cap (endstate-setup-8, 2026-11-18; blocked wake added by
# endstate-setup-10 after learn-orch-13 sat 3.5 h on an unseen prompt, Jm F-031/F-035/F-021).
# Also wakes on a status-page lag (page-lag.py --wake: an unsent relay post, or a post older than the 2-hour rule).
# Usage: wait-units-disk.sh <limit GiB> <step> <cap s> <board>...
LIM="$1"; STEP="$2"; CAP="$3"; shift 3
closed() { python3 -I -c "import json,sys; print(sum(1 for p in sys.argv[1:] for u in json.load(open(p))['units'] if u.get('result','open')!='open'))" "$@"; }
SEEN="${TMPDIR:-/tmp}/wait-blocked-seen.$$"; : > "$SEEN"
blocked() {  # prints "name id" of sessions blocked >= 10 min (first seen by this wait)
  claude agents --json 2>/dev/null | python3 -I -c "
import json,sys,time,os
seen_path=sys.argv[1]; now=time.time()
try: seen=dict(l.split(' ',1)[::-1] for l in open(seen_path).read().split('\n') if l)
except Exception: seen={}
try: d=json.load(sys.stdin)
except Exception: sys.exit(0)
items=d if isinstance(d,list) else d.get('agents',[])
cur={}
me=os.path.basename(os.environ.get('CLAUDE_JOB_DIR','').rstrip('/'))  # skip the session that runs this wait (setup-11: its own 'blocked' while its report waits on Jm woke it)
for a in items:
  if str(a.get('id'))==me: continue
  if str(a.get('id')) in os.environ.get('WAIT_SKIP_IDS','').split(','): continue  # setup-16: a known Jm-blocked session of another chain, already reported
  if a.get('state')=='blocked' or a.get('waitingFor'):
    k=str(a.get('id')); cur[k]=float(seen.get(k, now))
    if now-cur[k]>=600: print('%s %s (%s)'%(a.get('name'),k,a.get('waitingFor') or a.get('state')))
open(seen_path,'w').write('\n'.join('%s %s'%(v,k) for k,v in cur.items()))
" "$SEEN"
}
START=$(date +%s); BASE=$(closed "$@")
while true; do
  free=$(df -k / | tail -1 | awk '{printf "%.2f", $4/1048576}')
  if awk -v f="$free" -v l="$LIM" 'BEGIN{exit !(f<l)}'; then echo "DISK: free $free GiB < $LIM"; rm -f "$SEEN"; exit 0; fi
  now=$(closed "$@")
  if [ $(( now - BASE )) -ge "$STEP" ]; then echo "UNITS CLOSED: $BASE -> $now (free $free GiB)"; rm -f "$SEEN"; exit 0; fi
  b=$(blocked)
  if [ -n "$b" ]; then echo "BLOCKED >= 10 min: $b (free $free GiB)"; rm -f "$SEEN"; exit 0; fi
  pg=$(python3 -I "$HOME/.kaya/state/endstate-setup/page-lag.py" --wake 2>/dev/null)  # setup-19 11-24 (Jm: keep the status page current)
  if [ -n "$pg" ]; then echo "$pg (free $free GiB)"; rm -f "$SEEN"; exit 0; fi
  if [ $(( $(date +%s) - START )) -ge "$CAP" ]; then echo "CAP reached: closed units $BASE -> $now (free $free GiB)"; rm -f "$SEEN"; exit 0; fi
  sleep 60
done
