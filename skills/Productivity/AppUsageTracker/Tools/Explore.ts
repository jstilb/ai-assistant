#!/usr/bin/env bun
/**
 * Explore.ts — READ-ONLY explorer for events.db. Lets you inspect the raw rows
 * and reproduce every number behind the G37 media-reduction metric by hand.
 *
 * Opens the DB in READ_ONLY mode, so it can NEVER write/corrupt and won't fight
 * the nightly pipeline for the write lock.
 *
 * Commands:
 *   tables                       list every table + row count
 *   schema <table>               column definitions for a table
 *   metrics [N]                  daily_metrics, last N days (default 35)
 *   day <YYYY-MM-DD>             reproduce that day's calc (tier1 by device/app,
 *                                tier2 events, chrome, youtube, stored row)
 *   rolling <YYYY-MM-DD>         the 28-day window + AVG behind rolling_4wk_avg
 *   devices                      per-device/bucket sync freshness (sync_state)
 *   coverage [YYYY-MM-DD]        classification coverage (title/url present?
 *                                classified?) — explains "unclassifiable"
 *   sql "<SELECT ...>"           run any read-only query
 *
 * Add --json to any command for machine-readable output.
 *
 * Examples:
 *   bun Tools/Explore.ts metrics 35
 *   bun Tools/Explore.ts day 2026-05-31
 *   bun Tools/Explore.ts rolling 2026-05-31
 *   bun Tools/Explore.ts devices
 *   bun Tools/Explore.ts sql "SELECT device, COUNT(*) n FROM events GROUP BY 1"
 */
import { DuckDBInstance } from "@duckdb/node-api";
import { CONFIG } from "../Config.ts";

const argv = process.argv.slice(2);
const JSON_OUT = argv.includes("--json");
const args = argv.filter(a => a !== "--json");
const cmd = args[0] ?? "help";

/** Coerce DuckDB scalar (BigInt, Date, null) to something printable. */
function fmt(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "bigint") return v.toString();
  if (v instanceof Date) return v.toISOString().replace("T", " ").slice(0, 19);
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

/** Print an array of row objects as an aligned table (or JSON with --json). */
function printRows(rows: Record<string, unknown>[]): void {
  if (JSON_OUT) { console.log(JSON.stringify(rows, null, 2)); return; }
  if (rows.length === 0) { console.log("(0 rows)"); return; }
  const cols = Object.keys(rows[0]!);
  const widths = cols.map(c => Math.max(c.length, ...rows.map(r => fmt(r[c]).length)));
  const line = (cells: string[]) => cells.map((s, i) => s.padStart(widths[i]! >= 0 ? 0 : 0).padEnd(widths[i]!)).join("  ");
  console.log(line(cols));
  console.log(widths.map(w => "-".repeat(w)).join("  "));
  for (const r of rows) console.log(line(cols.map(c => fmt(r[c]))));
  console.log(`\n(${rows.length} row${rows.length === 1 ? "" : "s"})`);
}

async function openRO() {
  // access_mode READ_ONLY = cannot write, cannot deadlock the writers.
  const instance = await DuckDBInstance.create(CONFIG.dbPath, { access_mode: "READ_ONLY" });
  const conn = await instance.connect();
  const all = async (sql: string, params?: Record<string, unknown>) => {
    const reader = params ? await conn.runAndReadAll(sql, params) : await conn.runAndReadAll(sql);
    return reader.getRowObjects() as Record<string, unknown>[];
  };
  const close = () => { conn.disconnectSync(); instance.closeSync(); };
  return { all, close };
}

function assertReadOnlySql(sql: string): void {
  const head = sql.trimStart().slice(0, 12).toUpperCase();
  const ok = ["SELECT", "WITH", "DESCRIBE", "SHOW", "EXPLAIN", "PRAGMA", "FROM"].some(k => head.startsWith(k));
  if (!ok) throw new Error(`Refusing non-read query (must start with SELECT/WITH/DESCRIBE/SHOW/EXPLAIN/PRAGMA): ${sql.slice(0, 40)}…`);
}

