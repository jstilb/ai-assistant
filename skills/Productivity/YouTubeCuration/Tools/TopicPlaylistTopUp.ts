#!/usr/bin/env bun
/**
 * TopicPlaylistTopUp.ts — idempotent per-topic intent playlist top-up
 * (spec.md §7.1; ticket 06 pt 1/4).
 *
 * Playlist naming: `"Kaya: <topic>"` (precedent: `PlaylistClient
 * .SOMEDAY_PLAYLIST_TITLE` = "Kaya: Someday"). Reuses `PlaylistClient.ts`'s
 * generic surface UNCHANGED (that module's own header promises exactly
 * this): `findPlaylistByTitle`/`createPlaylist` to find-or-create,
 * `listPlaylistItemVideoIds` to read current contents,
 * `addAndVerifyPlaylistItem` (insert + verified-state-change re-read, with
 * its slice-6 retry — spec.md §10) to add.
 *
 * `listPlaylistItemVideoIds()` is called with `retryOn404: created` right
 * after find-or-create: `playlists.insert` and `playlistItems.list` don't
 * agree instantly (live, reproduced 2/2 2026-08-12/13) — listing a
 * brand-new playlist's items immediately after creating it can 404 for
 * several seconds even though the create already succeeded. Opting the
 * retry in only when THIS call just created the playlist keeps a 404 on an
 * already-existing (found) playlist a real, immediate failure.
 *

 * "Top up to ~10 UNWATCHED items" (spec.md §7.1) means the target is judged
 * against how many of the playlist's CURRENT items are still unwatched, not
 * its raw size — Jm watching from the queue is the whole point (ticket 06 pt
 * 1), so a playlist can accumulate watched items over time without ever
 * needing top-up if it already holds enough unwatched ones. `countUnwatched`
 * is injectable (defaults to `SeedSourcer.ts`'s `filterAlreadyWatched()`
 * against the live events.db) so this module's own tests never need a real
 * db fixture — that already-watched logic has its own dedicated tests in
 * SeedSourcer.test.ts.
 *
 * Playlist adds emit no rec signal (ticket 06 pt 1/3) — this is queue UX
 * only, never a judgment step itself. All relevance judgment already
 * happened upstream in `SeedSourcer.ts`'s LLM filter; this module only
 * decides HOW MANY of an already-ranked candidate list to add.
 */

import {
  addAndVerifyPlaylistItem,
  createPlaylist,
  findPlaylistByTitle,
  listPlaylistItemVideoIds,
  type PlaylistClientOptions,
} from "./PlaylistClient.ts";
import { filterAlreadyWatched } from "./SeedSourcer.ts";

export const TOPIC_PLAYLIST_PREFIX = "Kaya: ";

/** `"Kaya: <topic>"` — never `SOMEDAY_PLAYLIST_TITLE` itself, that's excluded by DroppedTopicCleanup.ts's own topic-parsing, not here (this function has no notion of "current topics" to exclude against). */
export function topicPlaylistTitle(topic: string): string {
  return `${TOPIC_PLAYLIST_PREFIX}${topic}`;
}

export interface TopUpTopicPlaylistInput {
  topic: string;
  /** Already unwatched + LLM-approved, in preference order (SeedSourcer.ts's `sourceTopicCandidates()` output). */
  candidateVideoIds: string[];
  /** spec.md §7.1: "top each up to ~10 unwatched items." */
  targetCount?: number;
}

export interface TopUpTopicPlaylistOptions extends PlaylistClientOptions {
  /** Returns the subset of the given video ids NOT already watched. Defaults to `filterAlreadyWatched()` against the live events.db (SeedSourcer.ts) — inject a stub in tests. */
  countUnwatched?: (videoIds: string[]) => Promise<string[]>;
}

