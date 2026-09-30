/**
 * RunStateWriter.test.ts — MEMORY/State/youtube-curation.json writer.
 *
 * Hermetic: every case passes an explicit path (mkdtemp). Covers: round-trip
 * with RunStateReader, held-items merge (per-surface partial patch),
 * corrupt/missing existing file stays safe, and malformed update fields
 * throw rather than silently keeping the old value.
 */

import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readRunState } from "../Tools/RunStateReader.ts";
import { writeRunState } from "../Tools/RunStateWriter.ts";

const TMP = mkdtempSync(join(tmpdir(), "yt-runstatewriter-test-"));

afterAll(() => {
  rmSync(TMP, { recursive: true, force: true });
});

test("writeRunState(): writing held.history on a fresh file round-trips through readRunState()", () => {
  const path = join(TMP, "fresh.json");
  const written = writeRunState(
    { held: { history: [{ videoId: "h1", reason: "unsure — could be a rewatch" }] } },
    { path },
  );
  expect(written.held.history).toEqual([{ videoId: "h1", reason: "unsure — could be a rewatch" }]);
  expect(written.held.watch_later).toEqual([]);

  const { state, note } = readRunState(path);
  expect(note).toBeNull();
  expect(state.held.history).toEqual([{ videoId: "h1", reason: "unsure — could be a rewatch" }]);
});

test("writeRunState(): held-items merge — writing history preserves an existing watch_later held list untouched", () => {
  const path = join(TMP, "merge.json");
  writeRunState(
    {
      held: {
        history: [{ videoId: "h-old", reason: "old history hold" }],
        watch_later: [{ videoId: "wl-old", title: "Old WL item", reason: "old wl hold" }],
      },
    },
    { path },
  );

  // A prune run only re-judges history — it must not touch watch_later's held list.
  const after = writeRunState(
    { held: { history: [{ videoId: "h-new", reason: "fresh judgment this run" }] } },
    { path },
  );

  expect(after.held.history).toEqual([{ videoId: "h-new", reason: "fresh judgment this run" }]);
  expect(after.held.watch_later).toEqual([{ videoId: "wl-old", title: "Old WL item", reason: "old wl hold" }]);
});

test("writeRunState(): held-items merge — writing watch_later (a wl run) preserves an existing history held list untouched (the reverse of a prune run)", () => {
  const path = join(TMP, "merge-reverse.json");
  writeRunState(
    {
      held: {
        history: [{ videoId: "h-old", reason: "old history hold" }],
        watch_later: [{ videoId: "wl-old", title: "Old WL item", reason: "old wl hold" }],
      },
    },
    { path },
  );

  // A wl run only re-judges watch_later — it must not touch history's held list.
  const after = writeRunState(
    { held: { watch_later: [{ videoId: "wl-new", title: "Fresh WL item", reason: "fresh judgment this run" }] } },
    { path },
  );

  expect(after.held.watch_later).toEqual([{ videoId: "wl-new", title: "Fresh WL item", reason: "fresh judgment this run" }]);
  expect(after.held.history).toEqual([{ videoId: "h-old", reason: "old history hold" }]);
});

test("writeRunState(): somedayPlaylist round-trips and survives an unrelated held-items update untouched", () => {
  const path = join(TMP, "someday-playlist.json");
  writeRunState({ somedayPlaylist: { id: "PL_someday", title: "Kaya: Someday" } }, { path });

  const after = writeRunState({ held: { watch_later: [{ videoId: "v1", reason: "hold" }] } }, { path });

  expect(after.somedayPlaylist).toEqual({ id: "PL_someday", title: "Kaya: Someday" });
});

test("writeRunState(): malformed somedayPlaylist throws rather than silently keeping the old value", () => {
  const path = join(TMP, "bad-someday-playlist.json");
  writeRunState({ somedayPlaylist: { id: "PL_old", title: "Kaya: Someday" } }, { path });

  let threw: unknown = null;
  try {
    // @ts-expect-error deliberately malformed — missing required `id`
    writeRunState({ somedayPlaylist: { title: "Kaya: Someday" } }, { path });
  } catch (err) {
    threw = err;
  }
  expect(threw).toBeInstanceOf(Error);
  expect((threw as Error).message).toContain("somedayPlaylist");

  const { state } = readRunState(path);
  expect(state.somedayPlaylist).toEqual({ id: "PL_old", title: "Kaya: Someday" });
});