function usage(): void {
  console.log(`events.db explorer (READ-ONLY)  —  db: ${CONFIG.dbPath}

  tables                      list tables + row counts
  schema <table>              column definitions
  metrics [N]                 daily_metrics, last N days (default 35)
  day <YYYY-MM-DD>            reproduce that day's full calc
  rolling <YYYY-MM-DD>        28-day window + AVG behind rolling_4wk_avg
  devices                     per-device sync freshness
  coverage [YYYY-MM-DD]       classification coverage (why "unclassifiable")
  sql "<SELECT ...>"          arbitrary read-only query

  add --json for JSON output

G37 reference: target 270 min/day (4.5 hr) · baseline 390 min/day (6.5 hr) · goalStart ${CONFIG.goalStartDate} · tz ${CONFIG.localTimezone}`);
}

const LOCAL = `AT TIME ZONE 'UTC' AT TIME ZONE '${CONFIG.localTimezone}'`;

async function main(): Promise<void> {
  if (cmd === "help" || cmd === "-h" || cmd === "--help") { usage(); return; }
  const db = await openRO();
  try {
    switch (cmd) {
      case "tables": {
        const tabs = await db.all(`SELECT table_name FROM information_schema.tables WHERE table_schema='main' ORDER BY table_name`);
        const out: Record<string, unknown>[] = [];
        for (const t of tabs) {
          const name = String(t.table_name);
          const c = await db.all(`SELECT COUNT(*) n FROM "${name}"`);
          out.push({ table: name, rows: c[0]!.n });
        }
        printRows(out);
        break;
      }
      case "schema": {
        const t = args[1];
        if (!t) throw new Error("usage: schema <table>");
        printRows(await db.all(`DESCRIBE "${t}"`));
        break;
      }
      case "metrics": {
        const n = Number(args[1] ?? 35);
        printRows(await db.all(
          `SELECT date::VARCHAR date, total_lowvalue_minutes lowval,
                  yt_watched_minutes ytW, yt_listened_minutes ytL,
                  total_youtube_minutes yt_all, total_media_minutes media, total_screen_minutes screen,
                  ROUND(rolling_4wk_avg,1) roll4wk
             FROM daily_metrics ORDER BY date DESC LIMIT ${n}`));
        break;
      }
      case "day": {
        const d = args[1];
        if (!d) throw new Error("usage: day <YYYY-MM-DD>");
        console.log(`\n# Stored daily_metrics row for ${d}`);
        printRows(await db.all(
          `SELECT date::VARCHAR date, tier1_minutes tier1, tier2_lowvalue_minutes tier2,
                  total_lowvalue_minutes total, yt_watched_minutes ytW, yt_listened_minutes ytL,
                  ROUND(rolling_4wk_avg,1) roll4wk FROM daily_metrics WHERE date=$d::DATE`, { d }));

        console.log(`\n# All foreground minutes by device/app (raw input to Tier-1 matching) — ${d}`);
        printRows(await db.all(
          `SELECT device, lower(app) app, ROUND(SUM(duration_sec)/60.0,1) mins, COUNT(*) events
             FROM events WHERE CAST(ts_start ${LOCAL} AS DATE)=$d::DATE
            GROUP BY 1,2 ORDER BY mins DESC LIMIT 30`, { d }));

        console.log(`\n# Tier-2 LLM-classified low-value minutes (events∩classifications) — ${d}`);
        printRows(await db.all(
          `SELECT c.classifier, c.is_low_value, ROUND(SUM(e.duration_sec)/60.0,1) mins, COUNT(*) events
             FROM events e JOIN classifications c ON c.event_id=e.id
            WHERE CAST(e.ts_start ${LOCAL} AS DATE)=$d::DATE AND c.tier=2
            GROUP BY 1,2 ORDER BY mins DESC`, { d }));

        console.log(`\n# Chrome low-value visits (capped 30min/visit) — ${d}`);
        printRows(await db.all(
          `SELECT v.classifier, ROUND(SUM(LEAST(GREATEST(cv.visit_duration_sec,60),1800))/60.0,1) mins, COUNT(*) visits
             FROM chrome_visits cv JOIN chrome_domain_verdicts v ON v.domain=cv.domain AND v.source=cv.source
            WHERE v.is_low_value=TRUE AND CAST(cv.visit_time ${LOCAL} AS DATE)=$d::DATE
            GROUP BY 1 ORDER BY mins DESC`, { d }));
        break;
      }
      case "rolling": {
        const d = args[1];
        if (!d) throw new Error("usage: rolling <YYYY-MM-DD>");
        const win = await db.all(
          `SELECT date::VARCHAR date, total_lowvalue_minutes total
             FROM daily_metrics WHERE date BETWEEN ($d::DATE - 27) AND $d::DATE ORDER BY date`, { d });
        printRows(win);
        const agg = await db.all(
          `SELECT COUNT(*) days_with_rows, SUM(total_lowvalue_minutes) sum_min,
                  ROUND(AVG(total_lowvalue_minutes),1) avg_min_per_day,
                  ROUND(AVG(total_lowvalue_minutes)/60.0,2) avg_hr_per_day
             FROM daily_metrics WHERE date BETWEEN ($d::DATE - 27) AND $d::DATE`, { d });
        console.log(`\n# rolling_4wk_avg = AVG(total) over rows in [${d} - 27, ${d}]`);
        printRows(agg);
        const zeros = win.filter(r => Number(r.total) === 0).map(r => r.date);
        if (zeros.length && !JSON_OUT) console.log(`\n⚠ zero-total days in window (${zeros.length}): ${zeros.join(", ")}`);
        break;
      }
      case "devices": {
        console.log(`\n# sync_state (poller bookkeeping)`);
        printRows(await db.all(
          `SELECT device, bucket, last_event_ts::VARCHAR last_event_ts,
                  last_sync_ok::VARCHAR last_sync_ok, last_error
             FROM sync_state ORDER BY device, bucket`));
        console.log(`\n# newest actual event per device (from events table)`);
        printRows(await db.all(
          `SELECT device, MAX(ts_start)::VARCHAR newest_event, COUNT(*) total_events
             FROM events GROUP BY device ORDER BY device`));
        break;
      }
      case "coverage": {
        const d = args[1];
        const where = d ? `WHERE CAST(e.ts_start ${LOCAL} AS DATE)=$d::DATE` : ``;
        console.log(`\n# event metadata + classification coverage${d ? ` — ${d}` : " (all time)"}`);
        printRows(await db.all(
          `SELECT e.device,
                  COUNT(*) events,
                  SUM(CASE WHEN e.title IS NULL OR e.title='' THEN 1 ELSE 0 END) no_title,
                  SUM(CASE WHEN e.url IS NULL OR e.url='' THEN 1 ELSE 0 END) no_url,
                  SUM(CASE WHEN c.event_id IS NULL THEN 1 ELSE 0 END) unclassified
             FROM events e LEFT JOIN classifications c ON c.event_id=e.id
             ${where}
            GROUP BY e.device ORDER BY e.device`, d ? { d } : undefined));
        break;
      }
      case "sql": {
        const q = args.slice(1).join(" ");
        if (!q) throw new Error('usage: sql "<SELECT ...>"');
        assertReadOnlySql(q);
        printRows(await db.all(q));
        break;
      }
      default:
        console.log(`unknown command: ${cmd}\n`); usage();
    }
  } finally {
    db.close();
  }
}

main().catch(err => { console.error("ERROR:", (err as Error).message); process.exit(1); });
