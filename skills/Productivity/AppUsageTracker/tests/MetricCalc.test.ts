/**
 * MetricCalc.test.ts — verifies Tier-1 minute counting + idempotency.
 *
 * Uses a single Db instance per test (no subprocess) and calls MetricCalc's
 * exported functions directly. Each test resets events + daily_metrics tables
 * to ensure independence.
 */

import { afterAll, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Db } from "../Tools/Db.ts";
import { computeTier1Minutes, computeTier2HeuristicMinutes, upsertMetric } from "../Tools/MetricCalc.ts";

const TMP = mkdtempSync(join(tmpdir(), "aw-test-"));
const DB_PATH = join(TMP, "events.db");

let db: Db;

afterAll(() => {
  if (db) db.close();
  rmSync(TMP, { recursive: true, force: true });
});

async function insertEvent(params: {
  id: string; device: string; bucket: string; app?: string | null; url?: string | null;
  ts: string; durationSec: number;
}): Promise<void> {
  await db.run(
    `INSERT OR REPLACE INTO events
     (id, device, bucket, watcher, app, title, url, audible, ts_start, duration_sec, raw_json)
     VALUES ($id, $device, $bucket, 'test', $app, NULL, $url, NULL, $ts::TIMESTAMP, $dur, '{"_test_":true}')`,
    {
      id: params.id, device: params.device, bucket: params.bucket,
      app: params.app ?? null, url: params.url ?? null,
      ts: params.ts, dur: params.durationSec,
    },
  );
}

beforeEach(async () => {
  if (!db) {
    db = await Db.open(DB_PATH);
    await db.initSchema();
  }
  await db.run("DELETE FROM events");
  await db.run("DELETE FROM daily_metrics");
});

test("Tier-1 minutes: app-name match counts (95 min Reddit)", async () => {
  await insertEvent({
    id: "test:reddit:1", device: "phone", bucket: "aw-watcher-android-usage_test",
    app: "com.reddit.frontpage", ts: "2026-04-28T10:00:00", durationSec: 5700, // 95 min
  });

  let minutes = await computeTier1Minutes(db, "2026-04-28");
  expect(minutes).toBe(95);

  // Idempotency: a second call yields the same number
  minutes = await computeTier1Minutes(db, "2026-04-28");
  expect(minutes).toBe(95);
});

test("Tier-1 minutes: URL-pattern match counts (reddit.com browser)", async () => {
  await insertEvent({
    id: "test:web:1", device: "mac", bucket: "aw-watcher-web-chrome",
    app: "Google Chrome", url: "https://www.reddit.com/r/programming",
    ts: "2026-04-28T11:00:00", durationSec: 600, // 10 min
  });

  const minutes = await computeTier1Minutes(db, "2026-04-28");
  expect(minutes).toBe(10);
});

test("Tier-3 events are excluded (Maps does not count)", async () => {
  // Maps: 1 hour — must NOT count
  await insertEvent({
    id: "test:maps:1", device: "phone", bucket: "aw-watcher-android-usage_test",
    app: "com.google.android.apps.maps", ts: "2026-04-28T12:00:00", durationSec: 3600,
  });
  // Reddit: 5 min — must count
  await insertEvent({
    id: "test:reddit:2", device: "phone", bucket: "aw-watcher-android-usage_test",
    app: "com.reddit.frontpage", ts: "2026-04-28T13:00:00", durationSec: 300,
  });

  const minutes = await computeTier1Minutes(db, "2026-04-28");
  expect(minutes).toBe(5);
});

test("upsertMetric: idempotent re-run yields same row", async () => {
  await insertEvent({
    id: "test:reddit:a", device: "phone", bucket: "aw-watcher-android-usage_test",
    app: "com.reddit.frontpage", ts: "2026-04-28T10:00:00", durationSec: 5700, // 95 min
  });
  const m1 = await computeTier1Minutes(db, "2026-04-28");
  await upsertMetric(db, "2026-04-28", m1);

  // Re-run
  const m2 = await computeTier1Minutes(db, "2026-04-28");
  await upsertMetric(db, "2026-04-28", m2);

  const row = await db.queryRow<{ tier1_minutes: number; total_lowvalue_minutes: number }>(
    `SELECT tier1_minutes, total_lowvalue_minutes FROM daily_metrics WHERE date = '2026-04-28'::DATE`,
  );
  expect(row).not.toBeNull();
  expect(Number(row!.tier1_minutes)).toBe(95);
  expect(Number(row!.total_lowvalue_minutes)).toBe(95);

  // Adding 30 min Twitter and re-running → 125
  await insertEvent({
    id: "test:twitter:1", device: "phone", bucket: "aw-watcher-android-usage_test",
    app: "com.twitter.android", ts: "2026-04-28T14:00:00", durationSec: 1800,
  });
  const m3 = await computeTier1Minutes(db, "2026-04-28");
  await upsertMetric(db, "2026-04-28", m3);

  const row2 = await db.queryRow<{ tier1_minutes: number }>(
    `SELECT tier1_minutes FROM daily_metrics WHERE date = '2026-04-28'::DATE`,
  );
  expect(Number(row2!.tier1_minutes)).toBe(125);
});

