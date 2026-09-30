#!/usr/bin/env bun
/**
 * ChromeTakeoutIngest.ts — read Takeout's Chrome/History.json (cross-device
 * Chrome history, including phone visits invisible to Mac SQLite) and insert
 * each entry into chrome_visits with source='takeout'.
 *
 * Schema mismatch vs Mac SQLite path (ChromeIngest.ts):
 *  - time_usec in History.json is microseconds since UNIX epoch (not Chrome
 *    epoch). Direct division to seconds, then TIMESTAMP.
 *  - duration is not in the export — we insert visit_duration_sec=0 and let
 *    MetricCalc's CHROME_VISIT_DURATION_FALLBACK_SEC handle minute estimation.
 *  - page_transition_qualifier is a string ("LINK","CLIENT_REDIRECT", etc.),
 *    not the Chrome SQLite transition bitfield. We store 0 here; transition
 *    isn't load-bearing downstream.
 *  - All entries carry the same client_id (account-level identifier), so we
 *    can't distinguish phone vs Mac at the row level. source='takeout' is a
 *    single bucket — the ChromeClassifier classifies (domain, source) pairs
 *    independently, so reddit.com on source='mac' and source='takeout' both
 *    end up classified.
 *
 * Scans takeout-inbox/ for .zip + .json files matching Chrome/History.json,
 * extracting zips on demand (same youtube-takeout-extracted/ scratch dir).
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { Db, logFailure } from "./Db.ts";

const HOME = process.env.HOME ?? "/Users/[user]";
export const TAKEOUT_INBOX = `${HOME}/.claude/MEMORY/AppUsage/youtube-takeout-inbox`;
export const TAKEOUT_EXTRACTED = `${HOME}/.claude/MEMORY/AppUsage/youtube-takeout-extracted`;

interface TakeoutHistoryEntry {
  url?: unknown;
  title?: unknown;
  time_usec?: unknown;
  client_id?: unknown;
}

interface TakeoutHistoryFile {
  "Browser History"?: TakeoutHistoryEntry[] | null;
}

export interface ParsedTakeoutVisit {
  url: string;
  domain: string;
  title: string | null;
  timeUsec: number;
  clientId: string | null;
}

export interface ChromeTakeoutSummary {
  source_files: string[];
  entries_read: number;
  entries_skipped: number;
  rows_inserted: number;
  skipped?: string;
  /**
   * Files that failed during this run (parse error / unreadable, or the
   * per-file ingest threw) — populated by ingestAll() so a partial failure
   * shows up in the aggregate summary instead of being silently absorbed as
   * a normal 0-row file. Always present (empty array = nothing failed) so
   * callers don't need an existence check.
   */
  failed_files: { path: string; error: string }[];
}

/** L1 batching: rows-per-transaction for bulk INSERT OR REPLACE. See
 *  Db.transaction()/runBatched() doc for why this exists (the ~129k
 *  single-row-autocommit SIGTRAP crash). */
const BATCH_SIZE = 1000;

function extractDomain(url: string): string | null {
  try {
    const u = new URL(url);
    if (!u.hostname) return null;
    let host = u.hostname.toLowerCase();
    if (host.startsWith("www.")) host = host.slice(4);
    return host;
  } catch {
    return null;
  }
}

/** Parse a Takeout Chrome History JSON object. Tolerates missing / null
 *  `Browser History` and silently skips malformed entries. */
export function parseChromeTakeoutHistory(parsed: unknown): ParsedTakeoutVisit[] {
  if (!parsed || typeof parsed !== "object") return [];
  const file = parsed as TakeoutHistoryFile;
  const raw = file["Browser History"];
  if (!Array.isArray(raw)) return [];

  const out: ParsedTakeoutVisit[] = [];
  for (const e of raw) {
    if (!e || typeof e !== "object") continue;
    const url = typeof e.url === "string" ? e.url : "";
    if (!url) continue;
    const timeUsec = typeof e.time_usec === "number" ? e.time_usec
      : typeof e.time_usec === "string" ? Number(e.time_usec) : 0;
    if (!Number.isFinite(timeUsec) || timeUsec <= 0) continue;
    const domain = extractDomain(url);
    if (!domain) continue;
    const title = typeof e.title === "string" && e.title.length > 0 ? e.title : null;
    const clientId = typeof e.client_id === "string" && e.client_id.length > 0 ? e.client_id : null;
    out.push({ url, domain, title, timeUsec, clientId });
  }
  return out;
}

const INSERT_VISIT_SQL = `INSERT OR REPLACE INTO chrome_visits
   (id, source, url, domain, title, visit_time, visit_duration_sec, transition, from_visit_id, originator_cache_guid)
 VALUES ($id, 'takeout', $url, $domain, $title,
         (to_timestamp($secs) AT TIME ZONE 'UTC')::TIMESTAMP,
         0, 0, 0, $cid)`;

