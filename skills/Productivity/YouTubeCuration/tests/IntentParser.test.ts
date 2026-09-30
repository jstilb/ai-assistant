/**
 * IntentParser.test.ts — prose → topic list (parse half of `/youtube steer`).
 *
 * Hermetic: the inference seam is stubbed via the `inferenceFn` DI parameter
 * (mirrors JobScanner.ts's `analyzeScamWithLLM` / EnsembleValidator.ts's
 * `runValidation` idiom) — no live LLM call, no mock.module() needed. Every
 * fs-touching case pins to a mkdtemp KAYA_HOME, never the live tree or the
 * worktree's own USER/.
 */

import { afterAll, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InferenceOptions, InferenceResult } from "../../../../lib/core/Inference.ts";
import { parseIntentTopics } from "../Tools/IntentParser.ts";

const TMP = mkdtempSync(join(tmpdir(), "yt-intent-parser-test-"));
const originalKayaHome = process.env.KAYA_HOME;

beforeEach(() => {
  process.env.KAYA_HOME = TMP;
});

afterAll(() => {
  if (originalKayaHome === undefined) delete process.env.KAYA_HOME;
  else process.env.KAYA_HOME = originalKayaHome;
  rmSync(TMP, { recursive: true, force: true });
});

/** Build a minimal successful InferenceResult carrying a stubbed structured topics payload. */
function stubResult(topics: string[]): InferenceResult {
  const parsed = { topics };
  return {
    success: true,
    output: JSON.stringify(parsed),
    parsed,
    latencyMs: 1,
    level: "standard",
    estimatedTokens: { input: 10, output: 5, total: 15 },
    estimatedCostUSD: 0,
  };
}

test("parseIntentTopics(): extracts topics from a stubbed structured inference response", async () => {
  const stub = async (_opts: InferenceOptions): Promise<InferenceResult> =>
    stubResult(["woodworking", "jazz guitar"]);

  const result = await parseIntentTopics("more woodworking and jazz guitar, less politics", stub);
  expect(result.topics).toEqual(["woodworking", "jazz guitar"]);
});

test("parseIntentTopics(): no-write — parse leaves the filesystem untouched", async () => {
  const stub = async (_opts: InferenceOptions): Promise<InferenceResult> =>
    stubResult(["cooking"]);

  const before = readdirSync(TMP);
  await parseIntentTopics("more cooking videos", stub);
  const after = readdirSync(TMP);

  expect(after).toEqual(before);
  expect(existsSync(join(TMP, "USER"))).toBe(false);
  expect(existsSync(join(TMP, "USER", "YouTubeIntent.yaml"))).toBe(false);
});

test("parseIntentTopics(): trims and drops blank entries from the structured response", async () => {
  const stub = async (_opts: InferenceOptions): Promise<InferenceResult> =>
    stubResult(["  history documentaries  ", "", "   "]);

  const result = await parseIntentTopics("more history documentaries", stub);
  expect(result.topics).toEqual(["history documentaries"]);
});

test("parseIntentTopics(): throws loud when inference fails (no silent empty result)", async () => {
  const stub = async (_opts: InferenceOptions): Promise<InferenceResult> => ({
    success: false,
    output: "",
    error: "timeout",
    latencyMs: 1,
    level: "standard",
    estimatedTokens: { input: 0, output: 0, total: 0 },
    estimatedCostUSD: 0,
  });

  await expect(parseIntentTopics("more woodworking", stub)).rejects.toThrow(/inference failed/);
});

test("parseIntentTopics(): throws on empty prose without calling inference", async () => {
  let called = false;
  const stub = async (_opts: InferenceOptions): Promise<InferenceResult> => {
    called = true;
    return stubResult(["x"]);
  };

  await expect(parseIntentTopics("   ", stub)).rejects.toThrow(/empty prose/);
  expect(called).toBe(false);
});
