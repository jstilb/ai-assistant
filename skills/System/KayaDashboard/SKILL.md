---
name: KayaDashboard
description: Local web dashboard into Kaya's brain and work — sessions, usage, launchd/cron jobs (toggle + run), Telegram senders, skills, hooks, key context editor, projects, recent/systems work, diagrams. USE WHEN kaya dashboard, open dashboard, toggle job, turn off cron, run job now, what is kaya doing, system overview.
---

# KayaDashboard

One page at **http://127.0.0.1:7790** with 12 sections. Spec and source inventory: `PRD.md`.

| Section | What you can do |
|---|---|
| Overview | jobs on/off/running, last-run failures, cron success rate, sessions, prompts, graph size |
| Sessions | browse recent transcripts (interactive vs headless), open a readable transcript, copy `claude --resume <id>` |
| Usage | prompts/sessions per day, hour-of-day, cron failures per day, most-failing jobs, session ratings |
| Jobs | **toggle on/off**, **run now** / restart, tail logs, open the cron manifest |
| Telegram | recurring senders (with on/off state) and the recent outbound messages |
| Skills · Hooks | every SKILL.md (click to edit) and every registered hook with its doc line |
| Context | view/edit CLAUDE.md, routing, USER/, TELOS, memory files |
| Projects · Recent work · Systems work | TELOS + LucidTasks projects, executor deliveries, tasks, commits, pipeline.db stages, tech debt, failure log, unmerged executor branches |
| Diagrams | mermaid architecture diagrams and the knowledge-graph shape |

## Commands

```bash
bun run skills/System/KayaDashboard/Tools/DashboardServer.ts        # serve on :7790 (KAYA_DASH_PORT overrides)
launchctl kickstart -k gui/$UID/com.kaya.dashboard                   # restart after editing (bun caches TS)
bun test skills/System/KayaDashboard                                 # unit tests
```

Production: `com.kaya.dashboard` (KeepAlive) is defined in `bin/rebuild-plists.sh`.

## How the actions work

- **Off** = `launchctl disable` + `bootout`, plus manifest `enabled: false`. This survives reboots, plist rebuilds and job-reconciler catch-up.
- **On** = the reverse, in the order enable → bootstrap.
- **Run now** depends on the job type:
  - cron jobs: `bun bin/run-cron-job.ts <id> --catchup`
  - other jobs: `launchctl kickstart`
  - KeepAlive services: `kickstart -k`
- Audit trail: `logs/kaya-dashboard-actions.jsonl`.
- Mutating HTTP routes require the header `x-kaya-dashboard: 1`.

## Files

- `Tools/DashboardServer.ts` — HTTP routes (Bun.serve, loopback only)
- `Tools/Jobs.ts` — job inventory + toggle/run/logs (the only module that mutates launchd)
- `Tools/Collectors.ts` — read-only collectors for every other section, plus the file view/edit allowlist
- `Tools/client.html` — the single-page UI (vanilla JS; mermaid is loaded from the jsdelivr CDN)
