#!/usr/bin/env bun
/**
 * lifeos-label-table-drift.test.ts — hermetic tests for
 * lib/lint/lifeos-label-table-drift.ts (audit finding F5 anti-drift lint).
 *
 * `diffLabelsAgainstTable` is a pure string-in/string-out function, so most
 * cases feed synthetic fixtures directly — no filesystem or git involved.
 * The one case that must touch the real repo (proving the real files are in
 * sync post-F5-fix) goes through `checkLifeOSLabelTableDrift` with an
 * explicit rootDir derived from this file's own location (`import.meta.dir`)
 * rather than `process.cwd()`, so the test is invocation-cwd-independent.
 *
 * The synthetic-file case additionally exercises `checkLifeOSLabelTableDrift`
 * against temp files (mkdtempSync) to prove the disk-reading path works too
 * — real SKILL.md/Router.ts are never written to by this test.
 *
 * Run: bun test ~/.claude/lib/lint/lifeos-label-table-drift.test.ts
 */
import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  parseLabelUnion,
  parseClassificationTableLabels,
  diffLabelsAgainstTable,
  checkLifeOSLabelTableDrift,
} from "./lifeos-label-table-drift.ts";

const REPO_ROOT = join(import.meta.dir, "..", "..");

function routerFixture(labels: string[]): string {
  const members = labels.map((l) => `  | "${l}"`).join("\n");
  return `export type Label =\n${members};\n\nexport type Domain = "food" | null;\n`;
}

function skillFixture(labels: string[], declaredCount: number): string {
  const rows = labels.map((l) => `| \`${l}\` | \`${l.toLowerCase()}_log\` | silent |`).join("\n");
  return [
    `## Classification rules (${declaredCount} labels — build plan §7.3)`,
    "",
    "| Label | Destination | Confirmation |",
    "|---|---|---|",
    rows,
    "",
    "---",
    "",
    "## Next section",
    "unrelated content that must not be scanned for label rows",
  ].join("\n");
}

describe("parseLabelUnion", () => {
  test("extracts members in declaration order", () => {
    const src = routerFixture(["FOO", "BAR", "BAZ"]);
    expect(parseLabelUnion(src)).toEqual(["FOO", "BAR", "BAZ"]);
  });

  test("returns [] when the union shape isn't found", () => {
    expect(parseLabelUnion("export const x = 1;\n")).toEqual([]);
  });
});

describe("parseClassificationTableLabels", () => {
  test("extracts label column, bounded by the next heading", () => {
    const src = skillFixture(["FOO", "BAR"], 2);
    expect(parseClassificationTableLabels(src)).toEqual(["FOO", "BAR"]);
  });

  test("returns [] when the heading isn't found", () => {
    expect(parseClassificationTableLabels("# Some other doc\n")).toEqual([]);
  });
});

describe("diffLabelsAgainstTable", () => {
  test("synthetic in-sync pair — passes (0 errors)", () => {
    const router = routerFixture(["FOO", "BAR"]);
    const skill = skillFixture(["FOO", "BAR"], 2);
    const result = diffLabelsAgainstTable(router, skill);
    expect(result.errors).toEqual([]);
  });

  test("synthetic Label union with an extra member missing a table row — fails with the right message", () => {
    const router = routerFixture(["FOO", "BAR", "BAZ"]); // BAZ has no table row
    const skill = skillFixture(["FOO", "BAR"], 2); // table only knows FOO/BAR
    const result = diffLabelsAgainstTable(router, skill);
    expect(result.errors.length).toBeGreaterThan(0);
    const joined = result.errors.join(" | ");
    expect(joined).toContain("BAZ");
    expect(joined).toContain("no row in SKILL.md's classification-rules table");
  });

  test("extra table row not present in the union also fails", () => {
    const router = routerFixture(["FOO", "BAR"]);
    const skillRows = skillFixture(["FOO", "BAR"], 2).replace(
      "| `BAR` | `bar_log` | silent |",
      "| `BAR` | `bar_log` | silent |\n| `QUX` | `qux_log` | silent |",
    );
    const result = diffLabelsAgainstTable(router, skillRows);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors.join(" | ")).toContain("QUX");
  });

  test("heading count mismatch is flagged even when rows otherwise match", () => {
    const router = routerFixture(["FOO", "BAR", "BAZ"]);
    // Table has a row for every union member (no missing/extra), but the
    // heading still says "2 labels" instead of 3.
    const skill = skillFixture(["FOO", "BAR", "BAZ"], 2);
    const result = diffLabelsAgainstTable(router, skill);
    expect(result.errors.length).toBe(1);
    expect(result.errors[0]).toContain("declares 2 label(s)");
    expect(result.errors[0]).toContain("has 3");
  });
});

describe("checkLifeOSLabelTableDrift — real repo files (post F5 fix)", () => {
  test("the CURRENT real Router.ts and SKILL.md are in sync", async () => {
    const result = await checkLifeOSLabelTableDrift(REPO_ROOT);
    expect(result.errors).toEqual([]);
  });
});

describe("checkLifeOSLabelTableDrift — disk-reading path via temp fixtures", () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  test("in-sync temp fixtures pass through the real file-reading path", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "lifeos-label-drift-"));
    const routerPath = join(tmpDir, "Router.ts");
    const skillPath = join(tmpDir, "SKILL.md");
    writeFileSync(routerPath, routerFixture(["FOO", "BAR"]));
    writeFileSync(skillPath, skillFixture(["FOO", "BAR"], 2));

    const result = await checkLifeOSLabelTableDrift(tmpDir, { routerPath, skillPath });
    expect(result.errors).toEqual([]);
  });

  test("drifted temp fixtures fail through the real file-reading path", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "lifeos-label-drift-"));
    const routerPath = join(tmpDir, "Router.ts");
    const skillPath = join(tmpDir, "SKILL.md");
    writeFileSync(routerPath, routerFixture(["FOO", "BAR", "BAZ"]));
    writeFileSync(skillPath, skillFixture(["FOO", "BAR"], 2)); // missing BAZ row

    const result = await checkLifeOSLabelTableDrift(tmpDir, { routerPath, skillPath });
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors.join(" | ")).toContain("BAZ");
  });
});
