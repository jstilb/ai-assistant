/**
 * TopicPlaylistTopUp.test.ts — idempotent per-topic intent playlist top-up.
 *
 * Fully hermetic: `http`/`getAccessToken` are always injected stubs (zero
 * real network calls), `countUnwatched` is always an injected stub (zero
 * real events.db reads — that logic has its own tests in
 * SeedSourcer.test.ts).
 */

import { expect, test } from "bun:test";
import type { ApiFetcher, ApiRequest } from "../Tools/PlaylistClient.ts";
import { topicPlaylistTitle, topUpTopicPlaylist } from "../Tools/TopicPlaylistTopUp.ts";

const STUB_TOKEN = async () => "ya29.stub-token";
const NO_SLEEP = async () => {};

function jsonResponse(status: number, body: unknown) {
  return { status, body: JSON.stringify(body) };
}

test("topicPlaylistTitle(): prefixes with 'Kaya: '", () => {
  expect(topicPlaylistTitle("woodworking")).toBe("Kaya: woodworking");
});

test("topUpTopicPlaylist(): playlist doesn't exist -> creates it, adds candidates up to target", async () => {
  const calls: ApiRequest[] = [];
  const insertedIds: string[] = [];
  const http: ApiFetcher = async (req) => {
    calls.push(req);
    if (req.url.includes("/playlists?") && req.method === "GET") return jsonResponse(200, { items: [] }); // find-by-title: nothing
    if (req.method === "POST" && req.url.includes("/playlists?")) {
      const body = JSON.parse(req.body ?? "{}") as { snippet?: { title?: string } };
      expect(body.snippet?.title).toBe("Kaya: woodworking");
      return jsonResponse(200, { id: "PL_new", snippet: { title: "Kaya: woodworking" } });
    }
    if (req.url.includes("/playlistItems?") && req.method === "GET") {
      return jsonResponse(200, { items: insertedIds.map((v) => ({ snippet: { resourceId: { videoId: v } } })) });
    }
    if (req.method === "POST" && req.url.includes("/playlistItems?")) {
      const body = JSON.parse(req.body ?? "{}") as { snippet?: { resourceId?: { videoId?: string } } };
      insertedIds.push(body.snippet?.resourceId?.videoId as string);
      return jsonResponse(200, { id: "PLI_1" });
    }
    throw new Error(`unexpected request: ${req.method} ${req.url}`);
  };

  const result = await topUpTopicPlaylist(
    { topic: "woodworking", candidateVideoIds: ["v1", "v2", "v3"], targetCount: 3 },
    { http, getAccessToken: STUB_TOKEN, sleepFn: NO_SLEEP, countUnwatched: async () => [] },
  );

  expect(result.created).toBe(true);
  expect(result.playlistId).toBe("PL_new");
  expect(result.playlistTitle).toBe("Kaya: woodworking");
  expect(result.existingCount).toBe(0);
  expect(result.existingUnwatchedCount).toBe(0);
  expect(result.added).toEqual(["v1", "v2", "v3"]);
  expect(result.skippedAlreadyPresent).toEqual([]);
  expect(result.failed).toEqual([]);
});

test("topUpTopicPlaylist(): playlist exists with enough unwatched items already -> adds nothing, never creates", async () => {
  let createCalled = false;
  const http: ApiFetcher = async (req) => {
    if (req.url.includes("/playlists?") && req.method === "GET") {
      return jsonResponse(200, { items: [{ id: "PL_existing", snippet: { title: "Kaya: jazz" } }] });
    }
    if (req.method === "POST" && req.url.includes("/playlists?")) { createCalled = true; return jsonResponse(200, {}); }
    if (req.url.includes("/playlistItems?") && req.method === "GET") {
      return jsonResponse(200, { items: [
        { snippet: { resourceId: { videoId: "old1" } } },
        { snippet: { resourceId: { videoId: "old2" } } },
      ] });
    }
    throw new Error(`unexpected request: ${req.method} ${req.url}`);
  };

  const result = await topUpTopicPlaylist(
    { topic: "jazz", candidateVideoIds: ["new1", "new2"], targetCount: 2 },
    { http, getAccessToken: STUB_TOKEN, sleepFn: NO_SLEEP, countUnwatched: async (ids) => ids }, // all "unwatched"
  );

  expect(createCalled).toBe(false);
  expect(result.created).toBe(false);
  expect(result.existingCount).toBe(2);
  expect(result.existingUnwatchedCount).toBe(2);
  expect(result.added).toEqual([]); // already at target, nothing needed
});

