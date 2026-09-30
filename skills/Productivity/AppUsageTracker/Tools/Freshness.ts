#!/usr/bin/env bun
/**
 * Freshness.ts — user-facing status: last-sync per device + today's metric.
 *
 * Without --force: queries DuckDB only. Fast, read-only.
 * With  --force:   spawns AWPoller and MetricCalc first, then prints status.
 *
 * Flags:
 *   --force    poll all devices NOW, recompute today's metric, then report
 *   --json     emit JSON instead of human text
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "path";
import { CONFIG } from "../Config.ts";
import { defaultKayaHome, getKayaHome } from "../../../../lib/core/KayaHome.ts";
import { Db } from "./Db.ts";
import { readMediaWigTargets } from "./WigTargets.ts";

interface FreshnessRow {
  device: string;
  buckets: number;
  newest_sync: Date | null;
  last_event: Date | null;
  last_error: string | null;
}

/** A device whose poll succeeded recently but whose newest event is older
 *  than this should be flagged "watcher silent" — the AW server answered but
 *  no watcher is producing events on that device. Catches the 2026-05-12
 *  tablet aw-watcher-android-web-chrome regression where the bucket existed
 *  but the extension stopped firing. */
const WATCHER_SILENT_THRESHOLD_HOURS = 24;
const RECENT_SYNC_THRESHOLD_MIN = 15;

/** A device that hasn't *synced* within this many hours makes today's metric
 *  and the rolling 4-wk avg untrustworthy: events recorded on that device
 *  during the gap haven't landed, so the numbers undercount actual usage.
 *  Root cause of the silent 2026-05-14→17 phone/tablet outage that still
 *  printed a clean "under target" 4-wk avg. Distinct from WATCHER_SILENT
 *  (device syncs fine but its watcher stopped producing events). */
const DEVICE_STALE_ALARM_HOURS = 24;

const FAILURE_LOG_PATH = join(getKayaHome(), "MEMORY", "MONITORING", "failure-log.jsonl");
const ALARM_FRESHNESS_HOURS = 24;

interface FailureLogEntry {
  ts: string;
  source: string;
  error?: { message?: string } | string;
  context?: Record<string, unknown>;
}

/** Return the most recent failure from any AppUsageTracker component (source
 *  prefixed "AppUsageTracker:" by Db.ts's logFailure wrapper — Classifier,
 *  ChromeClassifier, ChromeIngest, ChromeTakeoutIngest, OAuthBootstrap,
 *  PhoneAutoPoll, YouTubeClassifier, YouTubeDataPortability, YouTubeEnrich,
 *  YouTubeIngest, AWPoller, etc.) within the last ALARM_FRESHNESS_HOURS, or
 *  null. Previously matched only the exact source "AppUsageTracker:Classifier",
 *  which meant 10 of 11 real failure sources (e.g. ChromeClassifier) never
 *  surfaced here even though they were already in the failure log — confirmed
 *  live against 2026-07-15 AppUsageTracker:ChromeClassifier entries (fable-audit
 *  batch2). Tails the last ~64KB of the file so we don't pull a multi-MB log
 *  into memory. */
function latestComponentFailure(): { ts: string; message: string } | null {
  if (!existsSync(FAILURE_LOG_PATH)) return null;
  try {
    const buf = readFileSync(FAILURE_LOG_PATH, "utf8");
    const tail = buf.slice(Math.max(0, buf.length - 65_536));
    const lines = tail.split("\n").filter(Boolean);
    const cutoffMs = Date.now() - ALARM_FRESHNESS_HOURS * 3600_000;
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const entry = JSON.parse(lines[i]) as FailureLogEntry;
        if (!entry.source?.startsWith("AppUsageTracker:")) continue;
        const tsMs = Date.parse(entry.ts);
        if (!Number.isFinite(tsMs) || tsMs < cutoffMs) return null;
        const message = typeof entry.error === "string"
          ? entry.error
          : entry.error?.message ?? "unknown failure";
        return { ts: entry.ts, message: `${entry.source}: ${message}` };
      } catch { /* skip malformed line */ }
    }
  } catch { /* best-effort */ }
  return null;
}

interface MetricRow {
  date: string;
  tier1_minutes: number;
  total_lowvalue_minutes: number;
  rolling_4wk_avg: number | null;
}

