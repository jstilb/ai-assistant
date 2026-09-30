#!/usr/bin/env bun
/**
 * AgentSpawner.test.ts — Unit tests for the shared headless-agent spawn substrate.
 *
 * Hygiene:
 *   - No real process is ever spawned — `deps.spawnFn` is always injected with a fake.
 *   - Most tests also inject `deps.isRateLimitedFn` so they never touch the real
 *     ~/.claude/MEMORY/State/rate-limits.json. The one section that DOES exercise
 *     the real RateLimitGuard path pins KAYA_HOME to an mkdtemp dir first (and
 *     resets KayaHome's module-level cache — it is NOT re-evaluated per call).
 *   - The worktree-isolation test uses a real (but disposable, mkdtemp-rooted) git
 *     repo — following the precedent in lib/core/WorktreeManager.test.ts — with a
 *     fake spawnFn, so it proves real worktree wiring without ever invoking `claude`.
 */

import { describe, it, expect, beforeEach, afterEach, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, existsSync } from "fs";
import { execFileSync } from "child_process";
import { tmpdir } from "os";
import { join } from "path";
import { z } from "zod";

import {
  spawnAgentSync,
  spawnAgent,
  isInfraUnavailable,
  classifyInfraReason,
  parseVerdictBlock,
  resolveGuardHooks,
  buildGuardHookSettings,
  resolveEnforceTools,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_MAX_BUFFER,
} from "./AgentSpawner.ts";
import type { RawSpawnFn, RawSpawnOutcome, GetOrCreateWorktreeFn } from "./AgentSpawner.ts";
import { MEMORY } from "./MemoryPaths.ts";
import { removeWorktree, worktreesDir, repoSlug } from "./WorktreeManager.ts";

// ============================================================================
// Fake spawn fn — never touches a real process
// ============================================================================

type SpawnFnArgs = Parameters<RawSpawnFn>;
interface FakeSpawnCall {
  claudePath: SpawnFnArgs[0];
  args: SpawnFnArgs[1];
  opts: SpawnFnArgs[2];
}

function makeFakeSpawn(outcome: Partial<RawSpawnOutcome>): { fn: RawSpawnFn; calls: FakeSpawnCall[] } {
  const calls: FakeSpawnCall[] = [];
  const fn: RawSpawnFn = (claudePath, args, opts) => {
    calls.push({ claudePath, args, opts });
    return {
      stdout: outcome.stdout ?? "",
      stderr: outcome.stderr ?? "",
      status: outcome.status === undefined ? 0 : outcome.status,
      signal: outcome.signal ?? null,
      error: outcome.error,
    };
  };
  return { fn, calls };
}

const NEVER_LIMITED = () => false;

// ============================================================================
// spawnAgentSync — argument construction
// ============================================================================

describe("spawnAgentSync — argument construction", () => {
  it("builds the exact expected CLI args with the prompt as the LAST element", () => {
    const { fn, calls } = makeFakeSpawn({ status: 0 });
    spawnAgentSync(
      { prompt: "do the thing", model: "sonnet", allowedTools: "Read,Bash" },
      { spawnFn: fn, isRateLimitedFn: NEVER_LIMITED },
    );

    expect(calls).toHaveLength(1);
    expect(calls[0].args).toEqual([
      "-p",
      "--model", "sonnet",
      "--dangerously-skip-permissions",
      "--allowedTools", "Read,Bash",
      "--setting-sources", "",
      "--output-format", "text",
      "do the thing",
    ]);
  });

  it("inserts --effort right after --model when opts.effort is set", () => {
    const { fn, calls } = makeFakeSpawn({ status: 0 });
    spawnAgentSync(
      { prompt: "p", model: "sonnet", allowedTools: "Read", effort: "medium" },
      { spawnFn: fn, isRateLimitedFn: NEVER_LIMITED },
    );
    expect(calls[0].args.slice(0, 5)).toEqual(["-p", "--model", "sonnet", "--effort", "medium"]);
  });

  it("defaults cwd to process.env.HOME when neither cwd nor worktree is given", () => {
    const { fn, calls } = makeFakeSpawn({ status: 0 });
    spawnAgentSync(
      { prompt: "p", model: "sonnet", allowedTools: "Read" },
      { spawnFn: fn, isRateLimitedFn: NEVER_LIMITED },
    );
    expect(calls[0].opts.cwd).toBe(process.env.HOME ?? "/tmp");
  });

  it("uses an explicit cwd when given", () => {
    const { fn, calls } = makeFakeSpawn({ status: 0 });
    spawnAgentSync(
      { prompt: "p", model: "sonnet", allowedTools: "Read", cwd: "/explicit/dir" },
      { spawnFn: fn, isRateLimitedFn: NEVER_LIMITED },
    );
    expect(calls[0].opts.cwd).toBe("/explicit/dir");
  });

  it("passes DEFAULT_TIMEOUT_MS and DEFAULT_MAX_BUFFER when not overridden", () => {
    const { fn, calls } = makeFakeSpawn({ status: 0 });
    spawnAgentSync(
      { prompt: "p", model: "sonnet", allowedTools: "Read" },
      { spawnFn: fn, isRateLimitedFn: NEVER_LIMITED },
    );
    expect(calls[0].opts.timeoutMs).toBe(DEFAULT_TIMEOUT_MS);
    expect(calls[0].opts.maxBuffer).toBe(DEFAULT_MAX_BUFFER);
  });

  it("honors caller-supplied timeoutMs and maxBuffer overrides", () => {
    const { fn, calls } = makeFakeSpawn({ status: 0 });
    spawnAgentSync(
      { prompt: "p", model: "sonnet", allowedTools: "Read", timeoutMs: 5000, maxBuffer: 1024 },
      { spawnFn: fn, isRateLimitedFn: NEVER_LIMITED },
    );
    expect(calls[0].opts.timeoutMs).toBe(5000);
    expect(calls[0].opts.maxBuffer).toBe(1024);
  });

  it("throws when opts.worktree is given without an already-resolved cwd", () => {
    expect(() =>
      spawnAgentSync(
        {
          prompt: "p",
          model: "sonnet",
          allowedTools: "Read",
          worktree: { repoRoot: "/tmp/some-repo", branch: "b", createdBy: "c" },
        },
        { isRateLimitedFn: NEVER_LIMITED },
      ),
    ).toThrow(/worktree/i);
  });

  it("keeps the prompt as the LAST argv element even with guardHooks AND enforceTools both on", () => {
    const { fn, calls } = makeFakeSpawn({ status: 0 });
    spawnAgentSync(
      {
        prompt: "the final prompt",
        model: "sonnet",
        allowedTools: "Read,Bash",
        guardHooks: true,
        enforceTools: true,
      },
      { spawnFn: fn, isRateLimitedFn: NEVER_LIMITED },
    );
    const args = calls[0].args;
    expect(args[args.length - 1]).toBe("the final prompt");
  });
});

