/**
 * ExplicitRatingCapture.hook.test.ts — schema-adoption regression test (ISC S6b)
 * + S8 low-rating deferred-category regression test
 *
 * ExplicitRatingCapture.hook.ts has no exported pure handler — all logic
 * lives in main(), guarded by `if (import.meta.main)` — so this uses the
 * subprocess harness pattern from hooks/__tests__/smoke-critical-hooks.test.ts,
 * with KAYA_DIR pointed at a per-test scratch tmp dir (the hook already reads
 * `process.env.KAYA_DIR` for its base path, and acquireRatingsLock() reads it
 * via kayaPath()) so these tests never touch the live
 * ~/.claude/MEMORY/LEARNING/SIGNALS/ratings.jsonl file.
 *
 * Ratings are kept >= 6 in the ISC S6b describe block below so the
 * low-rating branch (which spawns TrendingAnalysis/captureFailure/
 * captureFailureDump side paths) never fires there.
 *
 * ISC-S8: A rating of 4 (< 6, triggers captureLowRatingLearning(), but
 *   4 > 3 so the heavier captureFailure()/captureFailureDump() side paths
 *   stay off) writes a learning file under
 *   MEMORY/LEARNING/UNCATEGORIZED/<yearMonth>/ — the deferred-category
 *   literal from lib/core/LearningJudgment.ts, not a getLearningCategory()
 *   regex guess (that classifier + hooks/lib/learning-utils.ts were deleted
 *   in S8; see docs/decisions/015).
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { execSync } from "child_process";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, readdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { ExplicitHookRatingSchema } from "../lib/core/LearningEntrySchema.ts";

const HOOK_PATH = join(import.meta.dir, "ExplicitRatingCapture.hook.ts");

let kayaDir: string;

beforeEach(() => {
  kayaDir = mkdtempSync(join(tmpdir(), "explicit-rating-hook-test-"));
});

afterEach(() => {
  try { rmSync(kayaDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

function runHookWithKayaDir(stdinJson: object, timeoutMs = 8000): {
  stdout: string;
  stderr: string;
  exitCode: number;
} {
  const ts = Date.now() + "_" + Math.random().toString(36).slice(2);
  const tmpInput = join(kayaDir, `in_${ts}.json`);
  const tmpStdout = join(kayaDir, `out_${ts}.txt`);
  const tmpStderr = join(kayaDir, `err_${ts}.txt`);
  writeFileSync(tmpInput, JSON.stringify(stdinJson));

  let exitCode = 0;
  try {
    execSync(
      `cat ${tmpInput} | bun run ${HOOK_PATH} 1>${tmpStdout} 2>${tmpStderr}`,
      // Pin BOTH home vars: the hook's own paths honor KAYA_DIR, but code it
      // imports resolves via getKayaHome() (KAYA_HOME) — pinning only one let
      // live main-tree state gate the hook when the suite ran from ~/.claude
      // (passed in worktrees, failed on main: mixed-resolution leak).
      { timeout: timeoutMs, env: { ...process.env, KAYA_DIR: kayaDir, KAYA_HOME: kayaDir } }
    );
  } catch (err: unknown) {
    exitCode = (err as { status?: number }).status ?? 1;
  }

  const stdout = existsSync(tmpStdout) ? readFileSync(tmpStdout, "utf-8") : "";
  const stderr = existsSync(tmpStderr) ? readFileSync(tmpStderr, "utf-8") : "";
  return { stdout, stderr, exitCode };
}

function readRatingsRows(): Array<Record<string, unknown>> {
  const ratingsPath = join(kayaDir, "MEMORY", "LEARNING", "SIGNALS", "ratings.jsonl");
  if (!existsSync(ratingsPath)) return [];
  return readFileSync(ratingsPath, "utf-8")
    .split("\n")
    .filter(Boolean)
    .map(line => JSON.parse(line) as Record<string, unknown>);
}

describe("ExplicitRatingCapture.hook.ts — schema adoption (ISC S6b)", () => {
  it("writes a row satisfying ExplicitHookRatingSchema for a bare numeric rating", () => {
    const r = runHookWithKayaDir({ session_id: "schema-test-1", prompt: "8" });
    expect(r.exitCode).toBe(0);

    const rows = readRatingsRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.session_id).toBe("schema-test-1");
    expect(rows[0]!.rating).toBe(8);
    expect(ExplicitHookRatingSchema.safeParse(rows[0]).success).toBe(true);
  });

  it("writes a row with a comment that satisfies ExplicitHookRatingSchema", () => {
    const r = runHookWithKayaDir({ session_id: "schema-test-2", prompt: "9 - excellent work" });
    expect(r.exitCode).toBe(0);

    const rows = readRatingsRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.comment).toBe("excellent work");
    expect(ExplicitHookRatingSchema.safeParse(rows[0]).success).toBe(true);
  });

  it("writes nothing and exits 0 for a non-rating prompt", () => {
    const r = runHookWithKayaDir({ session_id: "schema-test-3", prompt: "hello world" });
    expect(r.exitCode).toBe(0);
    expect(readRatingsRows()).toHaveLength(0);
  });
});

/** Recursively find every .md file under MEMORY/LEARNING/. */
function findLearningFiles(baseDir: string): string[] {
  const learningDir = join(baseDir, "MEMORY", "LEARNING");
  if (!existsSync(learningDir)) return [];
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".md")) out.push(full);
    }
  };
  walk(learningDir);
  return out;
}

describe("ExplicitRatingCapture.hook.ts — S8 deferred category for low ratings", () => {
  it("writes a learning file under LEARNING/UNCATEGORIZED/ for a rating < 6 (no getLearningCategory guess)", () => {
    const r = runHookWithKayaDir({ session_id: "low-rating-test-1", prompt: "4 - needs work" });
    expect(r.exitCode).toBe(0);

    const rows = readRatingsRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.rating).toBe(4);

    const files = findLearningFiles(kayaDir);
    expect(files).toHaveLength(1);
    expect(files[0]).toContain(join("LEARNING", "UNCATEGORIZED"));

    const content = readFileSync(files[0]!, "utf-8");
    expect(content).toContain("category: UNCATEGORIZED");
    expect(content).toContain("**Category:** UNCATEGORIZED");
  });

  it("writes no learning file for a rating >= 6", () => {
    const r = runHookWithKayaDir({ session_id: "high-rating-test-1", prompt: "8 - great" });
    expect(r.exitCode).toBe(0);
    expect(findLearningFiles(kayaDir)).toHaveLength(0);
  });
});