test("topUpTopicPlaylist(): partial gap — only adds enough candidates to close it, not the whole list", async () => {
  const inserted: string[] = [];
  const http: ApiFetcher = async (req) => {
    if (req.url.includes("/playlists?") && req.method === "GET") {
      return jsonResponse(200, { items: [{ id: "PL_x", snippet: { title: "Kaya: guitar" } }] });
    }
    if (req.url.includes("/playlistItems?") && req.method === "GET") {
      return jsonResponse(200, { items: [{ snippet: { resourceId: { videoId: "old1" } } }] }); // 1 existing
    }
    if (req.method === "POST" && req.url.includes("/playlistItems?")) {
      const body = JSON.parse(req.body ?? "{}") as { snippet?: { resourceId?: { videoId?: string } } };
      const vid = body.snippet?.resourceId?.videoId as string;
      inserted.push(vid);
      return jsonResponse(200, { id: `PLI_${vid}` });
    }
    throw new Error(`unexpected request: ${req.method} ${req.url}`);
  };
  // Verify (GET playlistItems, again) always reports whatever was inserted so far as present.
  const httpWithVerify: ApiFetcher = async (req) => {
    if (req.url.includes("/playlistItems?") && req.method === "GET") {
      const existing = [{ snippet: { resourceId: { videoId: "old1" } } }, ...inserted.map((v) => ({ snippet: { resourceId: { videoId: v } } }))];
      return jsonResponse(200, { items: existing });
    }
    return http(req);
  };

  // targetCount 3, 1 existing unwatched -> gap of 2 -> only first 2 of 3 candidates should be added
  const result = await topUpTopicPlaylist(
    { topic: "guitar", candidateVideoIds: ["c1", "c2", "c3"], targetCount: 3 },
    { http: httpWithVerify, getAccessToken: STUB_TOKEN, sleepFn: NO_SLEEP, countUnwatched: async (ids) => ids },
  );

  expect(result.existingUnwatchedCount).toBe(1);
  expect(result.added).toEqual(["c1", "c2"]);
  expect(inserted).toEqual(["c1", "c2"]);
});

test("topUpTopicPlaylist(): a candidate already present in the playlist is skipped, never re-added", async () => {
  const insertedIds: string[] = [];
  const http: ApiFetcher = async (req) => {
    if (req.url.includes("/playlists?") && req.method === "GET") {
      return jsonResponse(200, { items: [{ id: "PL_x", snippet: { title: "Kaya: cooking" } }] });
    }
    if (req.url.includes("/playlistItems?") && req.method === "GET") {
      const items = [{ snippet: { resourceId: { videoId: "dup1" } } }, ...insertedIds.map((v) => ({ snippet: { resourceId: { videoId: v } } }))];
      return jsonResponse(200, { items });
    }
    if (req.method === "POST" && req.url.includes("/playlistItems?")) {
      const body = JSON.parse(req.body ?? "{}") as { snippet?: { resourceId?: { videoId?: string } } };
      insertedIds.push(body.snippet?.resourceId?.videoId as string);
      return jsonResponse(200, { id: "PLI_new" });
    }
    throw new Error(`unexpected request: ${req.method} ${req.url}`);
  };

  const result = await topUpTopicPlaylist(
    { topic: "cooking", candidateVideoIds: ["dup1", "fresh1"], targetCount: 5 },
    { http, getAccessToken: STUB_TOKEN, sleepFn: NO_SLEEP, countUnwatched: async () => [] }, // existing counts as 0 unwatched, so top-up still runs
  );

  expect(result.skippedAlreadyPresent).toEqual(["dup1"]);
  expect(result.added).toEqual(["fresh1"]);
});

