/**
 * Classifier.test.ts — sessionization, idempotency, and tier-2 metric integration.
 *
 * Always-on tests are pure (no LLM calls). The accuracy test against the
 * fixture YouTube sessions is gated behind `RUN_LLM_TESTS=1` so default
 * `bun test` stays fast and free.
 */

import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Db } from "../Tools/Db.ts";
import {
  CLASSIFIER_NAME,
  classifyAll,
  groupIntoSessions,
  isClassifiable,
  loadTier2Events,
  upsertClassification,
  type Session,
  type Tier2Event,
} from "../Tools/Classifier.ts";
import { computeTier2LowValueMinutes, upsertMetric, computeTier1Minutes } from "../Tools/MetricCalc.ts";

const TMP = mkdtempSync(join(tmpdir(), "aw-classifier-test-"));
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

function ev(
  partial: Partial<Tier2Event> & { id: string; ts_start: string },
): Tier2Event {
  return {
    device: "phone",
    app: "com.google.android.youtube",
    title: null,
    url: null,
    duration_sec: 60,
    ...partial,
    ts_start: new Date(partial.ts_start),
  };
}

async function insertEvent(row: {
  id: string; device: string; bucket: string; app?: string | null;
  title?: string | null; url?: string | null; ts: string; durationSec: number;
}): Promise<void> {
  await db.run(
    `INSERT OR REPLACE INTO events
     (id, device, bucket, watcher, app, title, url, audible, ts_start, duration_sec, raw_json)
     VALUES ($id, $device, $bucket, 'test', $app, $title, $url, NULL, $ts::TIMESTAMP, $dur, '{}')`,
    {
      id: row.id, device: row.device, bucket: row.bucket,
      app: row.app ?? null, title: row.title ?? null, url: row.url ?? null,
      ts: row.ts, dur: row.durationSec,
    },
  );
}

test("groupIntoSessions: empty input → empty output", () => {
  expect(groupIntoSessions([])).toEqual([]);
});

test("groupIntoSessions: single event → single session", () => {
  const events = [ev({ id: "a", ts_start: "2026-05-01T10:00:00Z", duration_sec: 120 })];
  const sessions = groupIntoSessions(events);
  expect(sessions.length).toBe(1);
  expect(sessions[0].events.length).toBe(1);
  expect(sessions[0].totalDurationSec).toBe(120);
});

test("groupIntoSessions: same app, gap ≤120s → one session", () => {
  const events = [
    ev({ id: "a", ts_start: "2026-05-01T10:00:00Z", duration_sec: 60 }), // ends 10:01:00
    ev({ id: "b", ts_start: "2026-05-01T10:02:30Z", duration_sec: 60 }), // gap 90s — same session
  ];
  const sessions = groupIntoSessions(events);
  expect(sessions.length).toBe(1);
  expect(sessions[0].events.length).toBe(2);
});

test("groupIntoSessions: same app, gap >120s → two sessions", () => {
  const events = [
    ev({ id: "a", ts_start: "2026-05-01T10:00:00Z", duration_sec: 60 }), // ends 10:01:00
    ev({ id: "b", ts_start: "2026-05-01T10:05:00Z", duration_sec: 60 }), // gap 240s — split
  ];
  const sessions = groupIntoSessions(events);
  expect(sessions.length).toBe(2);
});

test("groupIntoSessions: different apps → separate sessions", () => {
  const events = [
    ev({ id: "a", app: "YouTube", ts_start: "2026-05-01T10:00:00Z" }),
    ev({ id: "b", app: "Google Chrome", ts_start: "2026-05-01T10:00:30Z" }),
  ];
  const sessions = groupIntoSessions(events);
  expect(sessions.length).toBe(2);
});

test("groupIntoSessions: different devices → separate sessions even for same app", () => {
  const events = [
    ev({ id: "a", device: "phone", ts_start: "2026-05-01T10:00:00Z" }),
    ev({ id: "b", device: "mac",   ts_start: "2026-05-01T10:00:30Z" }),
  ];
  const sessions = groupIntoSessions(events);
  expect(sessions.length).toBe(2);
});

test("groupIntoSessions: events with null app are dropped", () => {
  const events = [
    ev({ id: "a", app: null, ts_start: "2026-05-01T10:00:00Z" }),
    ev({ id: "b", app: "YouTube", ts_start: "2026-05-01T10:01:00Z" }),
  ];
  const sessions = groupIntoSessions(events);
  expect(sessions.length).toBe(1);
  expect(sessions[0].events[0].id).toBe("b");
});

test("isClassifiable: requires at least one non-empty title or url", () => {
  const blank = groupIntoSessions([
    ev({ id: "a", title: null, url: null, ts_start: "2026-05-01T10:00:00Z" }),
    ev({ id: "b", title: "", url: "   ", ts_start: "2026-05-01T10:00:30Z" }),
  ])[0];
  expect(isClassifiable(blank)).toBe(false);

  const titled = groupIntoSessions([
    ev({ id: "c", title: "Useful video", ts_start: "2026-05-01T10:00:00Z" }),
  ])[0];
  expect(isClassifiable(titled)).toBe(true);

  const urled = groupIntoSessions([
    ev({ id: "d", url: "https://youtube.com/watch?v=x", ts_start: "2026-05-01T10:00:00Z" }),
  ])[0];
  expect(isClassifiable(urled)).toBe(true);
});

