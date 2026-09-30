/**
 * YouTubeSessionJoin.test.ts — verifies gap-bounded consumption estimation
 * with tablet/Mac foreground-session refinement and the watched/listened
 * split. Never spawns claude -p; no live API.
 */

import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Db } from "../Tools/Db.ts";
import {
  computeYouTubeConsumption,
  YOUTUBE_ABSOLUTE_CAP_SEC,
  UNKNOWN_DURATION_FALLBACK_SEC,
} from "../Tools/YouTubeSessionJoin.ts";

const TMP = mkdtempSync(join(tmpdir(), "aw-yt-join-"));
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
  await db.run("DELETE FROM events");
  await db.run("DELETE FROM youtube_history");
  await db.run("DELETE FROM youtube_videos");
  await db.run("DELETE FROM youtube_verdicts");
});

async function insertEvent(p: {
  id: string; device: string; app: string; ts: string; durSec: number;
}): Promise<void> {
  await db.run(
    `INSERT OR REPLACE INTO events
       (id, device, bucket, watcher, app, title, url, audible, ts_start, duration_sec, raw_json)
     VALUES ($id, $device, 'yt-test', 'test', $app, NULL, NULL, NULL, $ts::TIMESTAMP, $dur, '{}')`,
    { id: p.id, device: p.device, app: p.app, ts: p.ts, dur: p.durSec },
  );
}

async function insertHistory(p: { vid: string; ts: string }): Promise<void> {
  await db.run(
    `INSERT OR REPLACE INTO youtube_history
       (ts, video_id, title, channel, channel_url, source_export)
     VALUES ($ts::TIMESTAMP, $vid, $title, 'test', NULL, 'test')`,
    { ts: p.ts, vid: p.vid, title: `vid ${p.vid}` },
  );
}

async function insertVideo(vid: string, durSec: number): Promise<void> {
  await db.run(
    `INSERT OR REPLACE INTO youtube_videos
       (video_id, title, channel, channel_id, duration_sec, category_id, tags_json, enriched_at, enrich_error)
     VALUES ($id, 'x', 'y', NULL, $dur, 22, '[]', $now::TIMESTAMP, NULL)`,
    { id: vid, dur: durSec, now: new Date().toISOString() },
  );
}

async function insertVerdict(vid: string, isLow: boolean): Promise<void> {
  await db.run(
    `INSERT OR REPLACE INTO youtube_verdicts
       (video_id, is_low_value, reason, confidence, classifier, classified_at)
     VALUES ($id, $low, 'x', 0.9, 'llm-sonnet', $now::TIMESTAMP)`,
    { id: vid, low: isLow, now: new Date().toISOString() },
  );
}

/** Convenience: a fully-set-up low-value open. */
async function lowValueOpen(vid: string, ts: string, durSec: number): Promise<void> {
  await insertHistory({ vid, ts });
  await insertVideo(vid, durSec);
  await insertVerdict(vid, true);
}

// ---- empty + non-classified paths ----

test("no youtube_history → zero consumption", async () => {
  expect(await computeYouTubeConsumption(db, "2026-05-10")).toEqual({
    minutes: 0, watchedMinutes: 0, listenedMinutes: 0,
  });
});

test("history row without verdict → 0 minutes", async () => {
  await insertHistory({ vid: "v1", ts: "2026-05-10T15:00:00Z" });
  await insertVideo("v1", 600);
  expect((await computeYouTubeConsumption(db, "2026-05-10")).minutes).toBe(0);
});

test("not-low-value verdict → 0 minutes", async () => {
  await insertHistory({ vid: "v1", ts: "2026-05-10T15:00:00Z" });
  await insertVideo("v1", 600);
  await insertVerdict("v1", false);
  expect((await computeYouTubeConsumption(db, "2026-05-10")).minutes).toBe(0);
});

// ---- gap heuristic ----

test("gap to next open bounds consumed time below video duration", async () => {
  // v1 is a 30-min video but the next open is only 60s later → 60s consumed.
  await lowValueOpen("v1", "2026-05-10T22:00:00Z", 1800);
  await lowValueOpen("v2", "2026-05-10T22:01:00Z", 600); // last open → duration wins
  const c = await computeYouTubeConsumption(db, "2026-05-10");
  // v1: min(1800, 60) = 60s (gap wins → real elapsed, NOT halved)
  // v2: min(600, ∞) = 600s, duration wins with no session → 2x ⇒ 300s
  // total 360s = 6 min
  expect(c).toEqual({ minutes: 6, watchedMinutes: 0, listenedMinutes: 6 });
});

test("last open (no next) → half video duration (2x speed), tagged listened", async () => {
  // 600s video, no session, duration wins → 2x playback ⇒ 300s = 5 min.
  await lowValueOpen("v1", "2026-05-10T22:00:00Z", 600);
  expect(await computeYouTubeConsumption(db, "2026-05-10")).toEqual({
    minutes: 5, watchedMinutes: 0, listenedMinutes: 5,
  });
});

test("unknown video duration → bounded fallback estimate", async () => {
  await insertHistory({ vid: "v_nodur", ts: "2026-05-10T22:00:00Z" });
  await insertVideo("v_nodur", 0); // 0 = no duration metadata
  await insertVerdict("v_nodur", true);
  // gap = ∞ → min(∞, UNKNOWN_DURATION_FALLBACK_SEC)
  expect((await computeYouTubeConsumption(db, "2026-05-10")).minutes)
    .toBe(Math.round(UNKNOWN_DURATION_FALLBACK_SEC / 60));
});

