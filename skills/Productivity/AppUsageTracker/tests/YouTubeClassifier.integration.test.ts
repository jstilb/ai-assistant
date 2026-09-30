/**
 * YouTubeClassifier.integration.test.ts — LIVE end-to-end check.
 *
 * Unlike YouTubeClassifier.test.ts (which DI-stubs the LLM), this exercises the
 * REAL `defaultYouTubeClassifier` → real `inference()` → real `claude -p`
 * subprocess, against a throwaway temp DB. It is the only test that actually
 * proves the production classification path — including the retry-on-transient-
 * stall behavior added to the `inference()` call — works end to end.
 *
 * Gated behind KAYA_LIVE_INFERENCE so normal `bun test` and the nightly
 * pipeline never spawn claude -p (cost + flakiness). Run on demand:
 *
 *   KAYA_LIVE_INFERENCE=1 bun test \
 *     ~/.claude/skills/Productivity/AppUsageTracker/tests/YouTubeClassifier.integration.test.ts
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Db } from "../Tools/Db.ts";
import { classifyYouTubeVideos } from "../Tools/YouTubeClassifier.ts";

const SKIP = !process.env.KAYA_LIVE_INFERENCE;
const LIVE_TIMEOUT_MS = 300_000; // two serial real claude -p calls, each up to 90s + retries

const TMP = mkdtempSync(join(tmpdir(), "aw-yt-classifier-live-"));
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

async function insertVideo(id: string, opts: {
  title: string; channel: string; duration_sec: number; tags?: string[]; categoryId?: number;
}): Promise<void> {
  const now = new Date().toISOString();
  await db.run(
    `INSERT OR REPLACE INTO youtube_videos
       (video_id, title, channel, channel_id, duration_sec, category_id, tags_json, enriched_at, enrich_error)
     VALUES ($id, $title, $channel, NULL, $dur, $cat, $tags, $now::TIMESTAMP, NULL)`,
    { id, title: opts.title, channel: opts.channel, dur: opts.duration_sec,
      cat: opts.categoryId ?? null, tags: JSON.stringify(opts.tags ?? []), now },
  );
  await db.run(
    `INSERT OR REPLACE INTO youtube_history (ts, video_id, title, channel, channel_url, source_export)
     VALUES ($now::TIMESTAMP, $id, $title, $channel, NULL, 'integration-test')`,
    { id, title: opts.title, channel: opts.channel, now },
  );
}

describe.skipIf(SKIP)("YouTubeClassifier — LIVE end-to-end via real claude -p", () => {
  test("classifies real videos through the production inference path", async () => {
    // One unambiguously educational, one unambiguously low-value, so the
    // semantic assertion below is robust to normal model variance.
    await insertVideo("edu_tcp", {
      title: "Understanding TCP Congestion Control — A Deep Technical Dive",
      channel: "Computerphile", duration_sec: 1800, categoryId: 28,
      tags: ["networking", "tcp", "computer science", "tutorial"],
    });
    await insertVideo("low_drama", {
      title: "INSANE Celebrity Drama Reaction!! 😱 You WON'T Believe What Happened",
      channel: "DramaAlert Daily", duration_sec: 420, categoryId: 24,
      tags: ["drama", "reaction", "celebrity", "gossip"],
    });

    // No `llm` override → real defaultYouTubeClassifier → real claude -p.
    const summary = await classifyYouTubeVideos({ db, force: true });

    // Integration contract: both videos went through the real path with no errors.
    expect(summary.errors).toBe(0);
    expect(summary.classified).toBe(2);
    expect(summary.tokens_in).toBeGreaterThan(0);
    expect(summary.tokens_out).toBeGreaterThan(0);

    // Both produced a well-formed, persisted verdict.
    for (const id of ["edu_tcp", "low_drama"]) {
      const row = await db.queryRow<{ is_low_value: boolean; confidence: number; classifier: string; reason: string }>(
        `SELECT is_low_value, confidence, classifier, reason FROM youtube_verdicts WHERE video_id = $id`,
        { id },
      );
      expect(row).not.toBeNull();
      expect(typeof row!.is_low_value).toBe("boolean");
      expect(row!.classifier).toBe("llm-sonnet");
      expect(Number(row!.confidence)).toBeGreaterThanOrEqual(0);
      expect(Number(row!.confidence)).toBeLessThanOrEqual(1);
      expect(typeof row!.reason).toBe("string");
    }

    // Semantic sanity: the educational video must NOT be flagged low-value
    // (the prompt explicitly prefers false-negatives for learning content).
    const edu = await db.queryRow<{ is_low_value: boolean }>(
      `SELECT is_low_value FROM youtube_verdicts WHERE video_id = 'edu_tcp'`,
    );
    expect(edu!.is_low_value).toBe(false);
  }, LIVE_TIMEOUT_MS);
});
