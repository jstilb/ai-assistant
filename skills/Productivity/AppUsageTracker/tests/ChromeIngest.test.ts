/**
 * ChromeIngest.test.ts — verifies that Mac Chrome's History SQLite is
 * faithfully copied into the chrome_visits table, with correct Chrome-epoch
 * conversion, source attribution, and incremental cursoring.
 *
 * Uses a temp fixture SQLite that mimics Chromium's `urls`/`visits` schema
 * exactly (subset of columns we actually read). NEVER touches Jm's real
 * Chrome history — that lives at ~/Library/Application Support/Google/Chrome.
 */

import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Db } from "../Tools/Db.ts";
import {
  chromeEpochToUnix,
  extractDomain,
  ingestChromeVisits,
} from "../Tools/ChromeIngest.ts";

const TMP = mkdtempSync(join(tmpdir(), "aw-chrome-ingest-"));
const DB_PATH = join(TMP, "events.db");
const FIXTURE_PATH = join(TMP, "fixture-history.db");

let db: Db;

// Chrome epoch helpers: microseconds since 1601-01-01 UTC.
// Unix epoch (ms) → Chrome epoch (μs): (unixMs + 11644473600000) * 1000
function unixIsoToChromeEpoch(iso: string): number {
  return (Date.parse(iso) + 11644473600000) * 1000;
}

interface FixtureVisit {
  url: string;
  title: string;
  visitTimeIso: string;
  visitDurationSec: number;
  transition: number;
  fromVisit: number;
  originatorCacheGuid: string;
}

