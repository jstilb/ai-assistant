#!/usr/bin/env bun
/**
 * YouTubeEnrich.ts — hydrate youtube_history.video_id rows into youtube_videos
 * via the YouTube Data API v3.
 *
 * ====== ONE-TIME SETUP ======================================================
 *
 * 1. Create a Google Cloud project at https://console.cloud.google.com/.
 * 2. Enable the "YouTube Data API v3" library.
 * 3. APIs & Services → Credentials → Create credentials → API key.
 * 4. Restrict the key (recommended): API restriction = YouTube Data API v3
 *    only; Application restriction = HTTP referrers blank for CLI use.
 * 5. Add the key to ~/.claude/secrets.json under `YOUTUBE_API_KEY` (uppercase
 *    to match the rest of the file's env-var-style keys; `youtube_api_key`
 *    also works as a fallback):
 *      { "YOUTUBE_API_KEY": "AIza..." }
 *
 * Quota: 10000 units/day. videos.list with `id` query costs 1 unit per call
 * regardless of how many IDs are batched (we batch 50). At 10000 IDs/day
 * we'd use 200 units — comfortably within budget.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "path";
import { defaultKayaHome } from "../../../../lib/core/KayaHome.ts";
import { Db, logFailure } from "./Db.ts";

const SECRETS_PATH = join(defaultKayaHome(), "secrets.json");
const API_BASE = "https://www.googleapis.com/youtube/v3/videos";
const BATCH_SIZE = 50;
const DEFAULT_LIMIT = 1000;

export interface EnrichedVideo {
  video_id: string;
  title?: string | null;
  channel?: string | null;
  channel_id: string | null;
  duration_sec: number | null;
  category_id: number | null;
  tags: string[];
}

export type VideoFetcher = (videoIds: string[]) => Promise<EnrichedVideo[]>;

export interface YouTubeEnrichOpts {
  db: Db;
  fetcher?: VideoFetcher;
  limit?: number;
  force?: boolean;
}

export interface YouTubeEnrichSummary {
  candidate_videos: number;
  requested: number;
  enriched: number;
  not_found: number;
  errors: number;
}

/**
 * Parse an ISO 8601 duration (PnDTnHnMnS, with parts optional) into seconds.
 * Returns null for inputs that don't begin with `PT` followed by at least one
 * unit.
 */
export function parseIsoDuration(iso: string): number | null {
  const m = iso.match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/);
  if (!m) return null;
  const [, h, mn, s] = m;
  if (h == null && mn == null && s == null) return null; // bare "PT"
  return (parseInt(h ?? "0", 10) * 3600) + (parseInt(mn ?? "0", 10) * 60) + parseInt(s ?? "0", 10);
}

function loadApiKey(): string | null {
  if (!existsSync(SECRETS_PATH)) return null;
  try {
    const raw = readFileSync(SECRETS_PATH, "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    // Accept both casings — secrets.json convention is uppercase env-var
    // style; older docs may have suggested lowercase.
    const key = parsed.YOUTUBE_API_KEY ?? parsed.youtube_api_key;
    return typeof key === "string" && key.length > 0 ? key : null;
  } catch { return null; }
}

interface ApiVideo {
  id: string;
  snippet?: {
    title?: string;
    channelTitle?: string;
    channelId?: string;
    tags?: string[];
    categoryId?: string;
  };
  contentDetails?: {
    duration?: string;
  };
}

interface ApiResponse {
  items?: ApiVideo[];
  error?: { message?: string };
}

/**
 * Production fetcher — hits the live YouTube Data API. Honors the API key
 * from secrets.json. Throws if the key is missing (caller is responsible for
 * surfacing this to Jm).
 */
export const defaultVideoFetcher: VideoFetcher = async (ids) => {
  if (ids.length === 0) return [];
  const apiKey = loadApiKey();
  if (!apiKey) throw new Error(`youtube_api_key missing from ${SECRETS_PATH} — see YouTubeEnrich.ts header for setup`);
  const url = `${API_BASE}?part=contentDetails,snippet&id=${encodeURIComponent(ids.join(","))}&key=${encodeURIComponent(apiKey)}`;
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`HTTP ${res.status} on videos.list: ${body.slice(0, 200)}`);
  }
  const data = await res.json() as ApiResponse;
  if (data.error?.message) throw new Error(`YouTube API error: ${data.error.message}`);
  const items = data.items ?? [];
  return items.map<EnrichedVideo>(item => ({
    video_id: item.id,
    title: item.snippet?.title ?? null,
    channel: item.snippet?.channelTitle ?? null,
    channel_id: item.snippet?.channelId ?? null,
    duration_sec: item.contentDetails?.duration ? parseIsoDuration(item.contentDetails.duration) : null,
    category_id: item.snippet?.categoryId ? parseInt(item.snippet.categoryId, 10) : null,
    tags: item.snippet?.tags ?? [],
  }));
};

