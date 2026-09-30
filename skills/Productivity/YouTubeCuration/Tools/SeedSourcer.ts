#!/usr/bin/env bun
/**
 * SeedSourcer.ts — per-topic candidate sourcing for `/youtube steer`'s
 * seeding pass (spec.md §7.1; ticket 06 pt 2).
 *
 * Pipeline: read Rubric.md §Channel quality + §Seeding (the judgment
 * criteria — fail loud if missing, BEFORE any quota spend) -> one
 * `search.list` call per topic (100 units) -> filter out already-watched
 * videos via a read-only `events.db` `youtube_history` check ->
 * `videos.list` for canonical metadata + stats (1 unit) -> `channels.list`
 * dossiers for the unique channels (1 unit per <=50 ids) + recent-upload
 * titles per channel (`playlistItems.list`, 1 unit each, degrade-to-empty)
 * -> LLM judgment against the declared intent AND the rubric
 * (`inference({schema})`, mirroring IntentParser.ts's pattern). Output:
 * <=10 unwatched, LLM-approved candidates per topic, plus channel-quality
 * rejections (with the LLM's one-line reasons) for the run report. Code
 * never filters on any stat — every number is handed to the LLM as text.
 *
 * Auth note (build-time decision — spec.md §4 leaves "how it's wired" to the
 * build): `search.list`/`videos.list` are PUBLIC read endpoints, so this
 * reuses the existing `YOUTUBE_API_KEY` (YouTubeEnrich.ts's established
 * pattern for the same `videos.list` endpoint) rather than the OAuth token
 * PlaylistClient.ts uses. Only playlist CRUD (writes) need the OAuth scope —
 * §4: "the existing YOUTUBE_API_KEY stays as-is for YouTubeEnrich; playlist
 * writes cannot use an API key." Reading search/video metadata with the
 * narrower, already-provisioned API key (rather than routing every read
 * through the OAuth-scoped playlist-write credential) is the smaller
 * credential surface and needs no new consent.
 *
 * events.db discipline (spec.md §5, §13): the already-watched check opens
 * READ_ONLY, wrapped in a timeout, fails loud (throws) on lock contention,
 * always fully closes — reusing LedgerReader.ts's proven
 * `openReadOnly`/`withTimeout`/lock-contention helpers rather than a second
 * copy (LedgerReader.ts, LedgerWriter.ts, and ReconcileRun.ts already share
 * this exact seam).
 */

import { existsSync, readFileSync } from "node:fs";
import { inference, type InferenceOptions, type InferenceResult } from "../../../../lib/core/Inference.ts";
import {
  errMessage,
  isLockContention,
  isMissingDb,
  isMissingTable,
  LedgerLockError,
  openReadOnly,
  withTimeout,
} from "./LedgerReader.ts";
// cross-skill-allowed: youtube_history lives in AppUsageTracker's events.db by spec (§5) — CONFIG.dbPath is the single source of truth for that path (ADR-006, same seam as LedgerReader.ts/LedgerWriter.ts/ReconcileRun.ts)
import { CONFIG } from "../../AppUsageTracker/Config.ts";

const API_BASE = "https://www.googleapis.com/youtube/v3";
const DEFAULT_TIMEOUT_MS = 15_000;
const DB_TIMEOUT_MS = 5_000;
/** How many raw search.list results to pull before already-watched + LLM filtering — generous enough that filtering down to TARGET_CANDIDATE_COUNT unwatched, on-topic items rarely starves. */
const DEFAULT_MAX_SEARCH_RESULTS = 25;
/** spec.md §7: "top each topic playlist up to ~10 unwatched items." */
export const TARGET_CANDIDATE_COUNT = 10;

const HOME = process.env.HOME ?? "/Users/[user]";
const DEFAULT_SECRETS_PATH = `${HOME}/.claude/secrets.json`;

// ----------------------------------------------------------------------------
// API key (search.list/videos.list only — NOT the OAuth token, see header)
// ----------------------------------------------------------------------------

