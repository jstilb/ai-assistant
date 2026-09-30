/**
 * PlaylistClient.test.ts — the skill's ONE YouTube Data API seam.
 *
 * Fully hermetic: `http` and `getAccessToken` are always injected stubs —
 * zero real network calls, zero real tokens. Every case builds a tiny
 * router-shaped fake fetcher so tests read as "given these responses, what
 * does the client do," matching this skill's YouTubeAuth.test.ts style.
 */

import { expect, test } from "bun:test";
import {
  addAndVerifyPlaylistItem,
  type ApiFetcher,
  type ApiRequest,
  createPlaylist,
  deletePlaylist,
  ensureSomedayPlaylist,
  findPlaylistByTitle,
  insertPlaylistItem,
  listPlaylistItemVideoIds,
  listMyPlaylists,
  PlaylistApiError,
  removeAndVerifyPlaylistItem,
  SOMEDAY_PLAYLIST_TITLE,
  verifyPlaylistContainsVideo,
} from "../Tools/PlaylistClient.ts";

const STUB_TOKEN = async () => "ya29.stub-token";

function jsonResponse(status: number, body: unknown) {
  return { status, body: JSON.stringify(body) };
}

// ----------------------------------------------------------------------------
// ensureSomedayPlaylist(): cached-id, found-by-title, and create paths
// ----------------------------------------------------------------------------

test("ensureSomedayPlaylist(): a valid cachedId short-circuits with an id lookup + owner check, no paginated search", async () => {
  const calls: ApiRequest[] = [];
  const http: ApiFetcher = async (req) => {
    calls.push(req);
    if (req.url.includes("/channels?")) return jsonResponse(200, { items: [{ id: "UC_me" }] });
    return jsonResponse(200, { items: [{ id: "PL_cached", snippet: { title: SOMEDAY_PLAYLIST_TITLE, channelId: "UC_me" } }] });
  };

  const result = await ensureSomedayPlaylist({ http, getAccessToken: STUB_TOKEN, cachedId: "PL_cached" });

  expect(result).toEqual({ id: "PL_cached", title: SOMEDAY_PLAYLIST_TITLE, created: false });
  expect(calls).toHaveLength(2);
  expect(calls[0]?.url).toContain("/playlists?");
  expect(calls[0]?.url).toContain("id=PL_cached");
  expect(calls[1]?.url).toContain("/channels?");
});

// Google rejects playlists.list with BOTH id and mine (HTTP 400 "Incompatible
// parameters" — reproduced live 2026-08-14). These routers mimic that, so a
// regression back to id+mine fails these tests the same way it fails live.
function incompatibleParamsGuard(req: ApiRequest): { status: number; body: string } | null {
  if (req.method === "GET" && req.url.includes("/playlists?") && req.url.includes("id=") && req.url.includes("mine=")) {
    return jsonResponse(400, {
      error: { code: 400, message: "Incompatible parameters specified in the request: id, mine" },
    });
  }
  return null;
}

test("ensureSomedayPlaylist(): cached-id validation sends a valid request shape (id without mine) and confirms ownership", async () => {
  const calls: ApiRequest[] = [];
  const http: ApiFetcher = async (req) => {
    calls.push(req);
    const rejected = incompatibleParamsGuard(req);
    if (rejected) return rejected;
    if (req.url.includes("/channels?")) return jsonResponse(200, { items: [{ id: "UC_me" }] });
    return jsonResponse(200, { items: [{ id: "PL_cached", snippet: { title: SOMEDAY_PLAYLIST_TITLE, channelId: "UC_me" } }] });
  };

  const result = await ensureSomedayPlaylist({ http, getAccessToken: STUB_TOKEN, cachedId: "PL_cached" });

  expect(result).toEqual({ id: "PL_cached", title: SOMEDAY_PLAYLIST_TITLE, created: false });
  const byIdCall = calls.find((c) => c.url.includes("id=PL_cached"));
  expect(byIdCall).toBeDefined();
  expect(byIdCall?.url).not.toContain("mine=");
});

