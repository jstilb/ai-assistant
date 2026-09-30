/**
 * SeedSourcer.test.ts — per-topic candidate sourcing (search.list ->
 * videos.list -> already-watched filter -> LLM judgment).
 *
 * Hermetic: HTTP is always an injected stub (zero real network/API-key
 * reads); the already-watched check always passes an explicit mkdtemp
 * dbPath (never CONFIG.dbPath); inferenceFn is always an injected stub
 * (zero live LLM calls).
 */

import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
// cross-skill-allowed: test seeds a fixture events.db through AppUsageTracker's real Db/schema so the already-watched check runs against a real table shape, not a hand-rolled mock
import { Db } from "../../AppUsageTracker/Tools/Db.ts";
import { LedgerLockError } from "../Tools/LedgerReader.ts";
import {
  type ApiGetFetcher,
  type ApiGetRequest,
  extractRubricSection,
  filterAlreadyWatched,
  getChannelDossiers,
  getVideosMetadata,
  readRubricSection,
  RUBRIC_CHANNEL_QUALITY_HEADING,
  RUBRIC_SEEDING_HEADING,
  searchTopicVideoIds,
  sourceTopicCandidates,
  TARGET_CANDIDATE_COUNT,
} from "../Tools/SeedSourcer.ts";

const TMP = mkdtempSync(join(tmpdir(), "yt-seedsourcer-test-"));

/** Minimal rubric fixture for hermetic pipeline tests — coverage against the REAL Rubric.md lives in the structural guard test below. */
const RUBRIC_FIXTURE_PATH = join(TMP, "rubric-fixture.md");
writeFileSync(
  RUBRIC_FIXTURE_PATH,
  ["## §Channel quality — fixture", "", "FIXTURE-QUALITY guidance", "", "## §Seeding — fixture", "", "FIXTURE-SEEDING guidance"].join("\n"),
);

afterAll(() => {
  rmSync(TMP, { recursive: true, force: true });
});

function jsonResponse(status: number, body: unknown) {
  return { status, body: JSON.stringify(body) };
}

async function fixtureDbWithHistory(name: string, watchedVideoIds: string[]): Promise<string> {
  const dbPath = join(TMP, name);
  const db = await Db.open(dbPath);
  try {
    await db.initSchema();
    for (const id of watchedVideoIds) {
      await db.run(
        `INSERT INTO youtube_history (ts, video_id, title, channel, channel_url, source_export) VALUES ($ts::TIMESTAMP, $id, $title, $channel, $url, $src)`,
        { ts: "2026-08-01T00:00:00Z", id, title: "Watched title", channel: "Some channel", url: null, src: "takeout:test" },
      );
    }
  } finally {
    db.close();
  }
  return dbPath;
}

// ----------------------------------------------------------------------------
// extractRubricSection() / readRubricSection()
// ----------------------------------------------------------------------------

const RUBRIC_FIXTURE = [
  "# Rubric — test fixture",
  "",
  "intro prose",
  "",
  '## §Channel quality — "does this channel earn trust?"',
  "",
  "farm signals here",
  "",
  "### a level-3 subheading that stays inside",
  "",
  "more prose",
  "",
  '## §History — next section',
  "",
  "history prose",
].join("\n");

test("extractRubricSection(): prefix-matches a heading with a descriptive suffix and stops at the next ## heading", () => {
  const section = extractRubricSection(RUBRIC_FIXTURE, "## §Channel quality");
  expect(section).toContain('## §Channel quality — "does this channel earn trust?"');
  expect(section).toContain("farm signals here");
  expect(section).toContain("### a level-3 subheading that stays inside");
  expect(section).toContain("more prose");
  expect(section).not.toContain("§History");
  expect(section).not.toContain("history prose");
});

test("extractRubricSection(): a section ending at EOF captures through the last line", () => {
  const section = extractRubricSection(RUBRIC_FIXTURE, "## §History");
  expect(section).toContain("history prose");
});

test("extractRubricSection(): missing heading throws loud, never judges without the rubric", () => {
  expect(() => extractRubricSection(RUBRIC_FIXTURE, "## §Seeding")).toThrow(/rubric section .* not found/);
});