/** Mirrors YouTubeEnrich.ts's loadApiKey() — same secrets.json key, same dual-casing fallback. Not imported from there: that module doesn't export it, and this is 6 lines, not worth a cross-skill seam for. */
export function loadYouTubeApiKey(secretsPath: string = DEFAULT_SECRETS_PATH): string | null {
  if (!existsSync(secretsPath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(secretsPath, "utf8")) as Record<string, unknown>;
    const key = parsed.YOUTUBE_API_KEY ?? parsed.youtube_api_key;
    return typeof key === "string" && key.length > 0 ? key : null;
  } catch {
    return null;
  }
}

// ----------------------------------------------------------------------------
// HTTP seam
// ----------------------------------------------------------------------------

export interface ApiGetRequest {
  url: string;
}
export interface ApiGetResponse {
  status: number;
  body: string;
}
export type ApiGetFetcher = (req: ApiGetRequest) => Promise<ApiGetResponse>;

const defaultFetcher: ApiGetFetcher = async (req) => {
  const res = await fetch(req.url);
  return { status: res.status, body: await res.text() };
};

async function apiGet(
  http: ApiGetFetcher,
  timeoutMs: number,
  action: string,
  path: string,
  query: Record<string, string>,
): Promise<ApiGetResponse> {
  const url = `${API_BASE}${path}?${new URLSearchParams(query).toString()}`;
  const res = await withTimeout(http({ url }), timeoutMs, action);
  if (res.status < 200 || res.status >= 300) {
    let message = res.body.slice(0, 300);
    try {
      const parsed = JSON.parse(res.body) as { error?: { message?: string } };
      if (parsed.error?.message) message = parsed.error.message;
    } catch {
      // body wasn't JSON — fall back to the raw slice above
    }
    throw new Error(`SeedSourcer: ${action} failed — HTTP ${res.status}: ${message}`);
  }
  return res;
}

// ----------------------------------------------------------------------------
// search.list
// ----------------------------------------------------------------------------

interface SearchListItem {
  id?: { videoId?: string };
}
interface SearchListResponse {
  items?: SearchListItem[];
}

export interface SearchOptions {
  http?: ApiGetFetcher;
  apiKey?: string;
  timeoutMs?: number;
  maxResults?: number;
}

/** One `search.list` call (100 units) — returns candidate video ids only; `videos.list` (below) is the canonical metadata source. */
export async function searchTopicVideoIds(topic: string, options: SearchOptions = {}): Promise<string[]> {
  const http = options.http ?? defaultFetcher;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const apiKey = options.apiKey ?? loadYouTubeApiKey();
  if (!apiKey) {
    throw new Error(`SeedSourcer: YOUTUBE_API_KEY missing from ${DEFAULT_SECRETS_PATH} — see YouTubeEnrich.ts header for setup`);
  }
  const maxResults = options.maxResults ?? DEFAULT_MAX_SEARCH_RESULTS;

  const res = await apiGet(http, timeoutMs, `search.list "${topic}"`, "/search", {
    part: "snippet",
    type: "video",
    maxResults: String(maxResults),
    q: topic,
    key: apiKey,
  });
  const parsed = JSON.parse(res.body) as SearchListResponse;
  const ids: string[] = [];
  for (const item of parsed.items ?? []) {
    const id = item.id?.videoId;
    if (id) ids.push(id);
  }
  return ids;
}

// ----------------------------------------------------------------------------
// videos.list
// ----------------------------------------------------------------------------

export interface VideoMetadata {
  videoId: string;
  title: string | null;
  channel: string | null;
  channelId: string | null;
  description: string | null;
  publishedAt: string | null;
  viewCount: string | null;
  likeCount: string | null;
  /** ISO8601 duration (e.g. "PT12M4S") — Shorts-spam length patterns are a rubric signal. */
  duration: string | null;
}

interface VideosListItem {
  id: string;
  snippet?: { title?: string; channelTitle?: string; channelId?: string; description?: string; publishedAt?: string };
  statistics?: { viewCount?: string; likeCount?: string };
  contentDetails?: { duration?: string };
}
interface VideosListResponse {
  items?: VideosListItem[];
}

