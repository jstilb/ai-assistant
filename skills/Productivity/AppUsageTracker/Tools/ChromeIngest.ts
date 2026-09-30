#!/usr/bin/env bun
/**
 * ChromeIngest.ts — pull rows from Mac Chrome's local SQLite History file
 * into DuckDB's chrome_visits table.
 *
 * Why this exists:
 *   aw-watcher-window emits "Google Chrome" + window title events on Mac but
 *   no URL. aw-watcher-android-usage emits "Chrome" foreground time on phone
 *   with NEITHER URL nor title. To classify browsing time properly we need
 *   the per-URL data Chrome itself records.
 *
 * Source path:
 *   ~/Library/Application Support/Google/Chrome/Default/History (SQLite 3)
 *   Locked while Chrome is running — we snapshot-copy before reading.
 *
 * Caveat — phone data: as of 2026-05-12 against Jm's profile, every visit in
 * the local Mac Chrome SQLite has `originator_cache_guid = ''` (empty
 * string), meaning Chrome sync is NOT replicating phone visits down to the
 * Mac DB despite sync being enabled at the metadata level. Phone Chrome time
 * therefore still needs the heuristic floor in Config.tier1AppsByDevice
 * until a real source materialises (Google Takeout Chrome history, or
 * something that pushes per-URL data off the phone).
 *
 * Time-on-page rule:
 *   chrome_visits stores `visit_duration_sec` directly from `visits.visit_duration`
 *   (microseconds → seconds). For terminated-abnormally visits this is 0; the
 *   downstream MetricCalc.computeChromeLowValueMinutes is responsible for the
 *   inter-visit-delta fallback (with a 30-min cap), so this file stays a
 *   pure ETL of the raw Chrome data.
 */

import { Database } from "bun:sqlite";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Db, logFailure } from "./Db.ts";

const CHROME_EPOCH_OFFSET_MS = 11644473600_000n;

/**
 * Default location of Mac Chrome's local History SQLite. Overridable via
 * the `historyPath` opt for tests (and for any future support of secondary
 * profile directories).
 */
export const DEFAULT_CHROME_HISTORY_PATH =
  `${process.env.HOME}/Library/Application Support/Google/Chrome/Default/History`;

/**
 * Convert a Chrome-epoch microsecond value (microseconds since 1601-01-01 UTC)
 * to a UTC Date. Accepts number or bigint — Chrome timestamps in 2025+ exceed
 * Number.MAX_SAFE_INTEGER (~9e15), so we keep them as bigint internally and
 * only narrow to number at the millisecond level for `new Date()`.
 */
export function chromeEpochToUnix(chromeUs: number | bigint): Date {
  const asBig = typeof chromeUs === "bigint" ? chromeUs : BigInt(chromeUs);
  const unixMs = asBig / 1000n - CHROME_EPOCH_OFFSET_MS;
  return new Date(Number(unixMs));
}

/**
 * Lowercase the host portion of a URL. Strips a leading `www.` if it precedes
 * a domain with at least one further label (so `www.bbc.co.uk` → `bbc.co.uk`
 * but `www.com` stays unchanged). Returns null when the input is not a
 * parseable http/https URL.
 */
export function extractDomain(url: string): string | null {
  if (!url || url.length === 0) return null;
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    const host = u.hostname.toLowerCase();
    if (host.startsWith("www.")) {
      const rest = host.slice(4);
      if (rest.includes(".")) return rest;
    }
    return host;
  } catch {
    return null;
  }
}

interface ChromeRawVisit {
  visit_time: bigint;            // microseconds since 1601-01-01 UTC; bigint to preserve precision
  url: string;
  title: string | null;
  visit_duration: bigint;        // microseconds
  transition: number;
  from_visit: number | null;
  originator_cache_guid: string | null;
}

export interface IngestOpts {
  /** Target DuckDB. */
  db: Db;
  /** Path to a Chrome `History` SQLite file. Defaults to Jm's local Chrome. */
  historyPath?: string;
  /** Override the per-source cursor; without this we use chrome_sync_state. */
  sinceUnix?: Date;
  /** Source label, defaults to 'mac'. */
  source?: "mac";
}

export interface IngestSummary {
  source: string;
  visits_read: number;
  visits_inserted: number;
  skipped?: string;
  /** Chrome epoch (microseconds since 1601-01-01 UTC) — stringified for JSON safety. */
  cursor_before_chrome_us: string;
  cursor_after_chrome_us: string;
}

/**
 * Snapshot the History file to a tmp path (it's locked while Chrome runs)
 * and return the snapshot path. For tests / non-default paths that aren't
 * locked, we still snapshot — keeps a clean code path.
 */
function snapshotHistory(sourcePath: string): string {
  const dir = join(tmpdir(), "kaya-chrome-ingest");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const snap = join(dir, `history-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`);
  copyFileSync(sourcePath, snap);
  return snap;
}

async function readCursor(db: Db, source: string): Promise<bigint> {
  const row = await db.queryRow<{ last_visit_time_chrome_us: number | bigint | null }>(
    `SELECT last_visit_time_chrome_us FROM chrome_sync_state WHERE source = $source`,
    { source },
  );
  if (row?.last_visit_time_chrome_us == null) return 0n;
  return typeof row.last_visit_time_chrome_us === "bigint"
    ? row.last_visit_time_chrome_us
    : BigInt(row.last_visit_time_chrome_us);
}

async function writeCursor(db: Db, source: string, cursorUs: bigint): Promise<void> {
  // DuckDB driver accepts BigInt for BIGINT columns directly.
  await db.run(
    `INSERT OR REPLACE INTO chrome_sync_state (source, last_visit_time_chrome_us, last_sync_ok)
     VALUES ($source, $cursor, $now::TIMESTAMP)`,
    { source, cursor: cursorUs, now: new Date().toISOString() },
  );
}

