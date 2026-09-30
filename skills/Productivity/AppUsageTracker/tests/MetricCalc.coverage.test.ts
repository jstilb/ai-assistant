/**
 * MetricCalc.coverage.test.ts — verifies the V1.5/V1.6 additions:
 *   - tier1AppsByDevice (device-restricted Tier-1 apps; Mac Chrome NOT counted)
 *   - tier1FloorsMinPerDay (per-(device, app) floors, clamped at 0)
 *   - UTC → local-date conversion in CONFIG.localTimezone
 *   - Tier-2 query excludes Tier-1 matches (no double-count)
 *   - AFK events do not contribute to Tier-1 totals
 */

import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Db } from "../Tools/Db.ts";
import {
  computeTier1Minutes,
  computeTier1MinutesByDevice,
  computeTier2LowValueMinutes,
} from "../Tools/MetricCalc.ts";
import {
  groupIntoSessions,
  upsertClassification,
  type Tier2Event,
} from "../Tools/Classifier.ts";

const TMP = mkdtempSync(join(tmpdir(), "aw-coverage-"));
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
  await db.run("DELETE FROM classifications");
  await db.run("DELETE FROM daily_metrics");
});

async function insertEvent(p: {
  id: string; device: string; bucket: string; app?: string | null;
  title?: string | null; url?: string | null; ts: string; durationSec: number;
}): Promise<void> {
  await db.run(
    `INSERT OR REPLACE INTO events
     (id, device, bucket, watcher, app, title, url, audible, ts_start, duration_sec, raw_json)
     VALUES ($id, $device, $bucket, 'test', $app, $title, $url, NULL, $ts::TIMESTAMP, $dur, '{}')`,
    {
      id: p.id, device: p.device, bucket: p.bucket,
      app: p.app ?? null, title: p.title ?? null, url: p.url ?? null,
      ts: p.ts, dur: p.durationSec,
    },
  );
}

// ---------- tier1AppsByDevice ----------

test("tier1AppsByDevice: phone Chrome counts (heuristic) but Mac Chrome does NOT", async () => {
  await insertEvent({ id: "phone-chrome", device: "phone", bucket: "android-test",
    app: "Chrome", ts: "2026-05-10T15:00:00", durationSec: 1800 }); // 30 min
  await insertEvent({ id: "mac-chrome", device: "mac", bucket: "aw-window",
    app: "Google Chrome", ts: "2026-05-10T16:00:00", durationSec: 1800 }); // 30 min — should NOT count
  // Floor for phone Chrome is 10 min → 30 - 10 = 20 min credited.
  expect(await computeTier1Minutes(db, "2026-05-10")).toBe(20);

  const byDevice = await computeTier1MinutesByDevice(db, "2026-05-10");
  expect(byDevice.get("phone")).toBe(20);
  expect(byDevice.get("mac") ?? 0).toBe(0);
});

test("tier1AppsByDevice: case-insensitive matching", async () => {
  await insertEvent({ id: "phone-chrome-CAPS", device: "phone", bucket: "android-test",
    app: "CHROME", ts: "2026-05-10T15:00:00", durationSec: 1200 }); // 20 min raw → 10 after floor
  expect(await computeTier1Minutes(db, "2026-05-10")).toBe(10);
});

// ---------- tier1FloorsMinPerDay ----------

test("tier1FloorsMinPerDay: floor subtracts before total (Chess phone floor=10)", async () => {
  await insertEvent({ id: "phone-chess", device: "phone", bucket: "android-test",
    app: "com.chess", ts: "2026-05-10T15:00:00", durationSec: 3000 }); // 50 min raw
  expect(await computeTier1Minutes(db, "2026-05-10")).toBe(40); // 50 - 10 floor
});

test("tier1FloorsMinPerDay: floor clamps at 0 (no negative credit)", async () => {
  await insertEvent({ id: "phone-chess-low", device: "phone", bucket: "android-test",
    app: "com.chess", ts: "2026-05-10T15:00:00", durationSec: 300 }); // 5 min raw → -5 → clamp 0
  expect(await computeTier1Minutes(db, "2026-05-10")).toBe(0);
});

test("tier1FloorsMinPerDay: floor applies to (device, app) bucket, NOT cross-device", async () => {
  // Mac chess wouldn't normally count (chess on mac is also tier-1 universal),
  // but mac has no floor → full 30 min credited. Phone chess has floor 10.
  await insertEvent({ id: "mac-chess", device: "mac", bucket: "aw-window",
    app: "Chess.com", ts: "2026-05-10T15:00:00", durationSec: 1800 }); // 30 min
  await insertEvent({ id: "phone-chess", device: "phone", bucket: "android-test",
    app: "Chess.com", ts: "2026-05-10T16:00:00", durationSec: 1800 }); // 30 - 10 = 20
  expect(await computeTier1Minutes(db, "2026-05-10")).toBe(50);
});

// ---------- UTC → local-date conversion ----------