test("ensureSomedayPlaylist(): dead cachedId (playlist deleted) recovers by falling back to title search", async () => {
  const http: ApiFetcher = async (req) => {
    const rejected = incompatibleParamsGuard(req);
    if (rejected) return rejected;
    if (req.url.includes("id=PL_dead")) return jsonResponse(200, { items: [] });
    return jsonResponse(200, { items: [{ id: "PL_real", snippet: { title: SOMEDAY_PLAYLIST_TITLE } }] });
  };

  const result = await ensureSomedayPlaylist({ http, getAccessToken: STUB_TOKEN, cachedId: "PL_dead" });

  expect(result).toEqual({ id: "PL_real", title: SOMEDAY_PLAYLIST_TITLE, created: false });
});

test("ensureSomedayPlaylist(): cachedId owned by a DIFFERENT channel does not validate — falls back to title search", async () => {
  const http: ApiFetcher = async (req) => {
    const rejected = incompatibleParamsGuard(req);
    if (rejected) return rejected;
    if (req.url.includes("/channels?")) return jsonResponse(200, { items: [{ id: "UC_me" }] });
    if (req.url.includes("id=PL_foreign")) {
      // Same title, wrong channel — the wrong-channel incident class (2026-08-14).
      return jsonResponse(200, { items: [{ id: "PL_foreign", snippet: { title: SOMEDAY_PLAYLIST_TITLE, channelId: "UC_other" } }] });
    }
    return jsonResponse(200, { items: [{ id: "PL_mine", snippet: { title: SOMEDAY_PLAYLIST_TITLE } }] });
  };

  const result = await ensureSomedayPlaylist({ http, getAccessToken: STUB_TOKEN, cachedId: "PL_foreign" });

  expect(result).toEqual({ id: "PL_mine", title: SOMEDAY_PLAYLIST_TITLE, created: false });
});

test("ensureSomedayPlaylist(): stale cachedId (title mismatch) falls back to search-by-title, finds it, does not create", async () => {
  const calls: ApiRequest[] = [];
  const http: ApiFetcher = async (req) => {
    calls.push(req);
    if (req.url.includes("id=PL_stale")) {
      // Renamed since it was cached — title no longer matches.
      return jsonResponse(200, { items: [{ id: "PL_stale", snippet: { title: "Something Else" } }] });
    }
    // Fallback search-by-title finds it under its real, current id.
    return jsonResponse(200, { items: [{ id: "PL_real", snippet: { title: SOMEDAY_PLAYLIST_TITLE } }] });
  };

  const result = await ensureSomedayPlaylist({ http, getAccessToken: STUB_TOKEN, cachedId: "PL_stale" });

  expect(result).toEqual({ id: "PL_real", title: SOMEDAY_PLAYLIST_TITLE, created: false });
  expect(calls).toHaveLength(2);
});

test("ensureSomedayPlaylist(): no cachedId, found on the first page of Jm's playlists", async () => {
  const http: ApiFetcher = async () =>
    jsonResponse(200, {
      items: [
        { id: "PL_other", snippet: { title: "Not It" } },
        { id: "PL_someday", snippet: { title: SOMEDAY_PLAYLIST_TITLE } },
      ],
    });

  const result = await ensureSomedayPlaylist({ http, getAccessToken: STUB_TOKEN });

  expect(result).toEqual({ id: "PL_someday", title: SOMEDAY_PLAYLIST_TITLE, created: false });
});

test("ensureSomedayPlaylist(): not found anywhere -> creates it (POST with private status)", async () => {
  const calls: ApiRequest[] = [];
  const http: ApiFetcher = async (req) => {
    calls.push(req);
    if (req.method === "GET") return jsonResponse(200, { items: [] });
    // POST /playlists
    const body = JSON.parse(req.body ?? "{}") as { snippet?: { title?: string }; status?: { privacyStatus?: string } };
    expect(body.snippet?.title).toBe(SOMEDAY_PLAYLIST_TITLE);
    expect(body.status?.privacyStatus).toBe("private");
    return jsonResponse(200, { id: "PL_new", snippet: { title: SOMEDAY_PLAYLIST_TITLE } });
  };

  const result = await ensureSomedayPlaylist({ http, getAccessToken: STUB_TOKEN });

  expect(result).toEqual({ id: "PL_new", title: SOMEDAY_PLAYLIST_TITLE, created: true });
  expect(calls.some((c) => c.method === "POST")).toBe(true);
});

