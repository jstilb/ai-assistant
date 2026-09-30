/**
 * ChromeTakeoutIngest.test.ts — verifies Takeout Chrome History.json parsing
 * and chrome_visits insert. Resolves the phone-Chrome blind spot called out
 * in project_chrome_sync_absence.md: Takeout's Chrome export is cross-device,
 * so visits that never landed in Mac's local SQLite show up here.
 */

import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// KAYA_HOME isolation — set BEFORE any import that reads it. The two
// "ingestAll: ... isolation" tests below deliberately trigger a real
// ingestAll failure path (bad JSON / a thrown per-file error), which calls
// logFailure("ChromeTakeoutIngest", ...) and routes through FailureLog's
// hermetic-write guard (assertNotLiveHomeUnderTest) — it throws if KAYA_HOME
// still resolves to the live ~/.claude home under NODE_ENV=test. Pinning it
// to a mkdtemp dir here (same idiom as PipelineDB.test.ts / AWPoller.test.ts)
// sandboxes that write instead of hitting the live failure-log.jsonl.
const KAYA_HOME_TMP = mkdtempSync(join(tmpdir(), "aw-chrome-takeout-kayahome-"));
process.env.KAYA_HOME = KAYA_HOME_TMP;

import { Db } from "../Tools/Db.ts";
import { ingestAll, ingestChromeTakeoutFile, parseChromeTakeoutHistory, type ChromeTakeoutSummary } from "../Tools/ChromeTakeoutIngest.ts";

const TMP = mkdtempSync(join(tmpdir(), "aw-chrome-takeout-"));
const DB_PATH = join(TMP, "events.db");
let db: Db;

beforeAll(async () => {
  db = await Db.open(DB_PATH);
  await db.initSchema();
});

afterAll(() => {
  if (db) db.close();
  rmSync(TMP, { recursive: true, force: true });
  rmSync(KAYA_HOME_TMP, { recursive: true, force: true });
});

beforeEach(async () => {
  await db.run("DELETE FROM chrome_visits");
});

function writeHistoryJson(filename: string, browserHistory: unknown[]): string {
  const path = join(TMP, filename);
  writeFileSync(path, JSON.stringify({
    "Browser History": browserHistory,
    "Typed Url": [],
    "Session": [],
    "Shared Tab Group": [],
  }));
  return path;
}

test("parseChromeTakeoutHistory: extracts url, title, time_usec; computes domain; handles empty input", () => {
  const rows = parseChromeTakeoutHistory({
    "Browser History": [
      { url: "https://www.reddit.com/r/programming/", title: "r/programming", time_usec: 1747581135935546, favicon_url: "", page_transition_qualifier: "CLIENT_REDIRECT", client_id: "X" },
      { url: "https://github.com/anthropics/claude", title: "Claude on GitHub", time_usec: 1747600000000000, favicon_url: "", page_transition_qualifier: "LINK", client_id: "X" },
    ],
  });
  expect(rows.length).toBe(2);
  expect(rows[0].url).toBe("https://www.reddit.com/r/programming/");
  expect(rows[0].domain).toBe("reddit.com");
  expect(rows[0].timeUsec).toBe(1747581135935546);
  expect(rows[0].title).toBe("r/programming");
  expect(rows[1].domain).toBe("github.com");
});

test("parseChromeTakeoutHistory: skips entries missing url or time_usec", () => {
  const rows = parseChromeTakeoutHistory({
    "Browser History": [
      { url: "", title: "no url", time_usec: 1747581135000000, page_transition_qualifier: "X", client_id: "X" },
      { url: "https://valid.com", title: "valid", time_usec: 0, page_transition_qualifier: "X", client_id: "X" },
      { url: "https://ok.com", title: "ok", time_usec: 1747600000000000, page_transition_qualifier: "X", client_id: "X" },
    ],
  });
  expect(rows.length).toBe(1);
  expect(rows[0].domain).toBe("ok.com");
});

