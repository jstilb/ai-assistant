/**
 * DroppedTopicCleanup.test.ts — dropped-topic playlist cleanup, log-then-
 * delete.
 *
 * Fully hermetic: `http`/`getAccessToken` are always injected stubs — zero
 * real network calls.
 */

import { expect, test } from "bun:test";
import type { ApiFetcher, ApiRequest } from "../Tools/PlaylistClient.ts";
import {
  cleanupDroppedTopicPlaylists,
  deleteDroppedTopicPlaylist,
  enumerateDroppedTopicPlaylists,
  topicFromPlaylistTitle,
} from "../Tools/DroppedTopicCleanup.ts";

const STUB_TOKEN = async () => "ya29.stub-token";

function jsonResponse(status: number, body: unknown) {
  return { status, body: JSON.stringify(body) };
}

// ----------------------------------------------------------------------------
// topicFromPlaylistTitle()
// ----------------------------------------------------------------------------

test("topicFromPlaylistTitle(): extracts the topic from a 'Kaya: <topic>' title", () => {
  expect(topicFromPlaylistTitle("Kaya: woodworking")).toBe("woodworking");
});

test("topicFromPlaylistTitle(): a non-Kaya playlist returns null", () => {
  expect(topicFromPlaylistTitle("My Road Trip Mix")).toBeNull();
});

test("topicFromPlaylistTitle(): the Someday playlist is explicitly excluded, never a cleanup candidate", () => {
  expect(topicFromPlaylistTitle("Kaya: Someday")).toBeNull();
});

// ----------------------------------------------------------------------------
// enumerateDroppedTopicPlaylists() — read-only
// ----------------------------------------------------------------------------

test("enumerateDroppedTopicPlaylists(): finds Kaya-prefixed playlists whose topic left the current set, enumerates their items, skips Someday and non-Kaya playlists, issues NO delete calls", async () => {
  const calls: ApiRequest[] = [];
  const http: ApiFetcher = async (req) => {
    calls.push(req);
    if (req.url.includes("/playlists?")) {
      return jsonResponse(200, {
        items: [
          { id: "PL_kept", snippet: { title: "Kaya: jazz" } }, // still current — not dropped
          { id: "PL_dropped", snippet: { title: "Kaya: origami" } }, // dropped
          { id: "PL_someday", snippet: { title: "Kaya: Someday" } }, // excluded regardless
          { id: "PL_other", snippet: { title: "My Own Mix" } }, // not Kaya-prefixed
        ],
      });
    }
    if (req.url.includes("/playlistItems?")) {
      return jsonResponse(200, { items: [{ snippet: { resourceId: { videoId: "v1" } } }, { snippet: { resourceId: { videoId: "v2" } } }] });
    }
    throw new Error(`unexpected request: ${req.method} ${req.url}`);
  };

  const result = await enumerateDroppedTopicPlaylists(["jazz"], { http, getAccessToken: STUB_TOKEN });

  expect(result).toEqual([
    { topic: "origami", playlistId: "PL_dropped", playlistTitle: "Kaya: origami", itemVideoIds: ["v1", "v2"] },
  ]);
  expect(calls.some((c) => c.method === "DELETE")).toBe(false);
});

test("enumerateDroppedTopicPlaylists(): no dropped topics -> empty result, no playlistItems calls at all", async () => {
  let itemsCalled = false;
  const http: ApiFetcher = async (req) => {
    if (req.url.includes("/playlists?")) return jsonResponse(200, { items: [{ id: "PL_kept", snippet: { title: "Kaya: jazz" } }] });
    itemsCalled = true;
    return jsonResponse(200, { items: [] });
  };

  const result = await enumerateDroppedTopicPlaylists(["jazz"], { http, getAccessToken: STUB_TOKEN });

  expect(result).toEqual([]);
  expect(itemsCalled).toBe(false);
});

// ----------------------------------------------------------------------------
// deleteDroppedTopicPlaylist() — takes an already-enumerated record
// ----------------------------------------------------------------------------

test("deleteDroppedTopicPlaylist(): deletes the given playlist and echoes back its already-captured item log", async () => {
  const calls: ApiRequest[] = [];
  const http: ApiFetcher = async (req) => {
    calls.push(req);
    return jsonResponse(204, "");
  };

  const entry = { topic: "origami", playlistId: "PL_dropped", playlistTitle: "Kaya: origami", itemVideoIds: ["v1", "v2"] };
  const result = await deleteDroppedTopicPlaylist(entry, { http, getAccessToken: STUB_TOKEN });

  expect(result).toEqual({ topic: "origami", playlistId: "PL_dropped", playlistTitle: "Kaya: origami", itemVideoIds: ["v1", "v2"], deleted: true });
  expect(calls).toHaveLength(1);
  expect(calls[0]?.method).toBe("DELETE");
  expect(calls[0]?.url).toContain("PL_dropped");
});