// ============================================================================
// spawnAgentSync — enforceTools (S-06 slice-3)
// ============================================================================

describe("spawnAgentSync — enforceTools (S-06 slice-3)", () => {
  it("omits --tools by default (option and env both unset)", () => {
    const { fn, calls } = makeFakeSpawn({ status: 0 });
    spawnAgentSync(
      { prompt: "p", model: "sonnet", allowedTools: "Read,Bash" },
      { spawnFn: fn, isRateLimitedFn: NEVER_LIMITED },
    );
    expect(calls[0].args).not.toContain("--tools");
  });

  it("passes --tools <allowedTools> right after --allowedTools when enforceTools: true (on-by-option)", () => {
    const { fn, calls } = makeFakeSpawn({ status: 0 });
    spawnAgentSync(
      { prompt: "p", model: "sonnet", allowedTools: "Read,Bash", enforceTools: true },
      { spawnFn: fn, isRateLimitedFn: NEVER_LIMITED },
    );
    expect(calls[0].args).toEqual([
      "-p",
      "--model", "sonnet",
      "--dangerously-skip-permissions",
      "--allowedTools", "Read,Bash",
      "--tools", "Read,Bash",
      "--setting-sources", "",
      "--output-format", "text",
      "p",
    ]);
  });

  it("passes --tools when KAYA_HEADLESS_TOOLS_ENFORCE=1 (on-by-env)", () => {
    const origEnv = process.env.KAYA_HEADLESS_TOOLS_ENFORCE;
    process.env.KAYA_HEADLESS_TOOLS_ENFORCE = "1";
    try {
      const { fn, calls } = makeFakeSpawn({ status: 0 });
      spawnAgentSync(
        { prompt: "p", model: "sonnet", allowedTools: "Read" },
        { spawnFn: fn, isRateLimitedFn: NEVER_LIMITED },
      );
      expect(calls[0].args).toContain("--tools");
    } finally {
      if (origEnv === undefined) delete process.env.KAYA_HEADLESS_TOOLS_ENFORCE;
      else process.env.KAYA_HEADLESS_TOOLS_ENFORCE = origEnv;
    }
  });

  it("explicit enforceTools: false overrides KAYA_HEADLESS_TOOLS_ENFORCE=1 (option wins over env)", () => {
    const origEnv = process.env.KAYA_HEADLESS_TOOLS_ENFORCE;
    process.env.KAYA_HEADLESS_TOOLS_ENFORCE = "1";
    try {
      const { fn, calls } = makeFakeSpawn({ status: 0 });
      spawnAgentSync(
        { prompt: "p", model: "sonnet", allowedTools: "Read", enforceTools: false },
        { spawnFn: fn, isRateLimitedFn: NEVER_LIMITED },
      );
      expect(calls[0].args).not.toContain("--tools");
    } finally {
      if (origEnv === undefined) delete process.env.KAYA_HEADLESS_TOOLS_ENFORCE;
      else process.env.KAYA_HEADLESS_TOOLS_ENFORCE = origEnv;
    }
  });
});

