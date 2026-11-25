#!/usr/bin/env python3
"""Status-page lag check for the watch (endstate-setup-N). Jm, 2026-11-24: "why is the endstate loop artifact not being
updated?" and "can we ensure the head orchestrator (this agent session and its future handoffs) continue to update this
appropriately?" (cause that day: the watch held form-doc-0060 for a correction post with no time limit, and the edition
orch posted nothing for 2 h).

Two kinds of loop:
- relay: the watch sends each post to the page (a Gemini orch cannot reach claude.ai). Due when a post file on disk is
  newer than the last one the watch sent (`<last-pushed file>`): audit it (Check.md, claim audit) and send it at once,
  with an audit line when a claim fails; never hold it.
- self: the orch sends its own posts. Due when its newest post is older than MAX_AGE_H (the 2-hour rule + 10 min).
Both: due when the loop has no new post for MAX_AGE_H (an alive loop posts every 2 h).

Usage: page-lag.py          -> one line per loop (OK / DUE ...); exit 0
       page-lag.py --wake   -> only DUE lines not reported before for the same post (state file), for wait scripts;
                               prints nothing when nothing is new. Exit 0.
"""
import json
import os
import sys
import time

MAX_AGE_H = 2 + 10 / 60
STATE = os.path.expanduser("~/.kaya/state/endstate-setup/page-lag-reported.txt")
LOOPS = [
    # name, kind, status dir, last-pushed file (relay only)
    # form-doc: a Claude orch (formdoc-orch-24, Jm F-030, 2026-11-24) posts itself. While it ran on Gemini (agy) it was
    # ("form-doc", "relay", ".../form-doc/data/endstate/status", "~/.kaya/state/endstate-setup/formdoc-last-pushed.txt").
    ("form-doc", "self", "/Users/[user]/projects/form-doc/data/endstate/status", None),
    ("edition", "self", "/Users/[user]/projects/intake-backups/endstate/status", None),
    # Learn: PAUSED on Jm's word (learn-orch-23-PAUSED.md); add it back when Jm resumes it:
    # ("learn", "self", "/Users/[user]/Projects/learn/data/endstate/status", None),
]


def newest_post(status_dir: str) -> tuple[str, float] | None:
    out = os.path.join(status_dir, "out")
    try:
        files = sorted(f for f in os.listdir(out) if f.endswith(".json"))
    except OSError:
        return None
    if not files:
        return None
    f = files[-1]
    try:
        at = json.load(open(os.path.join(out, f), encoding="utf-8")).get("at", "")
        t = time.mktime(time.strptime(at[:19], "%Y-%m-%dT%H:%M:%S"))  # local time; posts carry local offsets
    except Exception:
        t = os.path.getmtime(os.path.join(out, f))
    return f[: -len(".json")], t


def check() -> list[tuple[str, str]]:
    """(key, line) per loop; key is "" when OK, else a stable id for the DUE state."""
    res = []
    now = time.time()
    for name, kind, status_dir, pushed in LOOPS:
        np = newest_post(status_dir)
        if np is None:
            res.append(("", f"PAGE {name}: no post on disk"))
            continue
        pid, t = np
        age_h = (now - t) / 3600
        if kind == "relay":
            last = open(pushed).read().strip() if pushed and os.path.exists(pushed) else ""
            if pid > last:
                res.append((f"{name}:unsent:{pid}", f"PAGE DUE {name}: {pid} is on disk, not on the page (last sent {last or 'none'}): claim-audit it and send it now with an audit line if a claim fails; never hold it"))
                continue
        if age_h > MAX_AGE_H:
            who = "steer the loop host/orch" if kind == "relay" else f"nudge the {name} orch"
            res.append((f"{name}:old:{pid}", f"PAGE DUE {name}: newest post {pid} is {age_h:.1f} h old (> 2 h rule): {who} to post with --number"))
            continue
        res.append(("", f"PAGE ok {name}: newest {pid}, {age_h:.1f} h old"))
    return res


def main() -> int:
    rows = check()
    if "--wake" not in sys.argv[1:]:
        for _, line in rows:
            print(line)
        return 0
    seen = set(open(STATE).read().split()) if os.path.exists(STATE) else set()
    new = [(k, line) for k, line in rows if k and k not in seen]
    if new:
        with open(STATE, "w") as f:
            f.write("\n".join(sorted(seen | {k for k, _ in new})) + "\n")
        for _, line in new:
            print(line)
    return 0


if __name__ == "__main__":
    sys.exit(main())
