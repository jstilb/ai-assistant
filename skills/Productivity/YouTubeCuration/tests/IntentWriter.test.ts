/**
 * IntentWriter.test.ts — confirmed topics → `USER/YouTubeIntent.yaml`
 * (write half of `/youtube steer`).
 *
 * Hermetic: every case passes an explicit `path` (mkdtemp), never the live
 * tree or the worktree's own USER/ — mirrors IntentReader.test.ts.
 */

import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { readIntent } from "../Tools/IntentReader.ts";
import { writeIntent } from "../Tools/IntentWriter.ts";

const TMP = mkdtempSync(join(tmpdir(), "yt-intent-writer-test-"));

afterAll(() => {
  rmSync(TMP, { recursive: true, force: true });
});

test("writeIntent(): produces a YAML file with exactly topics + declared_at", () => {
  const path = join(TMP, "exact-shape.yaml");
  const now = new Date("2026-08-12T00:00:00.000Z");

  writeIntent(["woodworking", "jazz guitar"], { path, now });

  const raw = parseYaml(readFileSync(path, "utf8")) as Record<string, unknown>;
  expect(Object.keys(raw).sort()).toEqual(["declared_at", "topics"]);
  expect(raw.topics).toEqual(["woodworking", "jazz guitar"]);
  expect(raw.declared_at).toBe("2026-08-12T00:00:00.000Z");
});

test("writeIntent(): round-trips through IntentReader with content equality", () => {
  const path = join(TMP, "round-trip.yaml");
  const now = new Date("2026-08-01T12:30:00.000Z");

  const written = writeIntent(["cooking", "deep learning"], { path, now });

  const { intent, note } = readIntent(path);
  expect(note).toBeNull();
  expect(intent).toEqual({ topics: written.topics, declaredAt: written.declaredAt });
});

test("writeIntent(): replacement is total — a new declaration fully replaces the old topic list", () => {
  const path = join(TMP, "replace.yaml");

  writeIntent(["woodworking", "jazz guitar"], { path, now: new Date("2026-07-01T00:00:00.000Z") });
  writeIntent(["cooking"], { path, now: new Date("2026-08-01T00:00:00.000Z") });

  const { intent } = readIntent(path);
  expect(intent?.topics).toEqual(["cooking"]);
  expect(intent?.declaredAt).toBe("2026-08-01T00:00:00.000Z");
});

test("writeIntent(): trims topics and drops blank entries before writing", () => {
  const path = join(TMP, "trim.yaml");

  const result = writeIntent(["  history documentaries  ", "", "   "], { path, now: new Date() });

  expect(result.topics).toEqual(["history documentaries"]);
  const { intent } = readIntent(path);
  expect(intent?.topics).toEqual(["history documentaries"]);
});

test("writeIntent(): refuses to write an empty topic list", () => {
  const path = join(TMP, "empty.yaml");
  expect(() => writeIntent([], { path })).toThrow(/empty topic list/);
  expect(() => writeIntent(["   ", ""], { path })).toThrow(/empty topic list/);
});