interface TotalsRow {
  media_avg: number | bigint | null;
  screen_avg: number | bigint | null;
  youtube_avg: number | bigint | null;
}

function humanAge(d: Date | null): string {
  if (!d) return "never";
  const ms = Date.now() - d.getTime();
  const min = Math.round(ms / 60_000);
  if (min < 60) return `${min} min ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr} hr ago`;
  return `${Math.round(hr / 24)} d ago`;
}

function statusGlyph(d: Date | null, err: string | null): string {
  if (err) return "✗";
  if (!d) return "—";
  const ageMin = (Date.now() - d.getTime()) / 60_000;
  if (ageMin <= 15) return "✓";
  if (ageMin <= 60) return "·";
  return "⚠";
}

/** Devices whose newest successful sync is older than DEVICE_STALE_ALARM_HOURS
 *  (or which have never synced). Their absence undercounts the metric. */
function findStaleDevices(devices: FreshnessRow[]): FreshnessRow[] {
  return devices.filter(d =>
    !d.newest_sync
    || (Date.now() - d.newest_sync.getTime()) / 3600_000 > DEVICE_STALE_ALARM_HOURS,
  );
}

function runScript(scriptPath: string, args: string[] = []): void {
  const r = spawnSync("bun", ["run", scriptPath, ...args], {
    stdio: ["ignore", "inherit", "inherit"],
  });
  if (r.status !== 0) {
    console.error(`[Freshness] subprocess ${scriptPath} exited ${r.status}`);
  }
}