export async function ingestChromeTakeoutFile(db: Db, path: string): Promise<ChromeTakeoutSummary> {
  const summary: ChromeTakeoutSummary = {
    source_files: [path], entries_read: 0, entries_skipped: 0, rows_inserted: 0, failed_files: [],
  };
  await db.initSchema();
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    await logFailure("ChromeTakeoutIngest", err, { path });
    summary.skipped = `parse error in ${path}`;
    return summary;
  }
  const rows = parseChromeTakeoutHistory(raw);
  summary.entries_read = rows.length;

  // L1 batching: one BEGIN/COMMIT per BATCH_SIZE rows instead of one
  // auto-commit per row — see Db.transaction()/runBatched() doc. Same
  // INSERT OR REPLACE SQL/params as before (idempotency unaffected); only
  // the commit granularity changes. If a batch throws, this whole function
  // throws (summary.rows_inserted is never set to a partial/inflated value)
  // and the caller (ingestAll) records + continues to the next file.
  const params = rows.map(r => ({
    // DuckDB TIMESTAMP from microseconds. to_timestamp returns TIMESTAMPTZ;
    // cast via "AT TIME ZONE 'UTC'" so the stored TIMESTAMP holds UTC clock
    // components (the rest of the system reads visit_time as UTC).
    id: `takeout:${r.timeUsec}`,
    url: r.url,
    domain: r.domain,
    title: r.title,
    secs: r.timeUsec / 1_000_000,
    cid: r.clientId ?? "",
  }));
  await db.runBatched(INSERT_VISIT_SQL, params, BATCH_SIZE);
  summary.rows_inserted = rows.length;
  return summary;
}

function ensureExtracted(zipPath: string): string {
  const target = join(TAKEOUT_EXTRACTED, basename(zipPath, ".zip"));
  if (existsSync(target)) return target;
  mkdirSync(target, { recursive: true });
  const proc = Bun.spawnSync({ cmd: ["unzip", "-q", "-o", zipPath, "-d", target], stderr: "pipe" });
  if (proc.exitCode !== 0) {
    throw new Error(`unzip failed for ${zipPath}: ${proc.stderr.toString().slice(0, 500)}`);
  }
  return target;
}

function findHistoryJsonUnder(dir: string): string[] {
  const out: string[] = [];
  let entries: string[];
  try { entries = readdirSync(dir); } catch { return out; }
  for (const name of entries) {
    const full = join(dir, name);
    let st;
    try { st = statSync(full); } catch { continue; }
    if (st.isDirectory()) {
      out.push(...findHistoryJsonUnder(full));
    } else if (name === "History.json") {
      out.push(full);
    }
  }
  return out;
}

function discoverHistoryPaths(): string[] {
  if (!existsSync(TAKEOUT_INBOX)) return [];
  const out: string[] = [];
  for (const name of readdirSync(TAKEOUT_INBOX)) {
    const full = join(TAKEOUT_INBOX, name);
    let st;
    try { st = statSync(full); } catch { continue; }
    if (st.isDirectory()) {
      out.push(...findHistoryJsonUnder(full));
    } else if (name.toLowerCase().endsWith(".zip")) {
      out.push(...findHistoryJsonUnder(ensureExtracted(full)));
    }
  }
  return out;
}

/**
 * Ingest every discovered Takeout History.json. `paths` and `ingestFileFn`
 * are injectable (default: real discovery / real per-file ingest) purely for
 * testability — see ChromeTakeoutIngest.test.ts.
 *
 * Per-file isolation (L1 item 4): a crash/throw on file N of M must NOT
 * silently skip files N+1..M. Each file's ingest is individually try/catch'd
 * — a throw is breadcrumbed (logFailure) and recorded in `failed_files`, and
 * the loop continues. A file that returns a `.skipped` result (parse error /
 * unreadable — already breadcrumbed inside ingestChromeTakeoutFile) is ALSO
 * recorded in `failed_files` rather than silently counted as a normal 0-row
 * file, so a partial failure always shows up in the aggregate summary
 * (main() below turns a non-empty `failed_files` into a non-zero exit code —
 * "fail visibly", not silently).
 */
export async function ingestAll(
  db: Db,
  paths: string[] = discoverHistoryPaths(),
  ingestFileFn: (db: Db, path: string) => Promise<ChromeTakeoutSummary> = ingestChromeTakeoutFile,
): Promise<ChromeTakeoutSummary> {
  const summary: ChromeTakeoutSummary = {
    source_files: [], entries_read: 0, entries_skipped: 0, rows_inserted: 0, failed_files: [],
  };
  await db.initSchema();
  if (paths.length === 0) {
    return { ...summary, skipped: `no Chrome/History.json under ${TAKEOUT_INBOX}` };
  }
  for (const p of paths) {
    try {
      const sub = await ingestFileFn(db, p);
      if (sub.skipped) {
        summary.failed_files.push({ path: p, error: sub.skipped });
        continue;
      }
      summary.source_files.push(...sub.source_files);
      summary.entries_read += sub.entries_read;
      summary.entries_skipped += sub.entries_skipped;
      summary.rows_inserted += sub.rows_inserted;
    } catch (err) {
      await logFailure("ChromeTakeoutIngest", err, { path: p });
      summary.failed_files.push({ path: p, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return summary;
}

async function main(): Promise<void> {
  const db = await Db.open();
  try {
    const summary = await ingestAll(db);
    if (summary.skipped) {
      console.log(`[SKIP] ChromeTakeoutIngest: ${summary.skipped}`);
    } else {
      console.log(`ChromeTakeoutIngest: ${summary.rows_inserted}/${summary.entries_read} visits from ${summary.source_files.length} file(s)`);
    }
    if (summary.failed_files.length > 0) {
      console.error(
        `[DEGRADED] ChromeTakeoutIngest: ${summary.failed_files.length} file(s) failed: ` +
          summary.failed_files.map(f => `${f.path} (${f.error})`).join("; "),
      );
      // Mark the run degraded without cutting the finally block short —
      // process.exitCode lets the event loop drain (db.close() below still
      // runs) and the process exits with this code once main() returns.
      process.exitCode = 1;
    }
  } finally {
    db.close();
  }
}

if (import.meta.main) {
  main().catch(err => {
    console.error(`[ChromeTakeoutIngest] ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
