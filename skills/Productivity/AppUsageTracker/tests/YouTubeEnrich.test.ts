/**
 * YouTubeEnrich.test.ts — verifies that unenriched video_ids in youtube_history
 * get hydrated into youtube_videos via the (DI-injected) API fetcher. NEVER
 * hits the live YouTube Data API.
 */

import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Db } from "../Tools/Db.ts";
import {
  enrichYouTubeVideos,
  parseIsoDuration,
  type EnrichedVideo,
  type VideoFetcher,
} from "../Tools/YouTubeEnrich.ts";

const TMP = mkdtempSync(join(tmpdir(), "aw-yt-enrich-"));
const DB_PATH = join(TMP, "events.db");
let db: Db;

beforeAll(async () => {
  db = await Db.open(DB_PATH);
  await db.initSchema();
});

afterAll(() => {
  if (db) db.close();
  rmSync(TMP, { recursive: true, force: true });
});

beforeEach(async () => {
  await db.run("DELETE FROM youtube_history");
  await db.run("DELETE FROM youtube_videos");
});

async function insertHistory(id: string, title: string, time: string): Promise<void> {
  await db.run(
    `INSERT OR REPLACE INTO youtube_history (ts, video_id, title, channel, channel_url, source_export)
     VALUES ($ts::TIMESTAMP, $id, $title, 'TestChannel', 'http://channel', 'test')`,
    { ts: time, id, title },
  );
}

function makeStubFetcher(responses: Record<string, Partial<EnrichedVideo>>, calls?: string[][]): VideoFetcher {
  return async (ids: string[]) => {
    if (calls) calls.push([...ids]);
    return ids.flatMap(id => {
      const r = responses[id];
      if (r == null) return [];
      return [{
        video_id: id,
        duration_sec: r.duration_sec ?? null,
        category_id: r.category_id ?? null,
        tags: r.tags ?? [],
        channel_id: r.channel_id ?? null,
      }];
    });
  };
}

// ---- parseIsoDuration ----

test("parseIsoDuration: PT8M32S → 512s", () => {
  expect(parseIsoDuration("PT8M32S")).toBe(512);
});

test("parseIsoDuration: PT1H30M → 5400s", () => {
  expect(parseIsoDuration("PT1H30M")).toBe(5400);
});

test("parseIsoDuration: PT45S → 45s (shorts)", () => {
  expect(parseIsoDuration("PT45S")).toBe(45);
});

test("parseIsoDuration: bogus/empty returns null", () => {
  expect(parseIsoDuration("")).toBeNull();
  expect(parseIsoDuration("nope")).toBeNull();
  expect(parseIsoDuration("PT")).toBeNull();
});

// ---- enrichYouTubeVideos ----

test("enrich: empty history → no fetch, no rows", async () => {
  const calls: string[][] = [];
  const summary = await enrichYouTubeVideos({
    db, fetcher: makeStubFetcher({}, calls),
  });
  expect(summary.requested).toBe(0);
  expect(summary.enriched).toBe(0);
  expect(calls.length).toBe(0);
});

test("enrich: single unenriched id → 1 row in youtube_videos", async () => {
  await insertHistory("vid_A", "Bun talk", "2026-05-10T15:00:00Z");
  const calls: string[][] = [];
  const summary = await enrichYouTubeVideos({
    db,
    fetcher: makeStubFetcher({
      "vid_A": { duration_sec: 512, category_id: 28, tags: ["bun", "javascript"], channel_id: "UC123" },
    }, calls),
  });
  expect(summary.requested).toBe(1);
  expect(summary.enriched).toBe(1);
  expect(calls).toEqual([["vid_A"]]);

  const row = await db.queryRow<{
    video_id: string; duration_sec: number | bigint | null;
    category_id: number | bigint | null; tags_json: string; channel_id: string;
  }>(`SELECT video_id, duration_sec, category_id, tags_json, channel_id FROM youtube_videos`);
  expect(row!.video_id).toBe("vid_A");
  expect(Number(row!.duration_sec)).toBe(512);
  expect(Number(row!.category_id)).toBe(28);
  expect(JSON.parse(row!.tags_json)).toEqual(["bun", "javascript"]);
  expect(row!.channel_id).toBe("UC123");
});

test("enrich: batches IDs in groups of 50", async () => {
  for (let i = 0; i < 120; i++) {
    await insertHistory(`vid_${i}`, `title ${i}`, `2026-05-10T15:${String(i % 60).padStart(2, "0")}:00Z`);
  }
  const responses: Record<string, Partial<EnrichedVideo>> = {};
  for (let i = 0; i < 120; i++) responses[`vid_${i}`] = { duration_sec: 60 };
  const calls: string[][] = [];
  const summary = await enrichYouTubeVideos({ db, fetcher: makeStubFetcher(responses, calls) });
  expect(summary.requested).toBe(120);
  expect(summary.enriched).toBe(120);
  expect(calls.length).toBe(3);
  expect(calls[0].length).toBe(50);
  expect(calls[1].length).toBe(50);
  expect(calls[2].length).toBe(20);
});

test("enrich: idempotent — second run skips already-enriched videos", async () => {
  await insertHistory("vid_A", "A", "2026-05-10T15:00:00Z");
  const calls: string[][] = [];
  await enrichYouTubeVideos({
    db, fetcher: makeStubFetcher({ "vid_A": { duration_sec: 60 } }, calls),
  });
  await enrichYouTubeVideos({
    db, fetcher: makeStubFetcher({ "vid_A": { duration_sec: 60 } }, calls),
  });
  expect(calls.length).toBe(1); // only first run
});

test("enrich: limit caps requested IDs", async () => {
  for (let i = 0; i < 10; i++) {
    await insertHistory(`vid_${i}`, `t${i}`, `2026-05-10T15:${String(i).padStart(2, "0")}:00Z`);
  }
  const responses: Record<string, Partial<EnrichedVideo>> = {};
  for (let i = 0; i < 10; i++) responses[`vid_${i}`] = { duration_sec: 60 };
  const summary = await enrichYouTubeVideos({
    db, fetcher: makeStubFetcher(responses), limit: 3,
  });
  expect(summary.requested).toBe(3);
  expect(summary.enriched).toBe(3);
});

test("enrich: missing video (deleted/private) records enrich_error", async () => {
  await insertHistory("vid_gone", "gone", "2026-05-10T15:00:00Z");
  // Fetcher returns no entry for vid_gone
  await enrichYouTubeVideos({ db, fetcher: makeStubFetcher({}) });
  const row = await db.queryRow<{ enrich_error: string | null; duration_sec: number | bigint | null }>(
    `SELECT enrich_error, duration_sec FROM youtube_videos WHERE video_id='vid_gone'`,
  );
  expect(row!.enrich_error).toContain("not found");
  expect(row!.duration_sec).toBeNull();
});

test("enrich: force=true re-fetches even already-enriched", async () => {
  await insertHistory("vid_A", "A", "2026-05-10T15:00:00Z");
  const calls: string[][] = [];
  await enrichYouTubeVideos({
    db, fetcher: makeStubFetcher({ "vid_A": { duration_sec: 60 } }, calls),
  });
  await enrichYouTubeVideos({
    db, fetcher: makeStubFetcher({ "vid_A": { duration_sec: 60 } }, calls), force: true,
  });
  expect(calls.length).toBe(2);
});