test("local-date: 23:30 UTC May 12 → 16:30 PDT May 12 (same day)", async () => {
  await insertEvent({ id: "evening", device: "phone", bucket: "android-test",
    app: "com.reddit.frontpage", ts: "2026-05-12T23:30:00", durationSec: 600 }); // 10 min
  expect(await computeTier1Minutes(db, "2026-05-12")).toBe(10);
  expect(await computeTier1Minutes(db, "2026-05-11")).toBe(0);
});

test("local-date: 06:30 UTC May 13 → 23:30 PDT May 12 (lands on May 12, not May 13)", async () => {
  await insertEvent({ id: "midnight", device: "phone", bucket: "android-test",
    app: "com.reddit.frontpage", ts: "2026-05-13T06:30:00", durationSec: 600 });
  // Without the local-date conversion, this would credit May 13.
  expect(await computeTier1Minutes(db, "2026-05-12")).toBe(10);
  expect(await computeTier1Minutes(db, "2026-05-13")).toBe(0);
});

test("local-date: 08:00 UTC May 13 → 01:00 PDT May 13 (lands on May 13)", async () => {
  await insertEvent({ id: "early-am", device: "phone", bucket: "android-test",
    app: "com.reddit.frontpage", ts: "2026-05-13T08:00:00", durationSec: 600 });
  expect(await computeTier1Minutes(db, "2026-05-13")).toBe(10);
});

// ---------- Tier-2 excludes Tier-1 matches ----------

function ev(p: Partial<Tier2Event> & { id: string; ts: string; dur: number; app: string }): Tier2Event {
  return {
    device: "phone",
    title: p.title ?? null,
    url: p.url ?? null,
    duration_sec: p.dur,
    ts_start: new Date(p.ts),
    id: p.id,
    app: p.app,
  };
}

test("tier-2 excludes Tier-1 phone Chrome even if classifications row exists", async () => {
  // Insert a phone Chrome event AND a Reddit event, classify both as tier-2 low-value.
  await insertEvent({ id: "phone-chrome-t2", device: "phone", bucket: "android-test",
    app: "Chrome", title: "feed", ts: "2026-05-10T15:00:00", durationSec: 1800 });
  await insertEvent({ id: "phone-reddit-t2", device: "phone", bucket: "android-test",
    app: "com.reddit.frontpage", title: "post", ts: "2026-05-10T16:00:00", durationSec: 600 });

  // Backfill classifications by hand
  await upsertClassification(
    db,
    groupIntoSessions([
      ev({ id: "phone-chrome-t2", app: "Chrome", title: "feed", ts: "2026-05-10T15:00:00Z", dur: 1800 }),
    ])[0],
    { is_low_value: true, reason: "x", confidence: 0.9 },
  );
  await upsertClassification(
    db,
    groupIntoSessions([
      ev({ id: "phone-reddit-t2", app: "com.reddit.frontpage", title: "post", ts: "2026-05-10T16:00:00Z", dur: 600 }),
    ])[0],
    { is_low_value: true, reason: "y", confidence: 0.9 },
  );

  // Tier-2 should return 0 — both events are Tier-1 matches (chrome via
  // tier1AppsByDevice.phone, reddit via tier1Apps), so the NOT(tier1Match)
  // clause filters them.
  expect(await computeTier2LowValueMinutes(db, "2026-05-10")).toBe(0);
});

test("tier-2 counts YouTube (NOT a Tier-1 match) when classified low-value", async () => {
  await insertEvent({ id: "yt-drama", device: "phone", bucket: "android-test",
    app: "com.google.android.youtube", title: "drama", ts: "2026-05-10T15:00:00", durationSec: 1800 });
  await upsertClassification(
    db,
    groupIntoSessions([
      ev({ id: "yt-drama", app: "com.google.android.youtube", title: "drama", ts: "2026-05-10T15:00:00Z", dur: 1800 }),
    ])[0],
    { is_low_value: true, reason: "entertainment", confidence: 0.9 },
  );
  expect(await computeTier2LowValueMinutes(db, "2026-05-10")).toBe(30);
});

// ---------- AFK regression (C5) ----------

test("AFK events do NOT count toward Tier-1 (status='afk' / no app field)", async () => {
  // Simulate aw-watcher-afk emitting status events that lack an `app` field.
  await insertEvent({ id: "afk-1", device: "mac", bucket: "aw-watcher-afk_test-host",
    app: null, title: null, ts: "2026-05-10T10:00:00", durationSec: 3600 });
  // Sanity: a real tier-1 event on the same day counts.
  await insertEvent({ id: "real-reddit", device: "mac", bucket: "aw-window",
    app: "Reddit", ts: "2026-05-10T11:00:00", durationSec: 600 });
  expect(await computeTier1Minutes(db, "2026-05-10")).toBe(10);
});

test("regression: tier-3 apps still excluded (Music does not count even with long duration)", async () => {
  await insertEvent({ id: "music-marathon", device: "phone", bucket: "android-test",
    app: "com.spotify.music", ts: "2026-05-10T10:00:00", durationSec: 14400 }); // 4 hr
  await insertEvent({ id: "reddit-small", device: "phone", bucket: "android-test",
    app: "com.reddit.frontpage", ts: "2026-05-10T11:00:00", durationSec: 300 }); // 5 min
  expect(await computeTier1Minutes(db, "2026-05-10")).toBe(5);
});
