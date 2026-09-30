#!/usr/bin/env bun
/**
 * saved.test.ts — SavedEvents store + UI-server saved endpoints.
 *
 * Tests:
 *   1. saveEvent → readSaved roundtrip (newest first, savedAt stamped).
 *   2. Idempotent re-save: snapshot refreshed, savedAt preserved, added:false.
 *   3. unsaveEvent removes; unsaving an unknown id reports removed:false.
 *   4. Snapshot survives cache absence — a saved event NOT in the cache is
 *      still returned (the whole point of snapshotting).
 *   5. UI server: /api/data carries saved[]; POST /api/saved/add + /remove
 *      round-trip; add of an unknown id errors 404.
 *
 * Env isolation: same hazard class as cache.test.ts — KAYA_HOME/KAYA_DIR are
 * pinned to a mkdtempSync dir BEFORE any Tools module is imported (dynamic
 * import below), so module-init path constants never capture the live tree.
 *
 * Run:
 *   bun test <absolute path to this file>
 */

import { test, expect, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { EventItem } from "../Tools/types.ts";

const ORIGINAL_KAYA_HOME = process.env["KAYA_HOME"];
const ORIGINAL_KAYA_DIR = process.env["KAYA_DIR"];

const TEST_KAYA_HOME = mkdtempSync(join(tmpdir(), "eventscout-saved-test-"));
process.env["KAYA_HOME"] = TEST_KAYA_HOME;
process.env["KAYA_DIR"] = TEST_KAYA_HOME;
process.env["EVENTSCOUT_CACHE_PATH"] = join(TEST_KAYA_HOME, "events-cache.json");
process.env["EVENTSCOUT_SAVED_PATH"] = join(TEST_KAYA_HOME, "saved-events.json");
process.env["EVENTSCOUT_UI_PORT"] = "0";
process.env["EVENTSCOUT_UI_NO_OPEN"] = "1";

const { saveEvent, unsaveEvent, readSaved, savedIdSet } = await import("../Tools/SavedEvents.ts");
const { writeEvents } = await import("../Tools/Cache.ts");
const { startUiServer } = await import("../Tools/UiServer.ts");

afterAll(() => {
  if (ORIGINAL_KAYA_HOME === undefined) delete process.env["KAYA_HOME"];
  else process.env["KAYA_HOME"] = ORIGINAL_KAYA_HOME;
  if (ORIGINAL_KAYA_DIR === undefined) delete process.env["KAYA_DIR"];
  else process.env["KAYA_DIR"] = ORIGINAL_KAYA_DIR;
  delete process.env["EVENTSCOUT_CACHE_PATH"];
  delete process.env["EVENTSCOUT_SAVED_PATH"];
  delete process.env["EVENTSCOUT_UI_PORT"];
  delete process.env["EVENTSCOUT_UI_NO_OPEN"];
  rmSync(TEST_KAYA_HOME, { recursive: true, force: true });
});

function makeEvent(id: string, title: string): EventItem {
  return {
    id,
    title,
    startDatetime: "2027-01-15T19:00:00-08:00",
    allDay: false,
    venue: "The Casbah",
    category: "music",
    tags: ["indie"],
    isFree: false,
    priceMin: 25,
    sourceUrl: `https://example.com/${id}`,
    sources: [{ sourceId: "test-src", url: `https://example.com/${id}` }],
    fetchedAt: "2026-08-01T07:00:00Z",
    status: "scheduled",
  };
}

test("saveEvent → readSaved roundtrip, newest first", async () => {
  const a = makeEvent("ev-a", "Show A");
  const b = makeEvent("ev-b", "Show B");
  expect(saveEvent(a)).toEqual({ added: true });
  await Bun.sleep(2); // distinct savedAt timestamps for the sort assertion
  expect(saveEvent(b)).toEqual({ added: true });

  const saved = readSaved();
  expect(saved.length).toBe(2);
  expect(saved[0]!.event.id).toBe("ev-b"); // newest-saved first
  expect(saved[1]!.event.id).toBe("ev-a");
  expect(new Date(saved[0]!.savedAt).getTime()).toBeGreaterThan(0);
  expect(savedIdSet()).toEqual(new Set(["ev-a", "ev-b"]));
});

test("re-save is idempotent: snapshot refreshed, savedAt preserved", () => {
  const before = readSaved().find((s) => s.event.id === "ev-a")!;
  const richer = { ...makeEvent("ev-a", "Show A"), description: "now with a description" };
  expect(saveEvent(richer)).toEqual({ added: false });

  const after = readSaved().find((s) => s.event.id === "ev-a")!;
  expect(after.savedAt).toBe(before.savedAt);
  expect(after.event.description).toBe("now with a description");
  expect(readSaved().length).toBe(2);
});

test("unsaveEvent removes; unknown id reports removed:false", () => {
  expect(unsaveEvent("ev-b")).toEqual({ removed: true });
  expect(unsaveEvent("ev-b")).toEqual({ removed: false });
  expect(savedIdSet()).toEqual(new Set(["ev-a"]));
});

test("saved snapshot survives the event not being in the cache", () => {
  writeEvents([]); // cache regenerated without ev-a (e.g. pruned after the date passed)
  const saved = readSaved();
  expect(saved.length).toBe(1);
  expect(saved[0]!.event.title).toBe("Show A");
});

test("UI server: /api/data saved[] + add/remove endpoints", async () => {
  writeEvents([makeEvent("ev-c", "Show C")]);
  const server = startUiServer();
  const base = `http://localhost:${server.port}`;
  try {
    const add = await fetch(`${base}/api/saved/add`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "ev-c" }),
    });
    expect(add.status).toBe(200);
    const addBody = (await add.json()) as { added: boolean; saved: unknown[] };
    expect(addBody.added).toBe(true);
    expect(addBody.saved.length).toBe(2); // ev-a (from earlier tests) + ev-c

    const missing = await fetch(`${base}/api/saved/add`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "nope" }),
    });
    expect(missing.status).toBe(404);

    const data = (await (await fetch(`${base}/api/data`)).json()) as {
      saved: Array<{ savedAt: string; event: { id: string } }>;
    };
    expect(data.saved.map((s) => s.event.id).sort()).toEqual(["ev-a", "ev-c"]);

    const rm = await fetch(`${base}/api/saved/remove`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "ev-c" }),
    });
    expect(rm.status).toBe(200);
    const rmBody = (await rm.json()) as { removed: boolean; saved: unknown[] };
    expect(rmBody.removed).toBe(true);
    expect(savedIdSet()).toEqual(new Set(["ev-a"]));
  } finally {
    server.stop(true);
  }
});
