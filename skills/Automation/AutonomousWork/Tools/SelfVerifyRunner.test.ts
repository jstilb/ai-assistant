/**
 * SelfVerifyRunner.test.ts — Slice 1: the non-dangerous deterministic Phase L harness.
 *
 * All tests inject `exec`, `now`, `writeTranscript`, and `hasTsconfig` — no real
 * spawns, no `claude -p`, no disk writes.
 */

import { test, expect, describe } from "bun:test";
import {
  runSelfVerify,
  buildSelfVerifyCommands,
  isSelfVerifyCommandSafe,
  type ExecResult,
  type SelfVerifyDeps,
} from "./SelfVerifyRunner.ts";
import type { LiveVerifierInput } from "./LiveVerifier.ts";

function baseInput(over: Partial<LiveVerifierInput> = {}): LiveVerifierInput {
  return {
    itemId: "item-sv",
    surface: "cli",
    effort: "STANDARD",
    workingDir: "/tmp/worktree",
    specExcerpt: "greet prints Hello",
    diffPaths: ["bin/greet.ts"],
    ...over,
  };
}

/** Records every command and returns a scripted exit code per command. */
function recordingExec(scriptByCmd: Record<string, Partial<ExecResult>> = {}, fallback: Partial<ExecResult> = {}) {
  const calls: string[] = [];
  const exec = (cmd: string): ExecResult => {
    calls.push(cmd);
    const s = scriptByCmd[cmd] ?? fallback;
    return { stdout: "ran", stderr: "", exitCode: 0, timedOut: false, ...s };
  };
  return { calls, exec };
}

function quietDeps(over: Partial<SelfVerifyDeps> = {}): SelfVerifyDeps {
  return {
    now: () => 1000,
    writeTranscript: () => {},
    hasTsconfig: () => false,
    ...over,
  };
}

// ---------------------------------------------------------------------------
// Safety allowlist
// ---------------------------------------------------------------------------

describe("isSelfVerifyCommandSafe", () => {
  test("allows allowlisted executables", () => {
    expect(isSelfVerifyCommandSafe("bun test ./Foo.test.ts")).toBe(true);
    expect(isSelfVerifyCommandSafe("bunx tsc --noEmit")).toBe(true);
    expect(isSelfVerifyCommandSafe("curl -s localhost:3000/health")).toBe(true);
    expect(isSelfVerifyCommandSafe("/usr/local/bin/node script.js")).toBe(true);
  });

  test("NEVER allows claude (the blocked spawn can't recur)", () => {
    expect(isSelfVerifyCommandSafe("claude -p --dangerously-skip-permissions 'go'")).toBe(false);
  });

  test("blocks non-allowlisted executables", () => {
    expect(isSelfVerifyCommandSafe("python evil.py")).toBe(false);
    expect(isSelfVerifyCommandSafe("FOO=bar bun test")).toBe(false); // inline env prefix rejected
  });

  test("blocks catastrophic commands even when first token is allowlisted", () => {
    expect(isSelfVerifyCommandSafe("bun run x && rm -rf /")).toBe(false);
    expect(isSelfVerifyCommandSafe("git push --force origin main")).toBe(false);
    expect(isSelfVerifyCommandSafe("bun run db && drop database prod")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Command building
// ---------------------------------------------------------------------------

describe("buildSelfVerifyCommands", () => {
  test("uses caller commands and appends typecheck when tsconfig present", () => {
    const cmds = buildSelfVerifyCommands(
      baseInput({ selfVerifyCommands: ["bun run cli --help"] }),
      () => true,
    );
    expect(cmds).toEqual(["bun run cli --help", "bunx tsc --noEmit"]);
  });

  test("dedupes and skips typecheck when no tsconfig", () => {
    const cmds = buildSelfVerifyCommands(
      baseInput({ selfVerifyCommands: ["bun run a", "bun run a"] }),
      () => false,
    );
    expect(cmds).toEqual(["bun run a"]);
  });
});

// ---------------------------------------------------------------------------
// runSelfVerify — never spawns claude, emits real PASS/FAIL
// ---------------------------------------------------------------------------

describe("runSelfVerify", () => {
  test("all commands exit 0 → PASS, never invokes claude", async () => {
    const { calls, exec } = recordingExec();
    const res = await runSelfVerify(
      baseInput({ selfVerifyCommands: ["bun run cli --help", "bun test ./X.test.ts"] }),
      quietDeps({ exec }),
    );
    expect(res.verdict).toBe("PASS");
    expect(res.mode).toBe("self-verify");
    expect(res.scenariosRun).toBe(2);
    expect(res.environmentBlocked).toBe(false);
    expect(res.noEvidence).toBe(false);
    expect(calls).toEqual(["bun run cli --help", "bun test ./X.test.ts"]);
    expect(calls.some((c) => c.includes("claude"))).toBe(false);
  });

  test("a failing command → FAIL with real observed output", async () => {
    const { exec } = recordingExec({ "bun run cli": { exitCode: 1, stdout: "", stderr: "boom" } });
    const res = await runSelfVerify(
      baseInput({ selfVerifyCommands: ["bun run cli"] }),
      quietDeps({ exec }),
    );
    expect(res.verdict).toBe("FAIL");
    expect(res.scenariosFailed).toBe(1);
    expect(res.scenarios[0].observed).toContain("boom");
    expect(res.environmentBlocked).toBe(false);
  });

  test("no allowlisted command → environmentBlocked (NOT a code FAIL, NOT noEvidence)", async () => {
    const { calls, exec } = recordingExec();
    const res = await runSelfVerify(
      baseInput({ selfVerifyCommands: ["python evil.py"] }), // dropped by allowlist
      quietDeps({ exec }),
    );
    expect(calls.length).toBe(0);
    expect(res.environmentBlocked).toBe(true);
    expect(res.noEvidence).toBe(false); // distinct from the "never ran it" hard FAIL
    expect(res.verdict).toBe("FAIL");
  });

  test("native surface short-circuits to HUMAN_REQUIRED", async () => {
    const res = await runSelfVerify(baseInput({ surface: "native" }), quietDeps());
    expect(res.verdict).toBe("HUMAN_REQUIRED");
    expect(res.humanVerificationRequired).toBe(true);
    expect(res.environmentBlocked).toBe(false);
  });

  test("persists a transcript with the self-verify engine tag", async () => {
    const writes: Array<{ path: string; data: string }> = [];
    const { exec } = recordingExec();
    await runSelfVerify(
      baseInput({ selfVerifyCommands: ["bun run x"] }),
      quietDeps({ exec, writeTranscript: (path, data) => writes.push({ path, data }) }),
    );
    expect(writes.length).toBe(1);
    expect(writes[0].path).toContain("selfverify-1000.json");
    expect(JSON.parse(writes[0].data).engine).toBe("self-verify");
  });
});
