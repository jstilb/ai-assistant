/**
 * ChromeMetric.test.ts — verifies that MetricCalc.computeChromeLowValueMinutes
 * sums chrome_visits time per local-date according to chrome_domain_verdicts.
 * Also checks the 30-min cap and the zero-duration fallback.
 */

import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Db } from "../Tools/Db.ts";
import {
  computeChromeLowValueMinutes,
  computeTier2LowValueMinutes,
  computeTier1Minutes,
  upsertMetric,
  CHROME_VISIT_DURATION_CAP_SEC,
  CHROME_VISIT_DURATION_FALLBACK_SEC,
} from "../Tools/MetricCalc.ts";

const TMP = mkdtempSync(join(tmpdir(), "aw-chrome-metric-"));
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
  await db.run("DELETE FROM chrome_visits");
  await db.run("DELETE FROM chrome_domain_verdicts");
  await db.run("DELETE FROM events");
  await db.run("DELETE FROM classifications");
  await db.run("DELETE FROM daily_metrics");
});

async function insertVisit(row: {
  id: string; source: string; url: string; domain: string;
  ts: string; durSec: number;
}): Promise<void> {
  await db.run(
    `INSERT OR REPLACE INTO chrome_visits
       (id, source, url, domain, title, visit_time, visit_duration_sec,
        transition, from_visit_id, originator_cache_guid)
     VALUES ($id, $source, $url, $domain, NULL, $ts::TIMESTAMP, $dur, 0, 0, '')`,
    {
      id: row.id, source: row.source, url: row.url, domain: row.domain,
      ts: row.ts, dur: row.durSec,
    },
  );
}

async function insertVerdict(row: {
  domain: string; source: string; isLow: boolean;
  /** Defaults to 'llm-sonnet' — the classifier whose verdicts count toward
   * tier2_chrome minutes. `'tier1-domain'` short-circuit verdicts are excluded
   * by computeChromeLowValueMinutes to avoid double-counting with aw-watcher
   * URL pattern matches (see MetricCalc.ts doc comment). */
  classifier?: string;
}): Promise<void> {
  await db.run(
    `INSERT OR REPLACE INTO chrome_domain_verdicts
       (domain, source, is_low_value, reason, confidence, classifier, classified_at)
     VALUES ($domain, $source, $low, 'test', 0.9, $classifier, $now::TIMESTAMP)`,
    {
      domain: row.domain, source: row.source, low: row.isLow,
      classifier: row.classifier ?? "llm-sonnet",
      now: new Date().toISOString(),
    },
  );
}

test("low-value visit on its day → minutes counted", async () => {
  await insertVisit({
    id: "c1", source: "mac",
    url: "https://www.reddit.com/r/all", domain: "reddit.com",
    ts: "2026-05-10T15:00:00Z", durSec: 600, // 10 min
  });
  await insertVerdict({ domain: "reddit.com", source: "mac", isLow: true });

  // local-date 2026-05-10 (15:00 UTC = 08:00 PDT, same date)
  const min = await computeChromeLowValueMinutes(db, "2026-05-10");
  expect(min).toBe(10);
});

test("not-low-value visit → 0 minutes", async () => {
  await insertVisit({
    id: "c2", source: "mac",
    url: "https://mail.google.com/", domain: "mail.google.com",
    ts: "2026-05-10T15:00:00Z", durSec: 1800,
  });
  await insertVerdict({ domain: "mail.google.com", source: "mac", isLow: false });
  expect(await computeChromeLowValueMinutes(db, "2026-05-10")).toBe(0);
});

test("unclassified visit → 0 minutes (cannot count without verdict)", async () => {
  await insertVisit({
    id: "c3", source: "mac",
    url: "https://example.weird/", domain: "example.weird",
    ts: "2026-05-10T15:00:00Z", durSec: 600,
  });
  // No verdict row
  expect(await computeChromeLowValueMinutes(db, "2026-05-10")).toBe(0);
});

test("per-visit duration capped at 30 min (prevents tab-left-open-overnight)", async () => {
  await insertVisit({
    id: "c4", source: "mac",
    url: "https://www.reddit.com/r/all", domain: "reddit.com",
    ts: "2026-05-10T15:00:00Z", durSec: 7200, // 2 hr raw
  });
  await insertVerdict({ domain: "reddit.com", source: "mac", isLow: true });
  expect(CHROME_VISIT_DURATION_CAP_SEC).toBe(1800);
  expect(await computeChromeLowValueMinutes(db, "2026-05-10")).toBe(30); // capped
});

