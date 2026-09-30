/**
 * YouTubeClassifier.test.ts — verifies per-video low-value classification
 * with DI'd LLM. Never spawns claude -p.
 */

import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Db } from "../Tools/Db.ts";
import {
  classifyYouTubeVideos,
  type YouTubeLlmClassifier,
} from "../Tools/YouTubeClassifier.ts";

const TMP = mkdtempSync(join(tmpdir(), "aw-yt-classifier-"));
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
  await db.run("DELETE FROM youtube_verdicts");
});

async function insertVideo(id: string, opts: {
  title?: string; channel?: string; duration_sec?: number; tags?: string[]; categoryId?: number; err?: string;
  watchedAt?: string;
}): Promise<void> {
  await db.run(
    `INSERT OR REPLACE INTO youtube_videos
       (video_id, title, channel, channel_id, duration_sec, category_id, tags_json, enriched_at, enrich_error)
     VALUES ($id, $title, $channel, NULL, $dur, $cat, $tags, $now::TIMESTAMP, $err)`,
    {
      id,
      title: opts.title ?? "untitled",
      channel: opts.channel ?? "test",
      dur: opts.duration_sec ?? null,
      cat: opts.categoryId ?? null,
      tags: JSON.stringify(opts.tags ?? []),
      now: new Date().toISOString(),
      err: opts.err ?? null,
    },
  );
  await db.run(
    `INSERT OR REPLACE INTO youtube_history (ts, video_id, title, channel, channel_url, source_export)
     VALUES ($ts::TIMESTAMP, $id, $title, $channel, NULL, 'test')`,
    {
      id, title: opts.title ?? "untitled", channel: opts.channel ?? "test",
      ts: opts.watchedAt ?? new Date().toISOString(),
    },
  );
}

function stubLlm(verdicts: Record<string, boolean>, calls?: string[]): YouTubeLlmClassifier {
  return async (input) => {
    if (calls) calls.push(input.video_id);
    return {
      verdict: {
        is_low_value: verdicts[input.video_id] ?? false,
        reason: `stub:${input.video_id}`,
        confidence: 0.85,
      },
      tokensIn: 100, tokensOut: 30, estCostUSD: 0.0005,
    };
  };
}

test("classifies single unenriched-then-verdict-missing video", async () => {
  await insertVideo("vid_A", { title: "drama", duration_sec: 600 });
  const calls: string[] = [];
  const summary = await classifyYouTubeVideos({
    db, llm: stubLlm({ "vid_A": true }, calls),
  });
  expect(summary.classified).toBe(1);
  expect(calls).toEqual(["vid_A"]);
  const row = await db.queryRow<{ is_low_value: boolean; reason: string; classifier: string }>(
    `SELECT is_low_value, reason, classifier FROM youtube_verdicts WHERE video_id='vid_A'`,
  );
  expect(row!.is_low_value).toBe(true);
  expect(row!.classifier).toBe("llm-sonnet");
});

test("skips videos that already have a verdict", async () => {
  await insertVideo("vid_A", { duration_sec: 60 });
  const calls: string[] = [];
  await classifyYouTubeVideos({ db, llm: stubLlm({ "vid_A": true }, calls) });
  await classifyYouTubeVideos({ db, llm: stubLlm({ "vid_A": true }, calls) });
  expect(calls).toEqual(["vid_A"]); // only first run
});

test("force=true re-classifies all videos", async () => {
  await insertVideo("vid_A", { duration_sec: 60 });
  const calls: string[] = [];
  await classifyYouTubeVideos({ db, llm: stubLlm({ "vid_A": true }, calls) });
  await classifyYouTubeVideos({ db, llm: stubLlm({ "vid_A": false }, calls), force: true });
  expect(calls).toEqual(["vid_A", "vid_A"]);
});

test("skips videos with enrich_error (no data to classify on)", async () => {
  await insertVideo("vid_gone", { title: null as unknown as string, err: "not found" });
  const calls: string[] = [];
  const summary = await classifyYouTubeVideos({
    db, llm: stubLlm({}, calls),
  });
  expect(summary.classified).toBe(0);
  expect(summary.skipped_no_metadata).toBe(1);
  expect(calls).toEqual([]);
});

