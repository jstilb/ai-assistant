#!/usr/bin/env bun
/**
 * PlaylistClient.ts — the skill's ONE YouTube Data API seam for playlist
 * work (spec.md §4, §7, §8).
 *
 * Named `PlaylistClient`, not `SomedayPlaylist` (the build prompt's working
 * name): everything below `ensureSomedayPlaylist()`/`SOMEDAY_PLAYLIST_TITLE`
 * is generic playlist/playlistItem CRUD with no Someday-specific logic at
 * all — create, delete, insert-item, list-items, verify-contains, find-by-
 * title. Slice 5 (`wl`, this build) is the first caller; slice 6 (per-topic
 * intent playlists, dropped-topic cleanup — spec.md §7) is designed to reuse
 * this SAME module unchanged, adding zero new HTTP plumbing of its own. A
 * file named after the one-off Someday use would invite slice 6 to fork a
 * near-duplicate client instead of importing this one — the name says what
 * the module actually is now, not just what built it first.
 *
 * Auth: every call needs a live access token. Default token source is
 * `getYouTubeAccessToken()` from YouTubeAuth.ts (this skill's existing
 * refresh-and-cache helper); `getAccessToken` is injectable so tests never
 * touch secrets.json or the network. `http` is injectable the same way
 * YouTubeAuth.ts's `HttpFetcher` is — a fresh, slightly broader type here
 * (adds DELETE) rather than widening YouTubeAuth's own type for a concern
 * that module doesn't have.
 *
 * Fail-loud discipline (spec.md §10, this skill's binding rule everywhere):
 * any non-2xx response throws immediately, with the HTTP status + Google's
 * own error message folded in. 401 and scope-shaped 403s point at
 * YouTubeOAuthBootstrap.ts (the re-consent CLI); quota-shaped 403s
 * (quotaExceeded/dailyLimitExceeded) say so explicitly rather than reading
 * as a generic auth failure. Nothing here ever retries or silently
 * swallows a failed call — the caller (SKILL.md's `wl` runbook) decides what
 * "per-item failure vs. batch abort" means for its own control flow.
 *
 * Verified-state-change discipline (spec.md §10): `insertPlaylistItem()`
 * reports what the API *said* it did; `verifyPlaylistContainsVideo()` is a
 * SEPARATE, fresh re-read of the playlist's actual contents. A caller that
 * only checks the insert response is doing exactly the "26/26 added" false-
 * success thing this spec explicitly rejects — the two calls are exposed
 * separately for callers that need them independently, PLUS
 * `addAndVerifyPlaylistItem()`, which composes them and THROWS (mirroring
 * `LedgerWriter.ts`'s write-then-confirm pattern) if the re-read doesn't
 * find the video. SKILL.md's `wl` someday path calls the composed version.
 */

import { getYouTubeAccessToken } from "./YouTubeAuth.ts";

const API_BASE = "https://www.googleapis.com/youtube/v3";
const DEFAULT_TIMEOUT_MS = 15_000;
const RECONSENT_POINTER =
  "run `bun skills/Productivity/YouTubeCuration/Tools/YouTubeOAuthBootstrap.ts` to (re-)grant playlist-write consent";

/**
 * `playlistItems.list` lags a just-completed insert by seconds (observed,
 * slice 6) — an immediate verify re-read can come back empty even though the
 * insert landed. `addAndVerifyPlaylistItem()` retries the re-read (never the
 * insert — that would risk a duplicate) up to this many times, with these
 * delays between attempts (~8s of total backoff): attempt 1 immediate,
 * attempt 2 after 3s, attempt 3 after another 5s.
 *
 * Same API, a SECOND lag: `playlistItems.list` against a playlist that
 * `playlists.insert` just created can 404 ("playlist cannot be found") for
 * several seconds even though the create already succeeded (live, reproduced
 * 2/2 2026-08-12/13 — see `TopicPlaylistTopUp.ts`'s find-or-create path,
 * which lists a brand-new playlist's items immediately after creating it).
 * `listPlaylistItemVideoIds()`'s `retryOn404` option reuses this exact same
 * retry shape for that case — see its doc comment below.
 */