describe("resolveEnforceTools (pure)", () => {
  it("explicit option wins over env in both directions", () => {
    expect(resolveEnforceTools(true, { KAYA_HEADLESS_TOOLS_ENFORCE: "0" } as NodeJS.ProcessEnv)).toBe(true);
    expect(resolveEnforceTools(false, { KAYA_HEADLESS_TOOLS_ENFORCE: "1" } as NodeJS.ProcessEnv)).toBe(false);
  });

  it("env '1' turns it on, env '0' turns it off, when no explicit option is given", () => {
    expect(resolveEnforceTools(undefined, { KAYA_HEADLESS_TOOLS_ENFORCE: "1" } as NodeJS.ProcessEnv)).toBe(true);
    expect(resolveEnforceTools(undefined, { KAYA_HEADLESS_TOOLS_ENFORCE: "0" } as NodeJS.ProcessEnv)).toBe(false);
  });

  it("defaults to false (off) when neither option nor env is set", () => {
    expect(resolveEnforceTools(undefined, {} as NodeJS.ProcessEnv)).toBe(false);
  });
});

// ============================================================================
// spawnAgentSync — guardHooks (S-06 slice-3)
// ============================================================================

describe("spawnAgentSync — guardHooks (S-06 slice-3)", () => {
  it("omits --settings by default (option and env both unset)", () => {
    const { fn, calls } = makeFakeSpawn({ status: 0 });
    spawnAgentSync(
      { prompt: "p", model: "sonnet", allowedTools: "Read" },
      { spawnFn: fn, isRateLimitedFn: NEVER_LIMITED },
    );
    expect(calls[0].args).not.toContain("--settings");
  });

  it("appends --settings <json> after --output-format text and before the prompt when guardHooks: true (on-by-option)", () => {
    const { fn, calls } = makeFakeSpawn({ status: 0 });
    spawnAgentSync(
      { prompt: "p", model: "sonnet", allowedTools: "Read", guardHooks: true },
      { spawnFn: fn, isRateLimitedFn: NEVER_LIMITED },
    );
    const args = calls[0].args;
    const settingsIdx = args.indexOf("--settings");
    expect(settingsIdx).toBeGreaterThan(-1);
    expect(args[settingsIdx - 1]).toBe("text"); // right after --output-format text
    expect(args[args.length - 1]).toBe("p"); // prompt still last
    expect(() => JSON.parse(args[settingsIdx + 1] as string)).not.toThrow();
  });

  it("appends --settings when KAYA_HEADLESS_GUARD_HOOKS=1 (on-by-env)", () => {
    const origEnv = process.env.KAYA_HEADLESS_GUARD_HOOKS;
    process.env.KAYA_HEADLESS_GUARD_HOOKS = "1";
    try {
      const { fn, calls } = makeFakeSpawn({ status: 0 });
      spawnAgentSync(
        { prompt: "p", model: "sonnet", allowedTools: "Read" },
        { spawnFn: fn, isRateLimitedFn: NEVER_LIMITED },
      );
      expect(calls[0].args).toContain("--settings");
    } finally {
      if (origEnv === undefined) delete process.env.KAYA_HEADLESS_GUARD_HOOKS;
      else process.env.KAYA_HEADLESS_GUARD_HOOKS = origEnv;
    }
  });

  it("explicit guardHooks: false overrides KAYA_HEADLESS_GUARD_HOOKS=1 (option wins over env)", () => {
    const origEnv = process.env.KAYA_HEADLESS_GUARD_HOOKS;
    process.env.KAYA_HEADLESS_GUARD_HOOKS = "1";
    try {
      const { fn, calls } = makeFakeSpawn({ status: 0 });
      spawnAgentSync(
        { prompt: "p", model: "sonnet", allowedTools: "Read", guardHooks: false },
        { spawnFn: fn, isRateLimitedFn: NEVER_LIMITED },
      );
      expect(calls[0].args).not.toContain("--settings");
    } finally {
      if (origEnv === undefined) delete process.env.KAYA_HEADLESS_GUARD_HOOKS;
      else process.env.KAYA_HEADLESS_GUARD_HOOKS = origEnv;
    }
  });
});

describe("resolveGuardHooks (pure)", () => {
  it("explicit option wins over env in both directions", () => {
    expect(resolveGuardHooks(true, { KAYA_HEADLESS_GUARD_HOOKS: "0" } as NodeJS.ProcessEnv)).toBe(true);
    expect(resolveGuardHooks(false, { KAYA_HEADLESS_GUARD_HOOKS: "1" } as NodeJS.ProcessEnv)).toBe(false);
  });

  it("env '1' turns it on, env '0' turns it off, when no explicit option is given", () => {
    expect(resolveGuardHooks(undefined, { KAYA_HEADLESS_GUARD_HOOKS: "1" } as NodeJS.ProcessEnv)).toBe(true);
    expect(resolveGuardHooks(undefined, { KAYA_HEADLESS_GUARD_HOOKS: "0" } as NodeJS.ProcessEnv)).toBe(false);
  });

  it("defaults to false (off) when neither option nor env is set", () => {
    expect(resolveGuardHooks(undefined, {} as NodeJS.ProcessEnv)).toBe(false);
  });
});