/** `videos.list` (1 unit per batched call, regardless of how many ids) — the canonical metadata source (search.list's own snippet can be stale/truncated and doesn't re-confirm the video still exists, mirroring YouTubeEnrich.ts's videos.list-as-source-of-truth choice). */
export async function getVideosMetadata(videoIds: string[], options: SearchOptions = {}): Promise<VideoMetadata[]> {
  if (videoIds.length === 0) return [];
  const http = options.http ?? defaultFetcher;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const apiKey = options.apiKey ?? loadYouTubeApiKey();
  if (!apiKey) {
    throw new Error(`SeedSourcer: YOUTUBE_API_KEY missing from ${DEFAULT_SECRETS_PATH} — see YouTubeEnrich.ts header for setup`);
  }

  const res = await apiGet(http, timeoutMs, "videos.list", "/videos", {
    part: "snippet,statistics,contentDetails",
    id: videoIds.join(","),
    key: apiKey,
  });
  const parsed = JSON.parse(res.body) as VideosListResponse;
  return (parsed.items ?? []).map((item) => ({
    videoId: item.id,
    title: item.snippet?.title ?? null,
    channel: item.snippet?.channelTitle ?? null,
    channelId: item.snippet?.channelId ?? null,
    description: item.snippet?.description ?? null,
    publishedAt: item.snippet?.publishedAt ?? null,
    viewCount: item.statistics?.viewCount ?? null,
    likeCount: item.statistics?.likeCount ?? null,
    duration: item.contentDetails?.duration ?? null,
  }));
}

// ----------------------------------------------------------------------------
// Channel dossiers — channels.list + recent-upload titles. Fetch-and-format
// only: no code anywhere filters on these numbers; the LLM weighs them
// against Rubric.md §Channel quality.
// ----------------------------------------------------------------------------

/** How many recent upload titles to pull per channel — enough to show cadence + title-pattern signal without bloating the prompt. */
const DEFAULT_RECENT_UPLOADS_COUNT = 10;
/** channels.list accepts up to 50 ids per 1-unit call (same batching model as YouTubeEnrich.ts's videos.list). */
const CHANNELS_BATCH_SIZE = 50;

export interface ChannelDossier {
  channelId: string;
  title: string | null;
  description: string | null;
  /** null when the channel hides subscriber count (or stats are missing). */
  subscriberCount: string | null;
  videoCount: string | null;
  /** Channel creation date — the age signal. */
  publishedAt: string | null;
  /** Up to DEFAULT_RECENT_UPLOADS_COUNT recent upload titles; [] when the uploads fetch fails or the playlist is empty (supplementary signal — degrade, never abort). */
  recentUploadTitles: string[];
}

interface ChannelsListItem {
  id: string;
  snippet?: { title?: string; description?: string; publishedAt?: string };
  statistics?: { subscriberCount?: string; videoCount?: string; hiddenSubscriberCount?: boolean };
  contentDetails?: { relatedPlaylists?: { uploads?: string } };
}
interface ChannelsListResponse {
  items?: ChannelsListItem[];
}
interface PlaylistItemsListResponse {
  items?: { snippet?: { title?: string } }[];
}

/**
 * One dossier per unique channel id. `channels.list` is core dossier data —
 * an HTTP failure throws loud (the existing apiGet posture). The per-channel
 * recent-uploads fetch is supplementary — a failure degrades that ONE
 * channel's `recentUploadTitles` to `[]` and never aborts the topic (the
 * skill's per-item-failure discipline, applied to API calls).
 */
