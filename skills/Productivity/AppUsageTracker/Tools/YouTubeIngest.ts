#!/usr/bin/env bun
/**
 * YouTubeIngest.ts — parse Google Takeout watch-history.json into youtube_history.
 *
 * ====== ONE-TIME SETUP (manual; Jm must do this) ============================
 *
 * 1. Go to https://takeout.google.com/ → "Deselect all" → tick "YouTube and
 *    YouTube Music".
 * 2. Click "All YouTube data included" → uncheck everything EXCEPT "history".
 *    Pick JSON format. Hit OK.
 * 3. Pick "Add to Drive" as destination (free up to 50GB).
 * 4. Set frequency to "Export every 2 months for 1 year" (longest available).
 * 5. Click "Create export". Google will email when each export is ready.
 *
 * Once an export lands in Drive:
 *
 *   rclone copy gdrive:Takeout ~/.claude/MEMORY/AppUsage/youtube-takeout-inbox/
 *   bun ~/.claude/skills/Productivity/AppUsageTracker/Tools/YouTubeIngest.ts
 *
 * Or wait for the launchd job com.kaya.youtube-history-ingest (02:45 daily).
 *
 * ====== WHAT THIS TOOL DOES =================================================
 *
 * - Looks under YOUTUBE_INBOX for *.zip and *.json files.
 * - For .zip: extracts to YOUTUBE_EXTRACTED/<basename>/ and locates
 *   `Takeout/YouTube and YouTube Music/history/watch-history.json`.
 * - For each video-open entry, inserts a youtube_history row (PK is
 *   (ts, video_id) so re-running is idempotent).
 *
 * NOTE: Takeout records the time the video was OPENED, not how long it was
 * watched. YouTubeSessionJoin.ts is responsible for estimating consumed
 * minutes by intersecting these opens with aw-watcher YouTube session times.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { Db, logFailure } from "./Db.ts";

const HOME = process.env.HOME ?? "/Users/[user]";
export const YOUTUBE_INBOX = `${HOME}/.claude/MEMORY/AppUsage/youtube-takeout-inbox`;
export const YOUTUBE_EXTRACTED = `${HOME}/.claude/MEMORY/AppUsage/youtube-takeout-extracted`;

interface TakeoutEntry {
  header?: string;
  title?: string;
  titleUrl?: string;
  subtitles?: Array<{ name?: string; url?: string }>;
  time?: string;
  products?: string[];
}

export interface YouTubeIngestOpts {
  db: Db;
  /** Direct path to a watch-history.json file. If omitted, scan the inbox. */
  historyPath?: string;
  /** Skip entries whose `time` is earlier than this. */
  sinceUnix?: Date;
}

export interface YouTubeIngestSummary {
  source_files: string[];
  entries_read: number;
  entries_skipped: number;
  rows_inserted: number;
  skipped?: string;
}

/**
 * Pull the v= param (or path segment for /shorts/ and youtu.be) from a
 * YouTube URL. Returns null for non-video URLs (homepage, channel, etc.).
 */
