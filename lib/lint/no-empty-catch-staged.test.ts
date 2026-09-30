#!/usr/bin/env bun
/**
 * no-empty-catch-staged.test.ts — hermetic tests for the staged-diff mode of
 * the no-empty-catch lint rule (lib/lint/no-empty-catch.ts).
 *
 * Mirrors the staged-diff testing approach used for the sibling rule's
 * checkNoInlineKayaHomeStaged (lib/lint/no-inline-kaya-home-staged.test.ts):
 * a real git repo in a mkdtemp scratch dir, driven with real `git`
 * operations — never the live repo's index.
 *
 * Proves the S12 sweep's regression guard: a brand new empty/comment-only
 * catch block in hooks/ or lib/ trips the gate; a breadcrumbed one or one
 * carrying the `// intentionally silent:` marker does not; and pre-existing
 * (grandfathered) violations left untouched by a diff are not flagged.
 *
 * Run: bun test ~/.claude/.claude/worktrees/agent-a1800a26e7c0813f4/lib/lint/no-empty-catch-staged.test.ts
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { execSync } from "child_process";
import { checkNoEmptyCatchStaged } from "./no-empty-catch.ts";

function git(cwd: string, cmd: string): string {
  return execSync(`git ${cmd}`, { cwd, encoding: "utf-8" });
}

describe("checkNoEmptyCatchStaged", () => {
  let repo: string;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "no-empty-catch-staged-"));
    git(repo, "init -q");
    git(repo, 'config user.email "test@example.com"');
    git(repo, 'config user.name "Test"');
    mkdirSync(join(repo, "hooks"), { recursive: true });
    mkdirSync(join(repo, "lib"), { recursive: true });
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  test("staged new empty catch block — exactly 1 error", async () => {
    const file = join(repo, "hooks", "Example.hook.ts");
    writeFileSync(file, "export function main() {\n  return 1;\n}\n");
    git(repo, "add hooks/Example.hook.ts");
    git(repo, 'commit -q -m "baseline"');

    writeFileSync(
      file,
      "export function main() {\n" +
        "  try {\n" +
        "    doThing();\n" +
        "  } catch {\n" +
        "  }\n" +
        "  return 1;\n" +
        "}\n",
    );
    git(repo, "add hooks/Example.hook.ts");

    const result = await checkNoEmptyCatchStaged(repo);
    expect(result.errors.length).toBe(1);
    expect(result.errors[0]).toContain("hooks/Example.hook.ts");
  });

  test("non-.ts file with catch-shaped prose staged alongside a real .ts change — not flagged", async () => {
    const tsFile = join(repo, "hooks", "Example.hook.ts");
    writeFileSync(tsFile, "export function main() {\n  return 1;\n}\n");
    git(repo, "add hooks/Example.hook.ts");
    git(repo, 'commit -q -m "baseline"');

    // A markdown doc containing literal empty-catch example text (verifier-found
    // false-positive class: isExempt() previously never checked the extension).
    const mdFile = join(repo, "hooks", "NOTES.md");
    writeFileSync(mdFile, "Example anti-pattern:\n\n```ts\ntry {\n  doThing();\n} catch {\n}\n```\n");
    writeFileSync(tsFile, "export function main() {\n  return 2;\n}\n");
    git(repo, "add hooks/NOTES.md hooks/Example.hook.ts");

    const result = await checkNoEmptyCatchStaged(repo);
    expect(result.errors.length).toBe(0);
  });

  test("staged new comment-only catch block — exactly 1 error", async () => {
    const file = join(repo, "lib", "example.ts");
    writeFileSync(file, "export function run() {\n  return 1;\n}\n");
    git(repo, "add lib/example.ts");
    git(repo, 'commit -q -m "baseline"');

    writeFileSync(
      file,
      "export function run() {\n" +
        "  try {\n" +
        "    doThing();\n" +
        "  } catch {\n" +
        "    // best effort\n" +
        "  }\n" +
        "  return 1;\n" +
        "}\n",
    );
    git(repo, "add lib/example.ts");

    const result = await checkNoEmptyCatchStaged(repo);
    expect(result.errors.length).toBe(1);
  });

  test("staged new catch with a real breadcrumb statement — 0 errors", async () => {
    const file = join(repo, "hooks", "Example.hook.ts");
    writeFileSync(file, "export function main() {\n  return 1;\n}\n");
    git(repo, "add hooks/Example.hook.ts");
    git(repo, 'commit -q -m "baseline"');

    writeFileSync(
      file,
      "export function main() {\n" +
        "  try {\n" +
        "    doThing();\n" +
        "  } catch (err) {\n" +
        "    console.error('[Example] doThing failed: ' + err);\n" +
        "  }\n" +
        "  return 1;\n" +
        "}\n",
    );
    git(repo, "add hooks/Example.hook.ts");

    const result = await checkNoEmptyCatchStaged(repo);
    expect(result.errors.length).toBe(0);
  });

  test("staged new catch carrying the intentionally-silent marker — 0 errors", async () => {
    const file = join(repo, "hooks", "Example.hook.ts");
    writeFileSync(file, "export function main() {\n  return 1;\n}\n");
    git(repo, "add hooks/Example.hook.ts");
    git(repo, 'commit -q -m "baseline"');

    writeFileSync(
      file,
      "export function main() {\n" +
        "  try {\n" +
        "    doThing();\n" +
        "  } catch {\n" +
        "    // intentionally silent: optional probe, absence is normal\n" +
        "  }\n" +
        "  return 1;\n" +
        "}\n",
    );
    git(repo, "add hooks/Example.hook.ts");

    const result = await checkNoEmptyCatchStaged(repo);
    expect(result.errors.length).toBe(0);
  });

  test("pre-existing empty catch, untouched by an adjacent edit — 0 errors", async () => {
    const file = join(repo, "hooks", "Legacy.hook.ts");
    // Baseline commit already contains a grandfathered violation.
    writeFileSync(
      file,
      "export function main() {\n" +
        "  try {\n" +
        "    doThing();\n" +
        "  } catch {\n" +
        "  }\n" +
        "  return 1;\n" +
        "}\n",
    );
    git(repo, "add hooks/Legacy.hook.ts");
    git(repo, 'commit -q -m "baseline with existing violation"');

    // Edit only the unrelated return value — the catch block's own lines
    // are untouched context in this diff.
    writeFileSync(
      file,
      "export function main() {\n" +
        "  try {\n" +
        "    doThing();\n" +
        "  } catch {\n" +
        "  }\n" +
        "  return 2;\n" +
        "}\n",
    );
    git(repo, "add hooks/Legacy.hook.ts");

    const result = await checkNoEmptyCatchStaged(repo);
    expect(result.errors.length).toBe(0);
  });

  test("no staged hooks/lib .ts changes — 0 errors", async () => {
    const file = join(repo, "hooks", "Example.hook.ts");
    writeFileSync(file, "export function main() {\n  return 1;\n}\n");
    git(repo, "add hooks/Example.hook.ts");
    git(repo, 'commit -q -m "baseline"');

    const result = await checkNoEmptyCatchStaged(repo);
    expect(result.errors.length).toBe(0);
  });

  test("new empty catch outside hooks/ or lib/ — not flagged (out of scope)", async () => {
    mkdirSync(join(repo, "bin"), { recursive: true });
    const file = join(repo, "bin", "example.ts");
    writeFileSync(file, "export function run() {\n  return 1;\n}\n");
    git(repo, "add bin/example.ts");
    git(repo, 'commit -q -m "baseline"');

    writeFileSync(
      file,
      "export function run() {\n" +
        "  try {\n" +
        "    doThing();\n" +
        "  } catch {\n" +
        "  }\n" +
        "  return 1;\n" +
        "}\n",
    );
    git(repo, "add bin/example.ts");

    const result = await checkNoEmptyCatchStaged(repo);
    expect(result.errors.length).toBe(0);
  });

  test("new empty catch in a staged test file — not flagged (test files exempt)", async () => {
    const file = join(repo, "hooks", "Example.hook.test.ts");
    writeFileSync(file, "export function run() {\n  return 1;\n}\n");
    git(repo, "add hooks/Example.hook.test.ts");
    git(repo, 'commit -q -m "baseline"');

    writeFileSync(
      file,
      "export function run() {\n" +
        "  try {\n" +
        "    doThing();\n" +
        "  } catch {\n" +
        "  }\n" +
        "  return 1;\n" +
        "}\n",
    );
    git(repo, "add hooks/Example.hook.test.ts");

    const result = await checkNoEmptyCatchStaged(repo);
    expect(result.errors.length).toBe(0);
  });
});
