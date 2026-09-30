---
name: AppUsageTracker
description: Cross-device media-consumption tracker. Aggregates ActivityWatch events from Mac + Android phone + Android tablet over Tailscale into a local DuckDB events store. Computes daily Tier-1 (always low-value) minutes and 4-week rolling averages for G37. V1.5 adds an LLM-classifier for Tier-2 (mixed-value) sessions and a local HTML dashboard.
---

# AppUsageTracker

## INVOCATION — what to do when Jm calls this skill

**Default (no args, e.g. `/appusagetracker` or `/media`):** run

```bash
bun ~/.claude/skills/Productivity/AppUsageTracker/Tools/Freshness.ts
```

Then report the output verbatim in the RESULTS section. Read-only, fast (~200 ms).

**Args containing `sync`, `now`, `force`, `refresh`:** run

```bash
bash ~/.claude/skills/Productivity/AppUsageTracker/bin/sync-now.sh
```

This force-polls every device and recomputes today's metric. Use this when Jm wants the freshest possible number (e.g. just plugged the phone in or just used Reddit).

**Args containing `recompute`, `rebuild`, or after Jm edits `Config.ts`:** run

```bash
bun ~/.claude/skills/Productivity/AppUsageTracker/Tools/MetricCalc.ts --force
```

Rebuilds every day's metric from the events table. Useful after tier-list edits.

**Args containing `classify`:** run the LLM classifier on demand against unclassified Tier-2 sessions, then recompute metrics so the new tier2_lowvalue_minutes show up:

```bash
cd /tmp && bun ~/.claude/skills/Productivity/AppUsageTracker/Tools/Classifier.ts --json && \
  bun ~/.claude/skills/Productivity/AppUsageTracker/Tools/MetricCalc.ts --force
```

`cd /tmp` is required — the inference helper spawns `claude -p`, which exits silently if cwd is inside `~/.claude` (CLAUDE.md present triggers nesting detection). The nightly `com.kaya.appusage-nightly` LaunchAgent (single pipeline, `bin/nightly-pipeline.sh`, step 8 of 9) already does this with WorkingDirectory=/tmp; this manual form mirrors it. Use `--dry-run` to preview without LLM cost, or `--limit=N` to cap session count for one run.

**Args containing `apps`, `top`, `breakdown`:** run a top-apps query against DuckDB and show last 7 days. Pattern:

```bash
bun -e "import { Db } from '~/.claude/skills/Productivity/AppUsageTracker/Tools/Db.ts';
const db = await Db.open();
const rows = await db.queryAll(\`SELECT device, app, ROUND(SUM(duration_sec)/60,1)::DOUBLE AS min, COUNT(*)::INT AS n FROM events WHERE ts_start >= today() - INTERVAL 7 DAY GROUP BY device, app ORDER BY min DESC LIMIT 15\`);
for (const r of rows) console.log(\`  \${String(r.device).padEnd(7)} \${String(r.app ?? '(null)').padEnd(35)} \${String(r.min).padStart(7)} min (\${r.n} events)\`);
db.close();"
```

**Args containing `calibrate`, `calibration`:** run the media-value calibration flow — see the "Media-value calibration loop" section below. Short form: generate the next stratified review sheet (only if the previous one is `status: reviewed` or this is round 1):

```bash
bun ~/.claude/skills/Productivity/AppUsageTracker/Tools/CalibrationSampler.ts
```

USE WHEN (natural language triggers):
- Jm asks for the current G37 number ("how much low-value media today/this week", "what's my rolling avg", "how am I doing on media")
- Jm asks for a fresh sync ("update my media stats", "sync now")
- Jm asks which device he's been using ("am I substituting from phone to tablet?") — query DuckDB grouped by device
- Jm asks to add/remove an app from a tier — edit `Config.ts` and re-run `MetricCalc --force`
- A new app starts showing up in top-apps but isn't classified — edit `Config.ts`

DO NOT USE for:
- Writing media data into LifeOS substrates (attention_log / habit_log / loop_registry). This skill is stand-alone by design — substrate integration is a separate, later project.
- Real-time enforcement (blocking apps, sending notifications). This is a measurement tool only.