// ----------------------------------------------------------------------------
// Pagination — findPlaylistByTitle / listPlaylistItemVideoIds
// ----------------------------------------------------------------------------

test("findPlaylistByTitle(): walks pageToken across multiple pages until a match is found", async () => {
  let call = 0;
  const http: ApiFetcher = async (req) => {
    call += 1;
    if (!req.url.includes("pageToken")) {
      return jsonResponse(200, { items: [{ id: "PL_a", snippet: { title: "Page One Item" } }], nextPageToken: "tok2" });
    }
    return jsonResponse(200, { items: [{ id: "PL_b", snippet: { title: "Kaya: Someday" } }] });
  };

  const result = await findPlaylistByTitle("Kaya: Someday", { http, getAccessToken: STUB_TOKEN });

  expect(result).toEqual({ id: "PL_b", title: "Kaya: Someday" });
  expect(call).toBe(2);
});

test("findPlaylistByTitle(): exhausts all pages and returns null when no match anywhere", async () => {
  const http: ApiFetcher = async (req) => {
    if (!req.url.includes("pageToken")) return jsonResponse(200, { items: [{ id: "PL_a", snippet: { title: "Nope" } }], nextPageToken: "tok2" });
    return jsonResponse(200, { items: [{ id: "PL_b", snippet: { title: "Also Nope" } }] });
  };

  const result = await findPlaylistByTitle("Kaya: Someday", { http, getAccessToken: STUB_TOKEN });
  expect(result).toBeNull();
});

test("listMyPlaylists(): accumulates items across every page", async () => {
  const http: ApiFetcher = async (req) => {
    if (!req.url.includes("pageToken")) return jsonResponse(200, { items: [{ id: "PL_1", snippet: { title: "One" } }], nextPageToken: "tok2" });
    return jsonResponse(200, { items: [{ id: "PL_2", snippet: { title: "Two" } }] });
  };

  const result = await listMyPlaylists({ http, getAccessToken: STUB_TOKEN });
  expect(result).toEqual([{ id: "PL_1", title: "One" }, { id: "PL_2", title: "Two" }]);
});

test("listPlaylistItemVideoIds(): accumulates video ids across every page", async () => {
  const http: ApiFetcher = async (req) => {
    if (!req.url.includes("pageToken")) {
      return jsonResponse(200, {
        items: [{ snippet: { resourceId: { videoId: "vid1" } } }],
        nextPageToken: "tok2",
      });
    }
    return jsonResponse(200, { items: [{ snippet: { resourceId: { videoId: "vid2" } } }] });
  };

  const ids = await listPlaylistItemVideoIds("PL_x", { http, getAccessToken: STUB_TOKEN });
  expect(ids).toEqual(["vid1", "vid2"]);
});

test("listPlaylistItemVideoIds(): default (retryOn404 unset) — a 404 throws immediately, no retry, no sleep", async () => {
  let calls = 0;
  const sleeps: number[] = [];
  const http: ApiFetcher = async () => {
    calls += 1;
    return jsonResponse(404, { error: { code: 404, message: "playlist cannot be found", errors: [{ reason: "playlistNotFound" }] } });
  };

  await expect(
    listPlaylistItemVideoIds("PL_x", { http, getAccessToken: STUB_TOKEN, sleepFn: async (ms) => { sleeps.push(ms); } }),
  ).rejects.toThrow(/HTTP 404/);
  expect(calls).toBe(1); // no retry without opting in
  expect(sleeps).toEqual([]);
});

