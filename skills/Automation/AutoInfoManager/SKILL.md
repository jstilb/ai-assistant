---
name: AutoInfoManager
description: Daily information upkeep via one agent checklist plus a deterministic freshness sentinel. USE WHEN daily upkeep, autoinfo, scratchpad processing, inbox triage schedule, context digests, vault map refresh, freshness sentinel, OR context staleness alerts.
---

# AutoInfoManager

One cron → one agent → one checklist. The agent reads the state of each area,
does what it needs, skips what's already done, and reports honestly. A separate
deterministic sentinel verifies the artifacts — the agent cannot game its own
verification.

Replaced the tiered runner machinery (AutoInfoRunner/StepDispatcher/tiers.json,
~10,240 LOC) on 2026-07-04. History: `MEMORY/daemon/cron/jobs.retired/README.md`;
plan: `plans/staged-squishing-wand.md`.

## The two jobs

| Job | Schedule | Mode | What it does |
|-----|----------|------|--------------|
| `daily-upkeep` | 04:30 daily | agent (`claude -p`) | Executes `Workflows/Daily-Maintenance.md`: scratchpad organize → inbox triage → context digests → vault map → context routing table → dated report |
| `context-freshness-sentinel` | 07:00 daily | direct (`bun`) | Runs `Tools/FreshnessGuard.ts`: checks mtimes of VaultContext.md + the 4 context digests + CONTEXT-ROUTING.md against a 7d threshold; on stale → AlertGate page (key `freshness-guard`) + exit 1 |

Manifests: `MEMORY/daemon/cron/manifests/{daily-upkeep,context-freshness-sentinel}.yaml`
(installed in launchd as `com.kaya.cron.<id>` via `bin/migrate-crons-to-launchd.ts`).

## Files

- `Workflows/Daily-Maintenance.md` — the checklist the agent executes (6 steps; step 6's dated report is the proof-of-life artifact)
- `Tools/FreshnessGuard.ts` — standalone sentinel CLI (`--dry-run`, `--threshold-days N`, env `FRESHNESS_THRESHOLD_DAYS`); alerts route through `lib/core/AlertGate.ts`
- Reports: `MEMORY/AUTOINFO/daily/{YYYY-MM-DD}.md` (also the reconciler's `desiredArtifact`)
- Run ledgers: `MEMORY/daemon/cron/logs/{daily-upkeep,context-freshness-sentinel}.jsonl`

## Failure model (all pre-existing infrastructure, nothing bespoke)

- **Crash/timeout** → `success:false` ledger row → hourly `bin/cron-health-monitor.ts` → AlertGate → Telegram page.
- **Missed slot** (machine asleep) → `bin/job-reconciler.ts` re-runs via missing/stale `MEMORY/AUTOINFO/daily/{date}.md` (`catchUp: true`, `maxAgeHrs: 30`).
- **Stale context** → sentinel's own AlertGate page + non-zero exit (which also feeds the health monitor).
- **Empty day** → agent judgment: notes it in the report and moves on. No skip files, no streak counters, no hash stamps.

## Manual runs

```bash
# Real code path, bypasses schedule/idempotency guards:
bun ~/.claude/bin/run-cron-job.ts daily-upkeep --catchup
bun ~/.claude/bin/run-cron-job.ts context-freshness-sentinel --catchup

# Sentinel drill without paging (AlertGate honors KAYA_ALERT_DRY_RUN=1):
FRESHNESS_THRESHOLD_DAYS=0 KAYA_ALERT_DRY_RUN=1 bun ~/.claude/skills/Automation/AutoInfoManager/Tools/FreshnessGuard.ts
```

## Scoping rule (hard)

`MEMORY/AUTOINFO/` holds live data unrelated to this skill (`digests/` feeds
KayaTaskClassifier; `daily/` is this skill's own report history; `_archive/` is
frozen old-tier history — see its README, incl. the archived `daily-runs/` that
`label-clarity-golden.ts` reads as a fixture source). Never directory-wipe it.

---

**Last Updated:** 2026-07-05