test("parseChromeTakeoutHistory: lowercases domain, strips www, handles port and subdomain", () => {
  const rows = parseChromeTakeoutHistory({
    "Browser History": [
      { url: "https://WWW.Reddit.COM/x", title: "x", time_usec: 1747581100000000, page_transition_qualifier: "X", client_id: "X" },
      { url: "https://mail.google.com:443/u/0/", title: "y", time_usec: 1747581200000000, page_transition_qualifier: "X", client_id: "X" },
    ],
  });
  expect(rows[0].domain).toBe("reddit.com");
  expect(rows[1].domain).toBe("mail.google.com");
});

test("parseChromeTakeoutHistory: tolerates missing 'Browser History' key", () => {
  expect(parseChromeTakeoutHistory({})).toEqual([]);
  expect(parseChromeTakeoutHistory({ "Browser History": null })).toEqual([]);
});

test("ingestChromeTakeoutFile: inserts rows with source='takeout' and id='takeout:<usec>'", async () => {
  const path = writeHistoryJson("history-1.json", [
    { url: "https://reddit.com/", title: "Reddit", time_usec: 1747581135000000, page_transition_qualifier: "X", client_id: "X" },
    { url: "https://news.ycombinator.com/", title: "HN", time_usec: 1747581200000000, page_transition_qualifier: "X", client_id: "X" },
  ]);
  const summary = await ingestChromeTakeoutFile(db, path);
  expect(summary.entries_read).toBe(2);
  expect(summary.rows_inserted).toBe(2);

  const rows = await db.queryAll<{ id: string; source: string; domain: string; visit_time: string }>(
    `SELECT id, source, domain, visit_time::VARCHAR AS visit_time FROM chrome_visits ORDER BY visit_time`,
  );
  expect(rows.length).toBe(2);
  expect(rows[0].source).toBe("takeout");
  expect(rows[0].id).toBe("takeout:1747581135000000");
  expect(rows[0].domain).toBe("reddit.com");
  expect(rows[1].id).toBe("takeout:1747581200000000");
  expect(rows[1].domain).toBe("news.ycombinator.com");
});

test("ingestChromeTakeoutFile: idempotent re-runs (INSERT OR REPLACE on PK)", async () => {
  const path = writeHistoryJson("history-2.json", [
    { url: "https://reddit.com/", title: "Reddit v1", time_usec: 1747581135000000, page_transition_qualifier: "X", client_id: "X" },
  ]);
  await ingestChromeTakeoutFile(db, path);
  // Mutate the file — same time_usec, new title — must REPLACE, not duplicate.
  writeFileSync(path, JSON.stringify({
    "Browser History": [{ url: "https://reddit.com/", title: "Reddit v2", time_usec: 1747581135000000, page_transition_qualifier: "X", client_id: "X" }],
  }));
  await ingestChromeTakeoutFile(db, path);

  const rows = await db.queryAll<{ title: string }>(`SELECT title FROM chrome_visits WHERE id='takeout:1747581135000000'`);
  expect(rows.length).toBe(1);
  expect(rows[0].title).toBe("Reddit v2");
});

test("ingestChromeTakeoutFile: time_usec → visit_time TIMESTAMP is UTC and round-trips", async () => {
  // 1747581135935546 µs since Unix epoch = 2025-05-18 15:12:15.935546 UTC
  const path = writeHistoryJson("history-3.json", [
    { url: "https://example.com/", title: "x", time_usec: 1747581135935546, page_transition_qualifier: "X", client_id: "X" },
  ]);
  await ingestChromeTakeoutFile(db, path);
  const row = await db.queryRow<{ visit_time: string }>(
    `SELECT visit_time::VARCHAR AS visit_time FROM chrome_visits LIMIT 1`,
  );
  // DuckDB renders TIMESTAMP without timezone — verify the calendar+time.
  expect(row?.visit_time).toBe("2025-05-18 15:12:15.935546");
});

test("ingestChromeTakeoutFile: batches >1000 rows across multiple transactions — all rows land, none lost (L1 batching)", async () => {
  const n = 2500;
  const entries = Array.from({ length: n }, (_, i) => ({
    url: `https://example.com/page-${i}`,
    title: `page ${i}`,
    time_usec: 1747581135000000 + i,
    page_transition_qualifier: "X",
    client_id: "X",
  }));
  const path = writeHistoryJson("history-bulk.json", entries);
  const summary = await ingestChromeTakeoutFile(db, path);
  expect(summary.entries_read).toBe(n);
  expect(summary.rows_inserted).toBe(n);

  const count = await db.queryRow<{ c: bigint | number }>(`SELECT COUNT(*) AS c FROM chrome_visits`);
  expect(Number(count?.c)).toBe(n);
});

