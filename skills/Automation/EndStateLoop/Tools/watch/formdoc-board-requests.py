#!/usr/bin/env python3
"""Run the board writes that the Gemini orch asks for, outside the agy sandbox.

endstate-setup-18, 2026-11-24: `bun Board.ts` fails inside the agy sandbox ("CouldntReadCurrentDirectory", steps 0148
and 0153), so the orch wrote SCOREBOARD.json by hand and Board.ts then refused every write. Like PUSH-REQUESTS, the orch
now writes one JSON line per board command to BOARD-REQUESTS; loop.sh runs this script after the step.

Line format: {"cmd": "unit-open" | "unit-close" | "mark", "args": ["--row", "E2", ...]}
`args` = the Board.ts arguments after the board path (this script adds the path). No shell: argv only.
Refused: another cmd, a non-string arg, a first arg that is not an option, `--role examiner`, `--status proven`.
Each result goes to BOARD-RESULTS.md (read by the next step) and one line to stdout (LOOP.log).
Usage: board-requests.py <requests.jsonl> <BOARD-RESULTS.md> <step>   (env FORMDOC_BOARD overrides the board, for tests)
"""
import json
import os
import subprocess
import sys
import time

BUN = "/opt/homebrew/bin/bun"
BOARD_TS = "~/.claude/skills/Automation/EndStateLoop/Tools/Board.ts"
FORMDOC = "/Users/[user]/projects/form-doc"
BOARD = os.environ.get("FORMDOC_BOARD", FORMDOC + "/data/endstate/SCOREBOARD.json")
# endstate-setup-19 11-24: the claim audit runs right after a unit-close line, before any later line (a unit-open of the
# next unit must meet the gate AFTER the audit has revoked a false move; U79 opened before U78's revoke).
CLAIM_AUDIT = "~/.claude/skills/Automation/EndStateLoop/Tools/ClaimAudit.ts"
AUDIT_ON = os.environ.get("FORMDOC_CLAIM_AUDIT", "1") == "1"
CMDS = {"unit-open", "unit-close", "mark"}
SECRET_ENV = ("CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_MESSAGING_TOKEN", "ANTHROPIC_API_KEY")


def stamp() -> str:
    return time.strftime("%Y-%m-%d %H:%M:%S %Z")


def check(req: object) -> tuple[str, list[str]] | str:
    if not isinstance(req, dict):
        return "not a JSON object"
    cmd, args = req.get("cmd"), req.get("args")
    if cmd not in CMDS:
        return f"cmd must be one of {sorted(CMDS)}"
    if not isinstance(args, list) or not args or not all(isinstance(a, str) and "\x00" not in a and len(a) < 4000 for a in args):
        return "args must be a non-empty list of strings"
    if not args[0].startswith("--"):
        return "the first arg must be an option (the driver adds the board path)"
    for i, a in enumerate(args[:-1]):
        nxt = args[i + 1].strip().lower()
        if a == "--role" and nxt == "examiner":
            return "--role examiner is refused (only an examiner session marks as examiner)"
        if a == "--status" and nxt == "proven":
            return "--status proven is refused (only an examiner proves a row)"
    return cmd, args


def main() -> int:
    req_path, out_path, step = sys.argv[1], sys.argv[2], sys.argv[3]
    env = {k: v for k, v in os.environ.items() if k not in SECRET_ENV}
    lines = [ln for ln in open(req_path, encoding="utf-8").read().splitlines() if ln.strip()]
    report = [f"\n## step {step}, {stamp()}: {len(lines)} board request(s)"]
    bad = 0
    for n, ln in enumerate(lines, 1):
        try:
            got = check(json.loads(ln))
        except json.JSONDecodeError as e:
            got = f"not JSON ({e.msg})"
        if isinstance(got, str):
            bad += 1
            report.append(f"- {n}. REFUSED by the driver: {got}. Line: {ln[:300]}")
            continue
        cmd, args = got
        try:
            p = subprocess.run([BUN, BOARD_TS, cmd, BOARD, *args], cwd=FORMDOC, env=env, capture_output=True, text=True, timeout=120)
            rc, out = p.returncode, (p.stdout + p.stderr).strip().splitlines()
        except subprocess.TimeoutExpired:
            rc, out = 124, ["timeout after 120 s"]
        if rc != 0:
            bad += 1
        report.append(f"- {n}. `{cmd} {' '.join(args[:4])}` -> exit {rc}" + ("" if rc == 0 else " (NOT written: fix and ask again)"))
        report.extend(f"    {o[:300]}" for o in out[-8:])
        if AUDIT_ON and rc == 0 and cmd == "unit-close" and "--unit" in args[:-1]:
            unit = args[args.index("--unit") + 1]
            with open(out_path, "a", encoding="utf-8") as f:  # flush first: the audit appends its own block after these lines
                f.write("\n".join(report) + "\n")
            report = []
            try:
                a = subprocess.run([BUN, CLAIM_AUDIT, "run", BOARD, "--unit", unit, "--by", "formdoc-claim-audit", "--results", out_path],
                                   cwd=FORMDOC, env=env, capture_output=True, text=True, timeout=1800)
                print(f"{stamp()} claim audit {unit} (after unit-close, step {step}): exit {a.returncode}: {(a.stdout + a.stderr).strip()[-400:]}")
            except subprocess.TimeoutExpired:
                print(f"{stamp()} claim audit {unit} (after unit-close, step {step}): timeout after 1800 s; loop.sh retries it later")
    with open(out_path, "a", encoding="utf-8") as f:
        f.write("\n".join(report) + "\n")
    print(f"{stamp()} board requests step {step}: {len(lines)} line(s), {bad} not written; see BOARD-RESULTS.md")
    return 0 if bad == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
