/**
 * YouTubeIngest.test.ts — verifies that Google Takeout watch-history.json
 * files are correctly parsed into youtube_history rows. NEVER hits the live
 * YouTube API; fixtures live entirely under tmp.
 */

import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Db } from "../Tools/Db.ts";
import {
  extractVideoId,
  ingestTakeoutHistory,
} from "../Tools/YouTubeIngest.ts";

const TMP = mkdtempSync(join(tmpdir(), "aw-yt-ingest-"));
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
});

function writeFixture(name: string, entries: unknown[]): string {
  const dir = join(TMP, name);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "watch-history.json");
  writeFileSync(path, JSON.stringify(entries));
  return path;
}

// --- extractVideoId ---

test("extractVideoId: extracts v= param from watch URL", () => {
  expect(extractVideoId("https://www.youtube.com/watch?v=dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
  expect(extractVideoId("https://www.youtube.com/watch?v=AbC123_-x&t=42s")).toBe("AbC123_-x");
});

test("extractVideoId: handles youtu.be short links", () => {
  expect(extractVideoId("https://youtu.be/dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
  expect(extractVideoId("https://youtu.be/dQw4w9WgXcQ?t=42")).toBe("dQw4w9WgXcQ");
});

test("extractVideoId: youtube /shorts/ URLs", () => {
  expect(extractVideoId("https://www.youtube.com/shorts/AbC123_-x")).toBe("AbC123_-x");
});

test("extractVideoId: non-video URLs return null", () => {
  expect(extractVideoId("https://www.youtube.com/feed/subscriptions")).toBeNull();
  expect(extractVideoId("https://www.youtube.com/")).toBeNull();
  expect(extractVideoId("")).toBeNull();
});

// --- ingestTakeoutHistory ---

test("ingest: parses one entry into one history row", async () => {
  const path = writeFixture("one-entry", [
    {
      header: "YouTube",
      title: "Watched How to use Bun",
      titleUrl: "https://www.youtube.com/watch?v=abc123XYZ-_",
      subtitles: [{ name: "Bun Channel", url: "https://www.youtube.com/channel/UC123" }],
      time: "2026-05-10T15:00:00.000Z",
      products: ["YouTube"],
    },
  ]);
  const summary = await ingestTakeoutHistory({ db, historyPath: path });
  expect(summary.entries_read).toBe(1);
  expect(summary.rows_inserted).toBe(1);

  const row = await db.queryRow<{
    video_id: string; title: string; channel: string; channel_url: string; source_export: string;
  }>(`SELECT video_id, title, channel, channel_url, source_export FROM youtube_history`);
  expect(row!.video_id).toBe("abc123XYZ-_");
  expect(row!.title).toBe("How to use Bun");
  expect(row!.channel).toBe("Bun Channel");
  expect(row!.channel_url).toBe("https://www.youtube.com/channel/UC123");
  expect(row!.source_export).toContain("watch-history");
});

test("ingest: strips 'Watched ' prefix from title", async () => {
  const path = writeFixture("title-prefix", [
    {
      header: "YouTube",
      title: "Watched Some video",
      titleUrl: "https://www.youtube.com/watch?v=zzz",
      time: "2026-05-10T15:00:00.000Z",
    },
  ]);
  await ingestTakeoutHistory({ db, historyPath: path });
  const row = await db.queryRow<{ title: string }>(`SELECT title FROM youtube_history`);
  expect(row!.title).toBe("Some video");
});

test("ingest: skips entries without titleUrl (deleted videos / disabled history)", async () => {
  const path = writeFixture("missing-url", [
    {
      header: "YouTube",
      title: "Watched a video that has been removed",
      time: "2026-05-10T15:00:00.000Z",
    },
    {
      header: "YouTube",
      title: "Watched Real Video",
      titleUrl: "https://www.youtube.com/watch?v=real",
      time: "2026-05-10T16:00:00.000Z",
    },
  ]);
  const summary = await ingestTakeoutHistory({ db, historyPath: path });
  expect(summary.entries_read).toBe(2);
  expect(summary.entries_skipped).toBe(1);
  expect(summary.rows_inserted).toBe(1);
});

test("ingest: skips non-YouTube entries (e.g. YouTube Music)", async () => {
  const path = writeFixture("mixed-products", [
    {
      header: "YouTube Music",
      title: "Listened to song",
      titleUrl: "https://www.youtube.com/watch?v=music",
      time: "2026-05-10T15:00:00.000Z",
      products: ["YouTube Music"],
    },
    {
      header: "YouTube",
      title: "Watched yt video",
      titleUrl: "https://www.youtube.com/watch?v=video",
      time: "2026-05-10T16:00:00.000Z",
      products: ["YouTube"],
    },
  ]);
  const summary = await ingestTakeoutHistory({ db, historyPath: path });
  expect(summary.rows_inserted).toBe(1);
  const row = await db.queryRow<{ video_id: string }>(`SELECT video_id FROM youtube_history`);
  expect(row!.video_id).toBe("video");
});

test("ingest: idempotent — re-running same file writes no new rows", async () => {
  const path = writeFixture("idempotent", [
    {
      header: "YouTube",
      title: "Watched x",
      titleUrl: "https://www.youtube.com/watch?v=ID1",
      time: "2026-05-10T15:00:00.000Z",
    },
    {
      header: "YouTube",
      title: "Watched y",
      titleUrl: "https://www.youtube.com/watch?v=ID2",
      time: "2026-05-10T16:00:00.000Z",
    },
  ]);
  await ingestTakeoutHistory({ db, historyPath: path });
  await ingestTakeoutHistory({ db, historyPath: path });
  const cnt = await db.queryRow<{ n: number | bigint }>(`SELECT COUNT(*) AS n FROM youtube_history`);
  expect(Number(cnt!.n)).toBe(2);
});

test("ingest: sinceUnix filters out older entries", async () => {
  const path = writeFixture("since", [
    {
      header: "YouTube",
      title: "Watched old",
      titleUrl: "https://www.youtube.com/watch?v=old",
      time: "2025-01-01T00:00:00.000Z",
    },
    {
      header: "YouTube",
      title: "Watched new",
      titleUrl: "https://www.youtube.com/watch?v=new",
      time: "2026-05-10T15:00:00.000Z",
    },
  ]);
  const summary = await ingestTakeoutHistory({
    db, historyPath: path, sinceUnix: new Date("2026-01-01T00:00:00Z"),
  });
  expect(summary.rows_inserted).toBe(1);
  const row = await db.queryRow<{ video_id: string }>(`SELECT video_id FROM youtube_history`);
  expect(row!.video_id).toBe("new");
});

test("ingest: missing file returns skipped summary", async () => {
  const summary = await ingestTakeoutHistory({
    db, historyPath: `${TMP}/does-not-exist/watch-history.json`,
  });
  expect(summary.entries_read).toBe(0);
  expect(summary.rows_inserted).toBe(0);
  expect(summary.skipped).toBeTruthy();
});
