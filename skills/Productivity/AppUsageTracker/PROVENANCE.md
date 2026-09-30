# AppUsageTracker Data Provenance

This file describes how AppUsageTracker data is collected, what it covers, and what it does not. Read this before drawing inferences about Jm's usage patterns or habits from this data.

---

## Collection Method

AppUsageTracker data arrives through two independent pipelines:

1. **ActivityWatch polling** (`AWPoller.ts`) — runs every 5 minutes via a LaunchAgent. Polls the ActivityWatch REST API (`:5600`) on each registered device and inserts events into `~/.claude/MEMORY/AppUsage/events.db` (DuckDB). Devices are:
   - **Mac** — always-on, AW installed locally; events arrive continuously when the Mac is awake.
   - **Android phone** (serial `32281JEHN11329`) — connected via USB ADB forward (`localhost:5601`). Polled only when the phone is USB-plugged and ADB-debugging is active. A `com.kaya.aw-phone-autopoll` LaunchAgent triggers a poll the moment a known serial connects.
   - **Android tablet** (serial `R52N816X3LH`) — same USB/ADB pattern as phone (`localhost:5602`).

2. **Google Takeout / Chrome history** (`Classifier.ts` + `YouTubeClassifier`) — Chrome browse history and YouTube viewing history arrive **only when Jm manually exports a Google Takeout archive and drops it into the inbox folder**. This is a manual, episodic step — not automated. The nightly LLM classifier (`Classifier.ts`, 02:30 via `com.kaya.aw-classifier`) processes unclassified Tier-2 sessions from ActivityWatch, but it cannot enrich Chrome/YouTube rows that were never imported.

---

## Coverage Scope

| Source | Coverage |
|---|---|
| Mac ActivityWatch events | Continuous when Mac is awake; polled every 5 min. Represents the most complete device in the dataset. |
| Android phone AW events | Present only during USB-connected windows. AW buffers events locally for ~30 days; catch-up poll fills gaps when the phone reconnects. |
| Android tablet AW events | Same USB/ADB pattern as phone. |
| Chrome/YouTube history | Present only after a manual Google Takeout import. May be weeks or months stale between imports. |
| Tier-1 classification | Deterministic (Config.ts allowlist). Applied on every MetricCalc run. |
| Tier-2 LLM classification | Nightly, bounded. Sessions lacking title/url metadata (Android watcher buckets) are structurally unclassifiable and recorded as such. |

---

## Known Gaps

- **Phone and tablet data is USB-gated.** When a device is not plugged in, no events are collected for it, regardless of Tailscale connectivity. Periods of heavy phone use when the phone is not USB-connected appear as zero-usage in the dataset.
- **`source` column cannot distinguish phone vs Mac for Takeout rows.** Chrome Takeout data is imported without a reliable device-of-origin tag; queries that try to separate phone Chrome use from Mac Chrome use via the `source` column are unreliable for Takeout-sourced rows.
- **YouTube and Chrome history depends on manual exports.** There is no automated ingestion. If Jm has not performed a Takeout recently, YouTube consumption metrics will be stale or zero.
- **Android watcher buckets are structurally unclassifiable.** `aw-watcher-android-test` emits foreground app and package only (no per-screen title). `aw-watcher-android-unlock` is a boolean lock/unlock signal. `aw-watcher-android-web-chrome` has title + url but `app=null`, causing it to be dropped by the classifier's null-app filter. These sessions count as `unclassifiable` in the LLM classifier.
- **Tier-1/Tier-2 dedup.** Domains already in `tier1DomainPatterns` are excluded from Tier-2 Chrome verdict counts to prevent double-counting. Apps or domains that span both lists will be counted only once (Tier-1 wins).
- **Mac sleep.** Events are not collected while the Mac is asleep. AW does not backfill Mac sleep gaps.
- **Cursor drift history.** A TZ-drift bug (fixed 2026-05-14) caused ~10 days of under-collection on some device buckets prior to the fix. Historical daily metrics for that window may undercount.

---

## Inference Prohibition

**Do not infer Jm's overall media consumption habits, device preferences, or behavioral identity from this dataset.**

The dataset is a partial, structurally-gapped sample. Mac coverage is the most reliable; phone and tablet coverage depends entirely on USB-connection windows. Chrome/YouTube coverage depends on manual Takeout imports that may be infrequent.

Absence of events on a device or in a time window means those events were not collected — it does not mean Jm was not using the device or consuming media.

Default posture: **treat gaps as collection gaps, not as behavioral absence.** When the dataset is silent on a device or period, report it as not measured — never as "Jm wasn't using his phone" or "Jm didn't watch YouTube."

Use rolling averages and tier metrics only to characterize what the system measured during the stated window, not Jm's overall behavior or identity.
