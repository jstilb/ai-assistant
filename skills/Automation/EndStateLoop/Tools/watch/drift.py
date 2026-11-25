# Drift flags for the end-state loops (endstate-setup-5, 2026-11-10; Jm F-016/F-014:
# "meaningful progress towards actual end states, focus on important work first, and not spinning in
# circles or optimizing for proxy metrics").
# Usage: python3 -I drift.py <hours back> <agents.json> <board.json> [<board.json> ...]
#   agents.json = output of `claude agents --json` (live session names).
# Prints per board: SHIP (units closed with a live change, rows moved up by an examiner), TOP (the 6
# best-ranked rows that are not proven, with the work in flight), and the flags CHURN, ZOMBIE.
import json, os, re, sys
from datetime import datetime, timezone, timedelta

hours = float(sys.argv[1])
agents_raw = json.load(open(sys.argv[2]))
agents = agents_raw if isinstance(agents_raw, list) else agents_raw.get("agents", agents_raw.get("sessions", []))
live = {a.get("name") for a in agents if a.get("name")}
# BLOCKED (endstate-setup-10, 2026-11-18): a session that waits on a permission prompt shows "working" in its
# state.json; only `claude agents --json` says state "blocked", waitingFor "permission prompt". Only Jm answers it.
_me = os.path.basename(os.environ.get("CLAUDE_JOB_DIR", "").rstrip("/"))  # setup-11: skip the caller's own session
for a in agents:
    if str(a.get("id")) == _me:
        continue
    if a.get("state") == "blocked" or a.get("waitingFor"):
        print("FLAG BLOCKED: %s (%s) waits on %s: only Jm answers (claude attach %s)" % (
            a.get("name"), a.get("id"), a.get("waitingFor") or a.get("state"), a.get("id")))
now = datetime.now(timezone.utc)
cut = now - timedelta(hours=hours)
ORDER = {"untested": 0, "failed": 0, "claimed": 2, "proven": 3}  # release 11: untested = failed < claimed < proven
TEST_NOTE = re.compile(r"^(Test unit|check |instrument)", re.I)

def t(s):
    return datetime.fromisoformat(s) if s else None

