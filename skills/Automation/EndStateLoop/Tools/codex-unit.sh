#!/bin/bash
# codex-unit.sh — run one EndStateLoop unit with Codex (`codex exec`) as the builder.
#
# Jm, 2026-11-17 (form-doc F-006): "have it work on formdoc" — Codex builds the units and reports to the
# Claude orchestrator; a Claude examiner outside the loop marks the board.
#
# Usage: codex-unit.sh [--detach] <unit id> <worktree> <contract path> <board folder> [--add-dir <dir>]...
#        codex-unit.sh --wait <board folder> <unit id>
#   The orchestrator makes the worktree first (`git -C <project> worktree add <path> -b <branch>`), starts the run
#   with --detach and arms --wait with run_in_background: true. The wait's line is the report.
#   --detach: the run starts in a new session (setsid) with SIGHUP ignored, stdin /dev/null and its output in
#     codex-run.log, so the end of the orchestrator session that started it does not kill it (2026-11-18: Jm
#     stopped formdoc-orch-8, and its background runs of U31 and U32 ended "Terminated: 15"). It prints
#     "detached pid=<pid> done=<path>" and exits 0 at once. The run behaves as without --detach and, at its end,
#     writes its last line to codex-done.txt: that file = the builder ended. Exit 5: this unit's detached run
#     (codex-unit.pid) still runs.
#   --wait: ends when codex-done.txt exists (prints its line, exit 0), or when the run's pid ended without it
#     (prints "<unit> runner died without codex-done.txt ...", exit 3). Exit 2: no detached run for the unit.
#     A killed wait loses nothing: arm it again. Poll: CODEX_WAIT_POLL_S (default 10).
#   Without --detach, the run is in the caller's process tree and dies with it; its exit is the builder's end and
#   its last line is the report.
#   Codex may write only in: the worktree, <board folder>/units/<unit id>/, each --add-dir, and the temp folder
#   (sandbox workspace-write; the global config's danger-full-access is not used for units).
#
# Files (in <board folder>/units/<unit id>/): codex-events.jsonl (the `--json` events), codex-last.txt (Codex's last
# message), codex-stderr.log; with --detach also codex-unit.pid, codex-run.log and codex-done.txt. Codex writes
# RESULT.md there (the contract says so); the orchestrator reads RESULT.md.
# Codex cannot commit (its sandbox keeps .git read-only): after Codex ends, this tool commits the tree on its
# branch with the RESULT.md line "Commit message: …" and prints commit=<hash|none|FAILED>.
#
# Codex usage stop: before the run, the tool reads Codex's own weekly reading (rate_limits.primary.used_percent in
# the newest ~/.codex/sessions rollout that has one; a reading whose window has reset counts as 0) and refuses
# (exit 4) at or over CODEX_USAGE_LIMIT (default 98: Jm's Claude weekly line of 2026-11-12, used for Codex until
# Jm sets another). This is not the Claude guard: Codex runs do not spend Claude's weekly usage.
# If the first reading is at or over the limit, it may be stale (Jm reset the usage by hand; no Codex session ran
# since). The tool then runs ONE tiny read-only `codex exec` call (cost: one tiny Codex call, only in this case;
# timeout CODEX_REFRESH_TIMEOUT, default 120 s; log in the unit folder as codex-refresh.log) and reads again. It
# refuses only if the fresh reading is still at or over the limit (both readings are in the line), or if the refresh failed.
#
# Env: CODEX_USAGE_LIMIT (default 98), CODEX_MODEL (default: the Codex config), CODEX_EFFORT (model_reasoning_effort),
#      CODEX_UNIT_TIMEOUT (seconds, default 14400), CODEX_SESSIONS_DIR (default ~/.codex/sessions; for checks),
#      CODEX_BIN (default codex; for checks), CODEX_REFRESH_TIMEOUT (seconds, default 120), CODEX_WAIT_POLL_S.
# Exit: 0 Codex ended with 0 · 1 bad arguments · 4 refused (Codex usage) · other: Codex's exit (124 = timeout).
#       --detach: 0 started · 1 · 5 already runs. --wait: 0 done · 1 · 2 no detached run · 3 runner died.

set -uo pipefail

SELF="$(cd "$(dirname "$0")" && pwd -P)/$(basename "$0")"