function createFixture(visits: FixtureVisit[]): void {
  // Clean slate per fixture build
  try { rmSync(FIXTURE_PATH, { force: true }); } catch {}
  const f = new Database(FIXTURE_PATH);
  // Subset of the real Chromium History schema — just the columns we actually
  // SELECT from in ChromeIngest. Real Chrome adds many more (segment_id,
  // visited_link_id, etc.) but they're irrelevant here.
  f.run(`CREATE TABLE urls (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    url TEXT,
    title TEXT,
    visit_count INTEGER DEFAULT 0 NOT NULL,
    last_visit_time INTEGER NOT NULL,
    hidden INTEGER DEFAULT 0 NOT NULL
  )`);
  f.run(`CREATE TABLE visits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    url INTEGER NOT NULL,
    visit_time INTEGER NOT NULL,
    from_visit INTEGER,
    transition INTEGER DEFAULT 0 NOT NULL,
    visit_duration INTEGER DEFAULT 0 NOT NULL,
    originator_cache_guid TEXT,
    is_known_to_sync BOOLEAN DEFAULT FALSE NOT NULL
  )`);
  // Group visits by URL — Chromium has one urls row per unique URL.
  const urlIds = new Map<string, number>();
  const insertUrl = f.prepare(
    `INSERT INTO urls (url, title, last_visit_time) VALUES (?, ?, ?) RETURNING id`,
  );
  const insertVisit = f.prepare(
    `INSERT INTO visits (url, visit_time, from_visit, transition, visit_duration, originator_cache_guid)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  for (const v of visits) {
    let id = urlIds.get(v.url);
    if (id === undefined) {
      const row = insertUrl.get(v.url, v.title, unixIsoToChromeEpoch(v.visitTimeIso)) as { id: number };
      id = row.id;
      urlIds.set(v.url, id);
    }
    insertVisit.run(
      id,
      unixIsoToChromeEpoch(v.visitTimeIso),
      v.fromVisit,
      v.transition,
      v.visitDurationSec * 1_000_000, // seconds → microseconds
      v.originatorCacheGuid,
    );
  }
  f.close();
}

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
  await db.run("DELETE FROM chrome_sync_state");
});

// --- chromeEpochToUnix ---

test("chromeEpochToUnix: 0 maps to 1601-01-01 UTC", () => {
  expect(chromeEpochToUnix(0).toISOString()).toBe("1601-01-01T00:00:00.000Z");
});

test("chromeEpochToUnix: known timestamp round-trips", () => {
  const iso = "2026-05-12T15:00:00.000Z";
  const chromeUs = (Date.parse(iso) + 11644473600000) * 1000;
  expect(chromeEpochToUnix(chromeUs).toISOString()).toBe(iso);
});

// --- extractDomain ---

test("extractDomain: handles common URL shapes", () => {
  expect(extractDomain("https://www.reddit.com/r/programming")).toBe("reddit.com");
  expect(extractDomain("https://news.ycombinator.com/")).toBe("news.ycombinator.com");
  expect(extractDomain("http://example.com:8080/path")).toBe("example.com");
  expect(extractDomain("https://en.wikipedia.org/wiki/X")).toBe("en.wikipedia.org");
});

test("extractDomain: returns null for non-URL strings", () => {
  expect(extractDomain("")).toBeNull();
  expect(extractDomain("javascript:void(0)")).toBeNull();
  expect(extractDomain("not a url")).toBeNull();
});

test("extractDomain: strips www. prefix only on second-level domains", () => {
  // www.reddit.com → reddit.com (strip)
  expect(extractDomain("https://www.reddit.com/x")).toBe("reddit.com");
  // www.bbc.co.uk → bbc.co.uk (strip)
  expect(extractDomain("https://www.bbc.co.uk/x")).toBe("bbc.co.uk");
  // m.reddit.com → m.reddit.com (no strip — subdomains other than www stay)
  expect(extractDomain("https://m.reddit.com/x")).toBe("m.reddit.com");
});

// --- ingestChromeVisits: basic flow ---

test("ingestChromeVisits: empty SQLite yields 0 rows, no errors", async () => {
  createFixture([]);
  const summary = await ingestChromeVisits({ db, historyPath: FIXTURE_PATH });
  expect(summary.visits_read).toBe(0);
  expect(summary.visits_inserted).toBe(0);
  const cnt = await db.queryRow<{ n: number | bigint }>(`SELECT COUNT(*) AS n FROM chrome_visits`);
  expect(Number(cnt!.n)).toBe(0);
});

test("ingestChromeVisits: single local visit produces 1 chrome_visits row", async () => {
  createFixture([{
    url: "https://www.reddit.com/r/programming",
    title: "r/programming",
    visitTimeIso: "2026-05-10T15:00:00.000Z",
    visitDurationSec: 120,
    transition: 805306368,
    fromVisit: 0,
    originatorCacheGuid: "", // empty string = local Mac
  }]);
  const summary = await ingestChromeVisits({ db, historyPath: FIXTURE_PATH });
  expect(summary.visits_read).toBe(1);
  expect(summary.visits_inserted).toBe(1);

  const row = await db.queryRow<{
    source: string; url: string; domain: string;
    title: string; visit_time: string; visit_duration_sec: number | bigint;
    originator_cache_guid: string;
  }>(`SELECT source, url, domain, title, visit_time::VARCHAR AS visit_time,
            visit_duration_sec, originator_cache_guid
       FROM chrome_visits`);
  expect(row!.source).toBe("mac");
  expect(row!.url).toBe("https://www.reddit.com/r/programming");
  expect(row!.domain).toBe("reddit.com");
  expect(row!.title).toBe("r/programming");
  expect(Number(row!.visit_duration_sec)).toBe(120);
});

test("ingestChromeVisits: non-empty originator_cache_guid → source='sync'", async () => {
  createFixture([{
    url: "https://www.reddit.com/r/all",
    title: "r/all",
    visitTimeIso: "2026-05-10T15:00:00.000Z",
    visitDurationSec: 30,
    transition: 0,
    fromVisit: 0,
    originatorCacheGuid: "phone-guid-abc123",
  }]);
  await ingestChromeVisits({ db, historyPath: FIXTURE_PATH });
  const row = await db.queryRow<{ source: string; originator_cache_guid: string }>(
    `SELECT source, originator_cache_guid FROM chrome_visits`,
  );
  expect(row!.source).toBe("sync");
  expect(row!.originator_cache_guid).toBe("phone-guid-abc123");
});

test("ingestChromeVisits: idempotent — re-running same fixture writes no new rows", async () => {
  createFixture([{
    url: "https://www.reddit.com/r/programming",
    title: "r/programming",
    visitTimeIso: "2026-05-10T15:00:00.000Z",
    visitDurationSec: 60,
    transition: 0,
    fromVisit: 0,
    originatorCacheGuid: "",
  }]);
  await ingestChromeVisits({ db, historyPath: FIXTURE_PATH });
  const firstCount = Number(
    (await db.queryRow<{ n: number | bigint }>(`SELECT COUNT(*) AS n FROM chrome_visits`))!.n,
  );

  const summary2 = await ingestChromeVisits({ db, historyPath: FIXTURE_PATH });
  // Cursor advance means we don't re-read old rows
  expect(summary2.visits_read).toBe(0);
  expect(summary2.visits_inserted).toBe(0);

  const secondCount = Number(
    (await db.queryRow<{ n: number | bigint }>(`SELECT COUNT(*) AS n FROM chrome_visits`))!.n,
  );
  expect(secondCount).toBe(firstCount);
});

test("ingestChromeVisits: incremental — second run picks up only new visits", async () => {
  createFixture([{
    url: "https://www.reddit.com/r/programming",
    title: "r/programming",
    visitTimeIso: "2026-05-10T15:00:00.000Z",
    visitDurationSec: 60,
    transition: 0,
    fromVisit: 0,
    originatorCacheGuid: "",
  }]);
  await ingestChromeVisits({ db, historyPath: FIXTURE_PATH });

  // Append a NEW visit and re-ingest
  createFixture([
    {
      url: "https://www.reddit.com/r/programming",
      title: "r/programming",
      visitTimeIso: "2026-05-10T15:00:00.000Z",
      visitDurationSec: 60,
      transition: 0,
      fromVisit: 0,
      originatorCacheGuid: "",
    },
    {
      url: "https://news.ycombinator.com/",
      title: "Hacker News",
      visitTimeIso: "2026-05-11T16:00:00.000Z",
      visitDurationSec: 90,
      transition: 0,
      fromVisit: 0,
      originatorCacheGuid: "",
    },
  ]);
  const summary = await ingestChromeVisits({ db, historyPath: FIXTURE_PATH });
  expect(summary.visits_read).toBe(1);   // only new one read
  expect(summary.visits_inserted).toBe(1);

  const total = Number(
    (await db.queryRow<{ n: number | bigint }>(`SELECT COUNT(*) AS n FROM chrome_visits`))!.n,
  );
  expect(total).toBe(2);
});

test("ingestChromeVisits: cursor advance respects sinceUnix override", async () => {
  createFixture([
    {
      url: "https://old.example.com/",
      title: "old",
      visitTimeIso: "2025-01-01T00:00:00.000Z",
      visitDurationSec: 60,
      transition: 0,
      fromVisit: 0,
      originatorCacheGuid: "",
    },
    {
      url: "https://new.example.com/",
      title: "new",
      visitTimeIso: "2026-05-10T00:00:00.000Z",
      visitDurationSec: 90,
      transition: 0,
      fromVisit: 0,
      originatorCacheGuid: "",
    },
  ]);
  const summary = await ingestChromeVisits({
    db,
    historyPath: FIXTURE_PATH,
    sinceUnix: new Date("2026-01-01T00:00:00Z"),
  });
  expect(summary.visits_read).toBe(1);
  expect(summary.visits_inserted).toBe(1);

  const row = await db.queryRow<{ url: string }>(`SELECT url FROM chrome_visits`);
  expect(row!.url).toBe("https://new.example.com/");
});

test("ingestChromeVisits: handles missing History file gracefully", async () => {
  const summary = await ingestChromeVisits({
    db,
    historyPath: `${TMP}/does-not-exist.db`,
  });
  expect(summary.visits_read).toBe(0);
  expect(summary.visits_inserted).toBe(0);
  expect(summary.skipped).toBeTruthy();
});