test("listPlaylistItemVideoIds(): retryOn404 true — a 404 then success on retry succeeds (eventual-consistency lag right after playlists.insert)", async () => {
  let calls = 0;
  const sleeps: number[] = [];
  const http: ApiFetcher = async () => {
    calls += 1;
    if (calls === 1) {
      return jsonResponse(404, { error: { code: 404, message: "playlist cannot be found", errors: [{ reason: "playlistNotFound" }] } });
    }
    return jsonResponse(200, { items: [{ snippet: { resourceId: { videoId: "vid1" } } }] });
  };

  const ids = await listPlaylistItemVideoIds("PL_x", {
    http,
    getAccessToken: STUB_TOKEN,
    retryOn404: true,
    sleepFn: async (ms) => { sleeps.push(ms); },
  });

  expect(ids).toEqual(["vid1"]);
  expect(calls).toBe(2);
  expect(sleeps).toEqual([3_000]); // only the first backoff delay was needed
});

test("listPlaylistItemVideoIds(): retryOn404 true — 404 on every attempt still throws after exhausting retries (genuinely deleted playlist, never silently swallowed)", async () => {
  let calls = 0;
  const sleeps: number[] = [];
  const http: ApiFetcher = async () => {
    calls += 1;
    return jsonResponse(404, { error: { code: 404, message: "playlist cannot be found", errors: [{ reason: "playlistNotFound" }] } });
  };

  await expect(
    listPlaylistItemVideoIds("PL_x", {
      http,
      getAccessToken: STUB_TOKEN,
      retryOn404: true,
      sleepFn: async (ms) => { sleeps.push(ms); },
    }),
  ).rejects.toThrow(/HTTP 404/);
  expect(calls).toBe(3); // VERIFY_MAX_ATTEMPTS
  expect(sleeps).toEqual([3_000, 5_000]);
});

test("listPlaylistItemVideoIds(): retryOn404 true — a non-404 failure (e.g. 401) is never retried", async () => {
  let calls = 0;
  const http: ApiFetcher = async () => {
    calls += 1;
    return jsonResponse(401, { error: { code: 401, message: "Invalid Credentials", errors: [{ reason: "authError" }] } });
  };

  await expect(
    listPlaylistItemVideoIds("PL_x", { http, getAccessToken: STUB_TOKEN, retryOn404: true }),
  ).rejects.toThrow(/HTTP 401/);
  expect(calls).toBe(1);
});

// ----------------------------------------------------------------------------
// insertPlaylistItem / verifyPlaylistContainsVideo / addAndVerifyPlaylistItem
// ----------------------------------------------------------------------------

test("insertPlaylistItem(): posts the correct resourceId body and returns the new item's id", async () => {
  let seenBody: unknown = null;
  const http: ApiFetcher = async (req) => {
    seenBody = JSON.parse(req.body ?? "{}");
    return jsonResponse(200, { id: "PLI_1" });
  };

  const result = await insertPlaylistItem("PL_x", "vid123", { http, getAccessToken: STUB_TOKEN });

  expect(result).toEqual({ playlistItemId: "PLI_1" });
  expect(seenBody).toEqual({ snippet: { playlistId: "PL_x", resourceId: { kind: "youtube#video", videoId: "vid123" } } });
});

test("insertPlaylistItem(): malformed response (no id) throws rather than returning a garbage result", async () => {
  const http: ApiFetcher = async () => jsonResponse(200, {});
  await expect(insertPlaylistItem("PL_x", "vid123", { http, getAccessToken: STUB_TOKEN })).rejects.toThrow(/returned no id/);
});

test("verifyPlaylistContainsVideo(): true when a fresh re-read finds the video", async () => {
  const http: ApiFetcher = async () => jsonResponse(200, { items: [{ snippet: { resourceId: { videoId: "vid123" } } }] });
  const contains = await verifyPlaylistContainsVideo("PL_x", "vid123", { http, getAccessToken: STUB_TOKEN });
  expect(contains).toBe(true);
});

test("verifyPlaylistContainsVideo(): false when the fresh re-read does NOT find the video", async () => {
  const http: ApiFetcher = async () => jsonResponse(200, { items: [{ snippet: { resourceId: { videoId: "some-other-vid" } } }] });
  const contains = await verifyPlaylistContainsVideo("PL_x", "vid123", { http, getAccessToken: STUB_TOKEN });
  expect(contains).toBe(false);
});