describe("buildGuardHookSettings — exact JSON shape", () => {
  const KAYA_DIR = "/abs/kaya/dir";
  const parsed = JSON.parse(buildGuardHookSettings(KAYA_DIR)) as {
    hooks: {
      PreToolUse: Array<{ matcher: string; hooks: Array<{ type: string; command: string; timeout?: number }> }>;
      PostToolUse: Array<{ matcher: string; hooks: Array<{ type: string; command: string; timeout?: number }> }>;
    };
  };

  it("has exactly the two hook events (PreToolUse, PostToolUse) — nothing else", () => {
    expect(Object.keys(parsed.hooks).sort()).toEqual(["PostToolUse", "PreToolUse"]);
  });

  it("has exactly 3 PreToolUse matchers — Bash, Edit, Write — each routed to SecurityValidator.hook.ts with an absolute path", () => {
    expect(parsed.hooks.PreToolUse).toHaveLength(3);
    const matchers = parsed.hooks.PreToolUse.map((m) => m.matcher).sort();
    expect(matchers).toEqual(["Bash", "Edit", "Write"]);
    for (const m of parsed.hooks.PreToolUse) {
      expect(m.hooks).toHaveLength(1);
      expect(m.hooks[0].type).toBe("command");
      expect(m.hooks[0].command).toBe(`${KAYA_DIR}/hooks/SecurityValidator.hook.ts`);
      expect(m.hooks[0].command.startsWith("/")).toBe(true);
    }
  });

  it("has exactly 4 PostToolUse matchers — Bash, Read, WebFetch, WebSearch — each routed to `bun run .../PromptInjectionDefender.hook.ts` with an absolute path", () => {
    expect(parsed.hooks.PostToolUse).toHaveLength(4);
    const matchers = parsed.hooks.PostToolUse.map((m) => m.matcher).sort();
    expect(matchers).toEqual(["Bash", "Read", "WebFetch", "WebSearch"]);
    for (const m of parsed.hooks.PostToolUse) {
      expect(m.hooks).toHaveLength(1);
      expect(m.hooks[0].type).toBe("command");
      expect(m.hooks[0].command).toBe(`bun run ${KAYA_DIR}/hooks/PromptInjectionDefender.hook.ts`);
      expect(m.hooks[0].timeout).toBe(10);
    }
  });
});

// ============================================================================
// spawnAgentSync — env hardening
// ============================================================================

