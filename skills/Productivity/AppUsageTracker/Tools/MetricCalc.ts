#!/usr/bin/env bun
/**
 * MetricCalc.ts — computes daily Tier-1 minutes + 4-week rolling average per day.
 *
 * Idempotent: re-running yields identical rows. With --force, recomputes every
 * day from CONFIG.goalStartDate; without --force, skips days already present.
 *
 * V1 (now): only Tier-1 (whitelist + URL substr) is counted. tier2_lowvalue_minutes = 0.
 * V1.5: Classifier.ts populates `classifications` and MetricCalc joins it for tier2.
 *
 * Flags:
 *   --force    recompute all days, overwriting existing rows
 *   --json     emit JSON summary on stdout
 *   --date=YYYY-MM-DD   only compute that one day (still backfills nothing)
 */

import { CONFIG } from "../Config.ts";
import { Db } from "./Db.ts";
import { daysBetween as daysBetweenUtil, shiftDate as shiftDateUtil, todayLocal as todayLocalUtil } from "./Util.ts";
import { computeYouTubeConsumption } from "./YouTubeSessionJoin.ts";

/**
 * SQL fragment that converts the UTC-stored `ts_start` to the local calendar
 * date in `CONFIG.localTimezone`. Without this, events between 5pm-midnight
 * local time get attributed to tomorrow because aw-server emits UTC.
 * Safe to interpolate — `localTimezone` is a static IANA name from config.
 */
const LOCAL_DATE_SQL = `CAST(ts_start AT TIME ZONE 'UTC' AT TIME ZONE '${CONFIG.localTimezone}' AS DATE)`;

/**
 * Maximum per-visit duration applied when computing Chrome low-value minutes.
 * Defends against tabs left open overnight (Chrome records ~20h visit_duration
 * when the tab sits idle in the foreground without a navigation event).
 */
export const CHROME_VISIT_DURATION_CAP_SEC = 1800;

/**
 * Sentinel applied when Chrome's recorded `visit_duration` is 0 — happens for
 * terminated-abnormally visits (~13% of Jm's profile). A flat 1 min keeps the
 * visit from being silently dropped without overweighting it.
 */
export const CHROME_VISIT_DURATION_FALLBACK_SEC = 60;

interface DailyMetricRow {
  date: string;
  tier1_minutes: number;
  tier2_lowvalue_minutes: number;
  total_lowvalue_minutes: number;
  rolling_4wk_avg: number | null;
  computed_at: string;
}

const todayLocal = todayLocalUtil;
const daysBetween = daysBetweenUtil;

interface Tier1BucketRow {
  device: string;
  app_lc: string | null;
  sec: number | bigint;
}

/**
 * Builds the SQL fragment that matches Tier-1 candidate events, along with
 * the bindings needed. `prefix` namespaces parameter names so callers can
 * combine this with their own bindings without collision. Reused by
 * computeTier1Minutes (totals) and computeTier1BucketsByDeviceApp (Dashboard).
 *
 * The returned clause is the inner WHERE-eligible expression — caller still
 * needs to add the date filter. Tier-3 apps are excluded here.
 */
export function buildTier1MatchSql(
  bindingPrefix: string = "",
  columnPrefix: string = "",
): {
  matchClause: string;
  bindings: Record<string, unknown>;
} {
  const bindings: Record<string, unknown> = {};
  const appCol = `${columnPrefix}app`;
  const deviceCol = `${columnPrefix}device`;
  const urlCol = `${columnPrefix}url`;

  const appPh: string[] = [];
  CONFIG.tier1Apps.forEach((app, i) => {
    const k = `${bindingPrefix}app${i}`;
    bindings[k] = app.toLowerCase();
    appPh.push(`$${k}`);
  });
  const universalAppClause = appPh.length ? `lower(${appCol}) IN (${appPh.join(", ")})` : "FALSE";

  const deviceClauses: string[] = [];
  for (const [device, apps] of Object.entries(CONFIG.tier1AppsByDevice)) {
    if (!apps || apps.length === 0) continue;
    const devKey = `${bindingPrefix}dev_${device}`;
    bindings[devKey] = device;
    const placeholders: string[] = [];
    apps.forEach((app, i) => {
      const k = `${bindingPrefix}${device}_app${i}`;
      bindings[k] = app.toLowerCase();
      placeholders.push(`$${k}`);
    });
    deviceClauses.push(`(${deviceCol} = $${devKey} AND lower(${appCol}) IN (${placeholders.join(", ")}))`);
  }
  const deviceAppClause = deviceClauses.length ? `(${deviceClauses.join(" OR ")})` : "FALSE";

  const t3Ph: string[] = [];
  CONFIG.tier3Apps.forEach((app, i) => {
    const k = `${bindingPrefix}t3app${i}`;
    bindings[k] = app.toLowerCase();
    t3Ph.push(`$${k}`);
  });
  const tier3Clause = t3Ph.length ? `lower(${appCol}) NOT IN (${t3Ph.join(", ")})` : "TRUE";

  const urlClauses: string[] = [];
  CONFIG.tier1DomainPatterns.forEach((pat, i) => {
    const k = `${bindingPrefix}urlpat${i}`;
    bindings[k] = pat;
    // COALESCE(url, '') keeps the expression boolean rather than NULL when
    // url IS NULL — otherwise the entire `(app OR device OR url)` chain
    // returns NULL, NOT-flips to NULL, and DuckDB drops the row from a
    // tier-2 query whose WHERE clause is `NOT (tier1Match)`. Bug surfaced
    // by Classifier.test.ts:computeTier2LowValueMinutes.
    urlClauses.push(`COALESCE(${urlCol}, '') ILIKE $${k}`);
  });
  const urlClause = urlClauses.length ? `(${urlClauses.join(" OR ")})` : "FALSE";

  const matchClause = `(${universalAppClause} OR ${deviceAppClause} OR ${urlClause}) AND ${tier3Clause}`;
  return { matchClause, bindings };
}

