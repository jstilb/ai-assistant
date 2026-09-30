import { afterEach, beforeEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { checkNoRawStdin, checkNoRawStdinStaged } from "./no-raw-stdin.ts";

let repo: string;
const git = (...args: string[]) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], {
  cwd: repo, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
});
function stage(path: string, text: string) {
  mkdirSync(dirname(join(repo, path)), { recursive: true });
  writeFileSync(join(repo, path), text);
  git("add", "--", path);
}

beforeEach(() => { repo = mkdtempSync(join(tmpdir(), "credential-gate-")); git("init", "-q"); });
afterEach(() => rmSync(repo, { recursive: true, force: true }));

const reads = ["await Bun.stdin.text()", "await new Response(Bun.stdin.stream()).text()"];
for (const path of ["bin/setup-moonshot-key.ts", "plans/remediation-n1n5/rotate-creds.ts", "hooks/Example.ts"]) {
  for (const read of reads) {
    test(`rejects added raw input in ${path}: ${read}`, async () => {
      stage(path, `const credential = ${read};\n`);
      const result = await checkNoRawStdinStaged(repo);
      expect(result.errors.length).toBe(1);
      expect(result.errors[0]).toContain(`${path}:1:`);
    });
  }
}

for (const path of ["lib/core/SecretInput.ts", "lib/hook-utils.ts"]) {
  test(`accepts declared provider ${path}`, async () => {
    stage(path, reads.map((read) => `${read};\n`).join(""));
    expect((await checkNoRawStdinStaged(repo)).errors).toEqual([]);
  });
}

for (const path of ["nested/lib/core/SecretInput.ts", "lib/core/SecretInputCopy.ts", "bin/SecretInput.ts"]) {
  test(`provider recognition is exact: rejects ${path}`, async () => {
    stage(path, `const credential = ${reads[0]};\n`);
    expect((await checkNoRawStdinStaged(repo)).errors.length).toBe(1);
  });
}

for (const read of reads) {
  test(`grandfathers untouched raw input, catches changed and reintroduced input: ${read}`, async () => {
    const legacy = `const credential = ${read};\n`;
    stage("bin/legacy.ts", legacy + "export const marker = 1;\n");
    git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "-qm", "synthetic baseline");
    stage("bin/legacy.ts", legacy + "export const marker = 2;\n");
    expect((await checkNoRawStdinStaged(repo)).errors).toEqual([]);
    stage("bin/legacy.ts", legacy.replace("credential", "changed") + "export const marker = 2;\n");
    expect((await checkNoRawStdinStaged(repo)).errors.length).toBe(1);
    stage("bin/legacy.ts", "export const marker = 2;\n");
    git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "-qm", "synthetic removal");
    stage("bin/legacy.ts", legacy + "export const marker = 2;\n");
    expect((await checkNoRawStdinStaged(repo)).errors.length).toBe(1);
  });
}

test("full-tree warning mode uses the same new provider and stream pattern", async () => {
  stage("lib/core/SecretInput.ts", `const credential = ${reads[1]};\n`);
  stage("bin/client.ts", `const credential = ${reads[1]};\n`);
  const result = await checkNoRawStdin(repo);
  expect(result.errors).toEqual([]);
  expect(result.warnings.length).toBe(1);
  expect(result.warnings[0]).toContain("bin/client.ts");
});