test("limit caps LLM calls per run", async () => {
  for (let i = 0; i < 5; i++) await insertVideo(`vid_${i}`, { duration_sec: 60 });
  const calls: string[] = [];
  const summary = await classifyYouTubeVideos({
    db, llm: stubLlm({}, calls), limit: 2,
  });
  expect(summary.classified).toBe(2);
  expect(calls.length).toBe(2);
});

test("classifies most-recently-watched videos first when limited", async () => {
  // Video IDs are deliberately the INVERSE of recency order alphabetically:
  // newest = vid_z (alpha-last), oldest = vid_a (alpha-first). A plain
  // ORDER BY video_id would classify vid_a + vid_m; recency picks vid_z + vid_m.
  await insertVideo("vid_a", { duration_sec: 60, watchedAt: "2021-01-01T00:00:00Z" });
  await insertVideo("vid_z", { duration_sec: 60, watchedAt: "2026-05-14T00:00:00Z" });
  await insertVideo("vid_m", { duration_sec: 60, watchedAt: "2024-06-01T00:00:00Z" });
  const calls: string[] = [];
  const summary = await classifyYouTubeVideos({
    db, llm: stubLlm({}, calls), limit: 2,
  });
  expect(summary.classified).toBe(2);
  // Newest first: vid_z (2026), then vid_m (2024); vid_a (2021) skipped.
  expect(calls).toEqual(["vid_z", "vid_m"]);
});

test("recency order uses the latest watch when a video has multiple opens", async () => {
  // vid_Z first watched long ago, then re-watched recently → ranks newest.
  // vid_A (alpha-first) watched 2024. ORDER BY video_id would pick vid_A.
  await insertVideo("vid_Z", { duration_sec: 60, watchedAt: "2022-01-01T00:00:00Z" });
  await db.run(
    `INSERT OR REPLACE INTO youtube_history (ts, video_id, title, channel, channel_url, source_export)
     VALUES ('2026-05-10T00:00:00Z'::TIMESTAMP, 'vid_Z', 'untitled', 'test', NULL, 'test')`,
  );
  await insertVideo("vid_A", { duration_sec: 60, watchedAt: "2024-01-01T00:00:00Z" });
  const calls: string[] = [];
  await classifyYouTubeVideos({ db, llm: stubLlm({}, calls), limit: 1 });
  expect(calls).toEqual(["vid_Z"]); // re-watched 2026 beats vid_A 2024
});

test("dry-run does not write verdicts", async () => {
  await insertVideo("vid_A", { duration_sec: 60 });
  let llmCalls = 0;
  const stub: YouTubeLlmClassifier = async () => {
    llmCalls++;
    return { verdict: { is_low_value: true, reason: "x", confidence: 0.5 }, tokensIn: 0, tokensOut: 0, estCostUSD: 0 };
  };
  const summary = await classifyYouTubeVideos({ db, llm: stub, dryRun: true });
  expect(llmCalls).toBe(0);
  expect(summary.would_call_llm).toBe(1);
  const cnt = await db.queryRow<{ n: number | bigint }>(`SELECT COUNT(*) AS n FROM youtube_verdicts`);
  expect(Number(cnt!.n)).toBe(0);
});

test("only classifies videos that have a history row (skips orphan enriched-only videos)", async () => {
  // Insert a video row WITHOUT a history row → should not be considered.
  await db.run(
    `INSERT OR REPLACE INTO youtube_videos
       (video_id, title, channel, channel_id, duration_sec, category_id, tags_json, enriched_at, enrich_error)
     VALUES ('orphan', 'x', 'y', NULL, 60, 22, '[]', $now::TIMESTAMP, NULL)`,
    { now: new Date().toISOString() },
  );
  const calls: string[] = [];
  const summary = await classifyYouTubeVideos({ db, llm: stubLlm({}, calls) });
  expect(summary.candidate_videos).toBe(0);
  expect(calls).toEqual([]);
});