> **Data provenance:** Before drawing inferences about Jm's usage habits or device behavior from this data, read `PROVENANCE.md`. Coverage is structurally gapped — phone/tablet data is USB-gated and Chrome/YouTube history requires manual Takeout imports.

## Architecture (one paragraph)

ActivityWatch on each device exposes a local REST API on `:5600`. Tailscale provides a private mesh so the Mac can reach the phone and tablet without port-forwarding. A LaunchAgent runs `Tools/AWPoller.ts` every 5 min, polling each device incrementally and inserting events into `~/.claude/MEMORY/AppUsage/events.db` (DuckDB). A second LaunchAgent runs `Tools/MetricCalc.ts` nightly at 02:15, computing Tier-1 minutes per day and the 4-week rolling average into `daily_metrics`. Both jobs are idempotent (INSERT OR REPLACE), so re-running never double-counts. `Tools/Freshness.ts` is the user-facing freshness + metric reporter; `bin/sync-now.sh` is the on-demand "catch up now" entry point.

## Files

| Path | Purpose |
|---|---|
| `Config.ts` | DB path, device list (Tailscale IPs), Tier 1/2/3 app + URL allowlists |
| `db/schema.sql` | `events`, `sync_state`, `classifications`, `daily_metrics` tables |
| `Tools/DBInit.ts` | Idempotent schema init (run on every poll) |
| `Tools/AWPoller.ts` | Cron: pull AW REST per device → DuckDB |
| `Tools/MetricCalc.ts` | Nightly: compute Tier-1 minutes + rolling avg |
| `Tools/Freshness.ts` | User-facing: last-sync per device + today's metric |
| `Tools/Classifier.ts` | LLM-classifier (Sonnet) for Tier-2 sessions; idempotent; bounded by `--limit`; nightly as step 8/9 of `bin/nightly-pipeline.sh` via the single `com.kaya.appusage-nightly` LaunchAgent (02:00) |
| `Tools/Dashboard.ts` | Bun.serve HTML dashboard on `127.0.0.1:7745` (loopback). 4 stat cards + 60d trend + per-device stacked bar + top-10 apps + sync status. Auto-refresh 60s. KeepAlive via `com.kaya.aw-dashboard` |
| `Tools/Explore.ts` | **Wired, manual/on-demand.** Read-only CLI explorer for `events.db` — inspect raw rows and reproduce any day's metric by hand (`tables`, `schema`, `metrics`, `day`, `rolling`, `devices`, `coverage`, `sql`). Opens DB `READ_ONLY`; not part of the pipeline, not scheduled — a debug tool Jm/Kaya run directly |
| `Tools/SqlUI.ts` | **Wired, manual/on-demand.** Tiny local web SQL workbench for `events.db` (or any DuckDB file) on `127.0.0.1:4555`. Opens DB `READ_ONLY` per request so it never holds the write lock. Not scheduled — start it manually when you want to poke at the data in a browser |
| `Tools/OAuthBootstrap.ts` | **BUILT BUT UNWIRED.** One-time interactive OAuth consent flow for Google's Data Portability API scopes; persists a refresh token into `secrets.json`. Not called by `nightly-pipeline.sh` or any LaunchAgent — only runs if invoked directly, and only as prep for `YouTubeDataPortability.ts` below. Needs Jm's one-time consent; not currently in use |
| `Tools/YouTubeDataPortability.ts` | **BUILT BUT UNWIRED.** Designed to replace the manual takeout.google.com export flow by pulling YouTube (+ Chrome) history via Google's Data Portability API straight into `youtube-takeout-inbox/`. Not called by `nightly-pipeline.sh` or `SKILL.md`'s invocation flows; the manual Takeout drop (`YouTubeIngest.ts`) remains the live path. Turning this on is a Jm-gated decision (see PROVENANCE.md and the standing media-metric-undercount rule) |
| `Tools/CalibrationSampler.ts` | Weekly media-value calibration sampler — stratified review sheets into the Obsidian vault + `apply-verdict` ground-truth upserts. See "Media-value calibration loop" section |
| `MediaValueRubric.md` | Run-time-read rubric for `YouTubeClassifier.ts` — `## Classification guidance` is appended to its system prompt; maintained by the calibration loop |
| `bin/install-aw-mac.sh` | Installs AW + watchers on Mac (one-shot) |
| `bin/install-plists.sh` | Wrapper that re-runs `~/.claude/bin/rebuild-plists.sh` |
| `bin/sync-now.sh` | User-runnable: forces immediate poll + metric refresh |
| `bin/metric.sh` | User-runnable: prints today's metric + rolling avg |