test("addAndVerifyPlaylistItem(): insert + re-read confirm both succeed -> returns the result (2 HTTP calls)", async () => {
  const calls: ApiRequest[] = [];
  const http: ApiFetcher = async (req) => {
    calls.push(req);
    if (req.method === "POST") return jsonResponse(200, { id: "PLI_1" });
    return jsonResponse(200, { items: [{ snippet: { resourceId: { videoId: "vid123" } } }] });
  };

  const result = await addAndVerifyPlaylistItem("PL_x", "vid123", { http, getAccessToken: STUB_TOKEN });

  expect(result).toEqual({ playlistItemId: "PLI_1", videoId: "vid123", playlistId: "PL_x" });
  expect(calls).toHaveLength(2);
});

test("addAndVerifyPlaylistItem(): insert reports success but every verify retry attempt still finds nothing -> throws loud (never a silent false, never re-inserts)", async () => {
  const calls: ApiRequest[] = [];
  const sleeps: number[] = [];
  const http: ApiFetcher = async (req) => {
    calls.push(req);
    if (req.method === "POST") return jsonResponse(200, { id: "PLI_ghost" });
    // Re-read comes back empty on every attempt — the insert never actually landed.
    return jsonResponse(200, { items: [] });
  };

  await expect(
    addAndVerifyPlaylistItem("PL_x", "vid123", {
      http,
      getAccessToken: STUB_TOKEN,
      sleepFn: async (ms) => { sleeps.push(ms); },
    }),
  ).rejects.toThrow(/3 re-read attempt\(s\).*did NOT find it.*NOT retried on a verify miss/s);

  const posts = calls.filter((c) => c.method === "POST");
  const gets = calls.filter((c) => c.method === "GET");
  expect(posts).toHaveLength(1); // insert issued exactly once — never re-issued on verify miss
  expect(gets).toHaveLength(3); // 3 verify attempts
  expect(sleeps).toEqual([3_000, 5_000]); // backoff between attempts 1->2 and 2->3, ~8s total
});

test("addAndVerifyPlaylistItem(): a verify miss on the first attempt that succeeds on retry counts as success (no re-insert)", async () => {
  const calls: ApiRequest[] = [];
  let getCount = 0;
  const sleeps: number[] = [];
  const http: ApiFetcher = async (req) => {
    calls.push(req);
    if (req.method === "POST") return jsonResponse(200, { id: "PLI_1" });
    getCount += 1;
    // Empty on the first verify read (propagation lag), found on the second.
    if (getCount === 1) return jsonResponse(200, { items: [] });
    return jsonResponse(200, { items: [{ snippet: { resourceId: { videoId: "vid123" } } }] });
  };

  const result = await addAndVerifyPlaylistItem("PL_x", "vid123", {
    http,
    getAccessToken: STUB_TOKEN,
    sleepFn: async (ms) => { sleeps.push(ms); },
  });

  expect(result).toEqual({ playlistItemId: "PLI_1", videoId: "vid123", playlistId: "PL_x" });
  expect(calls.filter((c) => c.method === "POST")).toHaveLength(1); // still exactly one insert
  expect(getCount).toBe(2); // one miss, one hit — stops retrying once confirmed
  expect(sleeps).toEqual([3_000]); // only the first backoff delay was needed
});

// ----------------------------------------------------------------------------
// removeAndVerifyPlaylistItem() — the delete-side mirror of add-and-verify
// ----------------------------------------------------------------------------

test("removeAndVerifyPlaylistItem(): maps video to item id, deletes it, fresh re-read confirms absence (3 HTTP calls)", async () => {
  const calls: ApiRequest[] = [];
  let deleted = false;
  const http: ApiFetcher = async (req) => {
    calls.push(req);
    if (req.method === "DELETE") {
      deleted = true;
      return { status: 204, body: "" };
    }
    return jsonResponse(200, {
      items: deleted
        ? [{ id: "pi_other", snippet: { resourceId: { videoId: "vid_other" } } }]
        : [
            { id: "pi_other", snippet: { resourceId: { videoId: "vid_other" } } },
            { id: "pi_target", snippet: { resourceId: { videoId: "vid123" } } },
          ],
    });
  };

  const result = await removeAndVerifyPlaylistItem("PL_x", "vid123", { http, getAccessToken: STUB_TOKEN });

  expect(result).toEqual({ playlistItemId: "pi_target", videoId: "vid123", playlistId: "PL_x" });
  expect(calls).toHaveLength(3); // mapping read, delete, verify re-read
  const del = calls.find((c) => c.method === "DELETE");
  expect(del?.url).toContain("/playlistItems?");
  expect(del?.url).toContain("id=pi_target");
});