test("readRubricSection(): unreadable path throws loud", () => {
  expect(() => readRubricSection(RUBRIC_SEEDING_HEADING, join(TMP, "no-such-rubric.md"))).toThrow(/cannot read rubric/);
});

test("readRubricSection(): structural guard — the REAL Rubric.md contains both seeding headings, extractable", () => {
  const channelQuality = readRubricSection(RUBRIC_CHANNEL_QUALITY_HEADING);
  const seeding = readRubricSection(RUBRIC_SEEDING_HEADING);
  expect(channelQuality).toContain("Content-farm");
  expect(channelQuality).not.toContain("§History —"); // extraction boundary: next section never bleeds in
  expect(seeding).toContain("Topic fit");
  expect(seeding).toContain("Channel trust");
});

// ----------------------------------------------------------------------------
// searchTopicVideoIds()
// ----------------------------------------------------------------------------

test("searchTopicVideoIds(): extracts video ids from a search.list response", async () => {
  const calls: ApiGetRequest[] = [];
  const http: ApiGetFetcher = async (req) => {
    calls.push(req);
    return jsonResponse(200, {
      items: [
        { id: { videoId: "v1" } },
        { id: { videoId: "v2" } },
        { id: { kind: "youtube#channel" } }, // no videoId — must be skipped, not throw
      ],
    });
  };

  const ids = await searchTopicVideoIds("woodworking", { http, apiKey: "stub-key" });

  expect(ids).toEqual(["v1", "v2"]);
  expect(calls).toHaveLength(1);
  expect(calls[0]?.url).toContain("/search?");
  expect(calls[0]?.url).toContain("q=woodworking");
  expect(calls[0]?.url).toContain("type=video");
});

test("searchTopicVideoIds(): throws loud on a non-2xx response", async () => {
  const http: ApiGetFetcher = async () => jsonResponse(403, { error: { message: "quotaExceeded" } });
  await expect(searchTopicVideoIds("x", { http, apiKey: "stub-key" })).rejects.toThrow(/quotaExceeded/);
});

test("searchTopicVideoIds(): throws loud when no API key is available (never silently no-ops)", async () => {
  const http: ApiGetFetcher = async () => jsonResponse(200, { items: [] });
  await expect(searchTopicVideoIds("x", { http, apiKey: "" })).rejects.toThrow(/YOUTUBE_API_KEY/);
});

// ----------------------------------------------------------------------------
// getVideosMetadata()
// ----------------------------------------------------------------------------

test("getVideosMetadata(): maps a videos.list response to full metadata incl. stats; missing parts degrade to null", async () => {
  const http: ApiGetFetcher = async (req) => {
    expect(req.url).toContain("/videos?");
    expect(req.url).toContain("id=v1%2Cv2");
    expect(req.url).toContain("part=snippet%2Cstatistics%2CcontentDetails");
    return jsonResponse(200, {
      items: [
        {
          id: "v1",
          snippet: { title: "Video One", channelTitle: "Chan A", channelId: "ch-a", description: "desc one", publishedAt: "2026-01-01T00:00:00Z" },
          statistics: { viewCount: "1000", likeCount: "40" },
          contentDetails: { duration: "PT12M4S" },
        },
        { id: "v2", snippet: { title: "Video Two", channelTitle: "Chan B" } }, // no stats/contentDetails — degrade to null
      ],
    });
  };

  const meta = await getVideosMetadata(["v1", "v2"], { http, apiKey: "stub-key" });

  expect(meta).toEqual([
    {
      videoId: "v1", title: "Video One", channel: "Chan A", channelId: "ch-a", description: "desc one",
      publishedAt: "2026-01-01T00:00:00Z", viewCount: "1000", likeCount: "40", duration: "PT12M4S",
    },
    {
      videoId: "v2", title: "Video Two", channel: "Chan B", channelId: null, description: null,
      publishedAt: null, viewCount: null, likeCount: null, duration: null,
    },
  ]);
});

