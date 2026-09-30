#!/usr/bin/env bun
/**
 * Dashboard.ts — local HTML dashboard for AppUsageTracker, served on 127.0.0.1:7745.
 *
 * Loopback-only by design (no auth) — relies on host firewall + 127.0.0.1 bind.
 * Polls DuckDB on every /api/dashboard hit; no caching layer (data is small,
 * queries are fast, and freshness is the whole point).
 *
 * Routes:
 *   GET /                          HTML page with charts (Chart.js vendored locally, S1.12)
 *   GET /vendor/chart.umd.min.js   Vendored Chart.js UMD bundle — no runtime CDN dependency
 *   GET /api/dashboard             JSON payload powering the charts
 *   GET /health                    "ok" — used by smoke checks
 *
 * Run:
 *   bun run Tools/Dashboard.ts             # blocks; serve until killed
 *   PORT=8888 bun run Tools/Dashboard.ts   # custom port
 *
 * In production, com.kaya.aw-dashboard (KeepAlive) keeps it alive across reboot.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Db } from "./Db.ts";
import { CONFIG } from "../Config.ts";
import { computeTier1MinutesByDevice } from "./MetricCalc.ts";
import { shiftDate, todayLocal } from "./Util.ts";

const HOST = "127.0.0.1";
const PORT = Number(process.env.PORT ?? 7745);

// Single source of truth for the low-value ceiling is LifeOS/config/wig_status.json
// — the same file WigSection.ts reads for the :31337 dashboard/STATUS.md. Read
// fresh per request (this file already polls DuckDB fresh every request; no
// caching layer, "freshness is the whole point" per the header doc) so a
// quarterly WIG rollover there doesn't require a matching hand-edit here. This
// dashboard previously hardcoded the retired Q2 G37/270 target and drifted 11
// days into Q3 before this fix (fable-audit batch2, 2026-07-17).
const WIG_STATUS_PATH = join(import.meta.dir, "..", "..", "LifeOS", "config", "wig_status.json");
const FALLBACK_CEILING_MIN = 120; // Q3 G42 low_value target; used only if wig_status.json is unreadable
function readCeilingMin(): number {
  try {
    const status = JSON.parse(readFileSync(WIG_STATUS_PATH, "utf8")) as {
      G42?: { targets?: { low_value?: { target_min_per_day?: number } } };
    };
    const target = status.G42?.targets?.low_value?.target_min_per_day;
    return typeof target === "number" ? target : FALLBACK_CEILING_MIN;
  } catch {
    return FALLBACK_CEILING_MIN;
  }
}

/**
 * Chart.js is vendored locally (not fetched from a CDN at page-load time).
 * S1.12: the dashboard rendered fully blank whenever cdn.jsdelivr.net was
 * unreachable (offline machine / flaky network) — the page's <script> tag
 * failed to load, `Chart` was undefined, and the resulting exception aborted
 * the whole refresh() before the (unrelated) tables got a chance to render.
 * Serving the file ourselves removes the runtime network dependency entirely.
 */
const VENDOR_CHART_JS_PATH = join(import.meta.dir, "vendor", "chart.umd.min.js");
let vendoredChartJsCache: string | null = null;
function loadVendoredChartJs(): string {
  if (vendoredChartJsCache === null) vendoredChartJsCache = readFileSync(VENDOR_CHART_JS_PATH, "utf8");
  return vendoredChartJsCache;
}

/**
 * System/idle processes that surface as a macOS foreground "app" while Jm is
 * NOT actually using the machine (lock screen / screensaver render as their
 * own window owner). These are provably not usage — keep this list SHORT and
 * only add entries that are the same class of OS chrome, never a real app.
 * Verified against live events.db (2026-07-02): `loginwindow` is the only
 * match seen in practice (it was ranking #1 at 3346.8 min/7d, an artifact of
 * the Mac sitting at the lock screen). `ScreenSaverEngine` is the other
 * macOS process in this exact class (screensaver renderer) — included
 * defensively even though it hasn't appeared in the data yet, since it would
 * have the identical false-usage effect if it ever does.
 */
const NON_USAGE_APPS = new Set(["loginwindow", "screensaverengine"]);