test("ingestAll: injectable `paths` param processes exactly the given files (no real Takeout-inbox scan)", async () => {
  const p1 = writeHistoryJson("all-1.json", [
    { url: "https://a.com/", title: "A", time_usec: 1747581135000001, page_transition_qualifier: "X", client_id: "X" },
  ]);
  const p2 = writeHistoryJson("all-2.json", [
    { url: "https://b.com/", title: "B", time_usec: 1747581135000002, page_transition_qualifier: "X", client_id: "X" },
  ]);
  const summary = await ingestAll(db, [p1, p2]);
  expect(summary.source_files).toEqual([p1, p2]);
  expect(summary.rows_inserted).toBe(2);
  expect(summary.failed_files).toEqual([]);
});

test("ingestAll: per-file isolation — an unparseable file in the MIDDLE does not stop later files, and is surfaced in failed_files", async () => {
  const p1 = writeHistoryJson("good-1.json", [
    { url: "https://a.com/", title: "A", time_usec: 1747581135000011, page_transition_qualifier: "X", client_id: "X" },
  ]);
  const badPath = join(TMP, "bad-middle.json");
  writeFileSync(badPath, "{ not valid json !!!");
  const p3 = writeHistoryJson("good-3.json", [
    { url: "https://c.com/", title: "C", time_usec: 1747581135000013, page_transition_qualifier: "X", client_id: "X" },
  ]);

  const summary = await ingestAll(db, [p1, badPath, p3]);

  // Files 1 and 3 (surrounding the bad file) both got ingested — not skipped.
  expect(summary.source_files).toEqual([p1, p3]);
  expect(summary.rows_inserted).toBe(2);
  // The bad file is surfaced, not silently absorbed as a 0-row "success".
  expect(summary.failed_files.length).toBe(1);
  expect(summary.failed_files[0]!.path).toBe(badPath);
  expect(summary.failed_files[0]!.error).toContain("parse error");

  const rows = await db.queryAll<{ id: string }>(`SELECT id FROM chrome_visits ORDER BY id`);
  expect(rows.map(r => r.id)).toEqual(["takeout:1747581135000011", "takeout:1747581135000013"]);
});

test("ingestAll: a file whose ingest THROWS (e.g. a DB-level error) is caught, recorded, and later files still run", async () => {
  const p1 = writeHistoryJson("throw-1.json", []);
  const p2 = writeHistoryJson("throw-2.json", []);
  const p3 = writeHistoryJson("throw-3.json", []);

  const seen: string[] = [];
  const fakeIngest = async (_db: Db, path: string): Promise<ChromeTakeoutSummary> => {
    seen.push(path);
    if (path === p2) throw new Error("synthetic DB-level failure on file 2");
    return { source_files: [path], entries_read: 1, entries_skipped: 0, rows_inserted: 1, failed_files: [] };
  };

  const summary = await ingestAll(db, [p1, p2, p3], fakeIngest);

  // All three files were attempted — file 2 throwing did not stop file 3.
  expect(seen).toEqual([p1, p2, p3]);
  expect(summary.source_files).toEqual([p1, p3]);
  expect(summary.rows_inserted).toBe(2);
  expect(summary.failed_files.length).toBe(1);
  expect(summary.failed_files[0]!.path).toBe(p2);
  expect(summary.failed_files[0]!.error).toContain("synthetic DB-level failure");
});

test("ingestAll: failed_files defaults to an empty array when nothing failed", async () => {
  const p1 = writeHistoryJson("clean-1.json", [
    { url: "https://a.com/", title: "A", time_usec: 1747581135000099, page_transition_qualifier: "X", client_id: "X" },
  ]);
  const summary = await ingestAll(db, [p1]);
  expect(summary.failed_files).toEqual([]);
});