async function main(argv: string[]): Promise<void> {
  const force = argv.includes("--force");
  const json = argv.includes("--json");

  if (force) {
    const dir = join(defaultKayaHome(), "skills/Productivity/AppUsageTracker/Tools");
    runScript(`${dir}/AWPoller.ts`);
    // Recompute the entire window — backfills from a multi-day outage land
    // historical events, and without --force MetricCalc only fills missing
    // days. The full recompute is seconds for ~30 days.
    runScript(`${dir}/MetricCalc.ts`, ["--force"]);
  }

  const db = await Db.open();
  try {
    await db.initSchema();

    const devices: FreshnessRow[] = [];
    for (const dev of CONFIG.devices) {
      // Cast timestamps to VARCHAR so we get plain ISO-ish strings back
      // (DuckDB's typed timestamp value wrapper doesn't expose getTime()).
      const row = await db.queryRow<{
        buckets: number | bigint;
        newest_sync: string | null;
        last_event: string | null;
      }>(
        `SELECT COUNT(*) AS buckets,
                MAX(last_sync_ok)::VARCHAR  AS newest_sync,
                MAX(last_event_ts)::VARCHAR AS last_event
           FROM sync_state
          WHERE device = $device AND bucket != '_poll_'`,
        { device: dev.name },
      );
      const errRow = await db.queryRow<{ last_error: string | null }>(
        `SELECT last_error FROM sync_state
          WHERE device = $device AND last_error IS NOT NULL
          ORDER BY last_sync_ok DESC NULLS LAST LIMIT 1`,
        { device: dev.name },
      );
      devices.push({
        device: dev.name,
        buckets: Number(row?.buckets ?? 0),
        newest_sync: row?.newest_sync ? new Date(row.newest_sync.replace(" ", "T") + "Z") : null,
        last_event: row?.last_event ? new Date(row.last_event.replace(" ", "T") + "Z") : null,
        last_error: errRow?.last_error ?? null,
      });
    }

    const metric = await db.queryRow<MetricRow>(
      `SELECT date::VARCHAR AS date, tier1_minutes, total_lowvalue_minutes, rolling_4wk_avg
         FROM daily_metrics
         ORDER BY date DESC LIMIT 1`,
    );

    // 28-day averages of the "all-value" totals (tracking companions to the
    // low-value goal metric) over the same window as rolling_4wk_avg.
    const totals = metric ? await db.queryRow<TotalsRow>(
      `SELECT ROUND(AVG(total_media_minutes))   AS media_avg,
              ROUND(AVG(total_screen_minutes))  AS screen_avg,
              ROUND(AVG(total_youtube_minutes)) AS youtube_avg
         FROM daily_metrics
        WHERE date BETWEEN ($end::DATE - 27) AND $end::DATE`,
      { end: metric.date },
    ) : null;

    const stale = findStaleDevices(devices);
    const wig = readMediaWigTargets();

    if (json) {
      console.log(JSON.stringify({
        devices,
        metric,
        totals,
        wigTargets: wig,
        staleDevices: stale.map(d => d.device),
        // false → today's metric / 4-wk avg undercount; do not treat as a
        // pass/fail verdict against the WIG target.
        metricReliable: stale.length === 0,
      }, null, 2));
      return;
    }

    console.log("Devices:");
    for (const d of devices) {
      const glyph = statusGlyph(d.newest_sync, d.last_error);
      const sync = d.newest_sync ? `last sync ${humanAge(d.newest_sync)}` : "never synced";
      const err = d.last_error ? `  ⚠ ${d.last_error.slice(0, 80)}` : "";
      console.log(`  ${glyph} ${d.device.padEnd(7)} ${sync.padEnd(28)} buckets=${d.buckets}${err}`);
      // Watcher-silent: poll OK recently but newest event is stale. Indicates
      // the AW server is up but no watcher is producing events on this device.
      if (
        !d.last_error
        && d.newest_sync
        && (Date.now() - d.newest_sync.getTime()) / 60_000 <= RECENT_SYNC_THRESHOLD_MIN
        && d.last_event
        && (Date.now() - d.last_event.getTime()) / 3600_000 > WATCHER_SILENT_THRESHOLD_HOURS
      ) {
        console.log(`           ⚠ watcher silent: newest event ${humanAge(d.last_event)} — open ActivityWatch on this device`);
      }
    }
    const alarm = latestComponentFailure();
    if (alarm) {
      console.log(`  ⚠ component failure (${humanAge(new Date(alarm.ts))}): ${alarm.message.slice(0, 120)}`);
    }
    // Device-staleness alarm: a device dark for >24h means the metric below
    // undercounts. Surfaced loudly so a silent outage can't read as a clean
    // "under target" (see the 2026-05 phone/tablet outage).
    if (stale.length > 0) {
      const list = stale.map(d => `${d.device} (${humanAge(d.newest_sync)})`).join(", ");
      console.log(`  🚨 STALE-DATA ALARM — ${stale.length} device(s) not synced in >${DEVICE_STALE_ALARM_HOURS}h: ${list}`);
      console.log(`     → today's metric and the 4-wk avg UNDERCOUNT real usage; do NOT read this as "under target".`);
    }
    console.log("");
    if (metric) {
      const avg = metric.rolling_4wk_avg == null ? "n/a" : `${Number(metric.rolling_4wk_avg).toFixed(1)} min/logged-day`;
      const avgNote = stale.length > 0
        ? `🚨 UNRELIABLE — ${stale.length} stale device(s); undercounts actual usage`
        : wig
          ? `(${wig.goalId} low-value target ≤ ${wig.lowValue} min/day)`
          : `(⚠ no media WIG low_value target in wig_status.json)`;
      console.log(`Today's metric (${metric.date}):`);
      console.log(`  Tier-1 (always-low-value) : ${metric.tier1_minutes} min`);
      console.log(`  Total low-value           : ${metric.total_lowvalue_minutes} min`);
      console.log(`  4-wk avg (per logged day) : ${avg}  ${avgNote}`);
      if (totals) {
        // All-value tracking companions (total media is also a WIG headline
        // target). Distinct labels so the goal-surface parsers never mistake
        // these for the low-value avg.
        const t = (v: number | bigint | null) => v == null ? "n/a" : `${Number(v).toFixed(0)} min/day`;
        const totalNote = stale.length === 0 && wig?.totalMedia != null
          ? `  (${wig.goalId} total target ≤ ${wig.totalMedia} min/day)`
          : "";
        console.log(`  Total media (28d avg)     : ${t(totals.media_avg)}${totalNote}`);
        console.log(`  Total screen (28d avg)    : ${t(totals.screen_avg)}`);
        console.log(`  Total YouTube (28d avg)   : ${t(totals.youtube_avg)}`);
      }
    } else {
      console.log("No daily_metrics rows yet — run MetricCalc.ts.");
    }
  } finally {
    db.close();
  }
}

if (import.meta.main) main(process.argv.slice(2)).catch(err => {
  console.error(err);
  process.exit(1);
});