test("removeAndVerifyPlaylistItem(): video not in the playlist throws — and never issues a DELETE", async () => {
  const calls: ApiRequest[] = [];
  const http: ApiFetcher = async (req) => {
    calls.push(req);
    return jsonResponse(200, { items: [{ id: "pi_other", snippet: { resourceId: { videoId: "vid_other" } } }] });
  };

  await expect(removeAndVerifyPlaylistItem("PL_x", "vid123", { http, getAccessToken: STUB_TOKEN })).rejects.toThrow(
    /is not in playlist/,
  );
  expect(calls.every((c) => c.method === "GET")).toBe(true);
});

test("removeAndVerifyPlaylistItem(): finds the playlist item beyond the first page of the mapping read", async () => {
  let deleted = false;
  const http: ApiFetcher = async (req) => {
    if (req.method === "DELETE") {
      deleted = true;
      return { status: 204, body: "" };
    }
    if (deleted) return jsonResponse(200, { items: [] });
    if (!req.url.includes("pageToken=")) {
      return jsonResponse(200, { items: [{ id: "pi_1", snippet: { resourceId: { videoId: "vid_a" } } }], nextPageToken: "p2" });
    }
    return jsonResponse(200, { items: [{ id: "pi_2", snippet: { resourceId: { videoId: "vid123" } } }] });
  };

  const result = await removeAndVerifyPlaylistItem("PL_x", "vid123", { http, getAccessToken: STUB_TOKEN });

  expect(result.playlistItemId).toBe("pi_2");
});

test("removeAndVerifyPlaylistItem(): verify still sees the video on the first re-read (list lag) but not the second -> success, delete never re-issued", async () => {
  let gets = 0;
  const deletes: ApiRequest[] = [];
  const sleeps: number[] = [];
  const http: ApiFetcher = async (req) => {
    if (req.method === "DELETE") {
      deletes.push(req);
      return { status: 204, body: "" };
    }
    gets += 1;
    // GET 1: mapping read. GET 2: first verify re-read, still lagging. GET 3+: absence propagated.
    return jsonResponse(200, {
      items: gets <= 2 ? [{ id: "pi_target", snippet: { resourceId: { videoId: "vid123" } } }] : [],
    });
  };

  const result = await removeAndVerifyPlaylistItem("PL_x", "vid123", {
    http,
    getAccessToken: STUB_TOKEN,
    sleepFn: async (ms) => {
      sleeps.push(ms);
    },
  });

  expect(result).toEqual({ playlistItemId: "pi_target", videoId: "vid123", playlistId: "PL_x" });
  expect(deletes).toHaveLength(1);
  expect(sleeps).toEqual([3_000]); // only the first backoff delay was needed
});

test("removeAndVerifyPlaylistItem(): delete reports success but the video is still present after every verify retry -> throws loud, delete issued exactly once", async () => {
  const deletes: ApiRequest[] = [];
  const sleeps: number[] = [];
  const http: ApiFetcher = async (req) => {
    if (req.method === "DELETE") {
      deletes.push(req);
      return { status: 204, body: "" };
    }
    return jsonResponse(200, { items: [{ id: "pi_target", snippet: { resourceId: { videoId: "vid123" } } }] });
  };

  await expect(
    removeAndVerifyPlaylistItem("PL_x", "vid123", {
      http,
      getAccessToken: STUB_TOKEN,
      sleepFn: async (ms) => {
        sleeps.push(ms);
      },
    }),
  ).rejects.toThrow(/refusing to report success/);
  expect(deletes).toHaveLength(1);
  expect(sleeps).toEqual([3_000, 5_000]); // exhausted the full verify backoff before giving up
});