describe("spawnAgentSync — env hardening", () => {
  it("strips ANTHROPIC_API_KEY and CLAUDE_CODE_* (except OAuth token), sets KAYA_AUTONOMOUS=1 by default", () => {
    const origApiKey = process.env.ANTHROPIC_API_KEY;
    const origFoo = process.env.CLAUDE_CODE_FOO;
    process.env.ANTHROPIC_API_KEY = "sk-your-dummy-key-stripped";
    process.env.CLAUDE_CODE_FOO = "should-be-stripped";
    try {
      const { fn, calls } = makeFakeSpawn({ status: 0 });
      spawnAgentSync(
        { prompt: "p", model: "sonnet", allowedTools: "Read" },
        { spawnFn: fn, isRateLimitedFn: NEVER_LIMITED },
      );
      expect(calls[0].opts.env.ANTHROPIC_API_KEY).toBeUndefined();
      expect(calls[0].opts.env.CLAUDE_CODE_FOO).toBeUndefined();
      expect(calls[0].opts.env.KAYA_AUTONOMOUS).toBe("1");
    } finally {
      if (origApiKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = origApiKey;
      if (origFoo === undefined) delete process.env.CLAUDE_CODE_FOO;
      else process.env.CLAUDE_CODE_FOO = origFoo;
    }
  });

  it("lets caller-supplied env override the KAYA_AUTONOMOUS default and add extra vars", () => {
    const { fn, calls } = makeFakeSpawn({ status: 0 });
    spawnAgentSync(
      { prompt: "p", model: "sonnet", allowedTools: "Read", env: { KAYA_AUTONOMOUS: "0", CUSTOM_VAR: "x" } },
      { spawnFn: fn, isRateLimitedFn: NEVER_LIMITED },
    );
    expect(calls[0].opts.env.KAYA_AUTONOMOUS).toBe("0");
    expect(calls[0].opts.env.CUSTOM_VAR).toBe("x");
  });

  it("re-strips dangerous keys from a caller-supplied env — a caller cannot un-harden the spawn by passing env: {...process.env}", () => {
    const { fn, calls } = makeFakeSpawn({ status: 0 });
    spawnAgentSync(
      {
        prompt: "p",
        model: "sonnet",
        allowedTools: "Read",
        // Simulates the real-world footgun: a caller spreads the ambient
        // process.env (which may carry live ANTHROPIC_API_KEY / CLAUDECODE
        // from an interactive session) into opts.env.
        env: { ...process.env, ANTHROPIC_API_KEY: "x", CLAUDECODE: "1" },
      },
      { spawnFn: fn, isRateLimitedFn: NEVER_LIMITED },
    );
    expect(calls[0].opts.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(calls[0].opts.env.CLAUDECODE).toBeUndefined();
    // Legitimate extras must survive the re-strip.
    expect(calls[0].opts.env.KAYA_AUTONOMOUS).toBe("1");
  });
});

// ============================================================================
// spawnAgentSync — timeout detection
// ============================================================================

describe("spawnAgentSync — timeout detection", () => {
  it("detects timeout via signal===SIGTERM", () => {
    const { fn } = makeFakeSpawn({ status: null, signal: "SIGTERM" });
    const result = spawnAgentSync(
      { prompt: "p", model: "sonnet", allowedTools: "Read" },
      { spawnFn: fn, isRateLimitedFn: NEVER_LIMITED },
    );
    expect(result.timedOut).toBe(true);
    expect(result.success).toBe(false);
    expect(result.infraUnavailable).toBe(true);
    expect(result.infraReason).toBe("timeout");
  });

  it("detects timeout via error.code===ETIMEDOUT", () => {
    const { fn } = makeFakeSpawn({ status: null, signal: null, error: { code: "ETIMEDOUT" } });
    const result = spawnAgentSync(
      { prompt: "p", model: "sonnet", allowedTools: "Read" },
      { spawnFn: fn, isRateLimitedFn: NEVER_LIMITED },
    );
    expect(result.timedOut).toBe(true);
    expect(result.infraUnavailable).toBe(true);
    expect(result.infraReason).toBe("timeout");
  });
});

// ============================================================================
// spawnAgentSync — success / genuine failure
// ============================================================================

describe("spawnAgentSync — success and genuine failure", () => {
  it("reports success on exit 0", () => {
    const { fn } = makeFakeSpawn({ status: 0, stdout: "all good" });
    const result = spawnAgentSync(
      { prompt: "p", model: "sonnet", allowedTools: "Read" },
      { spawnFn: fn, isRateLimitedFn: NEVER_LIMITED },
    );
    expect(result.success).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.infraUnavailable).toBe(false);
    expect(result.preSpawnGated).toBe(false);
    expect(result.stdout).toBe("all good");
  });

  it("reports failure (not infra) for a genuine task error with real diagnostic output", () => {
    const { fn } = makeFakeSpawn({ status: 1, stdout: "TypeError: cannot read property of undefined\n  at foo.ts:12" });
    const result = spawnAgentSync(
      { prompt: "p", model: "sonnet", allowedTools: "Read" },
      { spawnFn: fn, isRateLimitedFn: NEVER_LIMITED },
    );
    expect(result.success).toBe(false);
    expect(result.infraUnavailable).toBe(false);
  });
});

// ============================================================================
// spawnAgentSync — post-spawn infra classification
// ============================================================================

describe("spawnAgentSync — post-spawn infra classification", () => {
  it("flags infraUnavailable for a session-limit notice on STDOUT (the 2026-06-22 regression shape)", () => {
    const { fn } = makeFakeSpawn({
      status: 1,
      stdout: "You've hit your session limit · resets 11:50pm (America/Los_Angeles)",
    });
    const result = spawnAgentSync(
      { prompt: "p", model: "sonnet", allowedTools: "Read" },
      { spawnFn: fn, isRateLimitedFn: NEVER_LIMITED },
    );
    expect(result.infraUnavailable).toBe(true);
    expect(result.infraReason).toBe("rate-limit");
  });

  it("flags infraUnavailable for a rate-limit notice on STDERR", () => {
    const { fn } = makeFakeSpawn({ status: 1, stderr: "You've hit your usage limit" });
    const result = spawnAgentSync(
      { prompt: "p", model: "sonnet", allowedTools: "Read" },
      { spawnFn: fn, isRateLimitedFn: NEVER_LIMITED },
    );
    expect(result.infraUnavailable).toBe(true);
    expect(result.infraReason).toBe("rate-limit");
  });

  it("flags infraUnavailable for blank stdout+stderr on failure (silent infra shutdown)", () => {
    const { fn } = makeFakeSpawn({ status: 1, stdout: "", stderr: "" });
    const result = spawnAgentSync(
      { prompt: "p", model: "sonnet", allowedTools: "Read" },
      { spawnFn: fn, isRateLimitedFn: NEVER_LIMITED },
    );
    expect(result.infraUnavailable).toBe(true);
    expect(result.infraReason).toBe("no-output");
  });

  it("flags infraUnavailable for a credit-pool/quota/overloaded notice", () => {
    const { fn } = makeFakeSpawn({ status: 1, stdout: "The monthly credit pool is exhausted, try later" });
    const result = spawnAgentSync(
      { prompt: "p", model: "sonnet", allowedTools: "Read" },
      { spawnFn: fn, isRateLimitedFn: NEVER_LIMITED },
    );
    expect(result.infraUnavailable).toBe(true);
    expect(result.infraReason).toBe("quota");
  });

  it("flags infraUnavailable/network for a DNS resolution error surfaced via raw.error.code (ENOTFOUND)", () => {
    const { fn } = makeFakeSpawn({ status: null, stdout: "", stderr: "", error: { code: "ENOTFOUND" } });
    const result = spawnAgentSync(
      { prompt: "p", model: "sonnet", allowedTools: "Read" },
      { spawnFn: fn, isRateLimitedFn: NEVER_LIMITED },
    );
    expect(result.success).toBe(false);
    expect(result.infraUnavailable).toBe(true);
    expect(result.infraReason).toBe("network");
    expect(result.errorCode).toBe("ENOTFOUND");
  });

  it("flags infraUnavailable/network for \"Can't reach the API server\" on STDOUT with non-blank output " +
    "(REGRESSION — before this slice this text matched NO infra pattern and fell through to a generic task failure)", () => {
    const { fn } = makeFakeSpawn({
      status: 1,
      stdout: "Error: Can't reach the API server. Please check your network connection.",
    });
    const result = spawnAgentSync(
      { prompt: "p", model: "sonnet", allowedTools: "Read" },
      { spawnFn: fn, isRateLimitedFn: NEVER_LIMITED },
    );
    expect(result.success).toBe(false);
    expect(result.infraUnavailable).toBe(true);
    expect(result.infraReason).toBe("network");
  });
});

// ============================================================================
// spawnAgentSync — pre-spawn rate-limit gate (DI override)
// ============================================================================

describe("spawnAgentSync — pre-spawn rate-limit gate (injected isRateLimitedFn)", () => {
  it("gates before spawning when isRateLimited() returns true — spawnFn is never called", () => {
    const { fn, calls } = makeFakeSpawn({ status: 0 });
    const result = spawnAgentSync(
      { prompt: "p", model: "sonnet", allowedTools: "Read" },
      { spawnFn: fn, isRateLimitedFn: () => true },
    );
    expect(result.preSpawnGated).toBe(true);
    expect(result.infraUnavailable).toBe(true);
    expect(result.success).toBe(false);
    expect(result.exitCode).toBe(-1);
    expect(calls).toHaveLength(0);
  });

  it("skipRateLimitGate bypasses the gate even when isRateLimited() would return true", () => {
    const { fn, calls } = makeFakeSpawn({ status: 0 });
    const result = spawnAgentSync(
      { prompt: "p", model: "sonnet", allowedTools: "Read", skipRateLimitGate: true },
      { spawnFn: fn, isRateLimitedFn: () => true },
    );
    expect(result.preSpawnGated).toBe(false);
    expect(result.success).toBe(true);
    expect(calls).toHaveLength(1);
  });
});

// ============================================================================
// spawnAgentSync — pre-spawn rate-limit gate (real RateLimitGuard + KAYA_HOME fixture)
// ============================================================================

describe("spawnAgentSync — pre-spawn rate-limit gate (real RateLimitGuard, no DI override)", () => {
  let tmpHome: string;
  const originalKayaHome = process.env.KAYA_HOME;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), "agentspawner-ratelimit-"));
    process.env.KAYA_HOME = tmpHome;
  });

  afterEach(() => {
    if (originalKayaHome === undefined) delete process.env.KAYA_HOME;
    else process.env.KAYA_HOME = originalKayaHome;
    try {
      rmSync(tmpHome, { recursive: true, force: true });
    } catch {
      // best effort
    }
  });

  it("gates the spawn when the real rate-limits.json fixture is over threshold", () => {
    MEMORY.state.rateLimits.write({
      fiveHour: { usedPercentage: 95, resetsAt: new Date(Date.now() + 3_600_000).toISOString() },
      sevenDay: null,
      updatedAt: new Date().toISOString(),
    });

    const { fn, calls } = makeFakeSpawn({ status: 0 });
    const result = spawnAgentSync({ prompt: "p", model: "sonnet", allowedTools: "Read" }, { spawnFn: fn });

    expect(result.preSpawnGated).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it("does not gate the spawn when the real rate-limits.json fixture is under threshold", () => {
    MEMORY.state.rateLimits.write({
      fiveHour: { usedPercentage: 10, resetsAt: new Date(Date.now() + 3_600_000).toISOString() },
      sevenDay: null,
      updatedAt: new Date().toISOString(),
    });

    const { fn, calls } = makeFakeSpawn({ status: 0 });
    const result = spawnAgentSync({ prompt: "p", model: "sonnet", allowedTools: "Read" }, { spawnFn: fn });

    expect(result.preSpawnGated).toBe(false);
    expect(calls).toHaveLength(1);
  });
});