async function loadUnenrichedIds(db: Db, force: boolean, limit: number): Promise<string[]> {
  const sql = force
    ? `SELECT DISTINCT video_id FROM youtube_history ORDER BY video_id LIMIT $limit`
    : `SELECT DISTINCT h.video_id FROM youtube_history h
         WHERE NOT EXISTS (SELECT 1 FROM youtube_videos v WHERE v.video_id = h.video_id)
         ORDER BY h.video_id LIMIT $limit`;
  const rows = await db.queryAll<{ video_id: string }>(sql, { limit });
  return rows.map(r => r.video_id);
}

async function upsertVideo(db: Db, v: EnrichedVideo & { error?: string | null }): Promise<void> {
  await db.run(
    `INSERT OR REPLACE INTO youtube_videos
       (video_id, title, channel, channel_id, duration_sec, category_id, tags_json, enriched_at, enrich_error)
     VALUES ($id, $title, $channel, $channelId, $dur, $cat, $tags, $now::TIMESTAMP, $err)`,
    {
      id: v.video_id,
      title: v.title ?? null,
      channel: v.channel ?? null,
      channelId: v.channel_id ?? null,
      dur: v.duration_sec,
      cat: v.category_id,
      tags: JSON.stringify(v.tags ?? []),
      now: new Date().toISOString(),
      err: v.error ?? null,
    },
  );
}

export async function enrichYouTubeVideos(opts: YouTubeEnrichOpts): Promise<YouTubeEnrichSummary> {
  const fetcher = opts.fetcher ?? defaultVideoFetcher;
  const limit = opts.limit ?? DEFAULT_LIMIT;
  const force = opts.force ?? false;

  await opts.db.initSchema();
  const ids = await loadUnenrichedIds(opts.db, force, limit);

  const summary: YouTubeEnrichSummary = {
    candidate_videos: ids.length,
    requested: ids.length,
    enriched: 0,
    not_found: 0,
    errors: 0,
  };

  for (let i = 0; i < ids.length; i += BATCH_SIZE) {
    const batch = ids.slice(i, i + BATCH_SIZE);
    let returned: EnrichedVideo[] = [];
    try {
      returned = await fetcher(batch);
    } catch (err) {
      summary.errors++;
      await logFailure("YouTubeEnrich", err, { batch_size: batch.length });
      continue;
    }
    const found = new Set(returned.map(v => v.video_id));
    for (const v of returned) {
      await upsertVideo(opts.db, v);
      summary.enriched++;
    }
    // Record an enrich_error placeholder for IDs the API didn't return —
    // either deleted, private, or wrong key. Keeps us from re-fetching the
    // same dead IDs every run.
    for (const id of batch) {
      if (found.has(id)) continue;
      await upsertVideo(opts.db, {
        video_id: id, channel_id: null, duration_sec: null, category_id: null, tags: [],
        error: "not found in API response (deleted/private/wrong-key)",
      });
      summary.not_found++;
    }
  }

  return summary;
}

async function main(argv: string[]): Promise<void> {
  const json = argv.includes("--json");
  const force = argv.includes("--force");
  const limitFlag = argv.find(a => a.startsWith("--limit="))?.slice("--limit=".length);
  const limit = limitFlag ? parseInt(limitFlag, 10) : undefined;

  const db = await Db.open();
  try {
    await db.initSchema();
    const summary = await enrichYouTubeVideos({ db, force, limit });
    if (json) {
      console.log(JSON.stringify(summary, null, 2));
    } else {
      console.log(`YouTubeEnrich: requested=${summary.requested} enriched=${summary.enriched} not_found=${summary.not_found} errors=${summary.errors}`);
    }
  } finally {
    db.close();
  }
}

if (import.meta.main) main(process.argv.slice(2)).catch(err => {
  console.error(err);
  process.exit(1);
});