// ----------------------------------------------------------------------------
// cleanupDroppedTopicPlaylists() — structural log-then-delete ordering
// ----------------------------------------------------------------------------

test("cleanupDroppedTopicPlaylists(): STRUCTURAL ordering — every enumeration call (playlists list + all playlistItems reads) completes before the first DELETE is ever issued", async () => {
  const callOrder: string[] = [];
  const http: ApiFetcher = async (req) => {
    if (req.url.includes("/playlists?") && req.method === "GET") {
      callOrder.push("list-playlists");
      return jsonResponse(200, {
        items: [
          { id: "PL_a", snippet: { title: "Kaya: origami" } },
          { id: "PL_b", snippet: { title: "Kaya: birdwatching" } },
        ],
      });
    }
    if (req.url.includes("/playlistItems?")) {
      callOrder.push(`list-items:${req.url.includes("PL_a") ? "PL_a" : "PL_b"}`);
      return jsonResponse(200, { items: [{ snippet: { resourceId: { videoId: "v1" } } }] });
    }
    if (req.method === "DELETE") {
      callOrder.push(`delete:${new URL(req.url).searchParams.get("id")}`);
      return jsonResponse(204, "");
    }
    throw new Error(`unexpected request: ${req.method} ${req.url}`);
  };

  const results = await cleanupDroppedTopicPlaylists([], { http, getAccessToken: STUB_TOKEN });

  expect(results).toHaveLength(2);
  expect(results.every((r) => r.deleted)).toBe(true);
  expect(results.every((r) => r.itemVideoIds.length > 0)).toBe(true);

  // The index of the FIRST delete call must be greater than the index of
  // EVERY enumeration call (list-playlists + both list-items reads) — proves
  // the full enumeration completed structurally before any delete began.
  const firstDeleteIndex = callOrder.findIndex((c) => c.startsWith("delete:"));
  const lastEnumerationIndex = callOrder.reduce(
    (max, c, i) => (!c.startsWith("delete:") ? Math.max(max, i) : max),
    -1,
  );
  expect(firstDeleteIndex).toBeGreaterThan(-1);
  expect(firstDeleteIndex).toBeGreaterThan(lastEnumerationIndex);
  expect(callOrder).toEqual([
    "list-playlists",
    "list-items:PL_a",
    "list-items:PL_b",
    "delete:PL_a",
    "delete:PL_b",
  ]);
});

test("cleanupDroppedTopicPlaylists(): a delete failure for one playlist is caught, recorded as deleted:false with its log intact, and does not stop the rest", async () => {
  const http: ApiFetcher = async (req) => {
    if (req.method === "DELETE") {
      if (req.url.includes("PL_bad")) return jsonResponse(500, { error: { message: "server error" } });
      return jsonResponse(204, "");
    }
    if (req.url.includes("/playlists?")) {
      return jsonResponse(200, {
        items: [
          { id: "PL_bad", snippet: { title: "Kaya: origami" } },
          { id: "PL_good", snippet: { title: "Kaya: birdwatching" } },
        ],
      });
    }
    if (req.url.includes("/playlistItems?")) {
      return jsonResponse(200, { items: [{ snippet: { resourceId: { videoId: "v1" } } }] });
    }
    throw new Error(`unexpected request: ${req.method} ${req.url}`);
  };

  const results = await cleanupDroppedTopicPlaylists([], { http, getAccessToken: STUB_TOKEN });

  expect(results).toHaveLength(2);
  const bad = results.find((r) => r.playlistId === "PL_bad");
  const good = results.find((r) => r.playlistId === "PL_good");
  expect(bad).toEqual({ topic: "origami", playlistId: "PL_bad", playlistTitle: "Kaya: origami", itemVideoIds: ["v1"], deleted: false });
  expect(good).toEqual({ topic: "birdwatching", playlistId: "PL_good", playlistTitle: "Kaya: birdwatching", itemVideoIds: ["v1"], deleted: true });
});

test("cleanupDroppedTopicPlaylists(): no dropped playlists -> empty result, zero DELETE calls", async () => {
  const http: ApiFetcher = async (req) => {
    if (req.url.includes("/playlists?")) return jsonResponse(200, { items: [{ id: "PL_kept", snippet: { title: "Kaya: jazz" } }] });
    throw new Error(`unexpected request: ${req.method} ${req.url}`);
  };

  const results = await cleanupDroppedTopicPlaylists(["jazz"], { http, getAccessToken: STUB_TOKEN });
  expect(results).toEqual([]);
});
