#!/usr/bin/env bun
/**
 * no-live-write-in-test-staged.test.ts — hermetic tests for the staged-diff
 * mode of the no-live-write-in-test lint rule
 * (lib/lint/no-live-write-in-test-staged.ts).
 *
 * Mirrors the staged-diff testing approach used for the sibling rule's
 * checkNoInlineKayaHomeStaged (lib/lint/no-inline-kaya-home-staged.test.ts):
 * a real git repo in a mkdtemp scratch dir, driven with real `git`
 * operations — never the live repo's index.
 *
 * Run: bun test ~/.claude/lib/lint/no-live-write-in-test-staged.test.ts
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { execSync } from "child_process";
import { checkNoLiveWriteInTestStaged } from "./no-live-write-in-test-staged.ts";

function git(cwd: string, cmd: string): string {
  return execSync(`git ${cmd}`, { cwd, encoding: "utf-8" });
}

describe("checkNoLiveWriteInTestStaged", () => {
  let repo: string;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "no-live-write-in-test-staged-"));
    git(repo, "init -q");
    git(repo, 'config user.email "test@example.com"');
    git(repo, 'config user.name "Test"');
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  test("staged test file importing a live writer with NO pin marker — exactly 1 warning", async () => {
    const file = join(repo, "AlertManager.testwriter.test.ts");
    writeFileSync(
      file,
      "import { AlertManager } from './AlertManager';\n" +
        "test('x', () => {});\n",
    );
    git(repo, "add AlertManager.testwriter.test.ts");

    const result = await checkNoLiveWriteInTestStaged(repo);
    expect(result.errors.length).toBe(0);
    expect(result.warnings.length).toBe(1);
    expect(result.warnings[0]).toContain("AlertManager.testwriter.test.ts");
    expect(result.warnings[0]).toContain("AlertManager");
  });

  test("staged test file importing a live writer WITH pinKayaHome( — 0 warnings", async () => {
    const file = join(repo, "SessionManager.test.ts");
    writeFileSync(
      file,
      "import { pinKayaHome, restoreKayaHome } from '../../lib/test/pinKayaHome.ts';\n" +
        "pinKayaHome('x-');\n" +
        "import { loadSession } from './SessionManager';\n",
    );
    git(repo, "add SessionManager.test.ts");

    const result = await checkNoLiveWriteInTestStaged(repo);
    expect(result.warnings.length).toBe(0);
  });

  test("staged test file importing a live writer WITH manual KAYA_HOME = assignment — 0 warnings", async () => {
    const file = join(repo, "HealthManager.test.ts");
    writeFileSync(
      file,
      "process.env.KAYA_HOME = '/tmp/scratch';\n" +
        "import { loadHealthState } from './HealthManager';\n",
    );
    git(repo, "add HealthManager.test.ts");

    const result = await checkNoLiveWriteInTestStaged(repo);
    expect(result.warnings.length).toBe(0);
  });

  test("staged test file importing NO live writer — 0 warnings", async () => {
    const file = join(repo, "Unrelated.test.ts");
    writeFileSync(file, "import { foo } from './Unrelated';\n");
    git(repo, "add Unrelated.test.ts");

    const result = await checkNoLiveWriteInTestStaged(repo);
    expect(result.warnings.length).toBe(0);
  });

  test("staged NON-test file importing a live writer with no pin — 0 warnings (production code is out of scope)", async () => {
    const file = join(repo, "Workflows.ts");
    writeFileSync(file, "import { AlertManager } from './AlertManager';\n");
    git(repo, "add Workflows.ts");

    const result = await checkNoLiveWriteInTestStaged(repo);
    expect(result.warnings.length).toBe(0);
  });

  test("no staged .ts changes — 0 warnings", async () => {
    const file = join(repo, "example.ts");
    writeFileSync(file, "export const x = 1;\n");
    git(repo, "add example.ts");
    git(repo, 'commit -q -m "baseline"');

    const result = await checkNoLiveWriteInTestStaged(repo);
    expect(result.warnings.length).toBe(0);
  });
});