test("getVideosMetadata(): empty input short-circuits with zero HTTP calls", async () => {
  let calls = 0;
  const http: ApiGetFetcher = async () => { calls += 1; return jsonResponse(200, { items: [] }); };
  const meta = await getVideosMetadata([], { http, apiKey: "stub-key" });
  expect(meta).toEqual([]);
  expect(calls).toBe(0);
});

// ----------------------------------------------------------------------------
// filterAlreadyWatched() — real fixture db, read-only
// ----------------------------------------------------------------------------

test("filterAlreadyWatched(): removes video ids present in youtube_history, keeps the rest", async () => {
  const dbPath = await fixtureDbWithHistory("watched.db", ["already-seen-1", "already-seen-2"]);

  const result = await filterAlreadyWatched(["already-seen-1", "fresh-1", "already-seen-2", "fresh-2"], { dbPath });

  expect(result.sort()).toEqual(["fresh-1", "fresh-2"]);
});

test("filterAlreadyWatched(): a fresh db with no youtube_history table degrades to 'nothing watched' (all ids kept)", async () => {
  const dbPath = join(TMP, "no-such-db.db");
  const result = await filterAlreadyWatched(["v1", "v2"], { dbPath });
  expect(result).toEqual(["v1", "v2"]);
});

test("filterAlreadyWatched(): empty input short-circuits without opening the db", async () => {
  const result = await filterAlreadyWatched([], { dbPath: join(TMP, "never-created.db") });
  expect(result).toEqual([]);
});

