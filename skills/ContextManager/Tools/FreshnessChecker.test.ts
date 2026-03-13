/**
 * FreshnessChecker.test.ts
 *
 * Tests for FreshnessChecker — context file staleness detection.
 *
 * Categories:
 *   - fresh:    < 24 hours
 *   - stale:    24–72 hours
 *   - outdated: > 72 hours
 *   - unknown:  file does not exist
 *
 * Tests cover all four categories, both frontmatter and mtime-based detection,
 * and the checkMultipleFreshness aggregation.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { checkFreshness, checkMultipleFreshness } from "./FreshnessChecker.ts";
import { writeFileSync, unlinkSync, existsSync, mkdirSync, utimesSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const TMP_DIR = join(tmpdir(), "kaya-freshness-tests");
if (!existsSync(TMP_DIR)) mkdirSync(TMP_DIR, { recursive: true });

// Helpers

function writeWithMtime(filePath: string, content: string, ageHours: number): void {
  writeFileSync(filePath, content);
  const mtime = new Date(Date.now() - ageHours * 60 * 60 * 1000);
  utimesSync(filePath, mtime, mtime);
}

function frontmatterFile(ageHours: number): string {
  const date = new Date(Date.now() - ageHours * 60 * 60 * 1000);
  return `---\nlast_updated: ${date.toISOString()}\n---\n\n# Content`;
}

// ─────────────────────────────────────────────────────────────────────────────
// checkFreshness — file does not exist
// ─────────────────────────────────────────────────────────────────────────────

describe("checkFreshness — file not found", () => {
  test("returns category=unknown for non-existent file", () => {
    const result = checkFreshness("/non/existent/file.md");
    expect(result.category).toBe("unknown");
  });

  test("returns ageHours=-1 for non-existent file", () => {
    const result = checkFreshness("/non/existent/file.md");
    expect(result.ageHours).toBe(-1);
  });

  test("returns lastUpdated=null for non-existent file", () => {
    const result = checkFreshness("/non/existent/file.md");
    expect(result.lastUpdated).toBeNull();
  });

  test("returns source=none for non-existent file", () => {
    const result = checkFreshness("/non/existent/file.md");
    expect(result.source).toBe("none");
  });

  test("result.file matches the input path", () => {
    const path = "/non/existent/file.md";
    const result = checkFreshness(path);
    expect(result.file).toBe(path);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// checkFreshness — mtime-based detection
// ─────────────────────────────────────────────────────────────────────────────

describe("checkFreshness — mtime-based (no frontmatter)", () => {
  const freshPath = join(TMP_DIR, "fresh-mtime.md");
  const stalePath = join(TMP_DIR, "stale-mtime.md");
  const outdatedPath = join(TMP_DIR, "outdated-mtime.md");

  beforeAll(() => {
    writeWithMtime(freshPath, "# Fresh file — no frontmatter", 1);   // 1 hour old
    writeWithMtime(stalePath, "# Stale file — no frontmatter", 48);  // 48 hours old
    writeWithMtime(outdatedPath, "# Outdated — no frontmatter", 100); // 100 hours old
  });

  afterAll(() => {
    [freshPath, stalePath, outdatedPath].forEach((p) => {
      if (existsSync(p)) unlinkSync(p);
    });
  });

  test("1-hour-old file is fresh", () => {
    const result = checkFreshness(freshPath);
    expect(result.category).toBe("fresh");
    expect(result.source).toBe("mtime");
  });

  test("48-hour-old file is stale", () => {
    const result = checkFreshness(stalePath);
    expect(result.category).toBe("stale");
    expect(result.source).toBe("mtime");
  });

  test("100-hour-old file is outdated", () => {
    const result = checkFreshness(outdatedPath);
    expect(result.category).toBe("outdated");
    expect(result.source).toBe("mtime");
  });

  test("ageHours is a non-negative number", () => {
    const result = checkFreshness(freshPath);
    expect(result.ageHours).toBeGreaterThanOrEqual(0);
  });

  test("lastUpdated is an ISO string", () => {
    const result = checkFreshness(freshPath);
    expect(typeof result.lastUpdated).toBe("string");
    expect(new Date(result.lastUpdated!).toISOString()).toBe(result.lastUpdated);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// checkFreshness — frontmatter-based detection
// ─────────────────────────────────────────────────────────────────────────────

describe("checkFreshness — frontmatter-based", () => {
  const freshFmPath = join(TMP_DIR, "fresh-fm.md");
  const staleFmPath = join(TMP_DIR, "stale-fm.md");
  const outdatedFmPath = join(TMP_DIR, "outdated-fm.md");

  beforeAll(() => {
    // Write files with frontmatter dates; mtime is irrelevant
    writeFileSync(freshFmPath, frontmatterFile(2));    // 2 hours old
    writeFileSync(staleFmPath, frontmatterFile(50));   // 50 hours old
    writeFileSync(outdatedFmPath, frontmatterFile(96)); // 96 hours old
  });

  afterAll(() => {
    [freshFmPath, staleFmPath, outdatedFmPath].forEach((p) => {
      if (existsSync(p)) unlinkSync(p);
    });
  });

  test("frontmatter-fresh file has source=frontmatter", () => {
    const result = checkFreshness(freshFmPath);
    expect(result.source).toBe("frontmatter");
  });

  test("frontmatter 2h old → fresh", () => {
    const result = checkFreshness(freshFmPath);
    expect(result.category).toBe("fresh");
  });

  test("frontmatter 50h old → stale", () => {
    const result = checkFreshness(staleFmPath);
    expect(result.category).toBe("stale");
  });

  test("frontmatter 96h old → outdated", () => {
    const result = checkFreshness(outdatedFmPath);
    expect(result.category).toBe("outdated");
  });

  test("lastUpdated is an ISO string from frontmatter", () => {
    const result = checkFreshness(freshFmPath);
    expect(typeof result.lastUpdated).toBe("string");
    // Should be parseable as a valid date
    const d = new Date(result.lastUpdated!);
    expect(isNaN(d.getTime())).toBe(false);
  });

  test("frontmatter date takes precedence over mtime", () => {
    // Write a file with a fresh frontmatter date but ancient mtime
    const path = join(TMP_DIR, "frontmatter-priority.md");
    writeFileSync(path, frontmatterFile(1)); // fresh frontmatter
    writeWithMtime(path, readFileSync(path, "utf-8") as string, 200); // ancient mtime

    const result = checkFreshness(path);
    expect(result.source).toBe("frontmatter");
    expect(result.category).toBe("fresh");

    if (existsSync(path)) unlinkSync(path);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// checkMultipleFreshness
// ─────────────────────────────────────────────────────────────────────────────

describe("checkMultipleFreshness", () => {
  const f1 = join(TMP_DIR, "multi-fresh.md");
  const f2 = join(TMP_DIR, "multi-stale.md");
  const f3 = join(TMP_DIR, "multi-outdated.md");
  const missing = "/non/existent/multi.md";

  beforeAll(() => {
    writeWithMtime(f1, "# fresh", 2);
    writeWithMtime(f2, "# stale", 48);
    writeWithMtime(f3, "# outdated", 100);
  });

  afterAll(() => {
    [f1, f2, f3].forEach((p) => { if (existsSync(p)) unlinkSync(p); });
  });

  test("returns results array with correct length", () => {
    const { results } = checkMultipleFreshness([f1, f2, f3]);
    expect(results.length).toBe(3);
  });

  test("summary counts are correct", () => {
    const { summary } = checkMultipleFreshness([f1, f2, f3]);
    expect(summary.fresh).toBe(1);
    expect(summary.stale).toBe(1);
    expect(summary.outdated).toBe(1);
    expect(summary.unknown).toBe(0);
  });

  test("missing file counted in unknown", () => {
    const { summary } = checkMultipleFreshness([f1, missing]);
    expect(summary.unknown).toBe(1);
  });

  test("empty input returns empty results and zero summary", () => {
    const { results, summary } = checkMultipleFreshness([]);
    expect(results.length).toBe(0);
    expect(summary.fresh).toBe(0);
    expect(summary.stale).toBe(0);
    expect(summary.outdated).toBe(0);
    expect(summary.unknown).toBe(0);
  });

  test("summary values sum to total files", () => {
    const files = [f1, f2, f3, missing];
    const { summary } = checkMultipleFreshness(files);
    const total = summary.fresh + summary.stale + summary.outdated + summary.unknown;
    expect(total).toBe(files.length);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Helpers used in tests
// ─────────────────────────────────────────────────────────────────────────────

function readFileSync(path: string, encoding: "utf-8"): string {
  return require("fs").readFileSync(path, encoding);
}