const VERIFY_MAX_ATTEMPTS = 3;
const VERIFY_RETRY_DELAYS_MS = [3_000, 5_000] as const;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * The ONE Kaya-managed "Someday" playlist's title (spec.md §8; ticket 08 pt
 * 3) — an archive shelf for WL items that are still wanted but not realistic
 * in the next 2–3 weeks, distinct from `/youtube steer`'s per-topic intent
 * playlists. Deliberately namespaced ("Kaya:" prefix) so an exact-title
 * search can never collide with a playlist Jm made himself.
 */
export const SOMEDAY_PLAYLIST_TITLE = "Kaya: Someday";

// ----------------------------------------------------------------------------
// Errors
// ----------------------------------------------------------------------------

export class PlaylistApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "PlaylistApiError";
  }
}

export class PlaylistTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlaylistTimeoutError";
  }
}

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new PlaylistTimeoutError(`${label} timed out after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

// ----------------------------------------------------------------------------
// HTTP seam
// ----------------------------------------------------------------------------

export interface ApiRequest {
  url: string;
  method: "GET" | "POST" | "DELETE";
  headers: Record<string, string>;
  body?: string;
}

export interface ApiResponse {
  status: number;
  body: string;
}

export type ApiFetcher = (req: ApiRequest) => Promise<ApiResponse>;

const defaultFetcher: ApiFetcher = async (req) => {
  const res = await fetch(req.url, {
    method: req.method,
    headers: req.headers,
    body: req.method === "GET" ? undefined : req.body,
  });
  return { status: res.status, body: await res.text() };
};

export interface PlaylistClientOptions {
  http?: ApiFetcher;
  /** Defaults to `getYouTubeAccessToken()` (live secrets.json). Tests always inject a stub — never exercises the real network/refresh flow. */
  getAccessToken?: () => Promise<string>;
  timeoutMs?: number;
  /** Defaults to a real `setTimeout`-based wait. Tests inject a fast/no-op stub so the retry backoff in `addAndVerifyPlaylistItem()` doesn't burn real wall-clock time. */
  sleepFn?: (ms: number) => Promise<void>;
}

interface ResolvedClient {
  http: ApiFetcher;
  token: string;
  timeoutMs: number;
}

async function resolveClient(options: PlaylistClientOptions): Promise<ResolvedClient> {
  const http = options.http ?? defaultFetcher;
  const getAccessToken = options.getAccessToken ?? (() => getYouTubeAccessToken());
  const token = await getAccessToken();
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return { http, token, timeoutMs };
}

interface GoogleApiErrorBody {
  error?: { code?: number; message?: string; errors?: { reason?: string; message?: string }[] };
}

function parseGoogleError(body: string): { message: string; reason: string | null } {
  try {
    const parsed = JSON.parse(body) as GoogleApiErrorBody;
    const reason = parsed.error?.errors?.[0]?.reason ?? null;
    const message = parsed.error?.message ?? body.slice(0, 300);
    return { message, reason };
  } catch {
    return { message: body.slice(0, 300) || "(empty body)", reason: null };
  }
}

function throwForFailedResponse(action: string, res: ApiResponse): never {
  const { message, reason } = parseGoogleError(res.body);
  if (res.status === 401) {
    throw new PlaylistApiError(
      `PlaylistClient: ${action} failed — HTTP 401 unauthorized (${message}); ${RECONSENT_POINTER}`,
      401,
    );
  }
  if (res.status === 403 && (reason === "quotaExceeded" || reason === "dailyLimitExceeded")) {
    throw new PlaylistApiError(
      `PlaylistClient: ${action} failed — YouTube Data API quota exceeded (${reason}: ${message}); ` +
        `wait for the daily quota reset (Pacific midnight) or reduce this run's action count`,
      403,
    );
  }
  if (res.status === 403) {
    throw new PlaylistApiError(
      `PlaylistClient: ${action} failed — HTTP 403 forbidden (${reason ?? "unknown reason"}: ${message}); ${RECONSENT_POINTER}`,
      403,
    );
  }
  throw new PlaylistApiError(`PlaylistClient: ${action} failed — HTTP ${res.status}: ${message}`, res.status);
}

interface RawApiRequest {
  method: "GET" | "POST" | "DELETE";
  path: string;
  query?: Record<string, string>;
  body?: string;
}

