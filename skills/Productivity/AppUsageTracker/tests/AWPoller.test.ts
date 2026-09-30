/**
 * AWPoller.test.ts — verifies AWPoller against a mock AW REST server.
 *
 * Spins up Bun.serve() on a random port returning the fixture in
 * `tests/fixtures/sample-aw-events.json`, then calls pollDevice() directly
 * (no subprocess) and asserts events landed in DuckDB.
 */

import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "bun";

// KAYA_HOME isolation — set BEFORE any import that reads it. The
// "cursor-poison guard" test below deliberately triggers pollDevice's real
// logFailure("AWPoller", ...) call, which routes through FailureLog's
// hermetic-write guard (assertNotLiveHomeUnderTest) and throws if KAYA_HOME
// still resolves to the live ~/.claude home under NODE_ENV=test. Pinning it
// to a mkdtemp dir here (same idiom as PipelineDB.test.ts) sandboxes that
// write instead of hitting the live failure-log.jsonl.
const KAYA_HOME_TMP = mkdtempSync(join(tmpdir(), "aw-poller-kayahome-"));
process.env.KAYA_HOME = KAYA_HOME_TMP;

import { Db } from "../Tools/Db.ts";
import { pollDevice } from "../Tools/AWPoller.ts";

const TMP = mkdtempSync(join(tmpdir(), "aw-poller-test-"));
const DB_PATH = join(TMP, "events.db");
const FIXTURE = JSON.parse(
  readFileSync(join(import.meta.dir, "fixtures", "sample-aw-events.json"), "utf8"),
) as {
  buckets: Record<string, unknown>;
  events: Record<string, unknown[]>;
};

let server: Server;
let db: Db;
let mockUrl: string;

beforeAll(async () => {
  server = Bun.serve({
    port: 0, // random
    hostname: "127.0.0.1",
    fetch(req) {
      const u = new URL(req.url);
      if (u.pathname === "/api/0/info") {
        return Response.json({ hostname: "test-host", version: "v0.13.x" });
      }
      if (u.pathname === "/api/0/buckets/") {
        return Response.json(FIXTURE.buckets);
      }
      const m = u.pathname.match(/^\/api\/0\/buckets\/([^/]+)\/events$/);
      if (m) {
        const bucketId = decodeURIComponent(m[1]);
        const events = FIXTURE.events[bucketId] ?? [];
        return Response.json(events);
      }
      return new Response("not found", { status: 404 });
    },
  });
  mockUrl = `http://127.0.0.1:${server.port}`;
  db = await Db.open(DB_PATH);
  await db.initSchema();
});

afterAll(() => {
  if (db) db.close();
  if (server) server.stop();
  rmSync(TMP, { recursive: true, force: true });
  rmSync(KAYA_HOME_TMP, { recursive: true, force: true });
});

beforeEach(async () => {
  await db.run("DELETE FROM events");
  await db.run("DELETE FROM sync_state");
});

test("pollDevice ingests all events from mock server", async () => {
  const result = await pollDevice({ name: "phone", baseUrl: mockUrl }, db, false);
  expect(result.ok).toBe(true);
  expect(result.buckets).toBe(4);
  // Fixture totals: 2 (window) + 3 (afk) + 3 (android) + 2 (web) = 10 events
  expect(result.events_inserted).toBe(10);

  const count = await db.queryRow<{ n: number | bigint }>(`SELECT COUNT(*) AS n FROM events`);
  expect(Number(count!.n)).toBe(10);
});

test("dry-run does not write events", async () => {
  const result = await pollDevice({ name: "phone", baseUrl: mockUrl }, db, true);
  expect(result.ok).toBe(true);
  expect(result.events_fetched).toBe(10);
  expect(result.events_inserted).toBe(0);

  const count = await db.queryRow<{ n: number | bigint }>(`SELECT COUNT(*) AS n FROM events`);
  expect(Number(count!.n)).toBe(0);
});

test("re-poll is idempotent (INSERT OR REPLACE on PK)", async () => {
  await pollDevice({ name: "phone", baseUrl: mockUrl }, db, false);
  await pollDevice({ name: "phone", baseUrl: mockUrl }, db, false);

  const count = await db.queryRow<{ n: number | bigint }>(`SELECT COUNT(*) AS n FROM events`);
  expect(Number(count!.n)).toBe(10); // not 20
});

test("placeholder Tailscale IP is skipped (not an error)", async () => {
  const result = await pollDevice(
    { name: "phone", baseUrl: "http://100.0.0.0:5600" },
    db,
    false,
  );
  expect(result.ok).toBe(true);
  expect(result.skipped).toBeDefined();
  expect(result.events_inserted).toBe(0);
});

test("event PK encodes device:bucket:event_id (cross-device unique)", async () => {
  await pollDevice({ name: "phone", baseUrl: mockUrl }, db, false);

  const ids = await db.queryAll<{ id: string }>(`SELECT id FROM events ORDER BY id`);
  expect(ids[0].id.startsWith("phone:")).toBe(true);
  // Spot check unique id format: "phone:<bucketId>:<eventId>"
  const sample = ids.find(r => r.id.includes("aw-watcher-window_test-host"));
  expect(sample).toBeDefined();
});