/** Apply per-(device, app) Tier-1 floor minutes to a bucketed row. Clamped at 0. */
function applyFloor(row: { device: string; app_lc: string | null; sec: number | bigint }): number {
  const sec = Number(row.sec ?? 0);
  const appLc = row.app_lc ?? "";
  const floor = CONFIG.tier1FloorsMinPerDay.find(
    f => f.device === row.device && f.app.toLowerCase() === appLc,
  );
  const floorSec = floor ? floor.floorMin * 60 : 0;
  return Math.max(0, sec - floorSec);
}

/** Tier-1 candidate events for a single date, bucketed by (device, app),
 *  with floors applied. Used by both totals + Dashboard per-device panel. */
export async function computeTier1BucketsByDeviceApp(db: Db, date: string): Promise<Array<{ device: string; app: string | null; netSec: number }>> {
  const { matchClause, bindings } = buildTier1MatchSql();
  bindings.date = date;

  const sql = `
    SELECT device,
           lower(app) AS app_lc,
           COALESCE(SUM(duration_sec), 0) AS sec
    FROM events
    WHERE ${LOCAL_DATE_SQL} = $date::DATE
      AND ${matchClause}
    GROUP BY device, lower(app)
  `;
  const rows = await db.queryAll<Tier1BucketRow>(sql, bindings);
  return rows.map(r => ({ device: r.device, app: r.app_lc, netSec: applyFloor(r) }));
}

/**
 * Tier-1 minutes for a single date. Counts an event if ANY of:
 *   - app matches a universal tier1 app (case-insensitive)
 *   - (device, app) matches a tier1AppsByDevice entry (case-insensitive)
 *   - url matches any of the tier1DomainPatterns LIKE patterns
 * Tier-3 apps are explicitly excluded. Per-(device, app) floor minutes are
 * subtracted post-aggregation, clamped at 0.
 */
export async function computeTier1Minutes(db: Db, date: string): Promise<number> {
  const buckets = await computeTier1BucketsByDeviceApp(db, date);
  const totalSec = buckets.reduce((acc, b) => acc + b.netSec, 0);
  return Math.round(totalSec / 60);
}

/** Tier-1 minutes per device for a single date (Dashboard panel data). */
export async function computeTier1MinutesByDevice(db: Db, date: string): Promise<Map<string, number>> {
  const buckets = await computeTier1BucketsByDeviceApp(db, date);
  const byDevice = new Map<string, number>();
  for (const b of buckets) {
    byDevice.set(b.device, (byDevice.get(b.device) ?? 0) + b.netSec);
  }
  for (const [k, v] of byDevice) byDevice.set(k, Math.round(v / 60));
  return byDevice;
}

/**
 * Tier-2 low-value minutes for a single date. Joins events to classifications
 * where the LLM classifier marked the session low-value. Excludes:
 *   - Tier-3 apps (utility — never counts regardless)
 *   - Tier-1 matches (would double-count — same event already in tier1_minutes)
 */