async function apiRequest(
  client: ResolvedClient,
  action: string,
  req: RawApiRequest,
): Promise<ApiResponse> {
  const qs = req.query ? `?${new URLSearchParams(req.query).toString()}` : "";
  const res = await withTimeout(
    client.http({
      url: `${API_BASE}${req.path}${qs}`,
      method: req.method,
      headers: {
        authorization: `Bearer ${client.token}`,
        "content-type": "application/json",
      },
      body: req.body,
    }),
    client.timeoutMs,
    action,
  );
  if (res.status < 200 || res.status >= 300) throwForFailedResponse(action, res);
  return res;
}

function apiGet(client: ResolvedClient, action: string, path: string, query: Record<string, string>): Promise<ApiResponse> {
  return apiRequest(client, action, { method: "GET", path, query });
}

// ----------------------------------------------------------------------------
// Playlists
// ----------------------------------------------------------------------------

export interface PlaylistSummary {
  id: string;
  title: string;
}

interface PlaylistsListItem {
  id: string;
  snippet?: { title?: string; channelId?: string };
}
interface PlaylistsListResponse {
  items?: PlaylistsListItem[];
  nextPageToken?: string;
}

/**
 * Exact-title search over Jm's own playlists (`mine=true`), paginated
 * (50/page). Returns the first exact match, or `null` if none of Jm's
 * playlists carry that title. Never creates anything.
 */
export async function findPlaylistByTitle(title: string, options: PlaylistClientOptions = {}): Promise<PlaylistSummary | null> {
  const client = await resolveClient(options);
  let pageToken: string | undefined;
  do {
    const res = await apiGet(client, "list playlists (find by title)", "/playlists", {
      part: "snippet",
      mine: "true",
      maxResults: "50",
      ...(pageToken ? { pageToken } : {}),
    });
    const parsed = JSON.parse(res.body) as PlaylistsListResponse;
    const match = (parsed.items ?? []).find((it) => it.snippet?.title === title);
    if (match) return { id: match.id, title: match.snippet?.title ?? title };
    pageToken = parsed.nextPageToken;
  } while (pageToken);
  return null;
}

/** All of Jm's playlists, paginated to completion. Mainly useful for tests/diagnostics — most callers want `findPlaylistByTitle()` instead. */
export async function listMyPlaylists(options: PlaylistClientOptions = {}): Promise<PlaylistSummary[]> {
  const client = await resolveClient(options);
  const all: PlaylistSummary[] = [];
  let pageToken: string | undefined;
  do {
    const res = await apiGet(client, "list playlists", "/playlists", {
      part: "snippet",
      mine: "true",
      maxResults: "50",
      ...(pageToken ? { pageToken } : {}),
    });
    const parsed = JSON.parse(res.body) as PlaylistsListResponse;
    for (const it of parsed.items ?? []) all.push({ id: it.id, title: it.snippet?.title ?? "" });
    pageToken = parsed.nextPageToken;
  } while (pageToken);
  return all;
}

// Google rejects playlists.list with BOTH `id` and `mine` (HTTP 400
// "Incompatible parameters" — reproduced live 2026-08-14), so a by-id lookup
// can't be ownership-scoped in the request itself. It returns `channelId` so
// the caller can do the owner check that `mine=true` would have done.
async function getPlaylistById(
  id: string,
  client: ResolvedClient,
): Promise<(PlaylistSummary & { channelId: string | null }) | null> {
  const res = await apiGet(client, "get playlist by id", "/playlists", { part: "snippet", id });
  const parsed = JSON.parse(res.body) as PlaylistsListResponse;
  const item = parsed.items?.[0];
  if (!item) return null;
  return { id: item.id, title: item.snippet?.title ?? "", channelId: item.snippet?.channelId ?? null };
}

async function getMyChannelId(client: ResolvedClient): Promise<string | null> {
  const res = await apiGet(client, "get my channel id", "/channels", { part: "id", mine: "true" });
  const parsed = JSON.parse(res.body) as { items?: { id?: string }[] };
  return parsed.items?.[0]?.id ?? null;
}

/**
 * Create a playlist (generic — no Someday-specific behavior). `privacyStatus`
 * is always `private`: every playlist this skill creates (Someday, and
 * slice 6's per-topic playlists) is a Kaya-managed working artifact, not
 * something meant to be publicly listed on Jm's channel.
 */