export function extractVideoId(url: string): string | null {
  if (!url || url.length === 0) return null;
  try {
    const u = new URL(url);
    if (u.hostname === "youtu.be") {
      const id = u.pathname.replace(/^\//, "").split("/")[0];
      return id.length > 0 ? id : null;
    }
    if (u.hostname.endsWith("youtube.com")) {
      if (u.pathname.startsWith("/watch")) {
        return u.searchParams.get("v");
      }
      if (u.pathname.startsWith("/shorts/")) {
        return u.pathname.replace("/shorts/", "").split("/")[0] || null;
      }
      if (u.pathname.startsWith("/embed/")) {
        return u.pathname.replace("/embed/", "").split("/")[0] || null;
      }
    }
  } catch { /* fall through */ }
  return null;
}

/** Strip the "Watched " prefix that Takeout adds. Falls back to raw title. */
function cleanTitle(raw: string | undefined): string | null {
  if (!raw) return null;
  if (raw.startsWith("Watched ")) return raw.slice("Watched ".length);
  return raw;
}

// ────────────────────────────────────────────────────────────────────────
// HTML watch-history parser — Takeout sometimes ships .html instead of .json
// depending on the format radio in the export wizard. Real-world entries
// look like:
//
//   <div class="content-cell mdl-cell--6-col mdl-typography--body-1">
//     Watched <a href="https://www.youtube.com/watch?v=ID">TITLE</a><br>
//     <a href="https://www.youtube.com/channel/CHID">CHANNEL</a><br>
//     May 14, 2026, 5:43:27 PM CDT<br>
//   </div>
//
// Note the verb is separated from the anchor by U+00A0 (nbsp), not space.
// "Viewed" entries point at /post/… (community posts) and are excluded.
// ────────────────────────────────────────────────────────────────────────

export interface ParsedHtmlEntry {
  ts: Date;
  videoId: string;
  title: string;
  channel: string | null;
  channelUrl: string | null;
}

const TZ_OFFSET_HOURS: Record<string, number> = {
  // Continental US
  PDT: -7, PST: -8,
  MDT: -6, MST: -7,
  CDT: -5, CST: -6,
  EDT: -4, EST: -5,
  // Outside CONUS that show up commonly in Takeout
  HDT: -9, HST: -10,
  AKDT: -8, AKST: -9,
  AST: -4, ADT: -3,
  // Reference
  UTC: 0, GMT: 0, Z: 0,
};

const MONTHS_3 = ["jan","feb","mar","apr","may","jun","jul","aug","sep","oct","nov","dec"];

/** Parse "May 14, 2026, 5:43:27 PM CDT" → Date. Returns null on unrecognized
 *  format or unknown tz. */
export function parseTakeoutHtmlTimestamp(raw: string): Date | null {
  const m = raw.trim().match(/^([A-Za-z]+)\s+(\d{1,2}),\s+(\d{4}),\s+(\d{1,2}):(\d{2}):(\d{2})(?:\s*(AM|PM))?\s+([A-Z]{1,5})$/i);
  if (!m) return null;
  const [, monRaw, dayStr, yearStr, hStr, minStr, secStr, ampm, tz] = m;
  const month = MONTHS_3.indexOf(monRaw.slice(0, 3).toLowerCase());
  if (month < 0) return null;
  let hour = parseInt(hStr, 10);
  if (ampm) {
    const a = ampm.toUpperCase();
    if (a === "PM" && hour < 12) hour += 12;
    else if (a === "AM" && hour === 12) hour = 0;
  }
  const offset = TZ_OFFSET_HOURS[tz.toUpperCase()];
  if (offset === undefined) return null;
  const localUtcMs = Date.UTC(
    parseInt(yearStr, 10), month, parseInt(dayStr, 10),
    hour, parseInt(minStr, 10), parseInt(secStr, 10),
  );
  return new Date(localUtcMs - offset * 3600 * 1000);
}

const HTML_ENTITY_MAP: Record<string, string> = {
  "&quot;": '"', "&apos;": "'", "&amp;": "&", "&lt;": "<", "&gt;": ">",
  "&#39;": "'", "&#34;": '"', "&nbsp;": " ",
};

function decodeHtmlEntities(s: string): string {
  return s.replace(/&(?:quot|apos|amp|lt|gt|nbsp|#39|#34);/g, m => HTML_ENTITY_MAP[m] ?? m);
}

// Match a single "Watched <nbsp> <a href=...watch?v=ID>TITLE</a><br> [<a href=channel>CHANNEL</a><br>]? TS <br>"
// block. The channel anchor is optional (older entries occasionally omit it).
// Using \s after <br> so the parser is tolerant of intra-entry whitespace.
const WATCH_ENTRY_RE = /Watched <a href="https:\/\/www\.youtube\.com\/watch\?v=([A-Za-z0-9_-]+)(?:&amp;[^"]*)?">((?:[^<]|<(?!\/a>))*?)<\/a><br>\s*(?:Watched at [^<]+<br>\s*)*(?:<a href="(https:\/\/www\.youtube\.com\/channel\/[^"]+)">([^<]*)<\/a><br>\s*)?([A-Za-z]+\s+\d{1,2},\s+\d{4},\s+\d{1,2}:\d{2}:\d{2}(?:\s*(?:AM|PM))?\s+[A-Z]{1,5})<br>/g;

/** Parse a Takeout watch-history.html document. Returns one row per actual
 *  video watch ("Watched" entries pointing at /watch?v=...). Community-post
 *  views are excluded; livestream entries are accepted (same `/watch?v=` URL
 *  pattern). Order matches the document; Takeout writes newest-first. */
export function parseWatchHistoryHtml(html: string): ParsedHtmlEntry[] {
  const out: ParsedHtmlEntry[] = [];
  WATCH_ENTRY_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = WATCH_ENTRY_RE.exec(html)) !== null) {
    const [, videoId, titleRaw, channelUrl, channelRaw, tsRaw] = m;
    const ts = parseTakeoutHtmlTimestamp(tsRaw);
    if (!ts) continue;
    out.push({
      ts,
      videoId,
      title: decodeHtmlEntities(titleRaw),
      channel: channelRaw ? decodeHtmlEntities(channelRaw) : null,
      channelUrl: channelUrl ?? null,
    });
  }
  return out;
}