function unixToChromeUs(date: Date): bigint {
  return (BigInt(date.getTime()) + CHROME_EPOCH_OFFSET_MS) * 1000n;
}

/**
 * Pull new Chrome visits past the per-source cursor (or `sinceUnix` override)
 * into DuckDB's `chrome_visits` table. Idempotent: re-running advances the
 * cursor by the highest visit_time seen, so a second call yields zero new rows.
 */
export async function ingestChromeVisits(opts: IngestOpts): Promise<IngestSummary> {
  const source = opts.source ?? "mac";
  const historyPath = opts.historyPath ?? DEFAULT_CHROME_HISTORY_PATH;

  const baseSummary: IngestSummary = {
    source,
    visits_read: 0,
    visits_inserted: 0,
    cursor_before_chrome_us: "0",
    cursor_after_chrome_us: "0",
  };

  if (!existsSync(historyPath)) {
    return {
      ...baseSummary,
      skipped: `History file not found at ${historyPath}`,
    };
  }

  await opts.db.initSchema();

  const cursorBefore = opts.sinceUnix != null
    ? unixToChromeUs(opts.sinceUnix)
    : await readCursor(opts.db, source);
  baseSummary.cursor_before_chrome_us = cursorBefore.toString();

  // Snapshot — Chrome's History file is locked while Chrome runs. For a fixture
  // file in a tmpdir this is also fine; the snapshot is a no-op-equivalent copy.
  const snapPath = snapshotHistory(historyPath);
  let chrome: Database | null = null;
  try {
    chrome = new Database(snapPath, { readonly: true });
    // Query visits since the cursor. Ascending order means newestUs grows
    // monotonically and we can stream the cursor advance.
    // safeIntegers(true) makes bun:sqlite return INTEGER columns as bigint,
    // which matters for visit_time (microseconds since 1601 — exceeds 2^53
    // in 2024+, so the default `number` decoding silently loses precision).
    const stmt = chrome.query<ChromeRawVisit, [bigint]>(`
      SELECT v.visit_time         AS visit_time,
             u.url                AS url,
             u.title              AS title,
             v.visit_duration     AS visit_duration,
             v.transition         AS transition,
             v.from_visit         AS from_visit,
             v.originator_cache_guid AS originator_cache_guid
        FROM visits v
        JOIN urls u ON v.url = u.id
       WHERE v.visit_time > ?
       ORDER BY v.visit_time ASC
    `);
    stmt.safeIntegers(true);
    const rows = stmt.all(cursorBefore);

    baseSummary.visits_read = rows.length;
    if (rows.length === 0) {
      await writeCursor(opts.db, source, cursorBefore);
      return { ...baseSummary, cursor_after_chrome_us: cursorBefore.toString() };
    }

    let newestUs = cursorBefore;
    for (const r of rows) {
      const id = `chrome:${r.visit_time.toString()}`;
      const visitDate = chromeEpochToUnix(r.visit_time);
      const durSec = Number(r.visit_duration) / 1_000_000;
      const guid = (r.originator_cache_guid ?? "").trim();
      const rowSource = guid.length > 0 ? "sync" : source; // 'sync' overrides caller-provided source
      const domain = extractDomain(r.url);

      await opts.db.run(
        `INSERT OR REPLACE INTO chrome_visits
           (id, source, url, domain, title, visit_time, visit_duration_sec,
            transition, from_visit_id, originator_cache_guid)
         VALUES ($id, $source, $url, $domain, $title, $ts::TIMESTAMP, $dur,
                 $trans, $fv, $guid)`,
        {
          id,
          source: rowSource,
          url: r.url,
          domain,
          title: r.title,
          ts: visitDate.toISOString(),
          dur: durSec,
          trans: Number(r.transition),
          fv: Number(r.from_visit ?? 0),
          guid: r.originator_cache_guid ?? "",
        },
      );
      baseSummary.visits_inserted++;
      if (r.visit_time > newestUs) newestUs = r.visit_time;
    }

    await writeCursor(opts.db, source, newestUs);
    return { ...baseSummary, cursor_after_chrome_us: newestUs.toString() };
  } catch (err) {
    await logFailure("ChromeIngest", err, { historyPath, source });
    throw err;
  } finally {
    try { chrome?.close(); } catch { /* best-effort */ }
    // Snapshot is left in tmpdir for OS cleanup (small, ~MB scale; same
    // behavior as the prior Mac install scripts that leave temp files).
  }
}

async function main(argv: string[]): Promise<void> {
  const json = argv.includes("--json");
  const pathFlag = argv.find(a => a.startsWith("--history="))?.slice("--history=".length);
  const sinceFlag = argv.find(a => a.startsWith("--since="))?.slice("--since=".length);
  const sinceUnix = sinceFlag ? new Date(sinceFlag) : undefined;

  const db = await Db.open();
  try {
    await db.initSchema();
    const summary = await ingestChromeVisits({ db, historyPath: pathFlag, sinceUnix });
    if (json) {
      console.log(JSON.stringify(summary, null, 2));
    } else {
      const tag = summary.skipped ? "SKIP" : "OK";
      const detail = summary.skipped
        ? summary.skipped
        : `${summary.visits_inserted}/${summary.visits_read} visits (cursor ${summary.cursor_before_chrome_us} → ${summary.cursor_after_chrome_us})`;
      console.log(`[${tag}] ChromeIngest ${summary.source}: ${detail}`);
    }
  } finally {
    db.close();
  }
}

if (import.meta.main) main(process.argv.slice(2)).catch(err => {
  console.error(err);
  process.exit(1);
});