## Common queries

```bash
# Today's Tier-1 minutes + freshness
bun ~/.claude/skills/Productivity/AppUsageTracker/Tools/Freshness.ts

# Force a full sync NOW (use when about to query and want fresh data)
bash ~/.claude/skills/Productivity/AppUsageTracker/bin/sync-now.sh

# Recompute all daily_metrics (e.g. after editing Config.ts tier lists)
bun ~/.claude/skills/Productivity/AppUsageTracker/Tools/MetricCalc.ts --force
```

```sql
-- Per-device minutes today (substitution detector)
SELECT device, ROUND(SUM(duration_sec)/60, 1) AS min
FROM events
WHERE date_trunc('day', ts_start) = today()
  AND app IN (...tier1Apps...)
GROUP BY device ORDER BY min DESC;

-- Top 10 apps last 7 days
SELECT app, ROUND(SUM(duration_sec)/60, 1) AS min
FROM events
WHERE ts_start >= today() - INTERVAL 7 DAY
GROUP BY app ORDER BY min DESC LIMIT 10;
```

## Media-value calibration loop (weekly)

The G37 number and /youtube curation both rest on LLM verdicts Jm never audits directly. The calibration loop closes that: every week Jm reviews a small stratified sample of Kaya's actual classifications, and his feedback becomes (a) ground-truth verdict rows and (b) rubric guidance the classifier reads at run time.

**Pieces:**
- `Tools/CalibrationSampler.ts` — draws a stratified sample from `youtube_verdicts` (8 confident-low + 8 confident-high + 8 borderline by default; recency-weighted, ≤2 per channel per stratum, never repeats a previously sampled video) and writes a review sheet to `~/Desktop/obsidian/POS/Reviews/YouTube Calibration/Round NN — YYYY-MM-DD.md`. State (which ids have been sampled, per round) lives in `~/.claude/MEMORY/AppUsage/calibration/rounds.json`. Opens events.db READ-ONLY.
- `MediaValueRubric.md` — its `## Classification guidance` section is appended to `YouTubeClassifier.ts`'s system prompt on every run (fail-loud if missing). Editing it changes nightly classification with zero code edits. `## Calibration log` records each applied round.
- `CalibrationSampler.ts apply-verdict --video=<id> --value=low|high --reason="..."` — writes one Jm ground-truth verdict (`classifier='jm-calibration'`, confidence 1.0). These rows are never re-sampled and never overwritten by the nightly classifier (it skips videos that already have verdicts).

