/**
 * A staged-diff lint rule that cannot run git (not a repository, git missing) must say so in
 * `warnings`. Before, each rule returned empty errors AND empty warnings, which looked like a clean
 * pass (ADR-017/018: fail visibly).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkNoCrossSkillImportStaged } from "./no-cross-skill-import.ts";
import { checkNoEmptyCatchStaged } from "./no-empty-catch.ts";
import { checkNoInlineKayaHomeStaged } from "./no-inline-kaya-home-staged.ts";
import { checkNoInlineMemoryPathStaged } from "./no-inline-memory-path.ts";
import { checkNoRawAppendStaged } from "./no-raw-append.ts";
import { checkNoRawStdinStaged } from "./no-raw-stdin.ts";
import { checkNoUnguardedHookMainStaged } from "./no-unguarded-hook-main.ts";

let notARepo: string;
beforeAll(() => {
  notARepo = mkdtempSync(join(tmpdir(), "lint-not-a-repo-"));
});
afterAll(() => rmSync(notARepo, { recursive: true, force: true }));

const rules = {
  "no-cross-skill-import": checkNoCrossSkillImportStaged,
  "no-empty-catch": checkNoEmptyCatchStaged,
  "no-inline-kaya-home-staged": checkNoInlineKayaHomeStaged,
  "no-inline-memory-path": checkNoInlineMemoryPathStaged,
  "no-raw-append": checkNoRawAppendStaged,
  "no-raw-stdin": checkNoRawStdinStaged,
  "no-unguarded-hook-main": checkNoUnguardedHookMainStaged,
};

describe("staged lint rules report a failed git call", () => {
  for (const [name, check] of Object.entries(rules)) {
    test(`${name}: warns instead of passing silently, and does not block`, async () => {
      const result = await check(notARepo);
      expect(result.errors).toEqual([]);
      expect(result.warnings.length).toBeGreaterThan(0);
      expect(result.warnings.join("\n")).toContain("check skipped");
    });
  }
});