export async function getChannelDossiers(channelIds: string[], options: SearchOptions = {}): Promise<ChannelDossier[]> {
  const uniqueIds = [...new Set(channelIds)];
  if (uniqueIds.length === 0) return [];
  const http = options.http ?? defaultFetcher;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const apiKey = options.apiKey ?? loadYouTubeApiKey();
  if (!apiKey) {
    throw new Error(`SeedSourcer: YOUTUBE_API_KEY missing from ${DEFAULT_SECRETS_PATH} — see YouTubeEnrich.ts header for setup`);
  }

  const items: ChannelsListItem[] = [];
  for (let i = 0; i < uniqueIds.length; i += CHANNELS_BATCH_SIZE) {
    const batch = uniqueIds.slice(i, i + CHANNELS_BATCH_SIZE);
    const res = await apiGet(http, timeoutMs, "channels.list", "/channels", {
      part: "snippet,statistics,contentDetails",
      id: batch.join(","),
      key: apiKey,
    });
    const parsed = JSON.parse(res.body) as ChannelsListResponse;
    items.push(...(parsed.items ?? []));
  }

  return Promise.all(
    items.map(async (item) => {
      const stats = item.statistics;
      const uploadsPlaylistId = item.contentDetails?.relatedPlaylists?.uploads;
      let recentUploadTitles: string[] = [];
      if (uploadsPlaylistId) {
        try {
          const res = await apiGet(http, timeoutMs, `playlistItems.list uploads(${item.id})`, "/playlistItems", {
            part: "snippet",
            playlistId: uploadsPlaylistId,
            maxResults: String(DEFAULT_RECENT_UPLOADS_COUNT),
            key: apiKey,
          });
          const parsed = JSON.parse(res.body) as PlaylistItemsListResponse;
          recentUploadTitles = (parsed.items ?? [])
            .map((it) => it.snippet?.title)
            .filter((t): t is string => typeof t === "string" && t.length > 0);
        } catch {
          recentUploadTitles = []; // supplementary signal — degrade this channel, never abort the topic
        }
      }
      return {
        channelId: item.id,
        title: item.snippet?.title ?? null,
        description: item.snippet?.description ?? null,
        subscriberCount: stats?.hiddenSubscriberCount ? null : (stats?.subscriberCount ?? null),
        videoCount: stats?.videoCount ?? null,
        publishedAt: item.snippet?.publishedAt ?? null,
        recentUploadTitles,
      };
    }),
  );
}

// ----------------------------------------------------------------------------
// Already-watched filter — read-only events.db check
// ----------------------------------------------------------------------------

export interface AlreadyWatchedCheckOptions {
  dbPath?: string;
  timeoutMs?: number;
}

/**
 * Returns the subset of `videoIds` that do NOT already appear in
 * `youtube_history` (Jm has never watched them, per the local Takeout
 * ingest). READ_ONLY, timed out, fails loud on lock contention, always
 * fully closes (LedgerReader.ts's proven pattern). A missing db/table
 * degrades to "nothing watched yet" (returns all ids unfiltered) rather
 * than throwing — a fresh events.db with no YouTube ingest yet is a valid
 * state, not an error.
 */
export async function filterAlreadyWatched(videoIds: string[], options: AlreadyWatchedCheckOptions = {}): Promise<string[]> {
  if (videoIds.length === 0) return [];
  const dbPath = options.dbPath ?? CONFIG.dbPath;
  const timeoutMs = options.timeoutMs ?? DB_TIMEOUT_MS;

  let opened: Awaited<ReturnType<typeof openReadOnly>>;
  try {
    opened = await openReadOnly(dbPath, timeoutMs);
  } catch (err) {
    if (isMissingDb(err)) return videoIds;
    if (isLockContention(err)) {
      throw new LedgerLockError(
        `events.db is locked by another writer (AppUsage pipeline?) — refusing to queue silently: ${errMessage(err)}`,
      );
    }
    throw err;
  }

  const { conn, instance } = opened;
  try {
    const placeholders = videoIds.map((_, i) => `$id${i}`).join(", ");
    const params: Record<string, unknown> = {};
    videoIds.forEach((id, i) => { params[`id${i}`] = id; });
    const rows = await withTimeout(
      conn.runAndReadAll(`SELECT DISTINCT video_id FROM youtube_history WHERE video_id IN (${placeholders})`, params),
      timeoutMs,
      "youtube_history watched-check",
    ).then((reader) => reader.getRowObjects() as { video_id: unknown }[]);
    const watched = new Set(rows.map((r) => String(r.video_id)));
    return videoIds.filter((id) => !watched.has(id));
  } catch (err) {
    if (isMissingTable(err)) return videoIds;
    if (isLockContention(err)) {
      throw new LedgerLockError(`events.db lock contention during watched-check: ${errMessage(err)}`);
    }
    throw err;
  } finally {
    conn.disconnectSync();
    instance.closeSync();
  }
}

