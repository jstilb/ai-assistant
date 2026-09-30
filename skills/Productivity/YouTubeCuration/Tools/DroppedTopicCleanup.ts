#!/usr/bin/env bun
/**
 * DroppedTopicCleanup.ts — dropped-topic intent-playlist cleanup, log-then-
 * delete (spec.md §7.4; ticket 06 pt 5).
 *
 * When a topic leaves `USER/YouTubeIntent.yaml`, its "Kaya: <topic>"
 * playlist (created by TopicPlaylistTopUp.ts) is no longer maintained and
 * gets deleted — but its remaining items must be recorded in the run report
 * FIRST (archive-before-delete in spirit; these are Kaya-created artifacts,
 * not Jm's data, so unlike prune/wl there is NO `youtube_deletions` ledger
 * row — spec.md §5, §7.4, ticket 06 line 25).
 *
 * STRUCTURAL log-then-delete: this module is split into an ENUMERATE step
 * (`enumerateDroppedTopicPlaylists()` — read-only, no delete call anywhere
 * in it) and a DELETE step (`deleteDroppedTopicPlaylist()` — takes an
 * already-enumerated record as its only input, has no enumeration logic of
 * its own). Neither function can skip the other's half of the contract by
 * construction; `cleanupDroppedTopicPlaylists()` composes them in that
 * fixed order (see DroppedTopicCleanup.test.ts's call-order assertion).
 *
 * The ONE Someday playlist (`PlaylistClient.SOMEDAY_PLAYLIST_TITLE`) is
 * explicitly excluded — it isn't a per-topic intent playlist and is never a
 * cleanup candidate regardless of what's declared in YouTubeIntent.yaml.
 */

import {
  deletePlaylist,
  listMyPlaylists,
  listPlaylistItemVideoIds,
  type PlaylistClientOptions,
  SOMEDAY_PLAYLIST_TITLE,
} from "./PlaylistClient.ts";
import { TOPIC_PLAYLIST_PREFIX } from "./TopicPlaylistTopUp.ts";

/** `"Kaya: <topic>"` -> `"<topic>"`, or `null` for a non-Kaya playlist or the excluded Someday shelf. */
export function topicFromPlaylistTitle(title: string): string | null {
  if (!title.startsWith(TOPIC_PLAYLIST_PREFIX)) return null;
  if (title === SOMEDAY_PLAYLIST_TITLE) return null;
  const topic = title.slice(TOPIC_PLAYLIST_PREFIX.length);
  return topic.length > 0 ? topic : null;
}

export interface EnumeratedDroppedPlaylist {
  topic: string;
  playlistId: string;
  playlistTitle: string;
  /** The playlist's remaining item video ids, captured BEFORE any delete call — this IS the run-report log (spec.md §7.4). */
  itemVideoIds: string[];
}

/**
 * READ-ONLY. Every "Kaya: <topic>" playlist (excluding Someday) whose topic
 * is no longer in `currentTopics`, with its remaining items enumerated.
 * Never deletes anything — there is no delete call anywhere in this
 * function, structurally.
 */
export async function enumerateDroppedTopicPlaylists(
  currentTopics: string[],
  options: PlaylistClientOptions = {},
): Promise<EnumeratedDroppedPlaylist[]> {
  const currentSet = new Set(currentTopics);
  const all = await listMyPlaylists(options);

  const dropped: EnumeratedDroppedPlaylist[] = [];
  for (const playlist of all) {
    const topic = topicFromPlaylistTitle(playlist.title);
    if (topic === null) continue;
    if (currentSet.has(topic)) continue;
    const itemVideoIds = await listPlaylistItemVideoIds(playlist.id, options);
    dropped.push({ topic, playlistId: playlist.id, playlistTitle: playlist.title, itemVideoIds });
  }
  return dropped;
}

export interface DroppedTopicCleanupResult {
  topic: string;
  playlistId: string;
  playlistTitle: string;
  /** The log, captured BEFORE delete — identical to the enumerated record's `itemVideoIds`. */
  itemVideoIds: string[];
  deleted: boolean;
}

/**
 * Delete ONE already-enumerated dropped playlist. Takes the enumeration
 * record as input and has no enumeration logic of its own — it CANNOT be
 * called before something has already produced that record, which is what
 * makes "log before delete" structural rather than a step-ordering
 * convention a future edit could silently reorder.
 */
export async function deleteDroppedTopicPlaylist(
  entry: EnumeratedDroppedPlaylist,
  options: PlaylistClientOptions = {},
): Promise<DroppedTopicCleanupResult> {
  await deletePlaylist(entry.playlistId, options);
  return {
    topic: entry.topic,
    playlistId: entry.playlistId,
    playlistTitle: entry.playlistTitle,
    itemVideoIds: entry.itemVideoIds,
    deleted: true,
  };
}

/**
 * Composed convenience: enumerate ALL dropped playlists (fully, into an
 * array) BEFORE issuing any delete call, then delete each in turn. No
 * approval round-trip (ticket 06 pt 5: "log-after autonomy"). A delete
 * failure for one playlist is caught per-item (mirrors SKILL.md's
 * per-item-try/catch discipline elsewhere) — it does not stop cleanup of
 * the remaining dropped playlists, and its enumerated log entry is still
 * returned (with `deleted: false`) so the report always shows what was
 * found even when the delete itself failed.
 */
export async function cleanupDroppedTopicPlaylists(
  currentTopics: string[],
  options: PlaylistClientOptions = {},
): Promise<DroppedTopicCleanupResult[]> {
  const dropped = await enumerateDroppedTopicPlaylists(currentTopics, options);

  const results: DroppedTopicCleanupResult[] = [];
  for (const entry of dropped) {
    try {
      results.push(await deleteDroppedTopicPlaylist(entry, options));
    } catch (err) {
      results.push({
        topic: entry.topic,
        playlistId: entry.playlistId,
        playlistTitle: entry.playlistTitle,
        itemVideoIds: entry.itemVideoIds,
        deleted: false,
      });
      // Fail-loud visibility; the caller's run report surfaces `deleted: false` as an anomaly (spec.md §10).
      console.error(`DroppedTopicCleanup: delete failed for "${entry.playlistTitle}" (${entry.playlistId}): ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return results;
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
  const cmd = argv[0];
  const usage =
    'Usage: bun DroppedTopicCleanup.ts enumerate --current-topics "<t1>,<t2>"\n' +
    '       bun DroppedTopicCleanup.ts cleanup --current-topics "<t1>,<t2>"';

  const currentTopicsRaw = flag(argv, "--current-topics");
  if (!cmd || currentTopicsRaw === undefined) {
    console.error(usage);
    process.exit(1);
  }
  const currentTopics = currentTopicsRaw.split(",").map((t) => t.trim()).filter(Boolean);

  switch (cmd) {
    case "enumerate": {
      const result = await enumerateDroppedTopicPlaylists(currentTopics);
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    case "cleanup": {
      const result = await cleanupDroppedTopicPlaylists(currentTopics);
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