for path in sys.argv[3:]:
    b = json.load(open(path))
    reqdir = os.path.join(os.path.dirname(path), "requests")
    reqs = []
    if os.path.isdir(reqdir):
        for f in os.listdir(reqdir):
            if f.endswith(".md") and "REPORT" not in f:
                p = os.path.join(reqdir, f)
                reqs.append((datetime.fromtimestamp(os.path.getmtime(p), timezone.utc), f, open(p, errors="replace").read()))
    units = b["units"]
    # Allowed waits that setup recorded (Orchestrate step 2, Waits), keyed by
    # row or unit id: {"<project>": {"R28": ["Workers AI cap", "2026-11-11T06:23:00-08:00"]}}. A wait whose
    # time has passed no longer counts, so the flag comes back.
    wf = os.path.join(os.path.dirname(os.path.abspath(__file__)), "waits.json")
    allw = json.load(open(wf)).get(b["project"], {}) if os.path.exists(wf) else {}
    waits = {k: "%s until %s" % (v[0], v[1][5:16]) for k, v in allw.items() if t(v[1]) > now}
    print("== %s (last %.1f h)" % (b["project"], hours))
    shipped = [u for u in units if u["endedAt"] and t(u["endedAt"]) >= cut and u.get("shipped") not in (None, "none")]
    ups = []
    for r in b["rows"]:
        ms = sorted(r["marks"], key=lambda m: m["at"])
        before = [m for m in ms if t(m["at"]) < cut]
        inside = [m for m in ms if t(m["at"]) >= cut and m["role"] == "examiner"]
        if inside:
            s0 = before[-1]["status"] if before else "untested"
            if ORDER[inside[-1]["status"]] > ORDER[s0]:
                ups.append("%s %s->%s" % (r["id"], s0, inside[-1]["status"]))
    print("  SHIP: %d units with a live change %s; rows up by exam: %s" % (
        len(shipped), [u["id"] + "/" + u["row"] for u in shipped], ups or "none"))
    # STALL clock (endstate-setup-8, 2026-11-18; Jm F-025/F-010 "these should not be stalling"):
    # wall hours since the last closed unit that shipped a live change (paused hours count too: read the
    # pause file before acting). Rows that no examiner ever marked are information only.
    never = [r["id"] for r in b["rows"] if not any(m.get("role") == "examiner" for m in r["marks"])]
    live_units = [u for u in units if u["result"] != "open" and u["endedAt"] and u.get("shipped") not in (None, "none")]
    last_ship = max(live_units, key=lambda u: t(u["endedAt"]), default=None)
    h_ship = (now - t(last_ship["endedAt"])).total_seconds() / 3600 if last_ship else None
    flag = "FLAG STALL" if h_ship is None or h_ship > 8 else "STALL ok"
    print("  %s: %s h since the last shipped live change (%s); info: never marked by an examiner: %d %s" % (
        flag, "none" if h_ship is None else round(h_ship, 1), last_ship["id"] + "/" + last_ship["row"] if last_ship else "-", len(never), never))
    # EXAM DEBT (endstate-setup-18, 2026-11-24; Jm F-029 form-doc / F-013 "spinning their wheels"): the STALL clock above
    # counts shipped units, which a busy loop always has. This line measures the end state instead: product rows that an
    # examiner proved, claims that no exam has checked, and units closed since the last examiner mark. A loop that ships
    # but is not examined flags here; the watch then requests an exam and steers to the core row.
    product = [r for r in b["rows"] if not r.get("sentence", "").startswith("Guard")]
    exam_proven = [r["id"] for r in product if r["status"] == "proven" and any(m.get("role") == "examiner" and m["status"] == "proven" for m in r["marks"])]
    ex_marks = [m for r in b["rows"] for m in r["marks"] if m.get("role") == "examiner"]
    last_ex = max((t(m["at"]) for m in ex_marks), default=None)
    h_ex = (now - last_ex).total_seconds() / 3600 if last_ex else None
    since_ex = [u for u in units if u["result"] != "open" and u["endedAt"] and (last_ex is None or t(u["endedAt"]) > last_ex)]
    unchecked = []
    for r in product:
        ms = sorted(r["marks"], key=lambda m: m["at"])
        if r["status"] == "claimed" and ms and ms[-1].get("role") != "examiner":
            unchecked.append(r["id"])
    # Debt when: no exam for a day or 10+ units; or 3+ unchecked claims after 12 h or 6 units; or 0 product rows ever
    # proven by an exam while 3+ claims wait (the core is unproven however busy the loop is).
    debt = (h_ex is None or h_ex > 24 or len(since_ex) >= 10) \
        or (len(unchecked) >= 3 and (h_ex > 12 or len(since_ex) >= 6)) \
        or (len(exam_proven) == 0 and len(unchecked) >= 3)
    print("  %s: product rows proven by exam %d of %d %s; %s h since the last examiner mark; %d units closed since; claims no exam checked: %d %s" % (
        "FLAG EXAM-DEBT" if debt else "EXAM ok", len(exam_proven), len(product), exam_proven,
        "never" if h_ex is None else round(h_ex, 1), len(since_ex), len(unchecked), unchecked))
    openu = {}
    for u in units:
        if u["result"] == "open":
            openu.setdefault(u["row"], []).append(u)
    def inflight(r):
        w = [u["id"] for u in openu.get(r["id"], [])]
        last = max((t(m["at"]) for m in r["marks"]), default=None)
        for mt, f, txt in reqs:
            name = f[:-3]
            if name in live and re.search(r"\b%s\b" % r["id"], txt):
                w.append(name)
        return w
    red = sorted([r for r in b["rows"] if r["status"] != "proven" and r.get("rank") is not None], key=lambda r: r["rank"])
    top = red[:6]
    print("  TOP: " + "; ".join("%s(r%s %s): %s" % (r["id"], r["rank"], r["status"][:4], ",".join(inflight(r)) or ("wait" if r["id"] in waits else "NOTHING")) for r in top))
    # CHURN: a row that is not proven with 3+ closed units and no move, or 3+ test units
    for rid in sorted({u["row"] for u in units}):
        r = next((r for r in b["rows"] if r["id"] == rid), None)
        if not r or r["status"] == "proven":
            continue
        ru = [u for u in units if u["row"] == rid]
        closed_nomove = [u for u in ru if u["result"] != "open" and not u["moved"]]
        tests = [u for u in ru if u.get("kind") == "test" or TEST_NOTE.match(u.get("note") or "")]
        active = any(t(u["startedAt"]) >= cut or (u["endedAt"] and t(u["endedAt"]) >= cut) or u["result"] == "open" for u in ru)
        if active and (len(closed_nomove) >= 3 or len(tests) >= 3):
            print("  FLAG CHURN: %s (%s) %d units, %d closed with no move, %d test units" % (rid, r["status"], len(ru), len(closed_nomove), len(tests)))
    # ZOMBIE: an open unit older than 2 h whose builder session is not live
    for u in units:
        if u["result"] == "open":
            age = (now - t(u["startedAt"])).total_seconds() / 3600
            r = next((r for r in b["rows"] if r["id"] == u["row"]), None)
            live_exam = [x for x in (inflight(r) if r else []) if x in live]
            if u["id"] in waits:
                print("  WAIT: %s on %s (%s)" % (u["id"], u["row"], waits[u["id"]]))
            elif age > 2 and u["builder"] not in live and not live_exam:
                print("  FLAG ZOMBIE: %s on %s open %.1f h, builder %s not live" % (u["id"], u["row"], age, u["builder"]))