// ----------------------------------------------------------------------------
// Rubric sections — the markdown IS the judgment criteria (Rubric.md's charter:
// "the ONE home for every judgment call"). Code only plumbs the text into the
// prompt; editing Rubric.md changes seeding behavior with zero code edits.
// ----------------------------------------------------------------------------

/** Rubric.md heading prefixes the seeding prompt embeds. Real headings carry descriptive suffixes (`## §Seeding — "does this…"`), so matching is by prefix. */
export const RUBRIC_CHANNEL_QUALITY_HEADING = "## §Channel quality";
export const RUBRIC_SEEDING_HEADING = "## §Seeding";

const DEFAULT_RUBRIC_PATH = `${import.meta.dir}/../Rubric.md`;

/**
 * Extract one level-2 section from rubric markdown by heading prefix:
 * captures the heading line through the line before the next `## ` heading
 * (or EOF); `###` subheadings stay inside the section. Deliberately dumb —
 * no markdown parser. A missing section throws: seeding judgment must never
 * silently run without its rubric.
 */
export function extractRubricSection(markdown: string, headingPrefix: string): string {
  const lines = markdown.split("\n");
  const start = lines.findIndex((line) => line.trim().startsWith(headingPrefix));
  if (start === -1) {
    throw new Error(
      `SeedSourcer: rubric section "${headingPrefix}" not found — the Rubric.md heading may have been renamed or removed; refusing to judge without it`,
    );
  }
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s/.test(lines[i] ?? "")) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join("\n").trim();
}

/** Read one section from the live Rubric.md. `rubricPath` is injectable for tests only — real runs always use the default. */
export function readRubricSection(headingPrefix: string, rubricPath: string = DEFAULT_RUBRIC_PATH): string {
  let markdown: string;
  try {
    markdown = readFileSync(rubricPath, "utf8");
  } catch (err) {
    throw new Error(`SeedSourcer: cannot read rubric at ${rubricPath} — ${errMessage(err)}`);
  }
  return extractRubricSection(markdown, headingPrefix);
}

// ----------------------------------------------------------------------------
// LLM filter — inference({schema}), IntentParser.ts's pattern
// ----------------------------------------------------------------------------

const SELECTION_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    selectedVideoIds: {
      type: "array",
      items: { type: "string" },
    },
    rejectedForQuality: {
      type: "array",
      items: {
        type: "object",
        properties: {
          videoId: { type: "string" },
          reason: { type: "string" },
        },
        required: ["videoId", "reason"],
        additionalProperties: false,
      },
    },
  },
  required: ["selectedVideoIds", "rejectedForQuality"],
  additionalProperties: false,
};

function seedSystemPrompt(topic: string, intentTopics: string[], rubricText: string): string {
  return `You are selecting YouTube videos to seed Jm's "Kaya: ${topic}" curation playlist.

Topic under consideration: "${topic}" — one of Jm's declared YouTube interests: ${intentTopics.join(", ")}.

Judge every candidate by the following rubric, verbatim from Rubric.md — it IS the criteria, not background reading:

${rubricText}

You will be given candidate videos grouped by channel — each channel's dossier (age, subscriber/upload counts, description, recent upload titles) followed by its candidate videos (id, title, publish date, duration, views, likes, description) — already filtered to videos Jm has never watched. Select up to ${TARGET_CANDIDATE_COUNT} that earn a place per the rubric, ordered by preference (best first). List every candidate you pass over specifically on channel-quality grounds in rejectedForQuality with a one-line reason (empty array if none) — that reasoning goes verbatim into the run report.

Respond with the structured output only, using EXACTLY the video ids given — never invent an id that wasn't in the candidate list.`;
}

