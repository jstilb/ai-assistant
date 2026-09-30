/**
 * SnapshotReader.test.ts — last Watch Later snapshot count + date.
 *
 * Prefers the state-file pointer (written by a future `wl` run); falls
 * back to the ticket-07 asset shipped with this effort. Hermetic: every
 * case passes explicit paths.
 */

import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readWlSnapshotCount } from "../Tools/SnapshotReader.ts";
import type { WlSnapshotPointer } from "../Tools/RunStateReader.ts";

const TMP = mkdtempSync(join(tmpdir(), "yt-snapshot-test-"));

afterAll(() => {
  rmSync(TMP, { recursive: true, force: true });
});

test("readWlSnapshotCount(): no state pointer and no fallback file -> none, with a note", () => {
  const fallback = join(TMP, "no-such-fallback.json");
  const result = readWlSnapshotCount(null, fallback);
  expect(result.count).toBeNull();
  expect(result.source).toBe("none");
  expect(result.note).not.toBeNull();
});

test("readWlSnapshotCount(): state pointer present and its file exists -> uses pointer directly", () => {
  const pointerPath = join(TMP, "state-snapshot.json");
  writeFileSync(pointerPath, JSON.stringify({ captured_at: "2026-08-11T00:00:00Z", items: new Array(42).fill({}) }));
  const pointer: WlSnapshotPointer = { path: pointerPath, capturedAt: "2026-08-11", count: 42 };
  const result = readWlSnapshotCount(pointer, join(TMP, "unused-fallback.json"));
  expect(result.count).toBe(42);
  expect(result.capturedAt).toBe("2026-08-11");
  expect(result.source).toBe("state-pointer");
});

test("readWlSnapshotCount(): state pointer's file is missing -> falls back to the fallback path", () => {
  const missingPointerPath = join(TMP, "gone.json");
  const fallbackPath = join(TMP, "fallback.json");
  writeFileSync(fallbackPath, JSON.stringify({ captured_at: "2026-08-09T12:33:00-0700", items: new Array(1094).fill({}) }));
  const pointer: WlSnapshotPointer = { path: missingPointerPath, capturedAt: "2026-07-01", count: 999 };
  const result = readWlSnapshotCount(pointer, fallbackPath);
  expect(result.count).toBe(1094);
  expect(result.capturedAt).toBe("2026-08-09");
  expect(result.source).toBe("ticket-07-fallback");
});

test("readWlSnapshotCount(): no state pointer, fallback file exists -> reads items.length + captured_at date", () => {
  const fallbackPath = join(TMP, "fallback2.json");
  writeFileSync(fallbackPath, JSON.stringify({ captured_at: "2026-08-09T12:33:00-0700", items: new Array(1094).fill({}) }));
  const result = readWlSnapshotCount(null, fallbackPath);
  expect(result.count).toBe(1094);
  expect(result.capturedAt).toBe("2026-08-09");
  expect(result.source).toBe("ticket-07-fallback");
  expect(result.note).toBeNull();
});

test("readWlSnapshotCount(): malformed fallback JSON degrades safely, does not throw", () => {
  const fallbackPath = join(TMP, "bad.json");
  writeFileSync(fallbackPath, "{ not json");
  expect(() => readWlSnapshotCount(null, fallbackPath)).not.toThrow();
  const result = readWlSnapshotCount(null, fallbackPath);
  expect(result.count).toBeNull();
  expect(result.source).toBe("none");
});