export async function computeTier2LowValueMinutes(db: Db, date: string): Promise<number> {
  // Reuse the Tier-1 predicate to EXCLUDE Tier-1 matches from Tier-2 totals
  // (would otherwise double-count: same event counted in tier1 + tier2).
  // "e." column prefix because we're joining events `e` to classifications `c`.
  const { matchClause: tier1Match, bindings } = buildTier1MatchSql("t2_", "e.");
  bindings.date = date;

  const sql = `
    SELECT COALESCE(SUM(e.duration_sec), 0) AS sec
      FROM events e
      JOIN classifications c ON c.event_id = e.id
     WHERE CAST(e.ts_start AT TIME ZONE 'UTC' AT TIME ZONE '${CONFIG.localTimezone}' AS DATE) = $date::DATE
       AND c.tier = 2
       AND c.is_low_value = TRUE
       AND NOT (${tier1Match})
  `;
  const row = await db.queryRow<{ sec: number | bigint }>(sql, bindings);
  const sec = Number(row?.sec ?? 0);
  return Math.round(sec / 60);
}

/**
 * Chrome low-value minutes for a single local-date. Joins chrome_visits to
 * chrome_domain_verdicts (per ChromeClassifier) and sums per-visit duration
 * with the cap + zero-fallback rules.
 *
 * This is a SEPARATE Tier-2 source from `events`+`classifications` — the
 * caller (`main` / `upsertMetric` integrations) sums both into the day's
 * `tier2_lowvalue_minutes` column. There are two overlap surfaces to avoid:
 *
 *   1) Tier-2 aw-watcher events: Mac browsers are deliberately NOT in
 *      CONFIG.tier2Apps anymore (see Config.ts), so the classifier path
 *      doesn't touch Chrome time.
 *   2) Tier-1 URL pattern matches: aw-watcher-web-chrome events on Mac
 *      already match `tier1DomainPatterns` (reddit/twitter/x/bsky) and are
 *      counted in `tier1_minutes`. ChromeClassifier ALSO marks those exact
 *      domains as low-value via the `'tier1-domain'` short-circuit. Counting
 *      them again here would double the minutes. We therefore exclude
 *      `tier1-domain` verdicts and only count LLM-classified domains here —
 *      those are the ones aw-watcher URL matching can't catch on its own.
 *
 * Phone Chrome still flows through Tier-1 via tier1AppsByDevice (no
 * chrome_visits source on phone).
 */
export async function computeChromeLowValueMinutes(db: Db, date: string): Promise<number> {
  const sql = `
    SELECT COALESCE(SUM(
             CASE
               WHEN cv.visit_duration_sec > 0
                 THEN LEAST(cv.visit_duration_sec, $cap)
               ELSE $fallback
             END
           ), 0) AS sec
      FROM chrome_visits cv
      JOIN chrome_domain_verdicts v
        ON v.domain = cv.domain AND v.source = cv.source
     WHERE v.is_low_value = TRUE
       AND v.classifier <> 'tier1-domain'
       AND CAST(cv.visit_time AT TIME ZONE 'UTC' AT TIME ZONE '${CONFIG.localTimezone}' AS DATE) = $date::DATE
  `;
  const row = await db.queryRow<{ sec: number | bigint }>(sql, {
    date,
    cap: CHROME_VISIT_DURATION_CAP_SEC,
    fallback: CHROME_VISIT_DURATION_FALLBACK_SEC,
  });
  const sec = Number(row?.sec ?? 0);
  return Math.round(sec / 60);
}

/**
 * Heuristic Tier-2 low-value minutes for a single local date.
 *
 * Some Tier-2 apps run only on Android, which exposes no window title/url — so
 * the LLM session classifier has nothing to judge and they'd otherwise be
 * silently uncounted. Instead we count a fixed low-value FRACTION of their
 * foreground minutes (CONFIG.tier2HeuristicFractions). Scoped to phone/tablet,
 * whose `currentwindow` durations are real wall-clock (Mac durations balloon
 * during idle and would need not-afk intersection; these apps don't appear on
 * Mac in practice). Apps absent from the map (e.g. WhatsApp/Messages = 0%)
 * contribute nothing. No overlap with the YouTube (watch-history) or Chrome
 * paths, so this is purely additive to the day's tier2 total.
 */
export async function computeTier2HeuristicMinutes(db: Db, date: string): Promise<number> {
  const fractions = CONFIG.tier2HeuristicFractions;
  const apps = Object.keys(fractions);
  if (apps.length === 0) return 0;
  const bindings: Record<string, unknown> = { date };
  const ph: string[] = [];
  apps.forEach((app, i) => { const k = `h${i}`; bindings[k] = app.toLowerCase(); ph.push(`$${k}`); });
  const sql = `
    SELECT lower(app) AS app, COALESCE(SUM(duration_sec), 0) AS sec
      FROM events
     WHERE device IN ('phone', 'tablet')
       AND lower(app) IN (${ph.join(", ")})
       AND ${LOCAL_DATE_SQL} = $date::DATE
     GROUP BY lower(app)
  `;
  const rows = await db.queryAll<{ app: string; sec: number | bigint }>(sql, bindings);
  let lowValueSec = 0;
  for (const r of rows) {
    lowValueSec += Number(r.sec) * (fractions[r.app] ?? 0);
  }
  return Math.round(lowValueSec / 60);
}