function candidateListForPrompt(candidates: VideoMetadata[], dossiers: ChannelDossier[]): string {
  const dossierById = new Map(dossiers.map((d) => [d.channelId, d] as const));
  const groups = new Map<string, VideoMetadata[]>();
  for (const c of candidates) {
    const key = c.channelId ?? "(unknown-channel)";
    const group = groups.get(key);
    if (group) group.push(c);
    else groups.set(key, [c]);
  }

  const blocks: string[] = [];
  for (const [channelId, vids] of groups) {
    const dossier = dossierById.get(channelId);
    const channelName = dossier?.title ?? vids[0]?.channel ?? "(unknown)";
    const headerLines = dossier
      ? [
          `Channel: "${channelName}" — created ${dossier.publishedAt ?? "unknown"}, subscribers ${dossier.subscriberCount ?? "hidden/unknown"}, total uploads ${dossier.videoCount ?? "unknown"}`,
          `  channel description: "${(dossier.description ?? "").slice(0, 300)}"`,
          `  recent upload titles: ${dossier.recentUploadTitles.length > 0 ? dossier.recentUploadTitles.map((t) => `"${t}"`).join(", ") : "(unavailable)"}`,
        ]
      : [`Channel: "${channelName}" — no dossier available`];
    const videoLines = vids.map(
      (c) =>
        `  - id=${c.videoId} title="${c.title ?? "(untitled)"}" published=${c.publishedAt ?? "?"} duration=${c.duration ?? "?"} views=${c.viewCount ?? "?"} likes=${c.likeCount ?? "?"} description="${(c.description ?? "").slice(0, 200)}"`,
    );
    blocks.push([...headerLines, ...videoLines].join("\n"));
  }
  return blocks.join("\n\n");
}

// ----------------------------------------------------------------------------
// Composition
// ----------------------------------------------------------------------------

export interface SeedCandidate {
  videoId: string;
  title: string | null;
  channel: string | null;
}

/** A candidate the LLM passed over specifically on channel-quality grounds — informational only (run-report transparency), never consumed by any filter. */
export interface QualityRejection {
  videoId: string;
  title: string | null;
  channel: string | null;
  reason: string;
}

export interface SourceTopicCandidatesResult {
  topic: string;
  /** <=TARGET_CANDIDATE_COUNT unwatched, LLM-approved candidates, in the LLM's preference order. */
  candidates: SeedCandidate[];
  /** Channel-quality pass-overs with the LLM's one-line reasons, for the run report. */
  rejectedForQuality: QualityRejection[];
  searched: number;
  afterWatchedFilter: number;
}

export interface SourceTopicCandidatesOptions extends SearchOptions, AlreadyWatchedCheckOptions {
  inferenceFn?: (opts: InferenceOptions) => Promise<InferenceResult>;
  /** Test-only override for the live Rubric.md path (same idiom as --db-path). */
  rubricPath?: string;
}

/**
 * The full per-topic sourcing pipeline (spec.md §7.1 as amended, ticket 06
 * pt 2): rubric read (fail loud first) -> search.list -> already-watched
 * filter -> videos.list -> channel dossiers -> LLM judgment against the
 * rubric. `inferenceFn` is injectable (mirrors IntentParser.ts's
 * `inferenceFn` DI idiom) so tests never make a live LLM call.
 */