export async function createPlaylist(
  title: string,
  options: PlaylistClientOptions & { description?: string } = {},
): Promise<PlaylistSummary> {
  const client = await resolveClient(options);
  const res = await apiRequest(client, `create playlist "${title}"`, {
    method: "POST",
    path: "/playlists",
    query: { part: "snippet,status" },
    body: JSON.stringify({
      snippet: { title, description: options.description ?? "" },
      status: { privacyStatus: "private" },
    }),
  });
  const parsed = JSON.parse(res.body) as { id?: string; snippet?: { title?: string } };
  if (!parsed.id) {
    throw new Error(`PlaylistClient: create playlist "${title}" returned no id — ${res.body.slice(0, 300)}`);
  }
  return { id: parsed.id, title: parsed.snippet?.title ?? title };
}

/** Delete a playlist outright (generic — spec.md §7's dropped-topic cleanup reuses this unchanged in slice 6). Google returns 204 with an empty body on success. */
export async function deletePlaylist(playlistId: string, options: PlaylistClientOptions = {}): Promise<void> {
  const client = await resolveClient(options);
  await apiRequest(client, `delete playlist ${playlistId}`, {
    method: "DELETE",
    path: "/playlists",
    query: { id: playlistId },
  });
}

export interface EnsurePlaylistResult {
  id: string;
  title: string;
  /** True only when this call actually created the playlist (it didn't already exist under this exact title). */
  created: boolean;
}

/**
 * Find-or-create the ONE Someday playlist. Resolution order (spec.md §8's
 * "ONE Kaya-managed Someday playlist" — never risk a duplicate):
 *
 *  1. If `cachedId` is given (the `RunStateReader.ts` `somedayPlaylist`
 *     pointer), re-validate it with a `playlists.list?id=` read plus a
 *     `channels.list?mine=true` owner check (2 units — `id` and `mine`
 *     can't be combined in one request, Google 400s that shape). A hit
 *     with a matching title AND owning channel short-circuits everything
 *     below; a same-titled playlist on another channel (the 2026-08-14
 *     wrong-channel incident class) never validates.
 *  2. Otherwise (no cache, or the cache is stale/renamed/deleted), fall back
 *     to `findPlaylistByTitle()` — a full paginated search. This is what
 *     makes losing the cache SAFE rather than merely inconvenient: the
 *     playlist is found again by its stable exact title, never re-created.
 *  3. Only create when neither path finds it.
 */
export async function ensureSomedayPlaylist(
  options: PlaylistClientOptions & { cachedId?: string | null } = {},
): Promise<EnsurePlaylistResult> {
  const title = SOMEDAY_PLAYLIST_TITLE;

  if (options.cachedId) {
    const client = await resolveClient(options);
    const cached = await getPlaylistById(options.cachedId, client);
    if (cached && cached.title === title) {
      const myChannelId = await getMyChannelId(client);
      if (myChannelId && cached.channelId === myChannelId) {
        return { id: cached.id, title, created: false };
      }
    }
  }

  const found = await findPlaylistByTitle(title, options);
  if (found) return { id: found.id, title, created: false };

  const created = await createPlaylist(title, options);
  return { id: created.id, title, created: true };
}

// ----------------------------------------------------------------------------
// Playlist items
// ----------------------------------------------------------------------------

export interface InsertItemResult {
  playlistItemId: string;
}

/** Add one video to a playlist. Reports what the API's insert response said — NOT itself a confirmation; pair with `verifyPlaylistContainsVideo()` before counting the add as done (spec.md §10). */
export async function insertPlaylistItem(
  playlistId: string,
  videoId: string,
  options: PlaylistClientOptions = {},
): Promise<InsertItemResult> {
  const client = await resolveClient(options);
  const res = await apiRequest(client, `add video ${videoId} to playlist ${playlistId}`, {
    method: "POST",
    path: "/playlistItems",
    query: { part: "snippet" },
    body: JSON.stringify({
      snippet: { playlistId, resourceId: { kind: "youtube#video", videoId } },
    }),
  });
  const parsed = JSON.parse(res.body) as { id?: string };
  if (!parsed.id) {
    throw new Error(
      `PlaylistClient: insert of video "${videoId}" into playlist "${playlistId}" returned no id — ${res.body.slice(0, 300)}`,
    );
  }
  return { playlistItemId: parsed.id };
}