# True when pid $1 is alive and is the detached run of unit $2 (a reused pid or a zombie is not).
runner_alive() {
  case "$1" in '' | *[!0-9]*) return 1 ;; esac
  case "$(ps -ww -o command= -p "$1" 2>/dev/null)" in *"codex-unit.sh --detached-run $2 "*) return 0 ;; *) return 1 ;; esac
}

if [ "${1:-}" = "--wait" ]; then
  [ $# -eq 3 ] || { echo "usage: codex-unit.sh --wait <board folder> <unit id>" >&2; exit 1; }
  BOARD_DIR="$2"; UNIT="$3"
  case "$UNIT" in U[0-9]*) ;; *) echo "codex-unit: unit id must look like U<n>: $UNIT" >&2; exit 1 ;; esac
  [ -d "$BOARD_DIR" ] || { echo "codex-unit: no board folder at $BOARD_DIR" >&2; exit 1; }
  OUT="$BOARD_DIR/units/$UNIT"
  while true; do
    [ -f "$OUT/codex-done.txt" ] && { cat "$OUT/codex-done.txt"; exit 0; }
    [ -f "$OUT/codex-unit.pid" ] || { echo "codex-unit: no detached run for $UNIT (no $OUT/codex-unit.pid)" >&2; exit 2; }
    pid=$(tr -d '[:space:]' < "$OUT/codex-unit.pid")
    if ! runner_alive "$pid" "$UNIT"; then
      # The run writes codex-done.txt just before it ends: look once more.
      [ -f "$OUT/codex-done.txt" ] && { cat "$OUT/codex-done.txt"; exit 0; }
      echo "$UNIT runner died without codex-done.txt (pid $pid; its output: $OUT/codex-run.log)"
      exit 3
    fi
    sleep "${CODEX_WAIT_POLL_S:-10}"
  done
fi

MODE=run
case "${1:-}" in
  --detach) MODE=detach; shift ;;
  --detached-run) MODE=detached-run; shift ;;  # internal: the run that --detach starts