export async function sourceTopicCandidates(
  topic: string,
  intentTopics: string[],
  options: SourceTopicCandidatesOptions = {},
): Promise<SourceTopicCandidatesResult> {
  const inferenceFn = options.inferenceFn ?? inference;

  // Rubric first — fail loud BEFORE any quota spend if the criteria are missing.
  const rubricText = [
    readRubricSection(RUBRIC_CHANNEL_QUALITY_HEADING, options.rubricPath),
    readRubricSection(RUBRIC_SEEDING_HEADING, options.rubricPath),
  ].join("\n\n");

  const searchedIds = await searchTopicVideoIds(topic, options);
  if (searchedIds.length === 0) {
    return { topic, candidates: [], rejectedForQuality: [], searched: 0, afterWatchedFilter: 0 };
  }

  const unwatchedIds = await filterAlreadyWatched(searchedIds, options);
  if (unwatchedIds.length === 0) {
    return { topic, candidates: [], rejectedForQuality: [], searched: searchedIds.length, afterWatchedFilter: 0 };
  }

  const metadata = await getVideosMetadata(unwatchedIds, options);
  if (metadata.length === 0) {
    return { topic, candidates: [], rejectedForQuality: [], searched: searchedIds.length, afterWatchedFilter: unwatchedIds.length };
  }

  const dossiers = await getChannelDossiers(
    metadata.map((m) => m.channelId).filter((id): id is string => id !== null),
    options,
  );

  const result = await inferenceFn({
    systemPrompt: seedSystemPrompt(topic, intentTopics, rubricText),
    userPrompt: candidateListForPrompt(metadata, dossiers),
    level: "smart",
    schema: SELECTION_SCHEMA,
  });
  if (!result.success || result.parsed === undefined || result.parsed === null) {
    throw new Error(`SeedSourcer: inference failed for topic "${topic}" — ${result.error ?? "no structured output"}`);
  }
  const parsed = result.parsed as { selectedVideoIds?: unknown; rejectedForQuality?: unknown };
  if (!Array.isArray(parsed.selectedVideoIds)) {
    throw new Error(`SeedSourcer: structured response for topic "${topic}" missing a selectedVideoIds array`);
  }

  const byId = new Map(metadata.map((m) => [m.videoId, m] as const));
  const candidates: SeedCandidate[] = [];
  for (const id of parsed.selectedVideoIds) {
    if (typeof id !== "string") continue;
    const meta = byId.get(id);
    if (!meta) continue; // defensive: never trust a hallucinated id outside the candidate set
    if (candidates.some((c) => c.videoId === id)) continue; // defensive: dedupe
    candidates.push({ videoId: meta.videoId, title: meta.title, channel: meta.channel });
    if (candidates.length >= TARGET_CANDIDATE_COUNT) break;
  }

  // Informational only — never filters anything; enriched with title/channel for the run report.
  const rejectedForQuality: QualityRejection[] = [];
  if (Array.isArray(parsed.rejectedForQuality)) {
    for (const entry of parsed.rejectedForQuality) {
      if (typeof entry !== "object" || entry === null) continue;
      const { videoId, reason } = entry as { videoId?: unknown; reason?: unknown };
      if (typeof videoId !== "string" || typeof reason !== "string") continue;
      const meta = byId.get(videoId);
      if (!meta) continue; // defensive: same anti-hallucination discipline as selectedVideoIds
      if (rejectedForQuality.some((r) => r.videoId === videoId)) continue; // defensive: dedupe
      rejectedForQuality.push({ videoId, title: meta.title, channel: meta.channel, reason });
    }
  }

  return { topic, candidates, rejectedForQuality, searched: searchedIds.length, afterWatchedFilter: unwatchedIds.length };
}

// ----------------------------------------------------------------------------
// CLI
// ----------------------------------------------------------------------------

function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const topic = flag(argv, "--topic");
  const intentTopicsRaw = flag(argv, "--intent-topics");
  if (!topic) {
    console.error(
      'Usage: bun SeedSourcer.ts --topic "<topic>" [--intent-topics "<t1>,<t2>"] [--max-results N] [--db-path <path>]',
    );
    process.exit(1);
  }
  const intentTopics = intentTopicsRaw ? intentTopicsRaw.split(",").map((t) => t.trim()).filter(Boolean) : [topic];
  const maxResultsRaw = flag(argv, "--max-results");
  // Overrides CONFIG.dbPath (hardcoded to the LIVE events.db, doesn't honor
  // KAYA_HOME — same note as LedgerWriter.ts's --db-path). Real /youtube
  // steer runs omit this; tests/demos against a throwaway db need it.
  const dbPath = flag(argv, "--db-path");

  const result = await sourceTopicCandidates(topic, intentTopics, {
    ...(maxResultsRaw ? { maxResults: Number(maxResultsRaw) } : {}),
    ...(dbPath ? { dbPath } : {}),
  });
  console.log(JSON.stringify(result, null, 2));
}

if (import.meta.main) {
  main().catch((err: unknown) => {
    console.error("Fatal:", err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