// ============================================================================
// isInfraUnavailable — pure classification
// ============================================================================

describe("isInfraUnavailable (pure classification)", () => {
  const base = { success: false, stdout: "", stderr: "", timedOut: false, preSpawnGated: false };

  it("is false when success is true, regardless of other fields", () => {
    expect(isInfraUnavailable({ ...base, success: true, timedOut: true })).toBe(false);
  });

  it("is true when preSpawnGated is true", () => {
    expect(isInfraUnavailable({ ...base, preSpawnGated: true })).toBe(true);
  });

  it("is true when timedOut is true, with infraReason 'timeout'", () => {
    expect(isInfraUnavailable({ ...base, timedOut: true })).toBe(true);
    expect(classifyInfraReason({ ...base, timedOut: true })).toBe("timeout");
  });

  it("is true on blank stdout+stderr with a failure, with infraReason 'no-output'", () => {
    expect(isInfraUnavailable({ ...base })).toBe(true);
    expect(classifyInfraReason({ ...base })).toBe("no-output");
  });

  it("is false for a genuine failure with real diagnostic output", () => {
    expect(isInfraUnavailable({ ...base, stdout: "SyntaxError: unexpected token" })).toBe(false);
    expect(classifyInfraReason({ ...base, stdout: "SyntaxError: unexpected token" })).toBeUndefined();
  });

  it("is true (infraReason 'network') for an ENOTFOUND errorCode, even with blank stdout+stderr", () => {
    expect(isInfraUnavailable({ ...base, errorCode: "ENOTFOUND" })).toBe(true);
    expect(classifyInfraReason({ ...base, errorCode: "ENOTFOUND" })).toBe("network");
  });

  it("is true (infraReason 'network') for \"Can't reach the API server\" text with non-blank output " +
    "(REGRESSION — before this slice this text matched NO infra pattern, i.e. isInfraUnavailable returned false)", () => {
    const stdout = "Error: Can't reach the API server. Please check your network connection.";
    expect(isInfraUnavailable({ ...base, stdout })).toBe(true);
    expect(classifyInfraReason({ ...base, stdout })).toBe("network");
  });

  it("is true (infraReason 'rate-limit') for rate/usage/session-limit wording", () => {
    const stdout = "You've hit your limit · resets 11:50pm (America/Los_Angeles)";
    expect(isInfraUnavailable({ ...base, stdout })).toBe(true);
    expect(classifyInfraReason({ ...base, stdout })).toBe("rate-limit");
  });

  it("is true (infraReason 'quota') for credit/pool/quota wording", () => {
    const stdout = "The monthly credit pool is exhausted, try later";
    expect(isInfraUnavailable({ ...base, stdout })).toBe(true);
    expect(classifyInfraReason({ ...base, stdout })).toBe("quota");
  });
});