interface PlaylistItemsListItem {
  id?: string;
  snippet?: { resourceId?: { videoId?: string } };
}
interface PlaylistItemsListResponse {
  items?: PlaylistItemsListItem[];
  nextPageToken?: string;
}

async function listPlaylistItemVideoIdsOnce(playlistId: string, client: ResolvedClient): Promise<string[]> {
  const ids: string[] = [];
  let pageToken: string | undefined;
  do {
    const res = await apiGet(client, "list playlist items", "/playlistItems", {
      part: "snippet",
      playlistId,
      maxResults: "50",
      ...(pageToken ? { pageToken } : {}),
    });
    const parsed = JSON.parse(res.body) as PlaylistItemsListResponse;
    for (const it of parsed.items ?? []) {
      const vid = it.snippet?.resourceId?.videoId;
      if (vid) ids.push(vid);
    }
    pageToken = parsed.nextPageToken;
  } while (pageToken);
  return ids;
}

/**
 * All video ids currently in a playlist, paginated to completion (50/page).
 * The read side of the verified-state-change pattern.
 *
 * `retryOn404`: opt-in bounded retry (same `VERIFY_MAX_ATTEMPTS`/
 * `VERIFY_RETRY_DELAYS_MS` shape as `addAndVerifyPlaylistItem()`'s verify-
 * read retry above — same underlying propagation window) for the OTHER
 * lag this API has: a `playlistItems.list` call against a playlist
 * `playlists.insert` just created can 404 even though the create already
 * succeeded. Default `false` — a 404 against a playlist that was NOT just
 * created is a real failure (deleted/renamed) and must throw immediately,
 * never get slow-retried into a confusing error. `TopicPlaylistTopUp.ts`'s
 * find-or-create path is the only caller that opts in, and only on its own
 * `created === true` branch.
 */
export async function listPlaylistItemVideoIds(
  playlistId: string,
  options: PlaylistClientOptions & { retryOn404?: boolean } = {},
): Promise<string[]> {
  const client = await resolveClient(options);
  if (!options.retryOn404) return listPlaylistItemVideoIdsOnce(playlistId, client);

  const sleep = options.sleepFn ?? defaultSleep;
  let lastErr: unknown;
  for (let attempt = 0; attempt < VERIFY_MAX_ATTEMPTS; attempt++) {
    try {
      return await listPlaylistItemVideoIdsOnce(playlistId, client);
    } catch (err) {
      if (!(err instanceof PlaylistApiError) || err.status !== 404) throw err;
      lastErr = err;
      const delay = VERIFY_RETRY_DELAYS_MS[attempt];
      if (delay !== undefined) await sleep(delay);
    }
  }
  throw lastErr;
}

/**
 * Verified-state-change check (spec.md §10): a FRESH re-read of the
 * playlist's actual contents, independent of whatever `insertPlaylistItem()`
 * reported. This is the only thing that may be treated as "the add
 * happened" — never a non-throwing insert response alone.
 */
export async function verifyPlaylistContainsVideo(
  playlistId: string,
  videoId: string,
  options: PlaylistClientOptions = {},
): Promise<boolean> {
  const ids = await listPlaylistItemVideoIds(playlistId, options);
  return ids.includes(videoId);
}

export interface AddAndVerifyResult {
  playlistItemId: string;
  videoId: string;
  playlistId: string;
}

/**
 * The ONE call SKILL.md's `wl` someday path (and slice 6's playlist top-up)
 * makes: insert, then a fresh re-read to CONFIRM the add landed, mirroring
 * `LedgerWriter.ts`'s write-then-confirm-before-resolving discipline for the
 * same reason (spec §10 — an add counts only on confirmed re-read). Throws
 * (never returns a "confirmed: false" value to silently branch on) when the
 * re-read doesn't find the video — an insert that reports success but isn't
 * actually there is exactly the "26/26 added" false-success shape this
 * exists to catch.
 *
 * Verify RETRIES (up to `VERIFY_MAX_ATTEMPTS`, ~8s total backoff — see the
 * constants above): `playlistItems.list` lags a just-completed insert by a
 * few seconds, so a single immediate re-read can fail spuriously even though
 * the insert genuinely landed. The retry loop is entirely inside the VERIFY
 * step — `insertPlaylistItem()` is called exactly once, never re-issued on a
 * verify miss, so a slow-to-propagate insert can never produce a duplicate.
 */