/**
 * Active-time semantics for screen/media totals.
 *
 * Mac's `currentwindow` watcher keeps a window "current" while you're idle, so
 * raw window durations balloon (a single event can read 38h). The correct
 * ActivityWatch measure is window time INTERSECTED with `not-afk` periods. We
 * therefore use:
 *   - Mac screen  = Σ not-afk afk durations (true present-at-screen time).
 *   - Mac media   = Σ (non-Tier-3 window event ∩ not-afk interval).
 *   - Android (phone/tablet) has NO afk watcher and its usage durations are
 *     real, so we sum `currentwindow` directly (optionally excluding Tier-3).
 */
const NOT_AFK = `device='mac' AND watcher='afkstatus' AND json_extract_string(raw_json,'$.data.status')='not-afk'`;

function tier3NotInClause(bindings: Record<string, unknown>, prefix: string): string {
  const ph: string[] = [];
  CONFIG.tier3Apps.forEach((app, i) => { const k = `${prefix}${i}`; bindings[k] = app.toLowerCase(); ph.push(`$${k}`); });
  return ph.length ? `AND lower(app) NOT IN (${ph.join(", ")})` : "";
}

/** Total active screen time (all apps) for a local date: Mac not-afk + Android window. */
export async function computeScreenMinutes(db: Db, date: string): Promise<number> {
  const row = await db.queryRow<{ sec: number | bigint }>(
    `
    WITH mac_active AS (
      SELECT COALESCE(SUM(duration_sec),0) sec FROM events
       WHERE ${NOT_AFK} AND ${LOCAL_DATE_SQL} = $date::DATE
    ),
    android AS (
      SELECT COALESCE(SUM(duration_sec),0) sec FROM events
       WHERE device IN ('phone','tablet') AND watcher='currentwindow' AND ${LOCAL_DATE_SQL} = $date::DATE
    )
    SELECT (SELECT sec FROM mac_active) + (SELECT sec FROM android) AS sec
    `,
    { date },
  );
  return Math.round(Number(row?.sec ?? 0) / 60);
}

/** Total active media time (non-Tier-3 apps) for a local date: Mac window∩not-afk + Android window. */
export async function computeMediaMinutes(db: Db, date: string): Promise<number> {
  const bindings: Record<string, unknown> = { date };
  const macT3 = tier3NotInClause(bindings, "mac_t3_");
  const andT3 = tier3NotInClause(bindings, "and_t3_"); // identical list, distinct param names
  const row = await db.queryRow<{ sec: number | bigint }>(
    `
    WITH notafk AS (
      SELECT ts_start AS s, ts_start + INTERVAL '1 second' * duration_sec AS e
        FROM events
       WHERE ${NOT_AFK} AND ${LOCAL_DATE_SQL} BETWEEN ($date::DATE - 1) AND ($date::DATE + 1)
    ),
    win AS (
      SELECT ts_start AS s, ts_start + INTERVAL '1 second' * duration_sec AS e
        FROM events
       WHERE device='mac' AND watcher='currentwindow' AND ${LOCAL_DATE_SQL} = $date::DATE ${macT3}
    ),
    mac_media AS (
      SELECT COALESCE(SUM(date_diff('second', GREATEST(w.s,a.s), LEAST(w.e,a.e))),0) sec
        FROM win w JOIN notafk a ON w.s < a.e AND a.s < w.e
    ),
    android AS (
      SELECT COALESCE(SUM(duration_sec),0) sec FROM events
       WHERE device IN ('phone','tablet') AND watcher='currentwindow' AND ${LOCAL_DATE_SQL} = $date::DATE ${andT3}
    )
    SELECT (SELECT sec FROM mac_media) + (SELECT sec FROM android) AS sec
    `,
    bindings,
  );
  return Math.round(Number(row?.sec ?? 0) / 60);
}

export async function computeRolling4wk(db: Db, date: string): Promise<number | null> {
  const row = await db.queryRow<{ avg: number | null }>(
    `SELECT AVG(total_lowvalue_minutes) AS avg
       FROM daily_metrics
      WHERE date BETWEEN $start::DATE AND $end::DATE`,
    {
      start: shiftDate(date, -27),
      end: date,
    },
  );
  return row?.avg == null ? null : Number(row.avg);
}

