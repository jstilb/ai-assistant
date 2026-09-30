#!/usr/bin/env bun
/**
 * no-inline-kaya-home-staged.test.ts — hermetic tests for the staged-diff
 * mode of the no-inline-kaya-home lint rule
 * (lib/lint/no-inline-kaya-home-staged.ts).
 *
 * Mirrors the staged-diff testing approach used for the sibling rule's
 * checkNoInlineMemoryPathStaged (lib/lint/no-inline-memory-path.ts): a real
 * git repo in a mkdtemp scratch dir, driven with real `git` operations —
 * never the live repo's index.
 *
 * Proves grandfathering: the ~155 existing module-scope KAYA_HOME/KAYA_DIR
 * violations already in the tree must NOT trip this rule; only lines newly
 * ADDED in the staged diff should.
 *
 * Run: bun test ~/.claude/lib/lint/no-inline-kaya-home-staged.test.ts
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { execSync } from "child_process";
import { checkNoInlineKayaHomeStaged } from "./no-inline-kaya-home-staged.ts";

function git(cwd: string, cmd: string): string {
  return execSync(`git ${cmd}`, { cwd, encoding: "utf-8" });
}

describe("checkNoInlineKayaHomeStaged", () => {
  let repo: string;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "no-inline-kaya-home-staged-"));
    git(repo, "init -q");
    git(repo, 'config user.email "test@example.com"');
    git(repo, 'config user.name "Test"');
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  test("staged synthetic violation (newly added line) — exactly 1 error", async () => {
    const file = join(repo, "example.ts");
    writeFileSync(file, "export const x = 1;\n");
    git(repo, "add example.ts");
    git(repo, 'commit -q -m "baseline"');

    // Stage a newly added line matching a BANNED_PATTERNS entry
    // (process.env.KAYA_DIR || <fallback path>).
    writeFileSync(
      file,
      "export const x = 1;\n" +
        "const home = process.env.KAYA_DIR || '/tmp/fallback';\n",
    );
    git(repo, "add example.ts");

    const result = await checkNoInlineKayaHomeStaged(repo);
    expect(result.errors.length).toBe(1);
    expect(result.errors[0]).toContain("example.ts");
  });

  test("staged edit adjacent to an existing (grandfathered) violation — 0 errors", async () => {
    const file = join(repo, "legacy.ts");
    // Baseline commit already contains a violation on line 1 — this is one
    // of the ~155 existing violations being grandfathered.
    writeFileSync(
      file,
      "const home = process.env.KAYA_DIR || '/tmp/legacy';\n" +
        "export const legacyValue = 1;\n",
    );
    git(repo, "add legacy.ts");
    git(repo, 'commit -q -m "baseline with existing violation"');

    // Stage an edit to the adjacent line only — the existing violation line
    // is untouched by this diff (it's neither added nor removed).
    writeFileSync(
      file,
      "const home = process.env.KAYA_DIR || '/tmp/legacy';\n" +
        "export const legacyValue = 2;\n",
    );
    git(repo, "add legacy.ts");

    const result = await checkNoInlineKayaHomeStaged(repo);
    expect(result.errors.length).toBe(0);
  });

  test("no staged .ts/.tsx changes — 0 errors", async () => {
    const file = join(repo, "example.ts");
    writeFileSync(file, "export const x = 1;\n");
    git(repo, "add example.ts");
    git(repo, 'commit -q -m "baseline"');

    const result = await checkNoInlineKayaHomeStaged(repo);
    expect(result.errors.length).toBe(0);
  });
});
