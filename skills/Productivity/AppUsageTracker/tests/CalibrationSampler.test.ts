/**
 * CalibrationSampler.test.ts — hermetic tests for the weekly media-value
 * calibration sampler. Temp DuckDB + temp state/sheet paths; no LLM, no live db.
 */

import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Db } from "../Tools/Db.ts";
import {
  applyJmVerdict,
  buildSample,
  loadState,
  pickForStratum,
  renderSheet,
  saveState,
  sheetVideoIds,
  stratumOf,
  type SampleRow,
} from "../Tools/CalibrationSampler.ts";
import { buildSystemPrompt, readCalibrationGuidance } from "../Tools/YouTubeClassifier.ts";

const TMP = mkdtempSync(join(tmpdir(), "aw-calibration-"));
const DB_PATH = join(TMP, "events.db");
let db: Db;

beforeAll(async () => {
  db = await Db.open(DB_PATH);
  await db.initSchema();
});

afterAll(() => {
  if (db) db.close();
  rmSync(TMP, { recursive: true, force: true });
});

beforeEach(async () => {
  await db.run("DELETE FROM youtube_verdicts");
});

const NOW = new Date("2026-08-25T12:00:00Z");
// Deterministic rng — cycles a fixed sequence.
function seededRng(): () => number {
  let i = 0;
  const seq = [0.11, 0.53, 0.97, 0.29, 0.71, 0.41, 0.83, 0.05, 0.61, 0.37];
  return () => seq[i++ % seq.length];
}

function row(id: string, opts: Partial<SampleRow> = {}): SampleRow {
  return {
    video_id: id,
    title: opts.title ?? `Video ${id}`,
    channel: opts.channel ?? `chan-${id}`,
    duration_sec: opts.duration_sec ?? 600,
    last_watched: opts.last_watched ?? "2026-08-20T00:00:00Z",
    is_low_value: opts.is_low_value ?? true,
    confidence: opts.confidence ?? 0.9,
    reason: opts.reason ?? "test reason",
    classifier: opts.classifier ?? "llm-sonnet",
  };
}

// --- stratumOf -------------------------------------------------------------

test("stratumOf: confident low / confident high / borderline", () => {
  expect(stratumOf(row("a", { is_low_value: true, confidence: 0.9 }))).toBe("confident-low");
  expect(stratumOf(row("b", { is_low_value: false, confidence: 0.8 }))).toBe("confident-high");
  expect(stratumOf(row("c", { is_low_value: true, confidence: 0.5 }))).toBe("borderline");
  expect(stratumOf(row("d", { is_low_value: false, confidence: 0.74 }))).toBe("borderline");
});

// --- pickForStratum --------------------------------------------------------

test("pickForStratum prefers recent videos and caps per channel", () => {
  const pool = [
    row("r1", { channel: "Binge", last_watched: "2026-08-20T00:00:00Z" }),
    row("r2", { channel: "Binge", last_watched: "2026-08-19T00:00:00Z" }),
    row("r3", { channel: "Binge", last_watched: "2026-08-18T00:00:00Z" }),
    row("r4", { channel: "Other", last_watched: "2026-08-17T00:00:00Z" }),
    row("old1", { channel: "Ancient", last_watched: "2024-01-01T00:00:00Z" }),
  ];
  const picked = pickForStratum(pool, 4, 90, seededRng(), NOW);
  expect(picked.length).toBe(4);
  const bingeCount = picked.filter(r => r.channel === "Binge").length;
  expect(bingeCount).toBe(2); // capped at MAX_PER_CHANNEL
  // 3 eligible recent picks (2 Binge + Other) → 4th must backfill from older.
  expect(picked.some(r => r.video_id === "old1")).toBe(true);
});

test("pickForStratum backfills from older pool when recent runs short", () => {
  const pool = [
    row("recent", { last_watched: "2026-08-20T00:00:00Z" }),
    row("old-a", { last_watched: "2025-01-01T00:00:00Z" }),
    row("old-b", { last_watched: "2025-02-01T00:00:00Z" }),
  ];
  const picked = pickForStratum(pool, 3, 90, seededRng(), NOW);
  expect(picked.map(r => r.video_id).sort()).toEqual(["old-a", "old-b", "recent"]);
});

// --- buildSample -----------------------------------------------------------

test("buildSample fills strata, excludes prior rounds and jm-calibration rows", () => {
  const all = [
    row("low1", { confidence: 0.9, is_low_value: true }),
    row("low2", { confidence: 0.85, is_low_value: true }),
    row("high1", { confidence: 0.9, is_low_value: false }),
    row("bord1", { confidence: 0.4, is_low_value: true }),
    row("sampled-before", { confidence: 0.9, is_low_value: true }),
    row("jm1", { confidence: 1.0, is_low_value: true, classifier: "jm-calibration" }),
  ];
  const plan = buildSample(all, new Set(["sampled-before"]), 8, 90, 3, seededRng(), NOW);
  expect(plan.round).toBe(3);
  expect(plan.strata["confident-low"].map(r => r.video_id).sort()).toEqual(["low1", "low2"]);
  expect(plan.strata["confident-high"].map(r => r.video_id)).toEqual(["high1"]);
  expect(plan.strata.borderline.map(r => r.video_id)).toEqual(["bord1"]);
  expect(plan.excluded).toBe(2);
  expect(sheetVideoIds(plan).sort()).toEqual(["bord1", "high1", "low1", "low2"]);
});