test("Tier-1 case-insensitive match (Reddit, REDDIT, reddit)", async () => {
  await insertEvent({
    id: "test:case:1", device: "mac", bucket: "aw-watcher-window_test",
    app: "REDDIT", ts: "2026-04-28T10:00:00", durationSec: 600,
  });
  const minutes = await computeTier1Minutes(db, "2026-04-28");
  expect(minutes).toBe(10);
});

test("Empty events for date returns 0", async () => {
  const minutes = await computeTier1Minutes(db, "2026-04-28");
  expect(minutes).toBe(0);
});

test("Db.close() fully releases the file lock (regression: instance.closeSync needed)", async () => {
  // Repro of 2026-05-05 issue: the dashboard's per-request open/close cycle
  // was leaving the DuckDBInstance alive, which kept the OS file lock and
  // blocked the AWPoller / MetricCalc / Classifier cron jobs from opening.
  // Db.close() must release both the connection and the instance.
  const tmpPath = `${TMP}/lock-regression-${Date.now()}.db`;
  const a = await Db.open(tmpPath);
  await a.initSchema();
  a.close();
  // Should be able to reopen from the same process immediately, no lock contention
  const b = await Db.open(tmpPath);
  await b.initSchema();
  b.close();
});

// ── Tier-2 heuristic minutes (phone apps with no classifiable metadata) ──────

test("Tier-2 heuristic: LinkedIn counts at its 0.80 fraction (100 min → 80)", async () => {
  await insertEvent({
    id: "h:li:1", device: "phone", bucket: "aw-watcher-android-usage_test",
    app: "com.linkedin.android", ts: "2026-04-28T18:00:00", durationSec: 6000, // 100 min
  });
  expect(await computeTier2HeuristicMinutes(db, "2026-04-28")).toBe(80);
});

test("Tier-2 heuristic: Nebula counts at the YouTube-equivalent 0.49 fraction (100 min → 49)", async () => {
  await insertEvent({
    id: "h:neb:1", device: "phone", bucket: "aw-watcher-android-usage_test",
    app: "Nebula", ts: "2026-04-28T18:00:00", durationSec: 6000,
  });
  expect(await computeTier2HeuristicMinutes(db, "2026-04-28")).toBe(49);
});

test("Tier-2 heuristic: WhatsApp/Messages (0% — not in map) contribute nothing", async () => {
  await insertEvent({
    id: "h:wa:1", device: "phone", bucket: "aw-watcher-android-usage_test",
    app: "com.whatsapp", ts: "2026-04-28T18:00:00", durationSec: 6000,
  });
  await insertEvent({
    id: "h:msg:1", device: "phone", bucket: "aw-watcher-android-usage_test",
    app: "com.google.android.apps.messaging", ts: "2026-04-28T18:30:00", durationSec: 6000,
  });
  expect(await computeTier2HeuristicMinutes(db, "2026-04-28")).toBe(0);
});

test("Tier-2 heuristic: only phone/tablet count (Mac LinkedIn ignored — idle inflation risk)", async () => {
  await insertEvent({
    id: "h:li:mac", device: "mac", bucket: "aw-watcher-window_test",
    app: "LinkedIn", ts: "2026-04-28T18:00:00", durationSec: 6000,
  });
  expect(await computeTier2HeuristicMinutes(db, "2026-04-28")).toBe(0);
});

test("Tier-2 heuristic: sums multiple apps and rounds once (LinkedIn 100m + Nebula 10m → 80+5)", async () => {
  await insertEvent({
    id: "h:li:2", device: "phone", bucket: "aw-watcher-android-usage_test",
    app: "com.linkedin.android", ts: "2026-04-28T18:00:00", durationSec: 6000, // 100m × .80 = 80
  });
  await insertEvent({
    id: "h:neb:2", device: "tablet", bucket: "aw-watcher-android-usage_test",
    app: "Nebula", ts: "2026-04-28T19:00:00", durationSec: 600, // 10m × .49 = 4.9 → 5
  });
  expect(await computeTier2HeuristicMinutes(db, "2026-04-28")).toBe(85);
});
