/**
 * Db.test.ts — transaction batching (L1: appusage-duckdb-batching).
 *
 * Root cause: ChromeTakeoutIngest issued ~129k individually-committed INSERTs
 * (no transaction wrapping), which crashed the nightly job with
 * duckdb::DuckTransaction::Commit -> std::terminate -> SIGTRAP on a bun N-API
 * worker thread. These tests cover the new transaction()/runBatched() helpers
 * that let bulk-insert callers batch many statements into ONE commit.
 */

import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Db } from "../Tools/Db.ts";

const TMP = mkdtempSync(join(tmpdir(), "aw-db-batch-"));
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
});

function visitParams(n: number): Record<string, unknown> {
  return {
    id: `takeout:${n}`,
    url: `https://example.com/${n}`,
    domain: "example.com",
    title: `title-${n}`,
    secs: 1747581135 + n,
    cid: "",
  };
}

const INSERT_SQL = `INSERT OR REPLACE INTO chrome_visits
   (id, source, url, domain, title, visit_time, visit_duration_sec, transition, from_visit_id, originator_cache_guid)
 VALUES ($id, 'takeout', $url, $domain, $title,
         (to_timestamp($secs) AT TIME ZONE 'UTC')::TIMESTAMP,
         0, 0, 0, $cid)`;

test("transaction(): commits all statements run inside fn", async () => {
  await db.transaction(async () => {
    await db.run(INSERT_SQL, visitParams(1));
    await db.run(INSERT_SQL, visitParams(2));
  });
  const rows = await db.queryAll(`SELECT id FROM chrome_visits ORDER BY id`);
  expect(rows.length).toBe(2);
});

test("transaction(): rolls back all statements when fn throws, and rethrows", async () => {
  let threw = false;
  try {
    await db.transaction(async () => {
      await db.run(INSERT_SQL, visitParams(1));
      throw new Error("synthetic mid-transaction failure");
    });
  } catch (err) {
    threw = true;
    expect((err as Error).message).toBe("synthetic mid-transaction failure");
  }
  expect(threw).toBe(true);
  const rows = await db.queryAll(`SELECT id FROM chrome_visits`);
  expect(rows.length).toBe(0);
});

test("transaction(): returns fn's resolved value", async () => {
  const result = await db.transaction(async () => 42);
  expect(result).toBe(42);
});

test("runBatched(): inserts all rows across multiple batches (default batchSize=1000)", async () => {
  const rows = Array.from({ length: 2500 }, (_, i) => visitParams(i));
  await db.runBatched(INSERT_SQL, rows, 1000);
  const count = await db.queryRow<{ n: bigint | number }>(`SELECT COUNT(*) AS n FROM chrome_visits`);
  expect(Number(count?.n)).toBe(2500);
});

test("runBatched(): a single-row batch still works (batchSize larger than row count)", async () => {
  const rows = [visitParams(1), visitParams(2), visitParams(3)];
  await db.runBatched(INSERT_SQL, rows, 1000);
  const count = await db.queryRow<{ n: bigint | number }>(`SELECT COUNT(*) AS n FROM chrome_visits`);
  expect(Number(count?.n)).toBe(3);
});

test("runBatched(): empty rows array is a no-op", async () => {
  await db.runBatched(INSERT_SQL, [], 1000);
  const count = await db.queryRow<{ n: bigint | number }>(`SELECT COUNT(*) AS n FROM chrome_visits`);
  expect(Number(count?.n)).toBe(0);
});

test("runBatched(): a bad row in a LATER batch does not roll back an EARLIER already-committed batch", async () => {
  // batchSize=2: batch1 = rows[0..1] (good, commits), batch2 = rows[2..3]
  // where rows[3] violates the NOT NULL url constraint — batch2 must roll
  // back as a whole, but batch1's rows must remain committed.
  const rows = [
    visitParams(1),
    visitParams(2),
    visitParams(3),
    { ...visitParams(4), url: null },
  ];
  let threw = false;
  try {
    await db.runBatched(INSERT_SQL, rows, 2);
  } catch {
    threw = true;
  }
  expect(threw).toBe(true);
  const ids = (await db.queryAll<{ id: string }>(`SELECT id FROM chrome_visits ORDER BY id`)).map(r => r.id);
  // batch1 (rows 1,2) committed; batch2 (rows 3,4) rolled back entirely.
  expect(ids).toEqual(["takeout:1", "takeout:2"]);
});