test("filterAlreadyWatched(): real cross-process lock contention throws LedgerLockError, not a silent skip", async () => {
  const dbPath = join(TMP, "locked.db");
  const seed = await Db.open(dbPath); // create the file up front (unlocked) so the holder subprocess can open it
  seed.close();

  const readyPath = join(TMP, "locked.ready");
  const releasePath = join(TMP, "locked.release");
  const holderScript = join(import.meta.dir, "fixtures", "lock-holder.ts");
  const child = spawn("bun", [holderScript, dbPath, readyPath, releasePath], { stdio: "ignore" });

  try {
    const deadline = Date.now() + 5_000;
    while (!existsSync(readyPath) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(existsSync(readyPath)).toBe(true);

    await expect(filterAlreadyWatched(["v1"], { dbPath, timeoutMs: 2_000 })).rejects.toBeInstanceOf(LedgerLockError);
  } finally {
    Bun.write(releasePath, "release");
    await new Promise<void>((resolve) => {
      child.once("exit", () => resolve());
      setTimeout(resolve, 3000);
    });
  }
});

// ----------------------------------------------------------------------------
// sourceTopicCandidates() — full composed pipeline
// ----------------------------------------------------------------------------

test("sourceTopicCandidates(): composes search -> metadata -> watched-filter -> LLM selection end to end", async () => {
  const dbPath = await fixtureDbWithHistory("compose-watched.db", ["watched-1"]);

  const http: ApiGetFetcher = async (req) => {
    if (req.url.includes("/search?")) {
      return jsonResponse(200, {
        items: [
          { id: { videoId: "watched-1" } }, // filtered out by watched-check
          { id: { videoId: "fresh-1" } },
          { id: { videoId: "fresh-2" } },
        ],
      });
    }
    if (req.url.includes("/channels?")) {
      return jsonResponse(200, {
        items: [
          {
            id: "ch-a",
            snippet: { title: "Chan A", description: "a real creator", publishedAt: "2020-05-01T00:00:00Z" },
            statistics: { subscriberCount: "52000", videoCount: "140" },
            contentDetails: { relatedPlaylists: { uploads: "UU-ch-a" } },
          },
          {
            id: "ch-b",
            snippet: { title: "Chan B", description: "another creator", publishedAt: "2021-02-01T00:00:00Z" },
            statistics: { subscriberCount: "9000", videoCount: "80" },
            contentDetails: { relatedPlaylists: { uploads: "UU-ch-b" } },
          },
        ],
      });
    }
    if (req.url.includes("/playlistItems?")) {
      return jsonResponse(200, { items: [{ snippet: { title: "A recent upload" } }] });
    }
    // /videos — only fresh-1/fresh-2 should ever be requested (watched-1 was filtered first)
    expect(req.url).not.toContain("watched-1");
    return jsonResponse(200, {
      items: [
        { id: "fresh-1", snippet: { title: "Fresh One", channelTitle: "Chan A", channelId: "ch-a", description: "on topic" } },
        { id: "fresh-2", snippet: { title: "Fresh Two", channelTitle: "Chan B", channelId: "ch-b", description: "also on topic" } },
      ],
    });
  };

  let inferencePrompt = "";
  let inferenceSystemPrompt = "";
  const inferenceFn = async (opts: { systemPrompt: string; userPrompt: string }) => {
    inferenceSystemPrompt = opts.systemPrompt;
    inferencePrompt = opts.userPrompt;
    return {
      success: true,
      output: "",
      parsed: { selectedVideoIds: ["fresh-2", "fresh-1"], rejectedForQuality: [] }, // LLM's preference order
      latencyMs: 1,
      level: "standard" as const,
      estimatedTokens: { input: 0, output: 0, total: 0 },
      estimatedCostUSD: 0,
    };
  };

  const result = await sourceTopicCandidates("woodworking", ["woodworking", "jazz guitar"], {
    http,
    apiKey: "stub-key",
    dbPath,
    inferenceFn,
    rubricPath: RUBRIC_FIXTURE_PATH,
  });

  expect(result.topic).toBe("woodworking");
  expect(result.searched).toBe(3);
  expect(result.afterWatchedFilter).toBe(2);
  expect(result.candidates).toEqual([
    { videoId: "fresh-2", title: "Fresh Two", channel: "Chan B" },
    { videoId: "fresh-1", title: "Fresh One", channel: "Chan A" },
  ]);
  expect(result.rejectedForQuality).toEqual([]);
  expect(inferenceSystemPrompt).toContain("FIXTURE-QUALITY guidance"); // the rubric IS the prompt criteria
  expect(inferenceSystemPrompt).toContain("FIXTURE-SEEDING guidance");
  expect(inferencePrompt).toContain("fresh-1");
  expect(inferencePrompt).toContain("fresh-2");
  expect(inferencePrompt).not.toContain("watched-1");
  expect(inferencePrompt).toContain("subscribers 52000"); // channel dossier reaches the LLM
  expect(inferencePrompt).toContain('"A recent upload"');
});

test("sourceTopicCandidates(): caps at TARGET_CANDIDATE_COUNT even if the LLM selects more", async () => {
  const dbPath = join(TMP, "cap-test.db");
  const allIds = Array.from({ length: 15 }, (_, i) => `v${i}`);

  const http: ApiGetFetcher = async (req) => {
    if (req.url.includes("/search?")) {
      return jsonResponse(200, { items: allIds.map((id) => ({ id: { videoId: id } })) });
    }
    if (req.url.includes("/channels?") || req.url.includes("/playlistItems?")) {
      return jsonResponse(200, { items: [] });
    }
    return jsonResponse(200, {
      items: allIds.map((id) => ({ id, snippet: { title: id, channelTitle: "Chan" } })),
    });
  };
  const inferenceFn = async () => ({
    success: true,
    output: "",
    parsed: { selectedVideoIds: allIds, rejectedForQuality: [] }, // LLM over-selects all 15
    latencyMs: 1,
    level: "standard" as const,
    estimatedTokens: { input: 0, output: 0, total: 0 },
    estimatedCostUSD: 0,
  });

  const result = await sourceTopicCandidates("topic", ["topic"], { http, apiKey: "stub-key", dbPath, inferenceFn, rubricPath: RUBRIC_FIXTURE_PATH });

  expect(result.candidates.length).toBe(TARGET_CANDIDATE_COUNT);
});

test("sourceTopicCandidates(): a hallucinated video id outside the candidate set is silently dropped, not trusted", async () => {
  const dbPath = join(TMP, "hallucination-test.db");
  const http: ApiGetFetcher = async (req) => {
    if (req.url.includes("/search?")) return jsonResponse(200, { items: [{ id: { videoId: "real-1" } }] });
    if (req.url.includes("/channels?") || req.url.includes("/playlistItems?")) return jsonResponse(200, { items: [] });
    return jsonResponse(200, { items: [{ id: "real-1", snippet: { title: "Real One", channelTitle: "Chan" } }] });
  };
  const inferenceFn = async () => ({
    success: true,
    output: "",
    parsed: { selectedVideoIds: ["real-1", "invented-id-not-in-candidates"], rejectedForQuality: [] },
    latencyMs: 1,
    level: "standard" as const,
    estimatedTokens: { input: 0, output: 0, total: 0 },
    estimatedCostUSD: 0,
  });

  const result = await sourceTopicCandidates("topic", ["topic"], { http, apiKey: "stub-key", dbPath, inferenceFn, rubricPath: RUBRIC_FIXTURE_PATH });

  expect(result.candidates).toEqual([{ videoId: "real-1", title: "Real One", channel: "Chan" }]);
});

test("sourceTopicCandidates(): zero search results short-circuits with empty candidates and no metadata/inference calls", async () => {
  const dbPath = join(TMP, "zero-results.db");
  let metadataCalled = false;
  let dossierCalled = false;
  let inferenceCalled = false;
  const http: ApiGetFetcher = async (req) => {
    if (req.url.includes("/search?")) return jsonResponse(200, { items: [] });
    if (req.url.includes("/channels?") || req.url.includes("/playlistItems?")) {
      dossierCalled = true;
      return jsonResponse(200, { items: [] });
    }
    metadataCalled = true;
    return jsonResponse(200, { items: [] });
  };
  const inferenceFn = async () => {
    inferenceCalled = true;
    return {
      success: true, output: "", parsed: { selectedVideoIds: [], rejectedForQuality: [] }, latencyMs: 1,
      level: "standard" as const, estimatedTokens: { input: 0, output: 0, total: 0 }, estimatedCostUSD: 0,
    };
  };

  const result = await sourceTopicCandidates("topic", ["topic"], { http, apiKey: "stub-key", dbPath, inferenceFn, rubricPath: RUBRIC_FIXTURE_PATH });

  expect(result).toEqual({ topic: "topic", candidates: [], rejectedForQuality: [], searched: 0, afterWatchedFilter: 0 });
  expect(metadataCalled).toBe(false);
  expect(dossierCalled).toBe(false);
  expect(inferenceCalled).toBe(false);
});

test("sourceTopicCandidates(): every search result already watched short-circuits before metadata/inference", async () => {
  const dbPath = await fixtureDbWithHistory("all-watched.db", ["w1", "w2"]);
  let metadataCalled = false;
  let dossierCalled = false;
  const http: ApiGetFetcher = async (req) => {
    if (req.url.includes("/search?")) return jsonResponse(200, { items: [{ id: { videoId: "w1" } }, { id: { videoId: "w2" } }] });
    if (req.url.includes("/channels?") || req.url.includes("/playlistItems?")) {
      dossierCalled = true;
      return jsonResponse(200, { items: [] });
    }
    metadataCalled = true;
    return jsonResponse(200, { items: [] });
  };

  const result = await sourceTopicCandidates("topic", ["topic"], { http, apiKey: "stub-key", dbPath, rubricPath: RUBRIC_FIXTURE_PATH });

  expect(result).toEqual({ topic: "topic", candidates: [], rejectedForQuality: [], searched: 2, afterWatchedFilter: 0 });
  expect(metadataCalled).toBe(false);
  expect(dossierCalled).toBe(false);
});

test("sourceTopicCandidates(): inference failure throws loud rather than returning an empty/silent result", async () => {
  const dbPath = join(TMP, "inference-fail.db");
  const http: ApiGetFetcher = async (req) => {
    if (req.url.includes("/search?")) return jsonResponse(200, { items: [{ id: { videoId: "v1" } }] });
    if (req.url.includes("/channels?") || req.url.includes("/playlistItems?")) return jsonResponse(200, { items: [] });
    return jsonResponse(200, { items: [{ id: "v1", snippet: { title: "T", channelTitle: "C" } }] });
  };
  const inferenceFn = async () => ({
    success: false, output: "", error: "model timeout", latencyMs: 1,
    level: "standard" as const, estimatedTokens: { input: 0, output: 0, total: 0 }, estimatedCostUSD: 0,
  });

  await expect(
    sourceTopicCandidates("topic", ["topic"], { http, apiKey: "stub-key", dbPath, inferenceFn, rubricPath: RUBRIC_FIXTURE_PATH }),
  ).rejects.toThrow(/model timeout/);
});

// ----------------------------------------------------------------------------
// getChannelDossiers()
// ----------------------------------------------------------------------------

test("getChannelDossiers(): maps channels.list + uploads titles; hidden subscriber count degrades to null; dupes deduped", async () => {
  const calls: string[] = [];
  const http: ApiGetFetcher = async (req) => {
    calls.push(req.url);
    if (req.url.includes("/channels?")) {
      return jsonResponse(200, {
        items: [
          {
            id: "ch-a",
            snippet: { title: "Chan A", description: "a creator", publishedAt: "2020-05-01T00:00:00Z" },
            statistics: { subscriberCount: "52000", videoCount: "140" },
            contentDetails: { relatedPlaylists: { uploads: "UU-a" } },
          },
          {
            id: "ch-b",
            snippet: { title: "Chan B" },
            statistics: { hiddenSubscriberCount: true, subscriberCount: "0", videoCount: "9" },
            // no contentDetails -> no uploads fetch, [] titles
          },
        ],
      });
    }
    expect(req.url).toContain("playlistId=UU-a");
    return jsonResponse(200, { items: [{ snippet: { title: "Upload One" } }, { snippet: { title: "Upload Two" } }, { snippet: {} }] });
  };

  const dossiers = await getChannelDossiers(["ch-a", "ch-b", "ch-a"], { http, apiKey: "stub-key" });

  expect(dossiers).toEqual([
    {
      channelId: "ch-a", title: "Chan A", description: "a creator", subscriberCount: "52000",
      videoCount: "140", publishedAt: "2020-05-01T00:00:00Z", recentUploadTitles: ["Upload One", "Upload Two"],
    },
    {
      channelId: "ch-b", title: "Chan B", description: null, subscriberCount: null,
      videoCount: "9", publishedAt: null, recentUploadTitles: [],
    },
  ]);
  expect(calls.filter((u) => u.includes("/channels?"))).toHaveLength(1); // deduped into one batch
});

test("getChannelDossiers(): empty input short-circuits with zero HTTP calls", async () => {
  let calls = 0;
  const http: ApiGetFetcher = async () => { calls += 1; return jsonResponse(200, { items: [] }); };
  expect(await getChannelDossiers([], { http, apiKey: "stub-key" })).toEqual([]);
  expect(calls).toBe(0);
});

test("getChannelDossiers(): >50 unique ids batch into multiple <=50-id channels.list calls", async () => {
  const ids = Array.from({ length: 60 }, (_, i) => `chan${i}`);
  const channelCalls: string[] = [];
  const http: ApiGetFetcher = async (req) => {
    if (req.url.includes("/channels?")) {
      channelCalls.push(req.url);
      return jsonResponse(200, { items: [] }); // batching is what's under test, not mapping
    }
    return jsonResponse(200, { items: [] });
  };
  await getChannelDossiers(ids, { http, apiKey: "stub-key" });
  expect(channelCalls).toHaveLength(2);
  expect(channelCalls[0]).toContain("chan0%2C");
  expect(channelCalls[1]).toContain("chan59");
});

test("getChannelDossiers(): channels.list failure throws loud (core dossier data)", async () => {
  const http: ApiGetFetcher = async (req) => {
    if (req.url.includes("/channels?")) return jsonResponse(500, { error: { message: "backend blew up" } });
    return jsonResponse(200, { items: [] });
  };
  await expect(getChannelDossiers(["ch-a"], { http, apiKey: "stub-key" })).rejects.toThrow(/backend blew up/);
});

test("getChannelDossiers(): a per-channel uploads-fetch failure degrades that ONE channel to [] titles, not a throw", async () => {
  const http: ApiGetFetcher = async (req) => {
    if (req.url.includes("/channels?")) {
      return jsonResponse(200, {
        items: [
          { id: "ch-ok", snippet: { title: "OK" }, contentDetails: { relatedPlaylists: { uploads: "UU-ok" } } },
          { id: "ch-bad", snippet: { title: "Bad" }, contentDetails: { relatedPlaylists: { uploads: "UU-bad" } } },
        ],
      });
    }
    if (req.url.includes("UU-bad")) return jsonResponse(404, { error: { message: "playlist gone" } });
    return jsonResponse(200, { items: [{ snippet: { title: "Still here" } }] });
  };

  const dossiers = await getChannelDossiers(["ch-ok", "ch-bad"], { http, apiKey: "stub-key" });

  expect(dossiers.find((d) => d.channelId === "ch-ok")?.recentUploadTitles).toEqual(["Still here"]);
  expect(dossiers.find((d) => d.channelId === "ch-bad")?.recentUploadTitles).toEqual([]);
});

// ----------------------------------------------------------------------------
// rejectedForQuality + rubric fail-loud
// ----------------------------------------------------------------------------

test("sourceTopicCandidates(): rejectedForQuality entries are enriched for the report; hallucinated ids and dupes dropped", async () => {
  const dbPath = join(TMP, "reject-test.db");
  const http: ApiGetFetcher = async (req) => {
    if (req.url.includes("/search?")) return jsonResponse(200, { items: [{ id: { videoId: "good-1" } }, { id: { videoId: "farm-1" } }] });
    if (req.url.includes("/channels?") || req.url.includes("/playlistItems?")) return jsonResponse(200, { items: [] });
    return jsonResponse(200, {
      items: [
        { id: "good-1", snippet: { title: "Good One", channelTitle: "Real Chan" } },
        { id: "farm-1", snippet: { title: "SHOCKING!!", channelTitle: "Farm Chan" } },
      ],
    });
  };
  const inferenceFn = async () => ({
    success: true,
    output: "",
    parsed: {
      selectedVideoIds: ["good-1"],
      rejectedForQuality: [
        { videoId: "farm-1", reason: "templated clickbait channel" },
        { videoId: "farm-1", reason: "dupe entry" }, // deduped
        { videoId: "invented-id", reason: "hallucinated" }, // dropped — not in candidate set
      ],
    },
    latencyMs: 1, level: "standard" as const, estimatedTokens: { input: 0, output: 0, total: 0 }, estimatedCostUSD: 0,
  });

  const result = await sourceTopicCandidates("topic", ["topic"], { http, apiKey: "stub-key", dbPath, inferenceFn, rubricPath: RUBRIC_FIXTURE_PATH });

  expect(result.rejectedForQuality).toEqual([
    { videoId: "farm-1", title: "SHOCKING!!", channel: "Farm Chan", reason: "templated clickbait channel" },
  ]);
});

test("sourceTopicCandidates(): a rubric missing the seeding sections throws BEFORE any HTTP or inference call", async () => {
  const badRubricPath = join(TMP, "rubric-missing-sections.md");
  writeFileSync(badRubricPath, "# Rubric\n\n## §History — only\n\nprose");
  let httpCalls = 0;
  let inferenceCalled = false;
  const http: ApiGetFetcher = async () => { httpCalls += 1; return jsonResponse(200, { items: [] }); };
  const inferenceFn = async () => {
    inferenceCalled = true;
    return {
      success: true, output: "", parsed: { selectedVideoIds: [], rejectedForQuality: [] }, latencyMs: 1,
      level: "standard" as const, estimatedTokens: { input: 0, output: 0, total: 0 }, estimatedCostUSD: 0,
    };
  };

  await expect(
    sourceTopicCandidates("topic", ["topic"], { http, apiKey: "stub-key", dbPath: join(TMP, "unused.db"), inferenceFn, rubricPath: badRubricPath }),
  ).rejects.toThrow(/rubric section .* not found/);
  expect(httpCalls).toBe(0);
  expect(inferenceCalled).toBe(false);
});