test("loadTier2Events: returns only Tier-2 events newer than sinceDate, excluding already-classified", async () => {
  // 1 YouTube event (Tier-2), 1 Reddit (Tier-1), 1 old YouTube (before since)
  await insertEvent({ id: "phone:yt:new", device: "phone", bucket: "android-test",
    app: "com.google.android.youtube", title: "fresh", ts: "2026-05-01T10:00:00", durationSec: 600 });
  await insertEvent({ id: "phone:reddit:new", device: "phone", bucket: "android-test",
    app: "com.reddit.frontpage", ts: "2026-05-01T10:10:00", durationSec: 600 });
  await insertEvent({ id: "phone:yt:old", device: "phone", bucket: "android-test",
    app: "com.google.android.youtube", title: "old", ts: "2025-01-01T10:00:00", durationSec: 600 });

  const events = await loadTier2Events(db, "2026-04-01", true);
  expect(events.length).toBe(1);
  expect(events[0].id).toBe("phone:yt:new");

  // After classifying it, excludeClassified=true should hide it
  const verdict = { is_low_value: false, reason: "test", confidence: 1 };
  const session: Session = groupIntoSessions(events)[0];
  await upsertClassification(db, session, verdict);

  const events2 = await loadTier2Events(db, "2026-04-01", true);
  expect(events2.length).toBe(0);

  // …but force=false equivalent (excludeClassified=false) returns it
  const events3 = await loadTier2Events(db, "2026-04-01", false);
  expect(events3.length).toBe(1);
});

test("upsertClassification: idempotent re-write yields one row per event", async () => {
  await insertEvent({ id: "phone:yt:1", device: "phone", bucket: "android-test",
    app: "com.google.android.youtube", title: "t1", ts: "2026-05-01T10:00:00", durationSec: 600 });
  await insertEvent({ id: "phone:yt:2", device: "phone", bucket: "android-test",
    app: "com.google.android.youtube", title: "t2", ts: "2026-05-01T10:00:30", durationSec: 600 });

  const events = await loadTier2Events(db, "2026-04-01", true);
  const sessions = groupIntoSessions(events);
  expect(sessions.length).toBe(1); // both grouped

  const verdict = { is_low_value: true, reason: "entertainment", confidence: 0.9 };
  await upsertClassification(db, sessions[0], verdict);
  await upsertClassification(db, sessions[0], verdict); // re-run → still 2 rows, not 4

  const cnt = await db.queryRow<{ n: number | bigint }>(`SELECT COUNT(*) AS n FROM classifications`);
  expect(Number(cnt!.n)).toBe(2);

  const sample = await db.queryRow<{ classifier: string; tier: number | bigint; is_low_value: boolean }>(
    `SELECT classifier, tier, is_low_value FROM classifications WHERE event_id = 'phone:yt:1'`,
  );
  expect(sample!.classifier).toBe(CLASSIFIER_NAME);
  expect(Number(sample!.tier)).toBe(2);
  expect(sample!.is_low_value).toBe(true);
});

test("computeTier2LowValueMinutes: only counts events flagged is_low_value=TRUE", async () => {
  // 30 min YouTube classified low-value → counts
  // 60 min YouTube classified NOT low-value → does not count
  // 10 min Reddit (Tier-1, no classification) → does not count here
  await insertEvent({ id: "phone:yt:bad", device: "phone", bucket: "android-test",
    app: "com.google.android.youtube", title: "drama", ts: "2026-05-01T10:00:00", durationSec: 1800 });
  await insertEvent({ id: "phone:yt:good", device: "phone", bucket: "android-test",
    app: "com.google.android.youtube", title: "rust tutorial", ts: "2026-05-01T11:00:00", durationSec: 3600 });
  await insertEvent({ id: "phone:reddit:1", device: "phone", bucket: "android-test",
    app: "com.reddit.frontpage", ts: "2026-05-01T12:00:00", durationSec: 600 });

  // Manually classify
  await upsertClassification(
    db,
    groupIntoSessions([ev({ id: "phone:yt:bad", title: "drama", ts_start: "2026-05-01T10:00:00Z", duration_sec: 1800 })])[0],
    { is_low_value: true, reason: "entertainment", confidence: 0.9 },
  );
  await upsertClassification(
    db,
    groupIntoSessions([ev({ id: "phone:yt:good", title: "rust tutorial", ts_start: "2026-05-01T11:00:00Z", duration_sec: 3600 })])[0],
    { is_low_value: false, reason: "educational", confidence: 0.9 },
  );

  const t2 = await computeTier2LowValueMinutes(db, "2026-05-01");
  expect(t2).toBe(30);
});