async function insertHistoryRow(db: Db, params: {
  ts: string; videoId: string; title: string | null; channel: string | null;
  channelUrl: string | null; sourceExport: string;
}): Promise<void> {
  await db.run(
    `INSERT OR REPLACE INTO youtube_history
       (ts, video_id, title, channel, channel_url, source_export)
     VALUES ($ts::TIMESTAMP, $vid, $title, $channel, $channelUrl, $src)`,
    {
      ts: params.ts, vid: params.videoId, title: params.title,
      channel: params.channel, channelUrl: params.channelUrl, src: params.sourceExport,
    },
  );
}

async function processFile(
  db: Db,
  historyPath: string,
  summary: YouTubeIngestSummary,
  sinceUnix: Date | undefined,
): Promise<void> {
  const raw = readFileSync(historyPath, "utf8");
  const sourceExport = `takeout:${basename(historyPath)}`;

  // HTML branch — Takeout occasionally delivers watch-history.html instead
  // of .json. Detected by extension, with a content sniff as backup.
  if (historyPath.toLowerCase().endsWith(".html") || raw.trimStart().startsWith("<")) {
    summary.source_files.push(historyPath);
    const rows = parseWatchHistoryHtml(raw);
    for (const r of rows) {
      summary.entries_read++;
      if (sinceUnix && r.ts < sinceUnix) { summary.entries_skipped++; continue; }
      await insertHistoryRow(db, {
        ts: r.ts.toISOString(), videoId: r.videoId,
        title: r.title, channel: r.channel, channelUrl: r.channelUrl,
        sourceExport,
      });
      summary.rows_inserted++;
    }
    return;
  }

  let entries: TakeoutEntry[];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      throw new Error("watch-history.json is not a JSON array");
    }
    entries = parsed as TakeoutEntry[];
  } catch (err) {
    await logFailure("YouTubeIngest", err, { historyPath });
    return;
  }

  summary.source_files.push(historyPath);

  for (const entry of entries) {
    summary.entries_read++;

    // Filter to actual YouTube watches (excludes YouTube Music, search, etc.)
    // Pre-2023 exports lack `products`; post-2023 ones have it. Treat header
    // as authoritative (it's been stable since Takeout launched); fall back
    // to products only as a tiebreaker for ambiguous headers.
    const header = (entry.header ?? "").trim();
    const products = entry.products ?? [];
    const isYouTubeWatch =
      header === "YouTube" ||
      (header === "" && products.includes("YouTube"));
    if (!isYouTubeWatch) { summary.entries_skipped++; continue; }

    const url = entry.titleUrl;
    if (!url) { summary.entries_skipped++; continue; }
    const videoId = extractVideoId(url);
    if (!videoId) { summary.entries_skipped++; continue; }

    const time = entry.time;
    if (!time) { summary.entries_skipped++; continue; }
    const ts = new Date(time);
    if (Number.isNaN(ts.getTime())) { summary.entries_skipped++; continue; }
    if (sinceUnix && ts < sinceUnix) { summary.entries_skipped++; continue; }

    const sub0 = entry.subtitles?.[0];
    await insertHistoryRow(db, {
      ts: ts.toISOString(),
      videoId,
      title: cleanTitle(entry.title),
      channel: sub0?.name ?? null,
      channelUrl: sub0?.url ?? null,
      sourceExport,
    });
    summary.rows_inserted++;
  }
}