/**
 * True if `app` should be counted in the RANKED top-apps display. Excludes:
 *  - null/empty app names (e.g. aw-watcher-android-web-chrome events, which
 *    carry title+url but no app — unclassified noise, not a real app to rank)
 *  - known system/idle processes (see NON_USAGE_APPS)
 * Exact case-insensitive match only (not substring) — a short, deliberately
 * conservative list so a real app whose name happens to contain "login"
 * isn't swept up. Does NOT touch underlying data or any other aggregate
 * (daily_metrics-derived totals are computed independently of this table).
 */
function isRankableApp(app: string | null | undefined): boolean {
  if (app == null) return false;
  const trimmed = app.trim();
  if (trimmed === "") return false;
  return !NON_USAGE_APPS.has(trimmed.toLowerCase());
}

interface DashboardPayload {
  generated_at: string;
  today: {
    date: string;
    tier1_minutes: number;
    tier2_lowvalue_minutes: number;
    total_lowvalue_minutes: number;
    ceiling_min: number;
    delta_vs_ceiling: number; // negative = under ceiling (good); positive = over
    rolling_4wk_avg: number | null;
  };
  trend_60d: Array<{
    date: string;
    tier1_minutes: number;
    tier2_lowvalue_minutes: number;
    total_lowvalue_minutes: number;
    rolling_4wk_avg: number | null;
  }>;
  per_device_today: Array<{
    device: string;
    tier1_minutes: number;
    tier2_lowvalue_minutes: number;
  }>;
  top_apps_7d: Array<{
    device: string;
    app: string;
    minutes: number;
    events: number;
  }>;
  devices: Array<{
    name: string;
    last_sync: string | null;
    last_event: string | null;
    last_error: string | null;
    age_min: number | null;
  }>;
}