esac
if [ $# -lt 4 ]; then
  sed -n '2,/^$/p' "$0" >&2
  exit 1
fi
RUN_ARGS=("$@")
UNIT="$1"; WT="$2"; CONTRACT="$3"; BOARD_DIR="$4"; shift 4
EXTRA=()
while [ $# -gt 0 ]; do
  case "$1" in
    --add-dir) [ $# -ge 2 ] || { echo "codex-unit: --add-dir needs a folder" >&2; exit 1; }
               EXTRA+=(--add-dir "$2"); shift 2 ;;
    *) echo "codex-unit: unknown argument: $1" >&2; exit 1 ;;
  esac
done
case "$UNIT" in U[0-9]*) ;; *) echo "codex-unit: unit id must look like U<n>: $UNIT" >&2; exit 1 ;; esac
[ -d "$WT" ] || { echo "codex-unit: no worktree at $WT" >&2; exit 1; }
git -C "$WT" rev-parse --is-inside-work-tree >/dev/null 2>&1 || { echo "codex-unit: not a git tree: $WT" >&2; exit 1; }
[ -f "$CONTRACT" ] || { echo "codex-unit: no contract at $CONTRACT" >&2; exit 1; }
[ -d "$BOARD_DIR" ] || { echo "codex-unit: no board folder at $BOARD_DIR" >&2; exit 1; }
# An --add-dir that is the board folder or holds it would let Codex write the board and the exam sets (guard G6).
# A folder inside the board folder (e.g. <board folder>/locks) is allowed.
BOARD_REAL=$(cd "$BOARD_DIR" && pwd -P)
for ((i = 1; i < ${#EXTRA[@]}; i += 2)); do
  a=$(cd "${EXTRA[$i]}" 2>/dev/null && pwd -P) || { echo "codex-unit: no --add-dir folder at ${EXTRA[$i]}" >&2; exit 1; }
  case "$BOARD_REAL/" in "${a%/}"/*) echo "codex-unit: --add-dir ${EXTRA[$i]} holds the board folder; give a folder that holds only locks or scratch" >&2; exit 1 ;; esac
done

OUT="$BOARD_DIR/units/$UNIT"
mkdir -p "$OUT"

if [ "$MODE" = detach ]; then
  PIDF="$OUT/codex-unit.pid"
  if [ -f "$PIDF" ]; then
    old=$(tr -d '[:space:]' < "$PIDF")
    if runner_alive "$old" "$UNIT"; then
      echo "codex-unit: the detached run of $UNIT still runs (pid $old); arm --wait instead" >&2
      exit 5
    fi
  fi
  rm -f "$OUT/codex-done.txt"
  # A new session and an ignored SIGHUP: a kill of the caller's process group or tree does not reach the run, and
  # the caller's exit leaves it to launchd.
  python3 -I -c 'import os, signal, sys; signal.signal(signal.SIGHUP, signal.SIG_IGN); os.setsid(); os.execvp(sys.argv[1], sys.argv[1:])' \
    "${BASH:-bash}" "$SELF" --detached-run "${RUN_ARGS[@]}" < /dev/null > "$OUT/codex-run.log" 2>&1 &
  pid=$!
  printf '%s\n' "$pid" > "$PIDF.tmp.$$" && mv -f "$PIDF.tmp.$$" "$PIDF" \
    || { echo "codex-unit: could not write $PIDF; the run (pid $pid) goes on, but --wait cannot find it" >&2; exit 1; }
  echo "detached pid=$pid done=$OUT/codex-done.txt"
  exit 0
fi

DONE_FILE=""
[ "$MODE" = detached-run ] && DONE_FILE="$OUT/codex-done.txt"
# Print the report line and exit. The detached run also writes the line to codex-done.txt (a temp file, then mv).
finish() {
  echo "$1"
  if [ -n "$DONE_FILE" ]; then
    printf '%s\n' "$1" > "$DONE_FILE.tmp.$$" && mv -f "$DONE_FILE.tmp.$$" "$DONE_FILE" \
      || echo "codex-unit: could not write $DONE_FILE" >&2
  fi
  exit "$2"
}

LIMIT="${CODEX_USAGE_LIMIT:-98}"
SESS="${CODEX_SESSIONS_DIR:-$HOME/.codex/sessions}"
CODEX="${CODEX_BIN:-codex}"

# The newest weekly reading; prints "<percent> <resets_at or 0>" or "unknown".
week_reading() {
  python3 -I - "$SESS" <<'PY'
import glob, json, os, sys, time
files = sorted(glob.glob(os.path.join(sys.argv[1], "**", "rollout-*.jsonl"), recursive=True), key=os.path.getmtime, reverse=True)
for f in files[:40]:
    last = None
    try:
        for line in open(f, errors="replace"):
            if '"rate_limits"' not in line:
                continue
            try:
                p = json.loads(line).get("payload") or {}
            except ValueError:
                continue
            rl = p.get("rate_limits") if isinstance(p, dict) else None
            if rl and isinstance(rl.get("primary"), dict):
                last = rl["primary"]
    except OSError:
        continue
    if last is not None:
        pct = float(last.get("used_percent") or 0)
        resets = int(last.get("resets_at") or 0)
        if resets and resets < time.time():
            pct = 0.0
        print(f"{pct:g} {resets}")
        sys.exit(0)
print("unknown")
PY
}

at_limit() {
  [ "$1" != "unknown" ] && python3 -I -c "import sys; sys.exit(0 if float(sys.argv[1]) >= float(sys.argv[2]) else 1)" "$1" "$LIMIT"
}

before=$(week_reading)
pct_before="${before%% *}"
if at_limit "$pct_before"; then
  # The newest rollout can be stale (Jm reset the usage by hand; no Codex session ran since). Refresh once with
  # one tiny read-only call, which writes a rollout with the true reading, then read again.
  stale="$pct_before"
  refresh="ok"
  if command -v timeout >/dev/null 2>&1; then
    timeout "${CODEX_REFRESH_TIMEOUT:-120}" "$CODEX" exec --skip-git-repo-check -C "$OUT" -s read-only "Reply with the word OK." < /dev/null > "$OUT/codex-refresh.log" 2>&1 || refresh="failed"
  else
    "$CODEX" exec --skip-git-repo-check -C "$OUT" -s read-only "Reply with the word OK." < /dev/null > "$OUT/codex-refresh.log" 2>&1 || refresh="failed"
  fi
  if [ "$refresh" = "failed" ]; then
    finish "$UNIT codex REFUSED: Codex weekly usage ${stale}% >= ${LIMIT}% (newest reading in $SESS); the refresh call failed (see $OUT/codex-refresh.log)" 4
  fi
  before=$(week_reading)
  pct_before="${before%% *}"
  if at_limit "$pct_before"; then
    finish "$UNIT codex REFUSED: Codex weekly usage ${pct_before}% >= ${LIMIT}% after refresh (stale reading ${stale}%, fresh reading ${pct_before}%, in $SESS)" 4
  fi
fi

TO="${CODEX_UNIT_TIMEOUT:-14400}"
RUNLOCK="$(cd "$(dirname "$0")" && pwd -P)/runlock.sh"
PROMPT="You are the builder of unit $UNIT. Read AGENTS.md in this folder first, then your unit contract: $CONTRACT. Build exactly that unit in this worktree ($WT), and run the checks that the contract names. Do not run git add or git commit: the sandbox keeps .git read-only. Leave your changes in the worktree and put one line \"Commit message: <one line>\" in RESULT.md; this runner commits the tree on its branch after you end. Write RESULT.md and your logs to $OUT/ as the contract says (the orchestrator reads that file, not your last message). Never touch the board (SCOREBOARD.json), EXAMINER-BRIEF.md or the exam folder. Your run is cut at $((TO / 60)) minutes. If your change alters what Jm sees (a screen, the report, a video), look at it after each slice: make the before and after images, open each one with your image viewer (view_image), and write one line per image in RESULT.md: what Jm sees and whether it is right; an image that you did not open does not count. Build in thin slices and leave each one working in the worktree, so that a stop leaves a part that the next unit can continue. Report the result \"too large\" only near that cut or when your context is full, never before you built the first slice; write the slices done, their evidence and the slices left. A command that this sandbox refuses is not a reason to stop: take the nearest way that keeps the contract's purpose and write it in RESULT.md. Sandbox facts: ps, pgrep and signals to processes that you did not start fail here. Run each heavy step (pose, video decode, model, a long test suite) as bash $RUNLOCK <the lock that the contract names> $UNIT <command>; never make or remove a lock by hand."

ARGS=(exec -C "$WT" -s workspace-write --add-dir "$OUT" ${EXTRA[@]+"${EXTRA[@]}"} --json -o "$OUT/codex-last.txt")
[ -n "${CODEX_MODEL:-}" ] && ARGS+=(-m "$CODEX_MODEL")
[ -n "${CODEX_EFFORT:-}" ] && ARGS+=(-c "model_reasoning_effort=\"$CODEX_EFFORT\"")

start=$(date +%s)
if command -v timeout >/dev/null 2>&1; then
  timeout "$TO" "$CODEX" "${ARGS[@]}" "$PROMPT" < /dev/null > "$OUT/codex-events.jsonl" 2> "$OUT/codex-stderr.log"
else
  "$CODEX" "${ARGS[@]}" "$PROMPT" < /dev/null > "$OUT/codex-events.jsonl" 2> "$OUT/codex-stderr.log"
fi
rc=$?
mins=$(( ($(date +%s) - start) / 60 ))

thread=$(python3 -I -c "
import json, sys
for line in open(sys.argv[1], errors='replace'):
    try: d = json.loads(line)
    except ValueError: continue
    if d.get('type') == 'thread.started': print(d.get('thread_id', '')); break
" "$OUT/codex-events.jsonl" 2>/dev/null)
after=$(week_reading)
result="missing"
[ -f "$OUT/RESULT.md" ] && result="$OUT/RESULT.md"

# Commit what Codex left in the tree (the sandbox keeps .git read-only), whatever its exit: nothing is lost
# when the worktree is removed, and the orchestrator decides on the branch.
commit="none"
if [ -n "$(git -C "$WT" status --porcelain 2>/dev/null)" ]; then
  msg=""
  [ -f "$OUT/RESULT.md" ] && msg=$(grep -m1 -i '^ *Commit message:' "$OUT/RESULT.md" | sed -E 's/^ *[Cc]ommit message: *//; s/^[`"]+//; s/[`"]+$//')
  [ -n "$msg" ] || msg="$UNIT: Codex unit (see RESULT.md)"
  if git -C "$WT" add -A >/dev/null 2>&1 \
     && git -C "$WT" commit -q -m "$msg" -m "Built by Codex through codex-unit.sh (unit $UNIT, thread ${thread:-none}, exit $rc)." >/dev/null 2>&1; then
    commit=$(git -C "$WT" rev-parse --short HEAD)
  else
    commit="FAILED"
  fi
fi
finish "$UNIT codex exit=$rc minutes=$mins result=$result commit=$commit thread=${thread:-none} codex-week=${after%% *}% (before ${pct_before}%)" "$rc"
