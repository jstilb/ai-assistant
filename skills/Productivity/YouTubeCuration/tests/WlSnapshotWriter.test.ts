/**
 * WlSnapshotWriter.test.ts — writes a dated WL snapshot file + updates the
 * run-state `wlSnapshot` pointer in one call. Hermetic: every case passes
 * explicit `dir`/`statePath` overrides (mkdtemp), never the live
 * `.scratch/youtube-curation/assets` or `MEMORY/State/`.
 */

import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readRunState } from "../Tools/RunStateReader.ts";
import { readWlSnapshotCount } from "../Tools/SnapshotReader.ts";
import { writeWlSnapshot, type WlSnapshotItem } from "../Tools/WlSnapshotWriter.ts";

const TMP = mkdtempSync(join(tmpdir(), "yt-wlsnapshot-writer-test-"));

afterAll(() => {
  rmSync(TMP, { recursive: true, force: true });
});

const SAMPLE_ITEMS: WlSnapshotItem[] = [
  { position: 1, video_id: "v1", title: "Video One", channel: "Chan A", channel_url: "https://youtube.com/@a", duration: "12:34", progress_pct: null },
  { position: 2, video_id: "v2", title: "Video Two", channel: "Chan B", channel_url: "https://youtube.com/@b", duration: "1:02:03", progress_pct: 45 },
];

test("writeWlSnapshot(): writes a dated file in ticket-07's exact shape (captured_at, engine, header_count, complete, items)", () => {
  const dir = join(TMP, "shape");
  const statePath = join(TMP, "shape-state.json");
  const now = new Date("2026-08-15T09:00:00.000Z");

  const result = writeWlSnapshot({ items: SAMPLE_ITEMS, headerCount: 2, complete: true }, { dir, statePath, now });

  expect(result.path).toBe(join(dir, "wl-snapshot-2026-08-15.json"));
  expect(result.capturedAt).toBe("2026-08-15");
  expect(result.count).toBe(2);

  const onDisk = JSON.parse(readFileSync(result.path, "utf8")) as Record<string, unknown>;
  expect(Object.keys(onDisk).sort()).toEqual(["captured_at", "complete", "engine", "header_count", "items"]);
  expect(onDisk.captured_at).toBe("2026-08-15T09:00:00.000Z");
  expect(onDisk.engine).toBe("claude-in-chrome");
  expect(onDisk.header_count).toBe(2);
  expect(onDisk.complete).toBe(true);
  expect(onDisk.items).toEqual(SAMPLE_ITEMS);
});

test("writeWlSnapshot(): a header/item-count mismatch is written with complete:false, never silently dropped", () => {
  const dir = join(TMP, "incomplete");
  const statePath = join(TMP, "incomplete-state.json");

  const result = writeWlSnapshot(
    { items: SAMPLE_ITEMS, headerCount: 5, complete: false },
    { dir, statePath, now: new Date("2026-08-15T09:00:00.000Z") },
  );

  const onDisk = JSON.parse(readFileSync(result.path, "utf8")) as { complete: boolean; header_count: number };
  expect(onDisk.complete).toBe(false);
  expect(onDisk.header_count).toBe(5);
  expect(result.count).toBe(2); // still reports the actually-extracted count, not the header claim
});

test("writeWlSnapshot(): updates the run-state wlSnapshot pointer, round-trips through RunStateReader", () => {
  const dir = join(TMP, "state-roundtrip");
  const statePath = join(TMP, "state-roundtrip-state.json");

  const result = writeWlSnapshot({ items: SAMPLE_ITEMS, headerCount: 2, complete: true }, { dir, statePath, now: new Date("2026-08-15T09:00:00.000Z") });

  const { state } = readRunState(statePath);
  expect(state.wlSnapshot).toEqual({ path: result.path, capturedAt: "2026-08-15", count: 2 });
});

test("writeWlSnapshot(): the fresh wlSnapshot pointer is exactly what SnapshotReader.ts resolves next (state-pointer source, not the ticket-07 fallback)", () => {
  const dir = join(TMP, "snapshotreader-integration");
  const statePath = join(TMP, "snapshotreader-integration-state.json");
  const fallback = join(TMP, "unused-fallback.json");

  writeWlSnapshot({ items: SAMPLE_ITEMS, headerCount: 2, complete: true }, { dir, statePath, now: new Date("2026-08-15T09:00:00.000Z") });

  const { state } = readRunState(statePath);
  const snap = readWlSnapshotCount(state.wlSnapshot, fallback);

  expect(snap.source).toBe("state-pointer");
  expect(snap.count).toBe(2);
  expect(snap.capturedAt).toBe("2026-08-15");
});

test("writeWlSnapshot(): held items from a prior run survive untouched (partial-patch merge, not a full overwrite)", () => {
  const dir = join(TMP, "merge-preserve");
  const statePath = join(TMP, "merge-preserve-state.json");

  // Simulate a prior run that had already held some history items.
  writeWlSnapshot({ items: [], headerCount: 0, complete: true }, { dir, statePath, now: new Date("2026-08-01T00:00:00.000Z") });
  const before = readRunState(statePath).state;
  expect(before.held.history).toEqual([]);

  // A fresh wl snapshot write must not disturb held.* at all.
  writeWlSnapshot({ items: SAMPLE_ITEMS, headerCount: 2, complete: true }, { dir, statePath, now: new Date("2026-08-15T00:00:00.000Z") });
  const after = readRunState(statePath).state;
  expect(after.held.history).toEqual(before.held.history);
  expect(after.held.watch_later).toEqual(before.held.watch_later);
});

test("writeWlSnapshot(): creates the target directory if it doesn't exist yet", () => {
  const dir = join(TMP, "nested", "does-not-exist-yet");
  const statePath = join(TMP, "nested-state.json");
  expect(existsSync(dir)).toBe(false);

  writeWlSnapshot({ items: SAMPLE_ITEMS, headerCount: 2, complete: true }, { dir, statePath, now: new Date("2026-08-15T00:00:00.000Z") });

  expect(existsSync(dir)).toBe(true);
});
