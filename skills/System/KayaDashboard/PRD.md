# PRD — Kaya Dashboard (a window into Kaya's brain and work)

**Task:** t-muwv8ld1-k3e0y8 · **Built:** 2026-10-17 · **Status:** v1 shipped on branch `executor/task-t-muwv8ld1-k3e0y8`

## Problem

Kaya's state is spread across ~86 LaunchAgents, 84 cron manifests, a 9 MB run ledger, 47k session
transcripts, 67 skills, 17 hooks, TELOS files, the auto-memory, two SQLite DBs, a Telegram outbound
log and a 126k-node knowledge graph. Answering "what is Kaya doing, what broke, what does it know,
and can I switch that job off" today means shell spelunking (`launchctl list | grep`, `tail -f`,
`sqlite3`, hand-editing yaml). The existing dashboards are each about a single domain:

| Surface | Port | Scope |
|---|---|---|
| LucidTasks board | 7777 | tasks |
| LifeOS dashboard | 31337 | habits / WIGs |
| AppUsage dashboard | 7745 | screen time |
| EventScout / RecipeIndex UIs | 4180 / 4181 | events / recipes |
| Observability | 5173 | agent traces |

Nothing covers Kaya *itself*. ("FleetView" is the upstream `claude agents` name — it has no
counterpart in this repo; the ontology review confirmed zero code hits.)

## Goal

Build one local page where Jm can **see** Kaya's activity, knowledge and machinery, and **act** on
the parts that are safe to act on: toggle or run jobs, and edit key context files.

**Done when:** a running local dashboard shows every section below, and the job toggle/run actions
have been verified live (see §Verification).

## Users & constraints

- Single user (Jm), on localhost. Loopback bind with no auth, matching the LucidTasks board's posture.
- Reads the **live** state at KAYA_HOME (`~/.claude`) and `~/.kaya`, and never a copy.
- No silent containment: a collector that fails shows an error card, not an empty panel.
- Mutations are explicit (confirm dialog), audit-logged, and reversible.

## Inventory → section mapping (sources actually used)

| Section | Source(s) |
|---|---|
| Overview | aggregates below + `~/.kaya/graph/meta.json` |
| Sessions (linked) | `~/.claude/projects/<slug>/<sessionId>.jsonl` (ai-title, first prompt, cwd), `history.jsonl` (interactive flag); per-session readable transcript view + `claude --resume` copy |
| Usage patterns | `history.jsonl` (prompts/sessions per day, hour-of-day, projects), `MEMORY/LEARNING/SIGNALS/ratings.jsonl`, `MEMORY/daemon/cron/run-ledger.jsonl` (cron ok/fail, most-failing jobs) |
| Jobs (toggle / run / logs) | `~/Library/LaunchAgents/com.{kaya,pai}.*.plist`, `launchctl list` + `print-disabled`, `MEMORY/daemon/cron/manifests/<id>.yaml`, run ledger, plist Standard{Out,Error}Path |
| Telegram (recurring) | manifests with `output ≠ silent`, or manifests whose job delivers from its own script (briefing / digest / nudge / notify / Telegram); `MEMORY/TELEGRAM/outbound.jsonl` |
| Skills | `skills/<Cat>/<Sub>/SKILL.md` frontmatter + Workflows/Tools counts |
| Hooks | `settings.json` → `hooks` (event, matcher, file, doc comment, missing-file flag) |
| Key context | CLAUDE.md, CONTEXT-ROUTING.md, CONTEXT-MAP.md, USER/*, TELOS/*, context/CalendarContext.md, docs; `~/.kaya/memory/MEMORY.md` index |
| Projects | `USER/TELOS/PROJECTS.md` table, LucidTasks `projects` (open/done counts, deep-link into :7777), links to every Kaya surface |
| Recent work | LucidTasks `tasks` (recently updated), `MEMORY/daemon/cron/logs/autonomous-executor.jsonl`, `git log main` |
| Systems work | `~/.kaya/runtime/pipeline.db` (`pipeline_items` by stage + active items), `QUEUES/tech-debt.jsonl`, `MONITORING/failure-log.jsonl`, unmerged `executor/*` branches |
| System diagrams | mermaid blocks in `docs/architecture.md` + `skills/Content/SystemFlowchart/Output/**`; graph node-type chart |

## Actions (the only mutations)

| Action | Mechanism | Why this mechanism |
|---|---|---|
| Job **off** | `launchctl disable` + `bootout`, plus manifest `enabled: false` | `disable` persists across reboot and `rebuild-plists.sh` re-loads; `enabled:false` is what `run-cron-job.ts` **and** `job-reconciler.ts` honor, so catch-up can't resurrect it |
| Job **on** | manifest `enabled: true`, then `launchctl enable` + `bootstrap` | enable must precede bootstrap: a disabled service refuses to bootstrap |
| **Run now** (cron job) | detached `bun bin/run-cron-job.ts <id> --catchup` with the plist's env/cwd/log paths | a plain `kickstart` exits `skip.cron-mismatch`, because run-cron-job re-validates the slot |
| **Run now** (other) | `launchctl kickstart`; KeepAlive services get `kickstart -k` (restart) | |
| **Edit file** | atomic tmp+rename; refuses (409) if the file's mtime changed since it was opened | |

Guards:
- Labels must match `^com\.(kaya|pai)\.` and have a plist.
- The dashboard refuses to disable itself.
- Mutating routes require the `x-kaya-dashboard: 1` header (CSRF: a cross-site page can't send it without a preflight that is never granted).
- Every job action is appended to `logs/kaya-dashboard-actions.jsonl`.

Edit allowlist: `.md/.yaml` files under USER/, context/, cron manifests, `skills/**/SKILL.md`, CLAUDE.md, CONTEXT-ROUTING.md, CONTEXT-MAP.md, and `~/.kaya/memory/*`. Everything else viewable is read-only. Secrets, `.env`, KAYASECURITYSYSTEM, `.git` and `node_modules` are not viewable at all.

## Non-goals (v1)

- Toggling hooks. That is a settings.json edit with session-wide blast radius, so it stays in the repo.
- Creating new jobs.
- Remote (Tailscale) access. If it's ever wanted, follow BoardServer's token pattern.
- Manifests that have no plist (for example `fermentation-reminder`, `queue-approval-nudge`) aren't listed. Scheduling one requires `migrate-crons-to-launchd.ts`.

## Verification (2026-10-17, live)

- Toggle `com.kaya.cron.voice-liveness` off → not in `launchctl list`, `print-disabled` shows `disabled`, manifest `enabled: false`. On → loaded, `enabled`, manifest `enabled: true`. The manifest came back byte-identical; `git diff` is empty.
- Run now (cron path) `voice-liveness` → a new run-ledger row with an off-schedule slotKey (02:22:10Z), `outcome: success`.
- Run now (kickstart path) `com.kaya.lifeos.db-backup` → new `~/.kaya-backups/lifeos/lifeos-20261017-192219657.db`, backup.log `level: ok`.
- Restart path `com.kaya.aw-dashboard` → PID 93687 → 70654, `:7745` serving HTTP 200.
- All 14 GET endpoints return 200 against live data. Headless-Chrome screenshots of Overview, Jobs, Usage and Diagrams were checked by eye.
- `bun test skills/System/KayaDashboard`: 21 pass. Covers the parsers, toggle/run against a fake launchd, the edit allowlist, the 409 mtime guard and the header guard.