// --- renderSheet -----------------------------------------------------------

test("renderSheet emits frontmatter, all three strata, rows and instructions", () => {
  const plan = buildSample(
    [
      row("lowA", { confidence: 0.92, title: "Pipe | Title", channel: "MrBeast" }),
      row("highA", { confidence: 0.88, is_low_value: false }),
      row("bordA", { confidence: 0.3 }),
    ],
    new Set(), 8, 90, 1, seededRng(), NOW,
  );
  const md = renderSheet(plan, NOW);
  expect(md).toContain("round: 1");
  expect(md).toContain("status: awaiting-review");
  expect(md).toContain("## Confidently LOW-value (1)");
  expect(md).toContain("## Confidently NOT low-value (1)");
  expect(md).toContain("## Borderline (low confidence) (1)");
  expect(md).toContain("https://www.youtube.com/watch?v=lowA");
  expect(md).toContain("Pipe \\| Title"); // pipes escaped for the table
  expect(md).toContain("## General feedback");
  expect(md).toContain("status: reviewed"); // instructions mention the reviewed signal
});

// --- state -----------------------------------------------------------------

test("state round-trips and missing file yields empty state", () => {
  const statePath = join(TMP, "state", "rounds.json");
  expect(loadState(statePath)).toEqual({ rounds: [] });
  saveState({ rounds: [{ round: 1, generated_at: "2026-08-25T12:00:00Z", sheet_path: "/tmp/x.md", video_ids: ["a", "b"] }] }, statePath);
  const loaded = loadState(statePath);
  expect(loaded.rounds.length).toBe(1);
  expect(loaded.rounds[0].video_ids).toEqual(["a", "b"]);
});

test("loadState throws on malformed state", () => {
  const statePath = join(TMP, "bad-state.json");
  writeFileSync(statePath, JSON.stringify({ nope: true }));
  expect(() => loadState(statePath)).toThrow(/malformed/);
});

// --- applyJmVerdict --------------------------------------------------------

test("applyJmVerdict upserts a jm-calibration row and reports the previous verdict", async () => {
  await db.run(
    `INSERT INTO youtube_verdicts (video_id, is_low_value, reason, confidence, classifier, classified_at)
     VALUES ('vid1', TRUE, 'llm said low', 0.9, 'llm-sonnet', NOW())`,
  );
  const { previous } = await applyJmVerdict(db, "vid1", "high", "actually a tutorial");
  expect(previous).toEqual({ is_low_value: true, classifier: "llm-sonnet" });
  const after = await db.queryRow<{ is_low_value: boolean; classifier: string; confidence: number; reason: string }>(
    `SELECT is_low_value, classifier, confidence, reason FROM youtube_verdicts WHERE video_id = 'vid1'`,
  );
  expect(after).not.toBeNull();
  expect(Boolean(after!.is_low_value)).toBe(false);
  expect(after!.classifier).toBe("jm-calibration");
  expect(Number(after!.confidence)).toBe(1.0);
});

test("applyJmVerdict on an unclassified video inserts fresh and reports previous=null", async () => {
  const { previous } = await applyJmVerdict(db, "brand-new", "low", "junk channel");
  expect(previous).toBeNull();
  const after = await db.queryRow<{ classifier: string }>(
    `SELECT classifier FROM youtube_verdicts WHERE video_id = 'brand-new'`,
  );
  expect(after!.classifier).toBe("jm-calibration");
});

// --- classifier guidance seam ---------------------------------------------

test("readCalibrationGuidance extracts the section and fails loud when absent", () => {
  const good = join(TMP, "rubric-good.md");
  writeFileSync(good, "# T\n\n## Classification guidance\n\n- bullet one\n- bullet two\n\n## Calibration log\n\n| a |\n");
  expect(readCalibrationGuidance(good)).toBe("- bullet one\n- bullet two");

  const noSection = join(TMP, "rubric-nosection.md");
  writeFileSync(noSection, "# T\n\nno sections here\n");
  expect(() => readCalibrationGuidance(noSection)).toThrow(/no "## Classification guidance"/);

  const empty = join(TMP, "rubric-empty.md");
  writeFileSync(empty, "## Classification guidance\n\n\n## Next\n");
  expect(() => readCalibrationGuidance(empty)).toThrow(/is empty/);

  expect(() => readCalibrationGuidance(join(TMP, "does-not-exist.md"))).toThrow(/cannot read rubric/);
});

test("shipped MediaValueRubric.md parses and lands in the system prompt", () => {
  const prompt = buildSystemPrompt(); // default path → the real shipped rubric
  expect(prompt).toContain("Calibration guidance from Jm's review rounds");
  expect(prompt).toContain("low-value");
});