// ============================================================================
// spawnAgent (async) — worktree resolution
// ============================================================================

describe("spawnAgent (async) — worktree resolution", () => {
  it("prefers an explicit cwd over worktree resolution (getOrCreateWorktreeFn is never called)", async () => {
    const { fn, calls } = makeFakeSpawn({ status: 0 });
    let worktreeFnCalled = false;
    const fakeGetOrCreateWorktree: GetOrCreateWorktreeFn = async (o) => {
      worktreeFnCalled = true;
      return {
        path: "/should/not/be/used",
        branch: o.branch,
        repoRoot: o.repoRoot,
        createdAt: new Date().toISOString(),
        createdBy: o.createdBy,
        locked: true,
      };
    };

    const result = await spawnAgent(
      {
        prompt: "p",
        model: "sonnet",
        allowedTools: "Read",
        cwd: "/explicit/cwd",
        worktree: { repoRoot: "/tmp/repo", branch: "b", createdBy: "x" },
      },
      { spawnFn: fn, isRateLimitedFn: NEVER_LIMITED, getOrCreateWorktreeFn: fakeGetOrCreateWorktree },
    );

    expect(worktreeFnCalled).toBe(false);
    expect(result.success).toBe(true);
    expect(calls[0].opts.cwd).toBe("/explicit/cwd");
  });

  it("resolves cwd via an injected getOrCreateWorktreeFn when no explicit cwd is given", async () => {
    const { fn, calls } = makeFakeSpawn({ status: 0 });
    const fakeGetOrCreateWorktree: GetOrCreateWorktreeFn = async (o) => ({
      path: "/fake/worktree/path",
      branch: o.branch,
      repoRoot: o.repoRoot,
      createdAt: new Date().toISOString(),
      createdBy: o.createdBy,
      locked: true,
    });

    const result = await spawnAgent(
      { prompt: "p", model: "sonnet", allowedTools: "Read", worktree: { repoRoot: "/tmp/repo", branch: "b", createdBy: "x" } },
      { spawnFn: fn, isRateLimitedFn: NEVER_LIMITED, getOrCreateWorktreeFn: fakeGetOrCreateWorktree },
    );

    expect(result.success).toBe(true);
    expect(calls[0].opts.cwd).toBe("/fake/worktree/path");
  });
});