async function buildPayload(db: Db): Promise<DashboardPayload> {
  const today = todayLocal();
  const sixtyAgo = shiftDate(today, -59);
  const sevenAgo = shiftDate(today, -6);

  const todayRow = await db.queryRow<{
    date: string | null; tier1_minutes: number | bigint; tier2_lowvalue_minutes: number | bigint;
    total_lowvalue_minutes: number | bigint; rolling_4wk_avg: number | null;
  }>(
    `SELECT date::VARCHAR AS date, tier1_minutes, tier2_lowvalue_minutes,
            total_lowvalue_minutes, rolling_4wk_avg
       FROM daily_metrics WHERE date = $today::DATE`,
    { today },
  );

  const tier1 = Number(todayRow?.tier1_minutes ?? 0);
  const tier2 = Number(todayRow?.tier2_lowvalue_minutes ?? 0);
  const total = Number(todayRow?.total_lowvalue_minutes ?? 0);
  const ceilingMin = readCeilingMin();

  const trend = await db.queryAll<{
    date: string; tier1_minutes: number | bigint; tier2_lowvalue_minutes: number | bigint;
    total_lowvalue_minutes: number | bigint; rolling_4wk_avg: number | null;
  }>(
    `SELECT date::VARCHAR AS date, tier1_minutes, tier2_lowvalue_minutes,
            total_lowvalue_minutes, rolling_4wk_avg
       FROM daily_metrics
      WHERE date BETWEEN $start::DATE AND $end::DATE
      ORDER BY date`,
    { start: sixtyAgo, end: today },
  );

  // Per-device today: tier-1 from the shared helper (matches daily_metrics
  // semantics — includes tier1AppsByDevice + applies floors); tier-2 from
  // classifications. Without this shared helper the panel would show different
  // numbers than the headline metric.
  const t1ByDevice = await computeTier1MinutesByDevice(db, today);
  const t2RowsByDevice = await db.queryAll<{ device: string; t2_min: number | bigint }>(
    `SELECT e.device,
            ROUND(SUM(e.duration_sec) / 60.0) AS t2_min
       FROM events e
       JOIN classifications c ON c.event_id = e.id
      WHERE CAST(e.ts_start AT TIME ZONE 'UTC' AT TIME ZONE '${CONFIG.localTimezone}' AS DATE) = $today::DATE
        AND c.tier = 2 AND c.is_low_value = TRUE
      GROUP BY e.device`,
    { today },
  );
  const t2Map = new Map<string, number>(t2RowsByDevice.map(r => [r.device, Number(r.t2_min)]));
  const devicesSeen = new Set<string>([...t1ByDevice.keys(), ...t2Map.keys()]);
  const perDevice: Array<{ device: string; t1_min: number; t2_min: number }> = [];
  for (const d of devicesSeen) {
    perDevice.push({ device: d, t1_min: t1ByDevice.get(d) ?? 0, t2_min: t2Map.get(d) ?? 0 });
  }
  perDevice.sort((a, b) => (b.t1_min + b.t2_min) - (a.t1_min + a.t2_min));

  // Ranked display only — fetch every (device, app) group (small: 7 days of
  // data), then filter out non-usage rows (loginwindow/idle, null app names)
  // in JS before taking the top 10. Underlying `events` rows are untouched;
  // this only shapes what lands in the DashboardPayload's top_apps_7d list.
  const topAppsRaw = await db.queryAll<{ device: string; app: string | null; minutes: number | bigint; events: number | bigint }>(
    `SELECT device,
            app,
            ROUND(SUM(duration_sec) / 60.0, 1) AS minutes,
            COUNT(*) AS events
       FROM events
      WHERE ts_start >= $start::TIMESTAMP
      GROUP BY device, app
      ORDER BY minutes DESC`,
    { start: sevenAgo + "T00:00:00" },
  );
  const topApps = topAppsRaw.filter(r => isRankableApp(r.app)).slice(0, 10);

  const devices = [];
  for (const dev of CONFIG.devices) {
    const row = await db.queryRow<{ last_sync: string | null; last_event: string | null }>(
      `SELECT MAX(last_sync_ok)::VARCHAR AS last_sync,
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
    const lastSync = row?.last_sync ? new Date(row.last_sync.replace(" ", "T") + "Z") : null;
    devices.push({
      name: dev.name,
      last_sync: lastSync ? lastSync.toISOString() : null,
      last_event: row?.last_event ? new Date(row.last_event.replace(" ", "T") + "Z").toISOString() : null,
      last_error: errRow?.last_error ?? null,
      age_min: lastSync ? Math.round((Date.now() - lastSync.getTime()) / 60_000) : null,
    });
  }

  return {
    generated_at: new Date().toISOString(),
    today: {
      date: todayRow?.date ?? today,
      tier1_minutes: tier1,
      tier2_lowvalue_minutes: tier2,
      total_lowvalue_minutes: total,
      ceiling_min: ceilingMin,
      delta_vs_ceiling: total - ceilingMin,
      rolling_4wk_avg: todayRow?.rolling_4wk_avg == null ? null : Number(todayRow.rolling_4wk_avg),
    },
    trend_60d: trend.map(r => ({
      date: r.date,
      tier1_minutes: Number(r.tier1_minutes),
      tier2_lowvalue_minutes: Number(r.tier2_lowvalue_minutes),
      total_lowvalue_minutes: Number(r.total_lowvalue_minutes),
      rolling_4wk_avg: r.rolling_4wk_avg == null ? null : Number(r.rolling_4wk_avg),
    })),
    per_device_today: perDevice.map(r => ({
      device: r.device,
      tier1_minutes: Number(r.t1_min ?? 0),
      tier2_lowvalue_minutes: Number(r.t2_min ?? 0),
    })),
    top_apps_7d: topApps.map(r => ({
      device: r.device,
      app: r.app ?? "(null)",
      minutes: Number(r.minutes),
      events: Number(r.events),
    })),
    devices,
  };
}

const HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>AppUsageTracker — G42</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    :root { --bg:#0e1116; --panel:#161b22; --fg:#e6edf3; --muted:#8b949e; --good:#3fb950; --warn:#d29922; --bad:#f85149; --link:#58a6ff; }
    * { box-sizing: border-box; }
    body { margin:0; background:var(--bg); color:var(--fg); font:14px/1.45 -apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif; }
    header { padding:18px 24px; border-bottom:1px solid #30363d; display:flex; align-items:baseline; gap:16px; }
    header h1 { margin:0; font-size:18px; font-weight:600; }
    header .updated { color:var(--muted); font-size:12px; }
    main { display:grid; grid-template-columns: repeat(12, 1fr); gap:16px; padding:16px 24px; }
    .panel { background:var(--panel); border:1px solid #30363d; border-radius:8px; padding:14px 16px; min-width:0; }
    .panel h2 { margin:0 0 10px; font-size:13px; font-weight:600; color:var(--muted); text-transform:uppercase; letter-spacing:.06em; }
    .col-3 { grid-column: span 3; } .col-4 { grid-column: span 4; } .col-6 { grid-column: span 6; } .col-8 { grid-column: span 8; } .col-12 { grid-column: span 12; }
    .big { font-size:32px; font-weight:600; line-height:1; }
    .delta-good { color:var(--good); }
    .delta-bad  { color:var(--bad); }
    .delta-warn { color:var(--warn); }
    .sub { color:var(--muted); font-size:12px; margin-top:6px; }
    table { width:100%; border-collapse:collapse; font-variant-numeric: tabular-nums; }
    th, td { text-align:left; padding:6px 8px; border-bottom:1px solid #21262d; }
    th { color:var(--muted); font-weight:500; font-size:12px; }
    td.num { text-align:right; }
    .glyph { display:inline-block; width:1.2em; }
    .glyph-ok { color:var(--good); } .glyph-warn { color:var(--warn); } .glyph-bad { color:var(--bad); }
    canvas { width:100% !important; height:240px !important; }
    .footer { padding:12px 24px; color:var(--muted); font-size:12px; }
    code { background:#21262d; padding:2px 5px; border-radius:3px; }
    .chart-warning { margin:12px 24px 0; padding:10px 16px; background:#3a2a00; border:1px solid #6b4d00; border-radius:6px; color:var(--warn); font-size:13px; }
  </style>
</head>
<body>
  <header>
    <h1>AppUsageTracker — G42 (<span id="ceiling-label">≤ … min/day low-value media</span>)</h1>
    <span class="updated" id="updated"></span>
  </header>
  <div class="chart-warning" id="chart-warning" hidden></div>
  <main>
    <section class="panel col-3">
      <h2>Today total low-value</h2>
      <div class="big" id="today-total">—</div>
      <div class="sub" id="today-delta">—</div>
    </section>
    <section class="panel col-3">
      <h2>Today Tier-1</h2>
      <div class="big" id="today-tier1">—</div>
      <div class="sub">whitelist + reddit/x/bsky URLs</div>
    </section>
    <section class="panel col-3">
      <h2>Today Tier-2 (LLM)</h2>
      <div class="big" id="today-tier2">—</div>
      <div class="sub">low-value classified sessions</div>
    </section>
    <section class="panel col-3">
      <h2>4-wk avg (per logged day)</h2>
      <div class="big" id="rolling-avg">—</div>
      <div class="sub" id="target-sub">target ≤ … min/day · excludes days with no events</div>
    </section>

    <section class="panel col-8">
      <h2>60-day trend (daily total + 4-wk avg-per-logged-day + ceiling)</h2>
      <canvas id="trendChart"></canvas>
    </section>
    <section class="panel col-4">
      <h2>Per-device today (substitution detector)</h2>
      <canvas id="deviceChart"></canvas>
    </section>

    <section class="panel col-6">
      <h2>Top 10 apps — last 7 days</h2>
      <table id="topApps">
        <thead><tr><th>device</th><th>app</th><th class="num">minutes</th><th class="num">events</th></tr></thead>
        <tbody></tbody>
      </table>
    </section>
    <section class="panel col-6">
      <h2>Device sync status</h2>
      <table id="devices">
        <thead><tr><th></th><th>device</th><th>last sync</th><th>last event</th><th>error</th></tr></thead>
        <tbody></tbody>
      </table>
    </section>
  </main>
  <div class="footer">
    Auto-refresh every 60s · DB <code>~/.claude/MEMORY/AppUsage/events.db</code> · loopback only · run <code>bash bin/sync-now.sh</code> to force sync.
  </div>

  <script src="/vendor/chart.umd.min.js"></script>
  <script>
    const fmt = n => Number(n).toFixed(0);
    const fmt1 = n => Number(n).toFixed(1);
    const ageHuman = m => m == null ? 'never' : m < 60 ? m + ' min ago' : m < 1440 ? Math.round(m/60) + ' hr ago' : Math.round(m/1440) + ' d ago';
    let trendChart, deviceChart;

    function deltaClass(delta) { return delta < 0 ? 'delta-good' : delta < 60 ? 'delta-warn' : 'delta-bad'; }

    // Charts are cosmetic — a chart failure (vendored script missing/corrupt,
    // canvas API issue, etc.) must never block the data tables below from
    // rendering. Each chart-construction call is isolated in its own
    // try/catch; failures surface as a visible banner, not a blank page.
    function showChartWarning(msg) {
      const el = document.getElementById('chart-warning');
      el.textContent = 'Chart rendering unavailable: ' + msg;
      el.hidden = false;
    }
    function clearChartWarning() {
      const el = document.getElementById('chart-warning');
      el.hidden = true;
      el.textContent = '';
    }

    function renderToday(t) {
      document.getElementById('today-total').textContent = fmt(t.total_lowvalue_minutes) + ' min';
      const sign = t.delta_vs_ceiling >= 0 ? '+' : '';
      const deltaEl = document.getElementById('today-delta');
      deltaEl.textContent = sign + fmt(t.delta_vs_ceiling) + ' min vs ceiling (' + t.ceiling_min + ')';
      deltaEl.className = 'sub ' + deltaClass(t.delta_vs_ceiling);
      document.getElementById('today-tier1').textContent = fmt(t.tier1_minutes) + ' min';
      document.getElementById('today-tier2').textContent = fmt(t.tier2_lowvalue_minutes) + ' min';
      document.getElementById('rolling-avg').textContent = t.rolling_4wk_avg == null ? '—' : fmt1(t.rolling_4wk_avg) + ' min';
      // Ceiling is read live from wig_status.json server-side (readCeilingMin) —
      // render it here rather than baking a goal number into the static HTML.
      document.getElementById('ceiling-label').textContent = '≤ ' + t.ceiling_min + ' min/day low-value media';
      document.getElementById('target-sub').textContent = 'target ≤ ' + t.ceiling_min + ' min/day · excludes days with no events';
    }

    function renderTrend(rows, ceilingMin) {
      try {
        const labels = rows.map(r => r.date);
        const totals = rows.map(r => r.total_lowvalue_minutes);
        const avg = rows.map(r => r.rolling_4wk_avg);
        const ceiling = labels.map(() => ceilingMin);
        if (trendChart) trendChart.destroy();
        trendChart = new Chart(document.getElementById('trendChart'), {
          type: 'line',
          data: { labels, datasets: [
            { label: 'daily total', data: totals, borderColor: '#58a6ff', backgroundColor: 'rgba(88,166,255,.15)', tension: .25, pointRadius: 0, fill: true },
            { label: '4-wk avg (per logged day)', data: avg, borderColor: '#3fb950', tension: .25, pointRadius: 0, borderWidth: 2 },
            { label: 'ceiling (' + ceilingMin + ')', data: ceiling, borderColor: '#d29922', borderDash: [4,4], pointRadius: 0, borderWidth: 1 },
          ]},
          options: {
            responsive: true, maintainAspectRatio: false,
            scales: { x: { ticks: { color: '#8b949e', maxTicksLimit: 12 }, grid: { color: '#21262d' } },
                      y: { ticks: { color: '#8b949e' }, grid: { color: '#21262d' }, beginAtZero: true } },
            plugins: { legend: { labels: { color: '#e6edf3' } } },
          },
        });
      } catch (e) {
        console.warn('[Dashboard] trend chart failed to render:', e);
        showChartWarning(e && e.message ? e.message : String(e));
      }
    }

    function renderDevices(rows) {
      try {
        const labels = rows.map(r => r.device);
        const t1 = rows.map(r => r.tier1_minutes);
        const t2 = rows.map(r => r.tier2_lowvalue_minutes);
        if (deviceChart) deviceChart.destroy();
        deviceChart = new Chart(document.getElementById('deviceChart'), {
          type: 'bar',
          data: { labels, datasets: [
            { label: 'Tier-1', data: t1, backgroundColor: '#f85149' },
            { label: 'Tier-2 low-value', data: t2, backgroundColor: '#d29922' },
          ]},
          options: {
            responsive: true, maintainAspectRatio: false,
            scales: { x: { stacked: true, ticks: { color: '#8b949e' }, grid: { color: '#21262d' } },
                      y: { stacked: true, ticks: { color: '#8b949e' }, grid: { color: '#21262d' }, beginAtZero: true } },
            plugins: { legend: { labels: { color: '#e6edf3' } } },
          },
        });
      } catch (e) {
        console.warn('[Dashboard] device chart failed to render:', e);
        showChartWarning(e && e.message ? e.message : String(e));
      }
    }

    function renderTopApps(rows) {
      const tbody = document.querySelector('#topApps tbody');
      tbody.innerHTML = rows.map(r =>
        '<tr><td>' + r.device + '</td><td>' + r.app + '</td><td class="num">' + fmt1(r.minutes) + '</td><td class="num">' + r.events + '</td></tr>'
      ).join('') || '<tr><td colspan=4 style="color:#8b949e">no events in last 7d</td></tr>';
    }

    function renderDeviceStatus(rows) {
      const tbody = document.querySelector('#devices tbody');
      tbody.innerHTML = rows.map(r => {
        const glyph = r.last_error ? '<span class="glyph glyph-bad">✗</span>'
                    : r.age_min == null ? '<span class="glyph">—</span>'
                    : r.age_min <= 15 ? '<span class="glyph glyph-ok">✓</span>'
                    : r.age_min <= 60 ? '<span class="glyph">·</span>'
                    : '<span class="glyph glyph-warn">⚠</span>';
        const sync = ageHuman(r.age_min);
        const lastEvt = r.last_event ? new Date(r.last_event).toLocaleString() : '—';
        const err = r.last_error ? r.last_error.slice(0, 60) : '';
        return '<tr>' + glyph + '<td>' + r.name + '</td><td>' + sync + '</td><td>' + lastEvt + '</td><td style="color:#f85149">' + err + '</td></tr>';
      }).join('');
    }

    async function refresh() {
      try {
        const r = await fetch('/api/dashboard');
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const d = await r.json();
        document.getElementById('updated').textContent = 'updated ' + new Date(d.generated_at).toLocaleTimeString();
        // Reset each cycle so a chart that recovers (e.g. vendor route back up)
        // clears its own banner on the next successful render call below.
        clearChartWarning();
        renderToday(d.today);
        renderTrend(d.trend_60d, d.today.ceiling_min);
        renderDevices(d.per_device_today);
        renderTopApps(d.top_apps_7d);
        renderDeviceStatus(d.devices);
      } catch (e) {
        document.getElementById('updated').textContent = 'refresh failed: ' + e.message;
      }
    }
    refresh();
    setInterval(refresh, 60_000);
  </script>
</body>
</html>`;

/**
 * Handle one HTTP request. If `dbOverride` is provided (tests), use it without
 * opening or closing — the caller owns the lifecycle. Otherwise (production)
 * open-and-close a fresh Db per request, so the lock is only held briefly and
 * MetricCalc / Classifier cron jobs can interleave without conflict.
 */
async function handleRequest(req: Request, dbOverride?: Db): Promise<Response> {
  const url = new URL(req.url);
  if (url.pathname === "/health") return new Response("ok\n", { headers: { "content-type": "text/plain" } });
  if (url.pathname === "/") return new Response(HTML, { headers: { "content-type": "text/html; charset=utf-8" } });
  if (url.pathname === "/vendor/chart.umd.min.js") {
    return new Response(loadVendoredChartJs(), {
      headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "public, max-age=86400, immutable" },
    });
  }
  if (url.pathname === "/api/dashboard") {
    const db = dbOverride ?? await Db.open();
    try {
      if (!dbOverride) await db.initSchema();
      const payload = await buildPayload(db);
      return new Response(JSON.stringify(payload), {
        headers: { "content-type": "application/json", "cache-control": "no-store" },
      });
    } finally {
      if (!dbOverride) db.close();
    }
  }
  return new Response("not found", { status: 404 });
}

if (import.meta.main) {
  const server = Bun.serve({
    hostname: HOST,
    port: PORT,
    fetch: req => handleRequest(req).catch(err => {
      console.error("[Dashboard] handler error:", err);
      return new Response(`internal error: ${err instanceof Error ? err.message : String(err)}`, { status: 500 });
    }),
  });
  console.log(`AppUsageTracker dashboard → http://${HOST}:${server.port}`);
}

export { HTML, buildPayload, handleRequest, isRankableApp, readCeilingMin };