test("zero-duration visit gets fallback minutes (low sentinel)", async () => {
  await insertVisit({
    id: "c5", source: "mac",
    url: "https://www.reddit.com/r/all", domain: "reddit.com",
    ts: "2026-05-10T15:00:00Z", durSec: 0,
  });
  await insertVerdict({ domain: "reddit.com", source: "mac", isLow: true });
  expect(CHROME_VISIT_DURATION_FALLBACK_SEC).toBe(60);
  expect(await computeChromeLowValueMinutes(db, "2026-05-10")).toBe(1); // 60s = 1 min
});

test("source must match — mac verdict does NOT classify sync visits", async () => {
  await insertVisit({
    id: "c6a", source: "sync",
    url: "https://example.weird/", domain: "example.weird",
    ts: "2026-05-10T15:00:00Z", durSec: 600,
  });
  // Verdict exists only for source='mac'
  await insertVerdict({ domain: "example.weird", source: "mac", isLow: true });
  expect(await computeChromeLowValueMinutes(db, "2026-05-10")).toBe(0);
});

test("local-date conversion respects CONFIG.localTimezone (UTC late-evening lands today)", async () => {
  // 06:30 UTC May 12 = 23:30 PDT May 11. Should land in 2026-05-11.
  await insertVisit({
    id: "c7", source: "mac",
    url: "https://www.reddit.com/r/all", domain: "reddit.com",
    ts: "2026-05-12T06:30:00Z", durSec: 600,
  });
  await insertVerdict({ domain: "reddit.com", source: "mac", isLow: true });
  expect(await computeChromeLowValueMinutes(db, "2026-05-11")).toBe(10);
  expect(await computeChromeLowValueMinutes(db, "2026-05-12")).toBe(0);
});

test("tier1-domain verdicts are EXCLUDED (already counted via aw-watcher URL match)", async () => {
  // Reddit on Mac browses through both pipelines:
  //   1) aw-watcher-web-chrome event with url ILIKE '%reddit.com%' → Tier-1 minutes
  //   2) chrome_visits + chrome_domain_verdicts(classifier='tier1-domain') → would be Tier-2 minutes
  // Counting (2) would double-count the same wall-clock time. The
  // computeChromeLowValueMinutes query excludes classifier='tier1-domain'
  // for exactly this reason. LLM-classified low-value domains DO count
  // (aw-watcher URL patterns can't catch them).
  await insertVisit({
    id: "c-t1domain", source: "mac",
    url: "https://www.reddit.com/r/all", domain: "reddit.com",
    ts: "2026-05-10T15:00:00Z", durSec: 600,
  });
  await insertVerdict({
    domain: "reddit.com", source: "mac", isLow: true,
    classifier: "tier1-domain",
  });
  expect(await computeChromeLowValueMinutes(db, "2026-05-10")).toBe(0);

  // Same domain via the LLM path → still counts.
  await insertVisit({
    id: "c-llm", source: "mac",
    url: "https://news.ycombinator.com/", domain: "news.ycombinator.com",
    ts: "2026-05-10T15:00:00Z", durSec: 600,
  });
  await insertVerdict({
    domain: "news.ycombinator.com", source: "mac", isLow: true,
    classifier: "llm-sonnet",
  });
  expect(await computeChromeLowValueMinutes(db, "2026-05-10")).toBe(10);
});

test("upsertMetric: chrome low-value minutes fold into tier2_lowvalue_minutes", async () => {
  // 15 min Reddit on phone (Tier-1) + 10 min Chrome low-value = 25 total
  await db.run(
    `INSERT OR REPLACE INTO events
       (id, device, bucket, watcher, app, title, url, audible, ts_start, duration_sec, raw_json)
     VALUES ('e1', 'phone', 'test', 'test', 'com.reddit.frontpage', NULL, NULL, NULL,
             '2026-05-10T15:00:00'::TIMESTAMP, 900, '{}')`,
  );
  await insertVisit({
    id: "c8", source: "mac",
    url: "https://www.reddit.com/r/all", domain: "reddit.com",
    ts: "2026-05-10T16:00:00Z", durSec: 600,
  });
  await insertVerdict({ domain: "reddit.com", source: "mac", isLow: true });

  const tier1 = await computeTier1Minutes(db, "2026-05-10");
  const tier2Events = await computeTier2LowValueMinutes(db, "2026-05-10");
  const tier2Chrome = await computeChromeLowValueMinutes(db, "2026-05-10");
  await upsertMetric(db, "2026-05-10", tier1, tier2Events + tier2Chrome);

  const row = await db.queryRow<{ t1: number | bigint; t2: number | bigint; tot: number | bigint }>(
    `SELECT tier1_minutes AS t1, tier2_lowvalue_minutes AS t2, total_lowvalue_minutes AS tot
       FROM daily_metrics WHERE date='2026-05-10'::DATE`,
  );
  expect(Number(row!.t1)).toBe(15);
  expect(Number(row!.t2)).toBe(10);
  expect(Number(row!.tot)).toBe(25);
});