/**
 * Find watch-history.json files under YOUTUBE_INBOX (and within extracted
 * Takeout directories). Plain .json files are processed in place; .zip files
 * are unpacked into YOUTUBE_EXTRACTED/<basename>/ first. Returns the absolute
 * paths discovered.
 */
function discoverHistoryPaths(): string[] {
  if (!existsSync(YOUTUBE_INBOX)) return [];
  const out: string[] = [];
  for (const name of readdirSync(YOUTUBE_INBOX)) {
    const full = join(YOUTUBE_INBOX, name);
    let st;
    try { st = statSync(full); } catch { continue; }
    if (st.isDirectory()) {
      // Recurse through directories looking for watch-history.json.
      out.push(...findHistoryFilesUnder(full));
    } else if ((name.toLowerCase().endsWith(".json") || name.toLowerCase().endsWith(".html")) && name.includes("history")) {
      out.push(full);
    } else if (name.toLowerCase().endsWith(".zip")) {
      const extracted = ensureExtracted(full);
      out.push(...findHistoryFilesUnder(extracted));
    }
  }
  return out;
}

function findHistoryFilesUnder(dir: string): string[] {
  const out: string[] = [];
  let entries: string[];
  try { entries = readdirSync(dir); } catch { return out; }
  for (const name of entries) {
    const full = join(dir, name);
    let st;
    try { st = statSync(full); } catch { continue; }
    if (st.isDirectory()) {
      out.push(...findHistoryFilesUnder(full));
    } else if (name === "watch-history.json" || name === "watch-history.html") {
      out.push(full);
    }
  }
  return out;
}

function ensureExtracted(zipPath: string): string {
  const target = join(YOUTUBE_EXTRACTED, basename(zipPath, ".zip"));
  if (existsSync(target)) return target;
  mkdirSync(target, { recursive: true });
  // Shell out — Bun doesn't ship a zip decoder. `unzip` is on every macOS by
  // default; if it's missing, surface the error in failure-log.
  const proc = Bun.spawnSync({
    cmd: ["unzip", "-q", "-o", zipPath, "-d", target],
    stderr: "pipe",
  });
  if (proc.exitCode !== 0) {
    const stderr = proc.stderr.toString();
    throw new Error(`unzip failed for ${zipPath}: ${stderr.slice(0, 500)}`);
  }
  return target;
}

export async function ingestTakeoutHistory(opts: YouTubeIngestOpts): Promise<YouTubeIngestSummary> {
  const summary: YouTubeIngestSummary = {
    source_files: [], entries_read: 0, entries_skipped: 0, rows_inserted: 0,
  };
  await opts.db.initSchema();

  if (opts.historyPath) {
    if (!existsSync(opts.historyPath)) {
      return { ...summary, skipped: `path not found: ${opts.historyPath}` };
    }
    await processFile(opts.db, opts.historyPath, summary, opts.sinceUnix);
    return summary;
  }

  const paths = discoverHistoryPaths();
  if (paths.length === 0) {
    return { ...summary, skipped: `no watch-history.json under ${YOUTUBE_INBOX}` };
  }
  for (const p of paths) {
    try { await processFile(opts.db, p, summary, opts.sinceUnix); }
    catch (err) { await logFailure("YouTubeIngest", err, { path: p }); }
  }
  return summary;
}

async function main(argv: string[]): Promise<void> {
  const json = argv.includes("--json");
  const pathFlag = argv.find(a => a.startsWith("--path="))?.slice("--path=".length);
  const sinceFlag = argv.find(a => a.startsWith("--since="))?.slice("--since=".length);
  const sinceUnix = sinceFlag ? new Date(sinceFlag) : undefined;

  const db = await Db.open();
  try {
    await db.initSchema();
    const summary = await ingestTakeoutHistory({ db, historyPath: pathFlag, sinceUnix });
    if (json) {
      console.log(JSON.stringify(summary, null, 2));
    } else {
      const tag = summary.skipped ? "SKIP" : "OK";
      const detail = summary.skipped
        ? summary.skipped
        : `${summary.rows_inserted}/${summary.entries_read} rows from ${summary.source_files.length} file(s); ${summary.entries_skipped} skipped`;
      console.log(`[${tag}] YouTubeIngest: ${detail}`);
    }
  } finally {
    db.close();
  }
}

if (import.meta.main) main(process.argv.slice(2)).catch(err => {
  console.error(err);
  process.exit(1);
});