test("cursor-poison guard: future cursor is reset to MAX(events.ts_start)", async () => {
  // Seed events + a normal cursor first.
  await pollDevice({ name: "phone", baseUrl: mockUrl }, db, false);

  // Now poison the cursor for one bucket to a year in the future, mimicking
  // the TZ-drift incident's end state.
  await db.run(
    `UPDATE sync_state SET last_event_ts = '2099-01-01 00:00:00'::TIMESTAMP
      WHERE device = 'phone' AND bucket = 'aw-watcher-window_test-host'`,
  );

  // Poll again. The guard should detect the future cursor, reset it to the
  // newest event we have for that bucket, then proceed.
  await pollDevice({ name: "phone", baseUrl: mockUrl }, db, false);

  const after = await db.queryRow<{ iso: string | null }>(
    `SELECT strftime(last_event_ts, '%Y-%m-%dT%H:%M:%S.%fZ') AS iso
       FROM sync_state
      WHERE device = 'phone' AND bucket = 'aw-watcher-window_test-host'`,
  );
  // Reset target = MAX(events.ts_start) for this bucket. We don't pin the
  // exact value (depends on fixture) — just assert it isn't the 2099 poison.
  expect(after?.iso).not.toBeNull();
  expect(after!.iso!.startsWith("2099-")).toBe(false);
});

test("stale bucket skip: server-side bucket idle > 7 days is not polled", async () => {
  // Spin a one-off mock server returning one fresh + one stale bucket.
  const eightDaysAgo = new Date(Date.now() - 8 * 86_400_000).toISOString();
  const oneHourAgo = new Date(Date.now() - 3600_000).toISOString();
  let eventsEndpointHits = 0;

  const localServer = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      const u = new URL(req.url);
      if (u.pathname === "/api/0/info") return Response.json({ hostname: "x", version: "v0.13" });
      if (u.pathname === "/api/0/buckets/") {
        return Response.json({
          "aw-watcher-fresh": {
            id: "aw-watcher-fresh", type: "currentwindow", client: "x",
            hostname: "x", last_updated: oneHourAgo,
          },
          "aw-watcher-stale": {
            id: "aw-watcher-stale", type: "currentwindow", client: "x",
            hostname: "x", last_updated: eightDaysAgo,
          },
        });
      }
      if (u.pathname.startsWith("/api/0/buckets/")) {
        eventsEndpointHits++;
        const bucket = decodeURIComponent(u.pathname.split("/")[4]);
        // Either bucket: return one event so we can tell what was actually polled.
        if (bucket === "aw-watcher-fresh") {
          return Response.json([{ id: 1, timestamp: oneHourAgo, duration: 60, data: { app: "x" } }]);
        }
        return Response.json([]);
      }
      return new Response("not found", { status: 404 });
    },
  });

  try {
    const localDb = await Db.open(join(TMP, "stale-test.db"));
    await localDb.initSchema();
    const r = await pollDevice({ name: "phone", baseUrl: `http://127.0.0.1:${localServer.port}` }, localDb, false);
    expect(r.ok).toBe(true);
    // The stale bucket should not have triggered an events fetch.
    expect(eventsEndpointHits).toBe(1);
    expect(r.events_inserted).toBe(1);
    localDb.close();
  } finally {
    localServer.stop();
  }
});

test("cursor is stable across empty polls — no TZ drift on round-trip", async () => {
  // Regression for the 2026-05-14 incident where DuckDB TIMESTAMP →
  // DuckDBTimestampValue → `new Date(...)` treated the naive value as LOCAL,
  // adding the host TZ offset on every poll. Within a few days of empty
  // polls cursors drifted months into the future and pollers stopped seeing
  // any events. The fix is to read the cursor as a UTC ISO string via
  // strftime and to UPDATE only last_sync_ok on empty polls.

  // First poll lands events; cursor should be set to the newest fixture ts.
  await pollDevice({ name: "phone", baseUrl: mockUrl }, db, false);

  const initial = await db.queryRow<{ iso: string | null }>(
    `SELECT strftime(MAX(last_event_ts), '%Y-%m-%dT%H:%M:%S.%fZ') AS iso
       FROM sync_state WHERE device = 'phone' AND bucket != '_poll_'`,
  );
  expect(initial?.iso).not.toBeNull();
  const initialCursor = initial!.iso!;

  // Now poll 5 more times. The mock returns the same fixture each time
  // (it doesn't filter by ?start=), so events are re-inserted via PK REPLACE
  // — but the cursor must not advance past the fixture's newest event.
  // If the TZ round-trip bug ever reappears, the cursor would silently shift
  // by the host's TZ offset each loop and this assertion would fail.
  for (let i = 0; i < 5; i++) {
    await pollDevice({ name: "phone", baseUrl: mockUrl }, db, false);
  }

  const after = await db.queryRow<{ iso: string | null }>(
    `SELECT strftime(MAX(last_event_ts), '%Y-%m-%dT%H:%M:%S.%fZ') AS iso
       FROM sync_state WHERE device = 'phone' AND bucket != '_poll_'`,
  );
  expect(after?.iso).toBe(initialCursor);
});