describe("spawnAgent (async) — real git worktree, fake process spawn", () => {
  const TEST_REPO = join(tmpdir(), `agentspawner-wt-test-${Date.now()}`);

  function setupTestRepo(): void {
    mkdirSync(TEST_REPO, { recursive: true });
    execFileSync("git", ["init"], { cwd: TEST_REPO, stdio: "pipe" });
    execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: TEST_REPO, stdio: "pipe" });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: TEST_REPO, stdio: "pipe" });
    execFileSync("git", ["commit", "--allow-empty", "-m", "init"], { cwd: TEST_REPO, stdio: "pipe" });
  }

  afterAll(() => {
    try {
      rmSync(join(worktreesDir(), repoSlug(TEST_REPO)), { recursive: true, force: true });
    } catch {
      // best effort
    }
    try {
      if (existsSync(TEST_REPO)) rmSync(TEST_REPO, { recursive: true, force: true });
    } catch {
      // best effort
    }
  });

  it("resolves cwd from a REAL worktree and passes it to the injected spawn fn (no real claude process spawned)", async () => {
    setupTestRepo();
    const { fn, calls } = makeFakeSpawn({ status: 0 });

    const result = await spawnAgent(
      {
        prompt: "hello",
        model: "sonnet",
        allowedTools: "Read",
        worktree: { repoRoot: TEST_REPO, branch: "agentspawner-smoke", createdBy: "agentspawner-test" },
      },
      { spawnFn: fn, isRateLimitedFn: NEVER_LIMITED },
    );

    expect(result.success).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].opts.cwd).toContain("agentspawner-smoke");
    expect(existsSync(calls[0].opts.cwd)).toBe(true);

    await removeWorktree(calls[0].opts.cwd);
  });
});

// ============================================================================
// parseVerdictBlock
// ============================================================================

describe("parseVerdictBlock", () => {
  const TAGS = { start: "VERDICT_START", end: "VERDICT_END" };

  it("parses a well-formed JSON block between tags", () => {
    const out = 'preamble\nVERDICT_START\n{"summary":"did the thing","count":3}\nVERDICT_END\npostamble';
    const parsed = parseVerdictBlock(out, TAGS);
    expect(parsed).toEqual({ summary: "did the thing", count: 3 });
  });

  it("returns null when the start tag is missing", () => {
    expect(parseVerdictBlock('{"summary":"x"}\nVERDICT_END', TAGS)).toBeNull();
  });

  it("returns null when the end tag is missing", () => {
    expect(parseVerdictBlock('VERDICT_START\n{"summary":"x"}', TAGS)).toBeNull();
  });

  it("returns null on empty output", () => {
    expect(parseVerdictBlock("", TAGS)).toBeNull();
  });

  it("returns null when the block between tags is empty/whitespace", () => {
    expect(parseVerdictBlock("VERDICT_START\n   \nVERDICT_END", TAGS)).toBeNull();
  });

  it("returns null on malformed JSON — never a default or partial result", () => {
    expect(parseVerdictBlock("VERDICT_START\n{summary: x}\nVERDICT_END", TAGS)).toBeNull();
  });

  it("validates against a supplied Zod schema and returns the typed value on success", () => {
    const schema = z.object({ summary: z.string(), artifacts: z.array(z.string()).default([]) });
    const out = 'VERDICT_START\n{"summary":"ok","artifacts":["a.md"]}\nVERDICT_END';
    expect(parseVerdictBlock(out, TAGS, schema)).toEqual({ summary: "ok", artifacts: ["a.md"] });
  });

  it("returns null when the parsed object fails schema validation", () => {
    const schema = z.object({ summary: z.string() });
    const out = 'VERDICT_START\n{"notSummary":"ok"}\nVERDICT_END';
    expect(parseVerdictBlock(out, TAGS, schema)).toBeNull();
  });

  it("without a schema, returns whatever valid JSON was parsed (e.g. an array)", () => {
    const parsed = parseVerdictBlock("VERDICT_START\n[1,2,3]\nVERDICT_END", TAGS);
    expect(parsed).toEqual([1, 2, 3]);
  });
});

// ============================================================================
// Public API surface smoke test
// ============================================================================

describe("AgentSpawner exports", () => {
  it("exports the expected public functions", () => {
    expect(typeof spawnAgentSync).toBe("function");
    expect(typeof spawnAgent).toBe("function");
    expect(typeof isInfraUnavailable).toBe("function");
    expect(typeof parseVerdictBlock).toBe("function");
  });
});
