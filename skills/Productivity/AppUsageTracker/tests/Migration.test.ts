/**
 * Migration.test.ts — verifies the schema_version migration logic.
 * Specifically v1: append ts_start to existing events.id values that lack a
 * timestamp segment.
 */

import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Db } from "../Tools/Db.ts";

const TMP = mkdtempSync(join(tmpdir(), "aw-migration-"));
const DB_PATH = join(TMP, "events.db");
let db: Db;

beforeAll(async () => {
  db = await Db.open(DB_PATH);
  // Don't initSchema yet — we want to seed a pre-migration state.
  await db.run(`CREATE TABLE IF NOT EXISTS events (
    id VARCHAR PRIMARY KEY, device VARCHAR NOT NULL, bucket VARCHAR NOT NULL,
    watcher VARCHAR NOT NULL, app VARCHAR, title VARCHAR, url VARCHAR,
    audible BOOLEAN, ts_start TIMESTAMP NOT NULL, duration_sec DOUBLE NOT NULL,
    raw_json VARCHAR
  )`);
  // Seed with OLD-style IDs (no T...Z segment)
  await db.run(`INSERT INTO events VALUES
    ('phone:b:1', 'phone', 'b', 'w', 'a', NULL, NULL, NULL, '2026-04-28T10:00:00'::TIMESTAMP, 600, '{}')`);
  await db.run(`INSERT INTO events VALUES
    ('phone:b:2', 'phone', 'b', 'w', 'a', NULL, NULL, NULL, '2026-04-28T10:10:00'::TIMESTAMP, 600, '{}')`);
  // Seed with one already-migrated-shape ID
  await db.run(`INSERT INTO events VALUES
    ('phone:b:3:2026-04-28T10:20:00.000Z', 'phone', 'b', 'w', 'a', NULL, NULL, NULL, '2026-04-28T10:20:00'::TIMESTAMP, 600, '{}')`);
});

afterAll(() => {
  if (db) db.close();
  rmSync(TMP, { recursive: true, force: true });
});

test("migration v1: appends ts_start to id values that lack a T...Z segment", async () => {
  await db.initSchema(); // runs migrations
  const rows = await db.queryAll<{ id: string }>(`SELECT id FROM events ORDER BY id`);
  const ids = rows.map(r => r.id);

  // Pre-migration row "phone:b:1" → has a T and Z now
  expect(ids.some(id => id.startsWith("phone:b:1:") && /T.*Z/.test(id))).toBe(true);
  expect(ids.some(id => id.startsWith("phone:b:2:") && /T.*Z/.test(id))).toBe(true);
  // Already-migrated row stayed intact
  expect(ids).toContain("phone:b:3:2026-04-28T10:20:00.000Z");
  // schema_version row exists
  const sv = await db.queryRow<{ v: number | bigint | null }>(`SELECT MAX(version) AS v FROM schema_version`);
  expect(Number(sv!.v)).toBeGreaterThanOrEqual(1);
});

test("migration v1: idempotent — second initSchema doesn't double-append", async () => {
  const beforeIds = (await db.queryAll<{ id: string }>(`SELECT id FROM events`)).map(r => r.id).sort();
  await db.initSchema();
  const afterIds = (await db.queryAll<{ id: string }>(`SELECT id FROM events`)).map(r => r.id).sort();
  expect(afterIds).toEqual(beforeIds);
});
