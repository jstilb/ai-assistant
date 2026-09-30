/**
 * IntentReader.test.ts — USER/YouTubeIntent.yaml reader.
 *
 * Hermetic: every case passes an explicit path (mkdtemp) rather than
 * relying on getKayaHome() resolution, so this suite never touches the live
 * tree regardless of KAYA_HOME.
 */

import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readIntent } from "../Tools/IntentReader.ts";

const TMP = mkdtempSync(join(tmpdir(), "yt-intent-test-"));

afterAll(() => {
  rmSync(TMP, { recursive: true, force: true });
});

test("readIntent(): missing file degrades to 'no intent declared', never throws", () => {
  const path = join(TMP, "does-not-exist.yaml");
  const result = readIntent(path);
  expect(result.intent).toBeNull();
  expect(result.note).toBe("no intent declared");
});

test("readIntent(): valid YAML returns topics + declaredAt", () => {
  const path = join(TMP, "valid.yaml");
  writeFileSync(path, "topics:\n  - woodworking\n  - deep learning\ndeclared_at: '2026-08-01'\n");
  const result = readIntent(path);
  expect(result.intent).toEqual({ topics: ["woodworking", "deep learning"], declaredAt: "2026-08-01" });
  expect(result.note).toBeNull();
});

test("readIntent(): malformed YAML degrades safely, does not throw", () => {
  const path = join(TMP, "malformed.yaml");
  writeFileSync(path, "topics: [unterminated\n  - broken");
  expect(() => readIntent(path)).not.toThrow();
  const result = readIntent(path);
  expect(result.intent).toBeNull();
  expect(result.note).toContain("malformed");
});

test("readIntent(): missing declared_at field degrades to no-intent", () => {
  const path = join(TMP, "missing-field.yaml");
  writeFileSync(path, "topics:\n  - cooking\n");
  const result = readIntent(path);
  expect(result.intent).toBeNull();
  expect(result.note).toContain("missing");
});

test("readIntent(): topics not an array of strings degrades to no-intent", () => {
  const path = join(TMP, "bad-topics.yaml");
  writeFileSync(path, "topics: 'not-an-array'\ndeclared_at: '2026-08-01'\n");
  const result = readIntent(path);
  expect(result.intent).toBeNull();
});