**Weekly cycle (driven by the recurring LucidTasks task "YouTube media-value calibration — weekly round"):**
1. Open the newest sheet in `~/Desktop/obsidian/POS/Reviews/YouTube Calibration/`.
2. If its frontmatter says `status: reviewed`: interpret Jm's **Your call** / **Notes** / **General feedback** with judgment (NOT a parser — his phrasing is free-form). For each per-video override, run `apply-verdict`. Distill *patterns* into `MediaValueRubric.md ## Classification guidance` (and into `skills/Productivity/YouTubeCuration/Rubric.md` when the feedback is about curation/channel quality rather than watch-value). Append a `## Calibration log` row. Change the sheet's frontmatter to `status: processed`. If overrides flipped verdicts, run `MetricCalc.ts --force` so daily_metrics reflect the corrected ground truth.
3. If the newest sheet is still `status: awaiting-review`: do NOT generate another one (don't pile up unreviewed sheets); report that it's waiting on Jm.
4. Otherwise (sheet processed, or no sheets yet): run `CalibrationSampler.ts` to generate the next round. If events.db is locked (nightly running), wait and retry — never kill the pipeline for this.

**Interpretation contract for the sheet:** blank **Your call** = Jm agrees with Kaya's verdict — that's silent confirmation, don't write agree-rows back as jm-calibration. Only explicit `low`/`high` overrides become verdict rows. Ambiguous notes → leave the verdict alone, carry the note into guidance only if the pattern is clear.

## Operational notes

- **DuckDB file is the single source of truth.** All tools read from / write to `~/.claude/MEMORY/AppUsage/events.db` only.
- **Idempotent by construction.** `events.id = "<device>:<bucket>:<event_id>"` and `INSERT OR REPLACE` means a duplicate poll is a no-op. `MetricCalc` upserts on `daily_metrics.date`.
- **Mac sleep is fine.** AW Android buffers events locally for ~30 days. The next successful poll catches up. `MetricCalc` (with or without `--force`) will populate any missing day.
- **Failures never propagate.** If one device is unreachable (phone offline), AWPoller logs the error and continues with the others. `Freshness.ts` surfaces the stale-sync.
- **Tier-1 list lives in `Config.ts`.** Adjusting it does NOT require code changes — `MetricCalc.ts --force` recomputes from the new list.

## Cursor TZ drift — a closed footgun (2026-05-14)

`sync_state.last_event_ts` is a DuckDB `TIMESTAMP` (TZ-naive). For ~10 days,
AWPoller had a silent +7h drift per poll because:

1. `SELECT last_event_ts FROM sync_state` returned a `DuckDBTimestampValue`
   wrapper; `new Date(it).toISOString()` parsed the naive value as local time
   (PDT = UTC-7), so the cursor read back +7h.
2. Empty polls rewrote the cursor with that drifted value, compounding the
   shift on every 5-min poll. Over a few days inactive buckets ended up with
   cursors in **Jan 2027**, after which AW returned 0 events forever.

Fix (committed): read the cursor via
`strftime(last_event_ts, '%Y-%m-%dT%H:%M:%S.%fZ') AS last_event_ts_iso` and use
the string directly; on empty polls, UPDATE only `last_sync_ok` — never
rewrite `last_event_ts`. Regression covered in `tests/AWPoller.test.ts` (the
"cursor is stable across empty polls" test). If you ever change AWPoller's
cursor read/write, do not reintroduce a TIMESTAMP → JS Date → string round-trip.

When debugging "0 events but device reachable," check:
```sql
SELECT device, bucket,
       strftime(last_event_ts, '%Y-%m-%dT%H:%M:%S.%fZ') AS cursor
  FROM sync_state WHERE bucket != '_poll_' ORDER BY device, bucket;
```
A cursor in the future = a stuck device. AWPoller now has an automatic
guard (`CURSOR_FUTURE_TOLERANCE_MS`) that resets cursors more than 5 min in
the future on next poll, logging the reset to
`MEMORY/MONITORING/failure-log.jsonl` (source `AppUsageTracker:AWPoller`,
message `"poisoned cursor reset"`). Manual reset SQL still works:
```sql
UPDATE sync_state
   SET last_event_ts = (
     SELECT MAX(e.ts_start) FROM events e
      WHERE e.device = sync_state.device AND e.bucket = sync_state.bucket)
 WHERE bucket != '_poll_';
```

## Server-side stale-bucket skip + watcher-silent warning

Two related defenses added 2026-05-14:

- **`STALE_BUCKET_DAYS` in `AWPoller.ts` (=7).** A server-side bucket whose
  `last_updated` is older than this is skipped at poll time. Prevents the
  five-minute cron from firing pointless HTTP requests at the dead
  hostname-suffixed buckets aw-server retains forever after a hostname
  change.
- **Watcher-silent warning in `Freshness.ts`.** If a device's `last_sync_ok`
  is within `RECENT_SYNC_THRESHOLD_MIN` (15 min) but the newest event for
  that device is older than `WATCHER_SILENT_THRESHOLD_HOURS` (24h), the
  output flags `⚠ watcher silent: ... — open ActivityWatch on this device`.
  Catches the case where ADB-forward succeeds but the AW app on phone or
  tablet has stopped recording.

Freshness also tails `failure-log.jsonl` and surfaces the latest failure from
any AppUsageTracker component (source prefixed `AppUsageTracker:` — Classifier,
ChromeClassifier, AWPoller, PhoneAutoPoll, YouTubeIngest, etc.) within
`ALARM_FRESHNESS_HOURS` (24). Previously matched only the exact source
`AppUsageTracker:Classifier`, silently missing all other components' failures
at this surface (fixed 2026-07-17, fable-audit batch2).

## Phone / tablet connectivity is USB-via-ADB, not Tailscale

Despite the original V1 design, the live setup uses
`/opt/homebrew/bin/adb forward tcp:<port> tcp:5600`:
- phone (serial `32281JEHN11329`) → `localhost:5601`
- tablet (serial `R52N816X3LH`) → `localhost:5602`

The `com.kaya.aw-phone-autopoll` LaunchAgent watches `adb track-devices` and
triggers an AWPoller run the moment a known serial plugs in. If a device is
not in `adb devices`, **it is not connected** regardless of what Tailscale
shows — the Pixel-7a Tailscale entry has been "offline 11d" with no impact
on tracking because the path is now USB. The error
`Unable to connect. Is the computer able to access the url?` from AWPoller
means the device is either (a) not USB-plugged, (b) USB-debugging revoked,
or (c) the ActivityWatch APK isn't running on the device.

## Tier-1 / Tier-2-Chrome dedup — second closed footgun (2026-05-14)

`computeChromeLowValueMinutes` excludes `chrome_domain_verdicts.classifier =
'tier1-domain'` rows. Without this filter, every Mac visit to reddit /
twitter / x / bsky was counted twice:

1. `aw-watcher-web-chrome` event with `url ILIKE '%reddit.com%'` matched
   `CONFIG.tier1DomainPatterns` → counted in `tier1_minutes`.
2. `chrome_visits + chrome_domain_verdicts(classifier='tier1-domain',
   is_low_value=true)` for `reddit.com` → counted in `tier2_lowvalue_minutes`.

Same wall-clock minutes, two ledgers. 2026-05-04 over-counted by 30 min
(t2=30 was pure duplicate of t1 reddit time). The fix excludes
`tier1-domain` verdicts from the Chrome tier-2 sum — those domains are the
LLM-cost-saver short-circuit and are already counted via aw-watcher URL
patterns. `llm-sonnet` verdicts (the actual LLM classifications: e.g.
youtube.com, news.ycombinator.com) DO count, because aw-watcher URL patterns
don't cover them.

Regression: `tests/ChromeMetric.test.ts` test
`"tier1-domain verdicts are EXCLUDED (already counted via aw-watcher URL match)"`.

If you ever re-introduce a "low-value domain" classifier path on either
side, audit this guard — the safe rule is:
**a domain that's already in `tier1DomainPatterns` must not also be in any
tier-2 source.**

## Classifier "unclassifiable" sessions are structural, not a bug

`Classifier.ts` requires each session to have at least one event with a
non-empty title or url (`isClassifiable`). Three buckets fail this gate by
their underlying watcher design:
- `aw-watcher-android-test` — emits foreground app + package only, no
  per-screen title (YouTube, LinkedIn, WhatsApp sessions show as
  app-name only).
- `aw-watcher-android-unlock` — boolean lock/unlock; not classifiable.
- `aw-watcher-android-web-chrome` — has title + url but `app=null`; the
  classifier filters null-app events before sessionising, so these are
  dropped today.

A `100% unclassifiable: ≥20 sessions` alarm is written to
`failure-log.jsonl` (see `UNCLASSIFIABLE_ALARM_MIN_SESSIONS`). The intended
unblock is the YouTube pipeline — Takeout or Data Portability API enriches
per-video metadata into `youtube_videos`, then `YouTubeClassifier` produces
verdicts independently of aw-watcher titles.