export async function addAndVerifyPlaylistItem(
  playlistId: string,
  videoId: string,
  options: PlaylistClientOptions = {},
): Promise<AddAndVerifyResult> {
  const inserted = await insertPlaylistItem(playlistId, videoId, options);
  const sleep = options.sleepFn ?? defaultSleep;

  let confirmed = false;
  for (let attempt = 0; attempt < VERIFY_MAX_ATTEMPTS; attempt++) {
    confirmed = await verifyPlaylistContainsVideo(playlistId, videoId, options);
    if (confirmed) break;
    const delay = VERIFY_RETRY_DELAYS_MS[attempt];
    if (delay !== undefined) await sleep(delay);
  }

  if (!confirmed) {
    throw new Error(
      `PlaylistClient: insert of video "${videoId}" into playlist "${playlistId}" reported id ` +
        `"${inserted.playlistItemId}" but ${VERIFY_MAX_ATTEMPTS} re-read attempt(s) (with backoff) did NOT ` +
        `find it in the playlist — refusing to report success (verified-state-change counting, spec.md §10). ` +
        `The insert is NOT retried on a verify miss (would risk a duplicate).`,
    );
  }
  return { playlistItemId: inserted.playlistItemId, videoId, playlistId };
}

export interface RemoveAndVerifyResult {
  playlistItemId: string;
  videoId: string;
  playlistId: string;
}

/**
 * The delete-side mirror of `addAndVerifyPlaylistItem()` (first caller: the
 * 2026-08 one-off re-judgment pass over the seeded intent playlists; generic
 * single-item remove surface from day one, same rationale as this module's
 * name). Three steps, each fail-loud:
 *
 * 1. Map videoId → playlistItemId via a paginated `playlistItems.list` —
 *    `playlistItems.delete` keys on the playlist ITEM id, not the video id.
 *    A video not present in the playlist throws (nothing to remove is a
 *    caller-state surprise, never a silent success).
 * 2. `playlistItems.delete` — issued exactly once, never re-issued on a
 *    verify miss (a slow-to-propagate delete re-issued would 404 and read
 *    as a spurious failure).
 * 3. A FRESH re-read confirming ABSENCE, with the same bounded verify
 *    retry/backoff as the add path (`playlistItems.list` lags deletes the
 *    same way it lags inserts). Still present after all attempts → throws;
 *    a removal counts only on confirmed absence (verified-state-change
 *    counting, spec.md §10).
 */
export async function removeAndVerifyPlaylistItem(
  playlistId: string,
  videoId: string,
  options: PlaylistClientOptions = {},
): Promise<RemoveAndVerifyResult> {
  const client = await resolveClient(options);

  let playlistItemId: string | undefined;
  let pageToken: string | undefined;
  do {
    const res = await apiGet(client, `map video ${videoId} to its playlist item in ${playlistId}`, "/playlistItems", {
      part: "snippet",
      playlistId,
      maxResults: "50",
      ...(pageToken ? { pageToken } : {}),
    });
    const parsed = JSON.parse(res.body) as PlaylistItemsListResponse;
    for (const it of parsed.items ?? []) {
      if (it.id && it.snippet?.resourceId?.videoId === videoId) {
        playlistItemId = it.id;
        break;
      }
    }
    pageToken = playlistItemId ? undefined : parsed.nextPageToken;
  } while (pageToken);

  if (!playlistItemId) {
    throw new Error(
      `PlaylistClient: video "${videoId}" is not in playlist "${playlistId}" — nothing to remove. ` +
        `Refusing to treat a missing item as a successful removal (the caller's model of the playlist is stale).`,
    );
  }

  await apiRequest(client, `remove video ${videoId} (item ${playlistItemId}) from playlist ${playlistId}`, {
    method: "DELETE",
    path: "/playlistItems",
    query: { id: playlistItemId },
  });

  const sleep = options.sleepFn ?? defaultSleep;
  let stillPresent = true;
  for (let attempt = 0; attempt < VERIFY_MAX_ATTEMPTS; attempt++) {
    stillPresent = await verifyPlaylistContainsVideo(playlistId, videoId, options);
    if (!stillPresent) break;
    const delay = VERIFY_RETRY_DELAYS_MS[attempt];
    if (delay !== undefined) await sleep(delay);
  }

  if (stillPresent) {
    throw new Error(
      `PlaylistClient: delete of playlist item "${playlistItemId}" (video "${videoId}") in playlist ` +
        `"${playlistId}" returned success but ${VERIFY_MAX_ATTEMPTS} re-read attempt(s) (with backoff) STILL ` +
        `find the video in the playlist — refusing to report success (verified-state-change counting, ` +
        `spec.md §10). The delete is NOT re-issued on a verify miss (a propagated delete would 404).`,
    );
  }
  return { playlistItemId, videoId, playlistId };
}