test("absolute cap guards against a pathologically long watched session", async () => {
  // 8-hour VOD inside an 8-hour tablet foreground session → WATCHED path, so the
  // 1h listening cap and the 2x factor don't apply; the 4h absolute cap binds.
  await lowValueOpen("v_huge", "2026-05-10T22:00:00Z", 8 * 3600);
  await insertEvent({
    id: "s_huge", device: "tablet", app: "com.google.android.youtube",
    ts: "2026-05-10T22:00:00", durSec: 8 * 3600,
  });
  expect((await computeYouTubeConsumption(db, "2026-05-10")).minutes)
    .toBe(Math.round(YOUTUBE_ABSOLUTE_CAP_SEC / 60));
});

// ---- foreground-session refinement ----

test("tablet foreground session refines consumed time DOWN", async () => {
  // 30-min video, next open 1h later (gap 3600s) → gap estimate 1800s.
  // But the tablet foreground session is only 300s → user left after 5 min.
  await lowValueOpen("v1", "2026-05-10T22:00:00Z", 1800);
  await insertHistory({ vid: "v2", ts: "2026-05-10T23:00:00Z" }); // next open, no verdict
  await insertEvent({
    id: "s1", device: "tablet", app: "com.google.android.youtube",
    ts: "2026-05-10T22:00:00", durSec: 300,
  });
  const c = await computeYouTubeConsumption(db, "2026-05-10");
  expect(c).toEqual({ minutes: 5, watchedMinutes: 5, listenedMinutes: 0 });
});

test("phone foreground fragments do NOT crush background-listening time", async () => {
  // Same shape as above but the session is a phone fragment — must be ignored.
  // gap (3600s) ≥ duration (1800s) → duration wins; no usable session, so the
  // 2x factor applies ⇒ 900s = 15 min, tagged listened (not watched).
  await lowValueOpen("v1", "2026-05-10T22:00:00Z", 1800);
  await insertHistory({ vid: "v2", ts: "2026-05-10T23:00:00Z" });
  await insertEvent({
    id: "p1", device: "phone", app: "com.google.android.youtube",
    ts: "2026-05-10T22:00:00", durSec: 9,
  });
  const c = await computeYouTubeConsumption(db, "2026-05-10");
  expect(c).toEqual({ minutes: 15, watchedMinutes: 0, listenedMinutes: 15 });
});

test("watched vs listened split is reported separately", async () => {
  // v_watch: inside a 10-min tablet session → watched.
  // v_listen: no session, last open → listened.
  await lowValueOpen("v_watch", "2026-05-10T22:00:00Z", 1800);
  await lowValueOpen("v_listen", "2026-05-10T22:30:00Z", 1200);
  await insertEvent({
    id: "s1", device: "mac", app: "YouTube",
    ts: "2026-05-10T22:00:00", durSec: 600,
  });
  const c = await computeYouTubeConsumption(db, "2026-05-10");
  // v_watch: gap 1800s, session share 600s → min = 600s = 10 min watched
  // v_listen: min(1200, ∞) = 1200s, duration wins, no session → 2x ⇒ 600s = 10 min listened
  expect(c).toEqual({ minutes: 20, watchedMinutes: 10, listenedMinutes: 10 });
});

test("session time is split across all opens it contains", async () => {
  // 30-min tablet session containing 3 opens (2 low-value) → 600s share each.
  await insertEvent({
    id: "s1", device: "tablet", app: "com.google.android.youtube",
    ts: "2026-05-10T22:00:00", durSec: 1800,
  });
  await lowValueOpen("v1", "2026-05-10T22:00:00Z", 1500); // 25-min video
  await lowValueOpen("v2", "2026-05-10T22:10:00Z", 1500);
  await insertHistory({ vid: "v3", ts: "2026-05-10T22:20:00Z" }); // 3rd open, not low
  const c = await computeYouTubeConsumption(db, "2026-05-10");
  // share = 1800/3 = 600s; v1 gap 600s → min(1500,600,600)=600; v2 gap 600s same
  expect(c).toEqual({ minutes: 20, watchedMinutes: 20, listenedMinutes: 0 });
});

// ---- local-date handling ----

test("respects local-date — 06:30 UTC lands on the prior PDT day", async () => {
  // 2026-05-13T06:30Z = 2026-05-12 23:30 PDT; 600s duration wins, no session → 2x ⇒ 300s = 5 min
  await lowValueOpen("v_late", "2026-05-13T06:30:00Z", 600);
  expect((await computeYouTubeConsumption(db, "2026-05-12")).minutes).toBe(5);
  expect((await computeYouTubeConsumption(db, "2026-05-13")).minutes).toBe(0);
});

test("same video opened on different days → counted on each day", async () => {
  await insertVideo("v_repeat", 600);
  await insertVerdict("v_repeat", true);
  await insertHistory({ vid: "v_repeat", ts: "2026-05-10T22:00:00Z" });
  await insertHistory({ vid: "v_repeat", ts: "2026-05-11T22:00:00Z" });
  // each day: next open 24h later → min(600, 86400)=600 duration wins, no session → 2x ⇒ 300s = 5 min
  expect((await computeYouTubeConsumption(db, "2026-05-10")).minutes).toBe(5);
  expect((await computeYouTubeConsumption(db, "2026-05-11")).minutes).toBe(5);
});
