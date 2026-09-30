#!/usr/bin/env bun
/**
 * RecallPlan.test.ts — hermetic tests for the plan-picker CLI.
 *
 * Uses a mkdtemp'd directory standing in for ~/.claude/plans so no live
 * plan files are touched. Mirrors the hermetic-tempdir pattern used by
 * skills/Automation/QueueRouter/Tools/SingleStorePath.test.ts.
 */

import { tmpdir } from "os";
import { join } from "path";
import { mkdtempSync, rmSync, writeFileSync, utimesSync } from "fs";
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { listPlans, resolvePlan, extractTitleAndExcerpt, DEFAULT_PLANS_DIR } from "./RecallPlan.ts";

const TEST_DIR = mkdtempSync(join(tmpdir(), "recallplan-test-"));

/** Write a fake plan file with a specific mtime (seconds resolution). */
function writePlan(filename: string, content: string, mtime: Date): void {
  const path = join(TEST_DIR, filename);
  writeFileSync(path, content, "utf-8");
  utimesSync(path, mtime, mtime);
}

beforeAll(() => {
  // Oldest to newest — index 1 in `list` should be the newest (iridescent).
  writePlan(
    "create-a-plan-to-oldest-plan.md",
    "# Oldest Plan Title\n\nContext for the oldest plan goes here.\nMore detail line.\n",
    new Date("2026-06-01T10:00:00Z"),
  );
  writePlan(
    "middle-slug-name.md",
    "# Middle Plan Title\n\nThis is the middle plan's opening context line.\n",
    new Date("2026-06-15T10:00:00Z"),
  );
  writePlan(
    "create-a-plan-to-iridescent-treehouse.md",
    "# Newest Plan: Iridescent Treehouse\n\nA review of the failure log surfaced two problems.\nSecond context line.\nThird context line.\nFourth line not included in excerpt.\n",
    new Date("2026-07-01T10:00:00Z"),
  );
  // No H1 heading at all — must fall back to a title-cased filename.
  writePlan(
    "no-heading-here.md",
    "Just some prose with no markdown heading at the top.\n",
    new Date("2026-06-20T10:00:00Z"),
  );
  // Should be excluded from listings entirely.
  writePlan(
    "TEMPLATE-plan-prompt.md",
    "# Template — not a real plan\n\nReusable prompt template.\n",
    new Date("2026-07-02T10:00:00Z"),
  );
  writeFileSync(join(TEST_DIR, "not-a-plan.txt"), "irrelevant non-markdown file", "utf-8");
});