test("upsertMetric: total_lowvalue_minutes = tier1 + tier2 when both present", async () => {
  // 10 min Reddit (Tier-1) + 30 min low-value YouTube (Tier-2 classified) = 40 min total
  await insertEvent({ id: "phone:reddit:1", device: "phone", bucket: "android-test",
    app: "com.reddit.frontpage", ts: "2026-05-01T10:00:00", durationSec: 600 });
  await insertEvent({ id: "phone:yt:bad", device: "phone", bucket: "android-test",
    app: "com.google.android.youtube", title: "drama", ts: "2026-05-01T11:00:00", durationSec: 1800 });

  await upsertClassification(
    db,
    groupIntoSessions([ev({ id: "phone:yt:bad", title: "drama", ts_start: "2026-05-01T11:00:00Z", duration_sec: 1800 })])[0],
    { is_low_value: true, reason: "entertainment", confidence: 0.9 },
  );

  const tier1 = await computeTier1Minutes(db, "2026-05-01");
  const tier2 = await computeTier2LowValueMinutes(db, "2026-05-01");
  await upsertMetric(db, "2026-05-01", tier1, tier2);

  const row = await db.queryRow<{ tier1_minutes: number | bigint; tier2_lowvalue_minutes: number | bigint; total_lowvalue_minutes: number | bigint }>(
    `SELECT tier1_minutes, tier2_lowvalue_minutes, total_lowvalue_minutes FROM daily_metrics WHERE date = '2026-05-01'::DATE`,
  );
  expect(Number(row!.tier1_minutes)).toBe(10);
  expect(Number(row!.tier2_lowvalue_minutes)).toBe(30);
  expect(Number(row!.total_lowvalue_minutes)).toBe(40);
});

test("classifyAll dry-run: counts classifiable sessions but writes nothing", async () => {
  // 1 classifiable YouTube session, 1 unclassifiable LinkedIn-on-phone session.
  // (Chrome used to be the unclassifiable example here — it was pulled from
  // tier2Apps in V1.6 because chrome_visits is now the URL-bearing source of
  // truth. LinkedIn-android has no title/url so it serves the same purpose.)
  await insertEvent({ id: "phone:yt:1", device: "phone", bucket: "android-test",
    app: "com.google.android.youtube", title: "Postgres talk", ts: "2026-05-01T10:00:00", durationSec: 600 });
  await insertEvent({ id: "phone:linkedin:1", device: "phone", bucket: "android-test",
    app: "com.linkedin.android", title: null, url: null, ts: "2026-05-01T10:30:00", durationSec: 600 });

  const summary = await classifyAll(db, { sinceDate: "2026-04-01", dryRun: true });
  expect(summary.candidate_events).toBe(2);
  expect(summary.sessions).toBe(2);
  expect(summary.classified).toBe(1); // YouTube counted
  expect(summary.skipped_unclassifiable).toBe(1); // Chrome no-title-no-url
  expect(summary.errors).toBe(0);

  const cnt = await db.queryRow<{ n: number | bigint }>(`SELECT COUNT(*) AS n FROM classifications`);
  expect(Number(cnt!.n)).toBe(0); // dry run wrote nothing
});

test("unclassifiable alarm: only counts apps NOT counted by another path", async () => {
  // Metadata-less phone apps that ARE counted elsewhere (YouTube → watch
  // history; WhatsApp/Messages → 0%; LinkedIn → heuristic). These are
  // unclassifiable but EXPECTED — they must not trip the regression alarm.
  await insertEvent({ id: "p:yt", device: "phone", bucket: "android-test",
    app: "com.google.android.youtube", title: null, url: null, ts: "2026-05-01T10:00:00", durationSec: 600 });
  await insertEvent({ id: "p:wa", device: "phone", bucket: "android-test",
    app: "com.whatsapp", title: null, url: null, ts: "2026-05-01T11:00:00", durationSec: 600 });
  await insertEvent({ id: "p:li", device: "phone", bucket: "android-test",
    app: "com.linkedin.android", title: null, url: null, ts: "2026-05-01T12:00:00", durationSec: 600 });
  // A title-bearing Tier-2 app (Pocket Casts) that lost its title → UNEXPECTED:
  // this is the genuine-regression signal the alarm is meant to catch.
  await insertEvent({ id: "p:pc", device: "phone", bucket: "android-test",
    app: "Pocket Casts", title: null, url: null, ts: "2026-05-01T13:00:00", durationSec: 600 });

  const summary = await classifyAll(db, { sinceDate: "2026-04-01", dryRun: true });
  expect(summary.skipped_unclassifiable).toBe(4);            // all four have no title/url
  expect(summary.skipped_unclassifiable_unexpected).toBe(1); // only Pocket Casts
});

// LLM accuracy test lives in tests/Classifier.accuracy.test.ts (its own file
// to avoid sharing a Db setup with the inference subprocess).