test("topUpTopicPlaylist(): just-created playlist — a 404 from playlistItems.list right after the create retries and succeeds, without a second create call (live eventual-consistency lag, reproduced 2/2 2026-08-12/13)", async () => {
  const calls: ApiRequest[] = [];
  const sleeps: number[] = [];
  const insertedIds: string[] = [];
  let listCalls = 0;
  let sawInitial404 = false;
  const http: ApiFetcher = async (req) => {
    calls.push(req);
    if (req.url.includes("/playlists?") && req.method === "GET") return jsonResponse(200, { items: [] }); // find-by-title: nothing
    if (req.method === "POST" && req.url.includes("/playlists?")) {
      return jsonResponse(200, { id: "PL_new", snippet: { title: "Kaya: woodworking" } });
    }
    if (req.url.includes("/playlistItems?") && req.method === "GET") {
      listCalls += 1;
      if (!sawInitial404) {
        sawInitial404 = true;
        // Eventual-consistency 404: playlists.insert already succeeded but
        // playlistItems.list against the brand-new playlist hasn't caught up yet.
        return jsonResponse(404, { error: { code: 404, message: "playlist cannot be found", errors: [{ reason: "playlistNotFound" }] } });
      }
      return jsonResponse(200, { items: insertedIds.map((v) => ({ snippet: { resourceId: { videoId: v } } })) });
    }
    if (req.method === "POST" && req.url.includes("/playlistItems?")) {
      const body = JSON.parse(req.body ?? "{}") as { snippet?: { resourceId?: { videoId?: string } } };
      insertedIds.push(body.snippet?.resourceId?.videoId as string);
      return jsonResponse(200, { id: "PLI_1" });
    }
    throw new Error(`unexpected request: ${req.method} ${req.url}`);
  };

  const result = await topUpTopicPlaylist(
    { topic: "woodworking", candidateVideoIds: ["v1"], targetCount: 1 },
    { http, getAccessToken: STUB_TOKEN, sleepFn: async (ms) => { sleeps.push(ms); }, countUnwatched: async () => [] },
  );

  expect(result.created).toBe(true);
  expect(result.playlistId).toBe("PL_new");
  expect(result.added).toEqual(["v1"]);
  expect(calls.filter((c) => c.method === "POST" && c.url.includes("/playlists?"))).toHaveLength(1); // no re-create
  // 3 list calls: (1) initial 404 right after create, (2) retry succeeds (empty),
  // (3) addAndVerifyPlaylistItem's own verify re-read after the insert (finds v1).
  expect(listCalls).toBe(3);
  expect(sleeps[0]).toBe(3_000); // first backoff delay of the list-after-create retry
});

test("topUpTopicPlaylist(): existing (NOT just-created) playlist — a 404 from playlistItems.list fails fast, no retry, no sleep", async () => {
  const sleeps: number[] = [];
  let listAttempts = 0;
  const http: ApiFetcher = async (req) => {
    if (req.url.includes("/playlists?") && req.method === "GET") {
      return jsonResponse(200, { items: [{ id: "PL_existing", snippet: { title: "Kaya: jazz" } }] }); // found — created: false
    }
    if (req.url.includes("/playlistItems?") && req.method === "GET") {
      listAttempts += 1;
      // Genuinely gone (deleted/renamed mid-run) — must throw immediately, never retry into a confusing slow error.
      return jsonResponse(404, { error: { code: 404, message: "playlist cannot be found", errors: [{ reason: "playlistNotFound" }] } });
    }
    throw new Error(`unexpected request: ${req.method} ${req.url}`);
  };

  await expect(
    topUpTopicPlaylist(
      { topic: "jazz", candidateVideoIds: ["v1"], targetCount: 1 },
      { http, getAccessToken: STUB_TOKEN, sleepFn: async (ms) => { sleeps.push(ms); }, countUnwatched: async () => [] },
    ),
  ).rejects.toThrow(/HTTP 404/);

  expect(listAttempts).toBe(1); // no retry
  expect(sleeps).toEqual([]); // no backoff wait at all
});

test("topUpTopicPlaylist(): a per-item add failure is caught, recorded in `failed`, and the loop continues", async () => {
  const insertedIds: string[] = [];
  const http: ApiFetcher = async (req) => {
    if (req.url.includes("/playlists?") && req.method === "GET") {
      return jsonResponse(200, { items: [{ id: "PL_x", snippet: { title: "Kaya: film" } }] });
    }
    if (req.url.includes("/playlistItems?") && req.method === "GET") {
      return jsonResponse(200, { items: insertedIds.map((v) => ({ snippet: { resourceId: { videoId: v } } })) });
    }
    if (req.method === "POST" && req.url.includes("/playlistItems?")) {
      const body = JSON.parse(req.body ?? "{}") as { snippet?: { resourceId?: { videoId?: string } } };
      if (body.snippet?.resourceId?.videoId === "bad1") return jsonResponse(403, { error: { message: "boom" } });
      insertedIds.push(body.snippet?.resourceId?.videoId as string);
      return jsonResponse(200, { id: "PLI_ok" });
    }
    throw new Error(`unexpected request: ${req.method} ${req.url}`);
  };

  const result = await topUpTopicPlaylist(
    { topic: "film", candidateVideoIds: ["bad1", "good1"], targetCount: 5 },
    { http, getAccessToken: STUB_TOKEN, sleepFn: NO_SLEEP, countUnwatched: async () => [] },
  );

  expect(result.added).toEqual(["good1"]);
  expect(result.failed).toHaveLength(1);
  expect(result.failed[0]?.videoId).toBe("bad1");
  expect(result.failed[0]?.error).toContain("boom");
});