export interface TopUpTopicPlaylistResult {
  topic: string;
  playlistId: string;
  playlistTitle: string;
  /** True only when this call actually created the playlist (didn't already exist). */
  created: boolean;
  /** Total items in the playlist before this call's adds (watched + unwatched). */
  existingCount: number;
  /** Of `existingCount`, how many are NOT already watched — this is what the target is measured against. */
  existingUnwatchedCount: number;
  /** Video ids confirmed added this call (verified-state-change counting — spec.md §10). */
  added: string[];
  /** Candidates already present in the playlist — skipped, never re-added. */
  skippedAlreadyPresent: string[];
  /** Per-item add failures (this run's per-item try/catch — one bad add doesn't abort the topic's whole top-up). */
  failed: { videoId: string; error: string }[];
}

/**
 * Find-or-create the topic's playlist, then add just enough of
 * `input.candidateVideoIds` (in the order given) to bring its unwatched
 * count up to `targetCount` (default 10). A candidate already present in
 * the playlist is skipped (never re-added); an add that fails (including a
 * verify-retry exhaustion — PlaylistClient.ts's slice-6 retry) is caught
 * per-item and recorded in `failed`, and the loop continues with the next
 * candidate rather than aborting the whole topic.
 */
export async function topUpTopicPlaylist(
  input: TopUpTopicPlaylistInput,
  options: TopUpTopicPlaylistOptions = {},
): Promise<TopUpTopicPlaylistResult> {
  const title = topicPlaylistTitle(input.topic);
  const targetCount = input.targetCount ?? 10;
  const countUnwatched = options.countUnwatched ?? ((ids: string[]) => filterAlreadyWatched(ids));

  const found = await findPlaylistByTitle(title, options);
  const playlist = found ?? (await createPlaylist(title, options));
  const created = !found;

  // `retryOn404` only on the just-created branch (PlaylistClient.ts's
  // eventual-consistency lag: `playlistItems.list` against a brand-new
  // playlist can 404 for several seconds after `playlists.insert` already
  // succeeded — live, reproduced 2/2 2026-08-12/13). An existing playlist's
  // 404 here is a real failure and must still throw immediately.
  const existingIds = await listPlaylistItemVideoIds(playlist.id, { ...options, retryOn404: created });
  const existingUnwatchedIds = await countUnwatched(existingIds);
  const existingSet = new Set(existingIds);

  let unwatchedCount = existingUnwatchedIds.length;
  const added: string[] = [];
  const skippedAlreadyPresent: string[] = [];
  const failed: { videoId: string; error: string }[] = [];

  for (const videoId of input.candidateVideoIds) {
    if (unwatchedCount >= targetCount) break;
    if (existingSet.has(videoId)) {
      skippedAlreadyPresent.push(videoId);
      continue;
    }
    try {
      await addAndVerifyPlaylistItem(playlist.id, videoId, options);
      added.push(videoId);
      existingSet.add(videoId);
      unwatchedCount += 1; // a freshly-added candidate is unwatched by construction (SeedSourcer already filtered it)
    } catch (err) {
      failed.push({ videoId, error: err instanceof Error ? err.message : String(err) });
    }
  }

  return {
    topic: input.topic,
    playlistId: playlist.id,
    playlistTitle: playlist.title,
    created,
    existingCount: existingIds.length,
    existingUnwatchedCount: existingUnwatchedIds.length,
    added,
    skippedAlreadyPresent,
    failed,
  };
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
  const candidatesRaw = flag(argv, "--candidates");
  if (!topic || !candidatesRaw) {
    console.error(
      'Usage: bun TopicPlaylistTopUp.ts --topic "<topic>" --candidates \'["vid1","vid2",...]\' [--target-count N]',
    );
    process.exit(1);
  }
  const candidateVideoIds = JSON.parse(candidatesRaw) as string[];
  const targetCountRaw = flag(argv, "--target-count");

  const result = await topUpTopicPlaylist({
    topic,
    candidateVideoIds,
    ...(targetCountRaw ? { targetCount: Number(targetCountRaw) } : {}),
  });
  console.log(JSON.stringify(result, null, 2));
}

if (import.meta.main) {
  main().catch((err: unknown) => {
    console.error("Fatal:", err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