// ----------------------------------------------------------------------------
// createPlaylist / deletePlaylist (generic surface, slice-6 reuse)
// ----------------------------------------------------------------------------

test("createPlaylist(): posts snippet.title + private status, returns the new id", async () => {
  const http: ApiFetcher = async () => jsonResponse(200, { id: "PL_topic", snippet: { title: "woodworking" } });
  const result = await createPlaylist("woodworking", { http, getAccessToken: STUB_TOKEN });
  expect(result).toEqual({ id: "PL_topic", title: "woodworking" });
});

test("deletePlaylist(): issues a DELETE with the playlist id as a query param", async () => {
  const calls: ApiRequest[] = [];
  const http: ApiFetcher = async (req) => {
    calls.push(req);
    return { status: 204, body: "" };
  };

  await deletePlaylist("PL_x", { http, getAccessToken: STUB_TOKEN });

  expect(calls).toHaveLength(1);
  expect(calls[0]?.method).toBe("DELETE");
  expect(calls[0]?.url).toContain("id=PL_x");
});

// ----------------------------------------------------------------------------
// Fail-loud: auth + quota
// ----------------------------------------------------------------------------

test("quota/auth failure: HTTP 401 throws a PlaylistApiError with the re-consent pointer", async () => {
  const http: ApiFetcher = async () => jsonResponse(401, { error: { code: 401, message: "Invalid Credentials", errors: [{ reason: "authError" }] } });

  let threw: unknown = null;
  try {
    await insertPlaylistItem("PL_x", "vid1", { http, getAccessToken: STUB_TOKEN });
  } catch (err) {
    threw = err;
  }
  expect(threw).toBeInstanceOf(PlaylistApiError);
  expect((threw as PlaylistApiError).status).toBe(401);
  expect((threw as Error).message).toContain("YouTubeOAuthBootstrap.ts");
});

test("quota/auth failure: HTTP 403 quotaExceeded says so explicitly, not a generic auth failure", async () => {
  const http: ApiFetcher = async () =>
    jsonResponse(403, { error: { code: 403, message: "Quota exceeded", errors: [{ reason: "quotaExceeded" }] } });

  let threw: unknown = null;
  try {
    await insertPlaylistItem("PL_x", "vid1", { http, getAccessToken: STUB_TOKEN });
  } catch (err) {
    threw = err;
  }
  expect(threw).toBeInstanceOf(PlaylistApiError);
  expect((threw as Error).message).toContain("quota exceeded");
  expect((threw as Error).message).not.toContain("YouTubeOAuthBootstrap.ts");
});

test("quota/auth failure: HTTP 403 non-quota reason still points at the re-consent pointer", async () => {
  const http: ApiFetcher = async () =>
    jsonResponse(403, { error: { code: 403, message: "insufficient scope", errors: [{ reason: "insufficientPermissions" }] } });

  await expect(insertPlaylistItem("PL_x", "vid1", { http, getAccessToken: STUB_TOKEN })).rejects.toThrow(/YouTubeOAuthBootstrap\.ts/);
});

test("HTTP 500 (or any other non-2xx) throws with the status + message, never silently swallowed", async () => {
  const http: ApiFetcher = async () => ({ status: 500, body: JSON.stringify({ error: { message: "backend error" } }) });
  await expect(insertPlaylistItem("PL_x", "vid1", { http, getAccessToken: STUB_TOKEN })).rejects.toThrow(/HTTP 500/);
});

test("getAccessToken failure propagates without ever calling http (no request attempted without a token)", async () => {
  let httpCalls = 0;
  const http: ApiFetcher = async () => { httpCalls += 1; throw new Error("must not be called"); };
  const getAccessToken = async () => { throw new Error("no refresh token — re-consent required"); };

  await expect(insertPlaylistItem("PL_x", "vid1", { http, getAccessToken })).rejects.toThrow(/re-consent required/);
  expect(httpCalls).toBe(0);
});