afterAll(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("extractTitleAndExcerpt", () => {
  test("extracts the first H1 as title and following lines as excerpt", () => {
    const { title, excerpt } = extractTitleAndExcerpt(
      "# My Plan Title\n\nFirst context line.\nSecond context line.\n",
      "fallback",
    );
    expect(title).toBe("My Plan Title");
    expect(excerpt).toBe("First context line. Second context line.");
  });

  test("falls back to the provided title when no H1 is present, and still surfaces leading prose as excerpt", () => {
    const { title, excerpt } = extractTitleAndExcerpt("Just prose, no heading.\n", "Fallback Title");
    expect(title).toBe("Fallback Title");
    expect(excerpt).toBe("Just prose, no heading.");
  });

  test("skips sub-headings rather than stopping at them (the common '# Title\\n\\n## Context\\n\\nprose' shape)", () => {
    const { excerpt } = extractTitleAndExcerpt(
      "# Title\n\n## Context\n\nActual content line one.\nActual content line two.\n",
      "fallback",
      2,
    );
    expect(excerpt).toBe("Actual content line one. Actual content line two.");
  });

  test("truncates long excerpts with an ellipsis", () => {
    const longLine = "x".repeat(300);
    const { excerpt } = extractTitleAndExcerpt(`# Title\n\n${longLine}\n`, "fallback", 1);
    expect(excerpt.endsWith("…")).toBe(true);
    expect(excerpt.length).toBeLessThan(300);
  });
});

describe("listPlans", () => {
  test("returns real plan files newest-first, excluding TEMPLATE and non-md files", () => {
    const plans = listPlans(TEST_DIR, 10);
    const files = plans.map((p) => p.file);

    expect(files).toEqual([
      "create-a-plan-to-iridescent-treehouse.md",
      "no-heading-here.md",
      "middle-slug-name.md",
      "create-a-plan-to-oldest-plan.md",
    ]);
    expect(files).not.toContain("TEMPLATE-plan-prompt.md");
    expect(files).not.toContain("not-a-plan.txt");
  });

  test("assigns 1-based sequential index matching sort order", () => {
    const plans = listPlans(TEST_DIR, 10);
    plans.forEach((p, i) => expect(p.index).toBe(i + 1));
  });

  test("derives readable title from H1, and title-cased filename when absent", () => {
    const plans = listPlans(TEST_DIR, 10);
    const newest = plans.find((p) => p.file === "create-a-plan-to-iridescent-treehouse.md");
    const noHeading = plans.find((p) => p.file === "no-heading-here.md");

    expect(newest?.title).toBe("Newest Plan: Iridescent Treehouse");
    expect(noHeading?.title).toBe("No Heading Here");
  });

  test("excerpt only includes up to 3 lines after the title by default", () => {
    const plans = listPlans(TEST_DIR, 10);
    const newest = plans.find((p) => p.file === "create-a-plan-to-iridescent-treehouse.md");
    expect(newest?.excerpt).toBe(
      "A review of the failure log surfaced two problems. Second context line. Third context line.",
    );
    expect(newest?.excerpt).not.toContain("Fourth line");
  });

  test("respects the limit parameter", () => {
    expect(listPlans(TEST_DIR, 2)).toHaveLength(2);
    expect(listPlans(TEST_DIR, 0)).toHaveLength(0);
  });

  test("returns an empty array for a directory that does not exist", () => {
    expect(listPlans(join(TEST_DIR, "does-not-exist"), 10)).toEqual([]);
  });

  test("default plansDir points at ~/.claude/plans", () => {
    expect(DEFAULT_PLANS_DIR.endsWith(join(".claude", "plans"))).toBe(true);
  });
});

describe("resolvePlan", () => {
  test("resolves by 1-based numeric index", () => {
    const plan = resolvePlan(TEST_DIR, "1");
    expect(plan.file).toBe("create-a-plan-to-iridescent-treehouse.md");
  });

  test("resolves by exact filename, with or without .md", () => {
    expect(resolvePlan(TEST_DIR, "middle-slug-name.md").file).toBe("middle-slug-name.md");
    expect(resolvePlan(TEST_DIR, "middle-slug-name").file).toBe("middle-slug-name.md");
  });

  test("resolves by unique case-insensitive substring against filename or title", () => {
    expect(resolvePlan(TEST_DIR, "IRIDESCENT").file).toBe(
      "create-a-plan-to-iridescent-treehouse.md",
    );
    expect(resolvePlan(TEST_DIR, "oldest").file).toBe("create-a-plan-to-oldest-plan.md");
  });

  test("throws a clear error for an out-of-range index", () => {
    expect(() => resolvePlan(TEST_DIR, "999")).toThrow(/No plan at index 999/);
  });

  test("throws a clear error when nothing matches", () => {
    expect(() => resolvePlan(TEST_DIR, "zzz-does-not-exist")).toThrow(/No plan matched/);
  });

  test("throws an ambiguity error (not a silent guess) when multiple plans match", () => {
    // "plan" matches both create-a-plan-to-* files' filenames.
    expect(() => resolvePlan(TEST_DIR, "create-a-plan-to")).toThrow(/Ambiguous selector/);
  });

  test("throws when the directory has no plans at all", () => {
    const emptyDir = mkdtempSync(join(tmpdir(), "recallplan-empty-"));
    try {
      expect(() => resolvePlan(emptyDir, "1")).toThrow(/No plans found/);
    } finally {
      rmSync(emptyDir, { recursive: true, force: true });
    }
  });
});
