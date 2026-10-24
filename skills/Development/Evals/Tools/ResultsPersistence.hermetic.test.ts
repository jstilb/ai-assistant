/**
 * ResultsPersistence.hermetic.test.ts — regression guard for the FU1b
 * de-freeze (Failure-Signal Integrity follow-up, 2026-07-09).
 *
 * ResultsPersistence is imported at the TOP of this file — that import is the
 * freeze point in the buggy version, which captured a module-scope
 * `const KAYA_HOME = getKayaHome()`. pinKayaHome() then repoints KAYA_HOME at a
 * fresh tmpdir AFTER that import. The module must resolve the validation dir
 * LAZILY at use-site and land under the PINNED tmpdir — never live
 * MEMORY/VALIDATION/evals, where eval results leaked before the fix.
 */
import { describe, it, expect, afterAll } from "bun:test";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { getResultsPath, persistResult } from "./ResultsPersistence.ts";
import { pinKayaHome, restoreKayaHome } from "../../../../lib/test/pinKayaHome.ts";

const TEST_DIR = pinKayaHome("eval-results-hermetic-");
afterAll(async () => {
  await restoreKayaHome();
});

describe("ResultsPersistence hermeticity (FU1b de-freeze)", () => {
  it("resolves the results path under the KAYA_HOME pinned after import", () => {
    const p = getResultsPath("probe-suite");
    expect(p.startsWith(TEST_DIR)).toBe(true);
    expect(p).toContain(join("MEMORY", "VALIDATION", "evals"));
  });

  it("writes eval results to the pinned tmpdir, not the live tree", () => {
    const filePath = persistResult(
      "probe-suite",
      { eval_name: "e1", category: "c1", scores: [1], passed: [true], grader_details: [] },
      { pass_rate: 1, pass_at_k: 1, pass_all_k: 1 },
    );
    expect(filePath.startsWith(TEST_DIR)).toBe(true);
    expect(existsSync(filePath)).toBe(true);
    expect(readFileSync(filePath, "utf8")).toContain("probe-suite");
  });
});