test("writeRunState(): lastRun update preserves held + wlSnapshot untouched", () => {
  const path = join(TMP, "lastrun-only.json");
  writeRunState(
    {
      held: { history: [{ videoId: "h1", reason: "hold" }] },
      wlSnapshot: { path: "/some/snap.json", capturedAt: "2026-08-09", count: 1094 },
    },
    { path },
  );

  const after = writeRunState(
    { lastRun: { mode: "prune", runId: "run-42", at: "2026-08-12T00:00:00Z", summary: "5 deleted, 1 held" } },
    { path },
  );

  expect(after.lastRun).toEqual({
    mode: "prune",
    runId: "run-42",
    at: "2026-08-12T00:00:00Z",
    summary: "5 deleted, 1 held",
  });
  expect(after.held.history).toEqual([{ videoId: "h1", reason: "hold" }]);
  expect(after.wlSnapshot).toEqual({ path: "/some/snap.json", capturedAt: "2026-08-09", count: 1094 });
});

test("writeRunState(): existing corrupt file is safe — write proceeds as if state was empty, self-heals", () => {
  const path = join(TMP, "corrupt.json");
  writeFileSync(path, "{ not json at all");

  const written = writeRunState({ held: { history: [{ videoId: "h1", reason: "hold" }] } }, { path });
  expect(written.held.history).toEqual([{ videoId: "h1", reason: "hold" }]);

  // File on disk is now valid JSON — corruption doesn't propagate forward.
  const onDisk = JSON.parse(readFileSync(path, "utf8"));
  expect(onDisk.held.history).toEqual([{ videoId: "h1", reason: "hold" }]);
});

test("writeRunState(): missing existing file is safe — first-ever write just works", () => {
  const path = join(TMP, "never-existed", "nested", "state.json");
  const written = writeRunState({ lastRun: { mode: "status", runId: "r1", at: "2026-08-12T00:00:00Z", summary: "ok" } }, { path });
  expect(written.lastRun?.runId).toBe("r1");
});

test("writeRunState(): malformed held item throws rather than silently dropping it", () => {
  const path = join(TMP, "bad-held.json");
  let threw: unknown = null;
  try {
    // @ts-expect-error deliberately malformed — missing required `reason`
    writeRunState({ held: { history: [{ videoId: "h1" }] } }, { path });
  } catch (err) {
    threw = err;
  }
  expect(threw).toBeInstanceOf(Error);
  expect((threw as Error).message).toContain("held.history");
});

test("writeRunState(): lastSteerDetail round-trips and survives an unrelated held-items update untouched", () => {
  const path = join(TMP, "steer-detail.json");
  const lastSteerDetail = {
    runId: "steer-42",
    at: "2026-08-12T00:00:00Z",
    topics: [
      { topic: "woodworking", playlistId: "PL_wood", playlistTitle: "Kaya: woodworking", created: true, existingUnwatchedCount: 0, added: ["v1", "v2", "v3"] },
    ],
    sweepActionCount: 5,
    searchesRun: 3,
    droppedTopicCleanups: [],
    subjectiveCheckIn: null,
  };
  writeRunState({ lastSteerDetail }, { path });

  const after = writeRunState({ held: { history: [{ videoId: "h1", reason: "hold" }] } }, { path });

  expect(after.lastSteerDetail).toEqual(lastSteerDetail);
  expect(after.held.history).toEqual([{ videoId: "h1", reason: "hold" }]);
});

test("writeRunState(): malformed lastSteerDetail throws rather than silently keeping the old value", () => {
  const path = join(TMP, "bad-steer-detail.json");
  const good = {
    runId: "steer-old", at: "2026-08-01T00:00:00Z", topics: [], sweepActionCount: 0, searchesRun: 0,
    droppedTopicCleanups: [], subjectiveCheckIn: null,
  };
  writeRunState({ lastSteerDetail: good }, { path });

  let threw: unknown = null;
  try {
    // @ts-expect-error deliberately malformed — sweepActionCount must be a number
    writeRunState({ lastSteerDetail: { ...good, sweepActionCount: "five" } }, { path });
  } catch (err) {
    threw = err;
  }
  expect(threw).toBeInstanceOf(Error);
  expect((threw as Error).message).toContain("lastSteerDetail");

  const { state } = readRunState(path);
  expect(state.lastSteerDetail).toEqual(good);
});

test("writeRunState(): malformed lastRun throws rather than silently keeping the old value", () => {
  const path = join(TMP, "bad-lastrun.json");
  writeRunState({ lastRun: { mode: "prune", runId: "run-old", at: "2026-08-01T00:00:00Z", summary: "old" } }, { path });

  let threw: unknown = null;
  try {
    // @ts-expect-error deliberately malformed — invalid mode
    writeRunState({ lastRun: { mode: "bogus", runId: "run-new", at: "2026-08-12T00:00:00Z", summary: "new" } }, { path });
  } catch (err) {
    threw = err;
  }
  expect(threw).toBeInstanceOf(Error);

  // The old value must still be intact — the throw must happen BEFORE any write.
  const { state } = readRunState(path);
  expect(state.lastRun?.runId).toBe("run-old");
});