const shiftDate = shiftDateUtil;

export async function upsertMetric(
  db: Db, date: string, tier1: number, tier2: number = 0,
  ytWatched: number = 0, ytListened: number = 0,
  totalYoutube: number = 0, totalMedia: number = 0, totalScreen: number = 0,
): Promise<void> {
  const total = tier1 + tier2;
  await db.run(
    `INSERT OR REPLACE INTO daily_metrics
     (date, tier1_minutes, tier2_lowvalue_minutes, total_lowvalue_minutes,
      yt_watched_minutes, yt_listened_minutes,
      total_youtube_minutes, total_media_minutes, total_screen_minutes,
      rolling_4wk_avg, computed_at)
     VALUES ($date::DATE, $tier1, $tier2, $total, $ytw, $ytl,
             $tyt, $tmed, $tscr, NULL, $now::TIMESTAMP)`,
    { date, tier1, tier2, total, ytw: ytWatched, ytl: ytListened,
      tyt: totalYoutube, tmed: totalMedia, tscr: totalScreen, now: new Date().toISOString() },
  );
  // Compute rolling avg in a second pass so it sees this row.
  const avg = await computeRolling4wk(db, date);
  if (avg == null) return;
  await db.run(
    `UPDATE daily_metrics SET rolling_4wk_avg = $avg WHERE date = $date::DATE`,
    { avg, date },
  );
}

async function main(argv: string[]): Promise<void> {
  const force = argv.includes("--force");
  const json = argv.includes("--json");
  const onlyDate = argv.find(a => a.startsWith("--date="))?.slice("--date=".length);

  const db = await Db.open();
  try {
    await db.initSchema();

    const days = onlyDate
      ? [onlyDate]
      : daysBetween(CONFIG.goalStartDate, todayLocal());

    const computed: DailyMetricRow[] = [];

    for (const date of days) {
      const existing = await db.queryRow<{ date: Date }>(
        `SELECT date FROM daily_metrics WHERE date = $date::DATE`,
        { date },
      );
      if (existing && !force) continue;

      const tier1 = await computeTier1Minutes(db, date);
      const tier2Events = await computeTier2LowValueMinutes(db, date);
      const tier2Chrome = await computeChromeLowValueMinutes(db, date);
      const tier2Heuristic = await computeTier2HeuristicMinutes(db, date);
      const youtube = await computeYouTubeConsumption(db, date);
      // Totals (all-value, tracking-only — do not feed the G37 goal):
      const youtubeTotal = await computeYouTubeConsumption(db, date, { includeAllVerdicts: true });
      const screenMin = await computeScreenMinutes(db, date);
      const mediaMin = await computeMediaMinutes(db, date);
      await upsertMetric(
        db, date, tier1, tier2Events + tier2Chrome + tier2Heuristic + youtube.minutes,
        youtube.watchedMinutes, youtube.listenedMinutes,
        youtubeTotal.minutes, mediaMin, screenMin,
      );

      const row = await db.queryRow<DailyMetricRow>(
        `SELECT date::VARCHAR AS date, tier1_minutes, tier2_lowvalue_minutes,
                total_lowvalue_minutes, rolling_4wk_avg, computed_at::VARCHAR AS computed_at
           FROM daily_metrics WHERE date = $date::DATE`,
        { date },
      );
      if (row) computed.push(row);
    }

    const latest = await db.queryRow<DailyMetricRow>(
      `SELECT date::VARCHAR AS date, tier1_minutes, tier2_lowvalue_minutes,
              total_lowvalue_minutes, rolling_4wk_avg, computed_at::VARCHAR AS computed_at
         FROM daily_metrics
         ORDER BY date DESC LIMIT 1`,
    );

    if (json) {
      console.log(JSON.stringify({ computed_count: computed.length, latest }, null, 2));
    } else {
      console.log(`Computed ${computed.length} day(s).`);
      if (latest) {
        const avg = latest.rolling_4wk_avg == null ? "n/a" : `${Number(latest.rolling_4wk_avg).toFixed(1)} min/day`;
        console.log(`Latest: ${latest.date}  tier1=${latest.tier1_minutes} min  total_lowvalue=${latest.total_lowvalue_minutes} min  4wk-avg=${avg}`);
      }
    }
  } finally {
    db.close();
  }
}

if (import.meta.main) main(process.argv.slice(2)).catch(err => {
  console.error(err);
  process.exit(1);
});