// ----------------------------------------------------------------------------
// CLI — for direct use from SKILL.md runbooks/demos, same pattern as this
// skill's other Tools/*.ts files. Real invocations (no --stub) hit the live
// YouTube Data API via getYouTubeAccessToken()'s default secrets path.
// ----------------------------------------------------------------------------

function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const cmd = argv[0];

  const usage =
    "Usage: bun PlaylistClient.ts ensure-someday [--cached-id <id>]\n" +
    "       bun PlaylistClient.ts create --title <t> [--description <d>]\n" +
    "       bun PlaylistClient.ts delete --playlist-id <id>\n" +
    "       bun PlaylistClient.ts add --playlist-id <id> --video-id <id>\n" +
    "       bun PlaylistClient.ts add-verified --playlist-id <id> --video-id <id>\n" +
    "       bun PlaylistClient.ts verify --playlist-id <id> --video-id <id>\n" +
    "       bun PlaylistClient.ts list --playlist-id <id>\n" +
    "       bun PlaylistClient.ts find --title <t>";

  if (!cmd) {
    console.error(usage);
    process.exit(1);
  }

  switch (cmd) {
    case "ensure-someday": {
      const cachedId = flag(argv, "--cached-id") ?? null;
      const result = await ensureSomedayPlaylist({ cachedId });
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    case "create": {
      const title = flag(argv, "--title");
      if (!title) { console.error(usage); process.exit(1); }
      const description = flag(argv, "--description");
      const result = await createPlaylist(title, description ? { description } : {});
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    case "delete": {
      const playlistId = flag(argv, "--playlist-id");
      if (!playlistId) { console.error(usage); process.exit(1); }
      await deletePlaylist(playlistId);
      console.log(JSON.stringify({ deleted: playlistId }, null, 2));
      return;
    }
    case "add": {
      const playlistId = flag(argv, "--playlist-id");
      const videoId = flag(argv, "--video-id");
      if (!playlistId || !videoId) { console.error(usage); process.exit(1); }
      const result = await insertPlaylistItem(playlistId, videoId);
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    case "add-verified": {
      const playlistId = flag(argv, "--playlist-id");
      const videoId = flag(argv, "--video-id");
      if (!playlistId || !videoId) { console.error(usage); process.exit(1); }
      const result = await addAndVerifyPlaylistItem(playlistId, videoId);
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    case "verify": {
      const playlistId = flag(argv, "--playlist-id");
      const videoId = flag(argv, "--video-id");
      if (!playlistId || !videoId) { console.error(usage); process.exit(1); }
      const contains = await verifyPlaylistContainsVideo(playlistId, videoId);
      console.log(JSON.stringify({ playlistId, videoId, contains }, null, 2));
      return;
    }
    case "list": {
      const playlistId = flag(argv, "--playlist-id");
      if (!playlistId) { console.error(usage); process.exit(1); }
      const ids = await listPlaylistItemVideoIds(playlistId);
      console.log(JSON.stringify({ playlistId, videoIds: ids }, null, 2));
      return;
    }
    case "find": {
      const title = flag(argv, "--title");
      if (!title) { console.error(usage); process.exit(1); }
      const result = await findPlaylistByTitle(title);
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    default:
      console.error(usage);
      process.exit(1);
  }
}

if (import.meta.main) {
  main().catch((err: unknown) => {
    console.error("Fatal:", err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
