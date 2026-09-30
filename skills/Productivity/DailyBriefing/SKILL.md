---
name: DailyBriefing
description: Personalized morning briefing — agent-composed, delivered via Telegram, voice, and written log. USE WHEN morning briefing, daily briefing, start my day, what's on my schedule, daily summary.
---

# DailyBriefing

Markdown-first (ADR-022): the briefing is an **agent executing
`Workflows/GenerateBriefing.md`** with real tools — not a TypeScript pipeline spawning a
context-starved one-shot LLM. Deterministic code survives only where determinism earns its
place: ground-truth gathering (honest counts, honest failures), idempotent delivery, and an
independent fallback sentinel the agent cannot game.

## Architecture

```
06:00 launchd → run-cron-job daily-briefing (agent-mode)
  └─ claude -p "Read Workflows/GenerateBriefing.md and execute it completely"
       1. bun Tools/DataGatherer.ts          ← starter-pack ground truth (JSON, true counts)
       2. drill deeper with judgment          ← kaya-cli tasks/gmail/gcal, WaitingOnJm --json,
                                                TechDebt CLI, LifeOSQuery, GraphQuerier,
                                                WebSearch, yesterday's briefing
       3. compose telegram/voice/markdown (instructions live in the workflow md)
       4. bun Tools/Deliver.ts --payload <json> ← sentinels, written+HTML, Drive, Telegram,
                                                  TTS voice, LOUD truncation
07:45 launchd → briefing-sentinel (deterministic, independent)
  └─ Tools/BriefingFallback.ts: .sent-{date} missing? → gather → minimal fallback →
     Deliver.ts → AlertGate page → exit non-zero. Shared sentinels = no double-delivery.
```

## Workflow Routing

| Trigger | Action |
|---------|--------|
| "morning briefing", "daily briefing" | Execute `Workflows/GenerateBriefing.md` |
| briefing didn't arrive / late | Check `MEMORY/daemon/cron/logs/daily-briefing.jsonl`, then `MEMORY/BRIEFINGS/.sent-{date}` |

## Tools (the deterministic keep-list)

| Tool | Purpose |
|------|---------|
| `Tools/DataGatherer.ts` | Parallel ground-truth gather → `BriefingData` JSON. Every capped array is paired with its true count; hard gather failures land in `meta.gatherFailures` (never silently empty). Standalone: `bun Tools/DataGatherer.ts` |
| `Tools/Deliver.ts` | Idempotent delivery: `--payload {date, markdown, telegram?, voice?}` (field presence = channel enable), `.sent-{date}(-channel)` sentinels, written md+HTML, Drive upload, Telegram (4096 truncation is LOUD), TTS voice. `--dry-run` prints and touches nothing |
| `Tools/BriefingFallback.ts` | The 07:45 safety net (F-025): missing briefing → deterministic minimal fallback + page + exit non-zero. `--dry-run` supported |
| `Tools/CalendarBlock.ts` | gcalcli agenda → events; failure = `success:false` (never "calendar clear") |
| `Tools/GoalsBlock.ts` | TELOS WIGs/missions + live G-metric overrides; failures carried in data (`parseError`, `unavailableLiveMetrics`) |
| `Tools/WeatherService.ts` | wttr.in + NWS: current, 3-day, hourly, astronomy, alerts. `fetchWeatherReport()` imported directly by `DataGatherer.ts`'s `gatherWeather` |
| `Tools/AutonomousDeliverableBlock.ts` | Lane-A deliverables awaiting Jm |
| `Tools/ClaudeCodeUpdatesBlock.ts` | Claude Code changelog, deduped + significance-tiered (`--dry-run` to test) |
| `Tools/DeliveryUtils.ts` | Shared Telegram/voice send mechanics (in-process, non-exiting secrets loader) |
| `Tools/ActivationLogger.ts` | Used by the six `activation-s*` cron jobs (not the briefing itself) |

## Composition rules

All composition/editorial instruction lives in `Workflows/GenerateBriefing.md` — the workflow
is the source of truth (role, three sections, framing, data-quality/staleness handling,
channel formats and limits, prompt-injection rule, verify-and-report contract). There is no
config yaml: channel enablement is payload field-presence in `Deliver.ts`.

## Cron

- `daily-briefing` — 06:00, agent-mode (`task:` + `agentTools`/`agentModel` in
  `MEMORY/daemon/cron/manifests/daily-briefing.yaml`), catchUp + desiredArtifact.
- `briefing-sentinel` — 07:45, execute-mode, independent deterministic verifier.

## Evals

`skills/Intelligence/Evals/Suites/dailybriefing-markdown-first.yaml` — the deleted
deterministic rules' fears live on as fixtures: calendar-outage honesty, no fabricated
numbers, telegram-limit awareness, capped-count drill-down judgment. Run via EvalExecutor.
