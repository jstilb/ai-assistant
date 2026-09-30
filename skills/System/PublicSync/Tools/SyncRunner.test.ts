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

import { describe, test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { runGit } from "./SyncRunner";

const FAKE_TOKEN = "FAKE_TOKEN_1234567890abcdefghij";

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
