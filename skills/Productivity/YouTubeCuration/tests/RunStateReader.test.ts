/**
 * RunStateReader.test.ts — MEMORY/State/youtube-curation.json reader.
 *
 * Hermetic: every case passes an explicit path (mkdtemp). This file is a
 * convenience cache, not ground truth (spec.md §2) — missing/corrupt input
 * must degrade to safe defaults, never throw.
 */

import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readRunState } from "../Tools/RunStateReader.ts";

const TMP = mkdtempSync(join(tmpdir(), "yt-runstate-test-"));

afterAll(() => {
  rmSync(TMP, { recursive: true, force: true });
});

test("readRunState(): missing file degrades to empty defaults, never throws", () => {
  const path = join(TMP, "does-not-exist.json");
  const result = readRunState(path);
  expect(result.state.held.history).toEqual([]);
  expect(result.state.held.watch_later).toEqual([]);
  expect(result.state.lastRun).toBeNull();
  expect(result.state.wlSnapshot).toBeNull();
  expect(result.state.somedayPlaylist).toBeNull();
  expect(result.state.lastSteerDetail).toBeNull();
  expect(result.note).toContain("no run state yet");
});

test("readRunState(): corrupt JSON degrades safely, does not throw", () => {
  const path = join(TMP, "corrupt.json");
  writeFileSync(path, "{ this is not json");
  expect(() => readRunState(path)).not.toThrow();
  const result = readRunState(path);
  expect(result.state.held.history).toEqual([]);
  expect(result.note).toContain("malformed");
});

test("readRunState(): valid state file round-trips held items + lastRun + wlSnapshot", () => {
  const path = join(TMP, "valid.json");
  const stateJson = {
    held: {
      history: [{ videoId: "v1", reason: "unsure — could be a rewatch" }],
      watch_later: [{ videoId: "v2", title: "Some video", reason: "unsure — recent add" }],
    },
    lastRun: { mode: "prune", runId: "run-42", at: "2026-08-10T12:00:00Z", summary: "5 deleted, 0 held" },
    wlSnapshot: { path: "/some/path.json", capturedAt: "2026-08-09", count: 1094 },
    somedayPlaylist: { id: "PL_someday", title: "Kaya: Someday" },
  };
  writeFileSync(path, JSON.stringify(stateJson));
  const result = readRunState(path);
  expect(result.note).toBeNull();
  expect(result.state.held.history).toEqual([{ videoId: "v1", reason: "unsure — could be a rewatch" }]);
  expect(result.state.held.watch_later.length).toBe(1);
  expect(result.state.lastRun).toEqual({
    mode: "prune", runId: "run-42", at: "2026-08-10T12:00:00Z", summary: "5 deleted, 0 held",
  });
  expect(result.state.wlSnapshot).toEqual({ path: "/some/path.json", capturedAt: "2026-08-09", count: 1094 });
  expect(result.state.somedayPlaylist).toEqual({ id: "PL_someday", title: "Kaya: Someday" });
});

test("readSomedayPlaylist-shaped input via readRunState: malformed somedayPlaylist (missing id) degrades to null, does not throw", () => {
  const path = join(TMP, "bad-someday.json");
  writeFileSync(path, JSON.stringify({ somedayPlaylist: { title: "Kaya: Someday" } }));
  const result = readRunState(path);
  expect(result.note).toBeNull();
  expect(result.state.somedayPlaylist).toBeNull();
});

test("readRunState(): partially-shaped file (missing held) degrades that field only", () => {
  const path = join(TMP, "partial.json");
  writeFileSync(path, JSON.stringify({ lastRun: { mode: "wl", runId: "r1", at: "2026-08-10T00:00:00Z", summary: "ok" } }));
  const result = readRunState(path);
  expect(result.state.held.history).toEqual([]);
  expect(result.state.held.watch_later).toEqual([]);
  expect(result.state.lastRun?.mode).toBe("wl");
});

test("readRunState(): valid lastSteerDetail round-trips every field", () => {
  const path = join(TMP, "steer-detail.json");
  const lastSteerDetail = {
    runId: "steer-42",
    at: "2026-08-12T00:00:00Z",
    topics: [
      { topic: "woodworking", playlistId: "PL_wood", playlistTitle: "Kaya: woodworking", created: false, existingUnwatchedCount: 3, added: ["v1", "v2"] },
    ],
    sweepActionCount: 7,
    searchesRun: 4,
    droppedTopicCleanups: [
      { topic: "origami", playlistId: "PL_origami", playlistTitle: "Kaya: origami", itemVideoIds: ["o1"], deleted: true },
    ],
    subjectiveCheckIn: "yes, homepage felt better",
  };
  writeFileSync(path, JSON.stringify({ lastSteerDetail }));
  const result = readRunState(path);
  expect(result.note).toBeNull();
  expect(result.state.lastSteerDetail).toEqual(lastSteerDetail);
});

test("readRunState(): malformed lastSteerDetail (bad topics shape) degrades to null, does not throw", () => {
  const path = join(TMP, "bad-steer-detail.json");
  writeFileSync(path, JSON.stringify({ lastSteerDetail: { runId: "r1", at: "2026-08-12T00:00:00Z", topics: "not-an-array" } }));
  expect(() => readRunState(path)).not.toThrow();
  const result = readRunState(path);
  expect(result.state.lastSteerDetail).toBeNull();
});

test("readRunState(): lastSteerDetail with a null subjectiveCheckIn (not yet asked/answered) round-trips", () => {
  const path = join(TMP, "steer-detail-null-checkin.json");
  const lastSteerDetail = {
    runId: "steer-1", at: "2026-08-12T00:00:00Z", topics: [], sweepActionCount: 0, searchesRun: 0,
    droppedTopicCleanups: [], subjectiveCheckIn: null,
  };
  writeFileSync(path, JSON.stringify({ lastSteerDetail }));
  const result = readRunState(path);
  expect(result.state.lastSteerDetail).toEqual(lastSteerDetail);
});
