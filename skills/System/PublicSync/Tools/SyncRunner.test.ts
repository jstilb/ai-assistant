#!/usr/bin/env bun
/**
 * SyncRunner.test.ts — a failing git operation must never leak a raw token
 * into the thrown error message.
 *
 * Root cause (security-audit S-08 addendum, 2026-09-08): ensureStagingRepo()
 * and the push step ran clone/pull/push with stdio:"inherit" against an
 * HTTPS remote URL of the form `https://<GITHUB_TOKEN>@github.com/...`. On
 * failure, the raw stderr streamed straight through, unredacted. runGit()
 * replaces that with captured stdio piped through redactSecrets() — and the
 * thrown Error is built only from the label + redacted stderr, never from
 * the caught error's own `.message` (which embeds the full argv, token
 * included — see the extractOutput() comment in SyncRunner.ts).
 *
 * Run: bun test ~/.claude/.claude/worktrees/security-audit-exec-20260908/skills/System/PublicSync/Tools/SyncRunner.test.ts
 */

import { describe, test, expect, afterAll } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { execFileSync } from "child_process";
import { join } from "path";
import { tmpdir } from "os";

const FAKE_TOKEN = "FAKE_TOKEN_1234567890abcdefghij";

// SyncRunner reads <KAYA_HOME>/secrets.json at import time, so KAYA_HOME is
// pinned to an empty temp dir BEFORE the dynamic import — a static import
// would hoist and read the real GITHUB_TOKEN (t-mvloqd9d-zhvbvz).
const ORIGINAL_KAYA_HOME = process.env.KAYA_HOME;
const TEST_KAYA_HOME = mkdtempSync(join(tmpdir(), "syncrunner-kaya-home-"));
process.env.KAYA_HOME = TEST_KAYA_HOME;
const { discardStagingHusk, runGit, loadGithubToken } = await import("./SyncRunner");

afterAll(() => {
  if (ORIGINAL_KAYA_HOME === undefined) delete process.env.KAYA_HOME;
  else process.env.KAYA_HOME = ORIGINAL_KAYA_HOME;
  rmSync(TEST_KAYA_HOME, { recursive: true, force: true });
});

describe("loadGithubToken", () => {
  test("reads secrets.json under KAYA_HOME, not the real ~/.claude", () => {
    // Boolean asserts: on a regression the received value is the REAL token,
    // and a plain toBe/toBeUndefined failure would print it.
    expect(loadGithubToken() === undefined).toBe(true); // empty temp KAYA_HOME
    writeFileSync(join(TEST_KAYA_HOME, "secrets.json"), JSON.stringify({ GITHUB_TOKEN: FAKE_TOKEN }));
    expect(loadGithubToken() === FAKE_TOKEN).toBe(true);
  });
});

describe("runGit", () => {
  test("a failing clone against an unreachable host never leaks the token in the thrown message", () => {
    const dest = mkdtempSync(join(tmpdir(), "syncrunner-rungit-test-"));
    rmSync(dest, { recursive: true, force: true }); // git clone requires the dest not exist yet
    try {
      // Port 9 (discard) on loopback refuses immediately — no hang, no
      // timeout needed. The URL embeds the fake token as userinfo, exactly
      // like the real REMOTE_URL shape (`https://<token>@github.com/...`).
      const unreachableUrl = `https://${FAKE_TOKEN}@127.0.0.1:9/none.git`;

      let thrown: unknown;
      try {
        runGit(["clone", unreachableUrl, dest], "clone", [FAKE_TOKEN]);
      } catch (err) {
        thrown = err;
      }

      expect(thrown).toBeInstanceOf(Error);
      const message = (thrown as Error).message;
      expect(message).not.toContain(FAKE_TOKEN);
      expect(message.startsWith("[SyncRunner] git clone failed")).toBe(true);
    } finally {
      rmSync(dest, { recursive: true, force: true });
    }
  }, 15_000);
});

// Root cause of the 2026-10 nightly exit-1 streak (t-mvlek5j1-dpxytf): macOS
// /tmp cleanup guts /tmp/pai-public-staging's .git but leaves the directory,
// so ensureStagingRepo() saw "exists", skipped the clone and died at
// `git pull` ("not a git repository") every night.
describe("discardStagingHusk", () => {
  test("removes a staging dir that has no usable .git, so the runner re-clones", () => {
    const dir = mkdtempSync(join(tmpdir(), "syncrunner-husk-test-"));
    try {
      mkdirSync(join(dir, ".git", "objects"), { recursive: true }); // gutted: no HEAD
      writeFileSync(join(dir, "README.md"), "stale\n");
      expect(discardStagingHusk(dir)).toBe(true);
      expect(existsSync(dir)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("keeps a real git clone untouched", () => {
    const dir = mkdtempSync(join(tmpdir(), "syncrunner-husk-test-"));
    try {
      execFileSync("git", ["init", "-q", dir]);
      expect(discardStagingHusk(dir)).toBe(false);
      expect(existsSync(join(dir, ".git", "HEAD"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("is a no-op when the staging dir does not exist", () => {
    const dir = join(tmpdir(), `syncrunner-husk-absent-${process.pid}`);
    expect(discardStagingHusk(dir)).toBe(false);
  });
});
