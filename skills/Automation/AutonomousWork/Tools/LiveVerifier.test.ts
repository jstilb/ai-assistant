/**
 * LiveVerifier.test.ts — Slice 1 tests for the live-verification Explorer engine.
 *
 * Unit-tests use an injected `runExplorer` (no real `claude -p` spawn) and injected
 * `now` + `writeTranscript` for determinism.
 */

import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import {
  runLiveVerification,
  buildExplorerPrompt,
  parseExplorerOutput,
  LIVE_BUDGETS,
  type LiveVerifierInput,
  type ExplorerRunResult,
} from "./LiveVerifier.ts";

// This file exercises the Explorer engine specifically. Pin the mode so the
// context-aware default (self-verify when CLAUDECODE is set, e.g. when these
// tests run inside an interactive session) does not reroute the engine.
let _prevMode: string | undefined;
beforeAll(() => {
  _prevMode = process.env.KAYA_LIVE_VERIFY_MODE;
  process.env.KAYA_LIVE_VERIFY_MODE = "explorer";
});
afterAll(() => {
  if (_prevMode === undefined) delete process.env.KAYA_LIVE_VERIFY_MODE;
  else process.env.KAYA_LIVE_VERIFY_MODE = _prevMode;
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function baseInput(overrides: Partial<LiveVerifierInput> = {}): LiveVerifierInput {
  return {
    itemId: "item-123",
    surface: "cli",
    effort: "STANDARD",
    workingDir: "/tmp/worktree",
    specExcerpt: "The `greet` CLI prints 'Hello, <name>' and exits 0.",
    diffPaths: ["bin/greet.ts"],
    ...overrides,
  };
}

/** Build a fake explorer that returns a fenced JSON block. */
function fakeExplorer(payload: unknown, opts: Partial<ExplorerRunResult> = {}) {
  const stdout =
    "I ran the artifact. Here are the results:\n\n```json\n" +
    JSON.stringify(payload) +
    "\n```\n";
  const calls: Array<{ prompt: string; cwd: string; timeoutMs: number }> = [];
  const fn = (prompt: string, o: { cwd: string; timeoutMs: number }): ExplorerRunResult => {
    calls.push({ prompt, ...o });
    return { success: true, stdout, stderr: "", exitCode: 0, timedOut: false, ...opts };
  };
  return { fn, calls };
}

function captureTranscript() {
  const writes: Array<{ path: string; data: string }> = [];
  return {
    writes,
    writeTranscript: (path: string, data: string) => {
      writes.push({ path, data });
    },
  };
}

// ---------------------------------------------------------------------------
// LIVE_BUDGETS scaling
// ---------------------------------------------------------------------------

describe("LIVE_BUDGETS", () => {
  test("scenario count and time budget increase monotonically with effort", () => {
    const order = ["TRIVIAL", "QUICK", "STANDARD", "THOROUGH", "DETERMINED"] as const;
    for (let i = 1; i < order.length; i++) {
      const prev = LIVE_BUDGETS[order[i - 1]];
      const cur = LIVE_BUDGETS[order[i]];
      expect(cur.scenarios).toBeGreaterThanOrEqual(prev.scenarios);
      expect(cur.timeBudgetMs).toBeGreaterThanOrEqual(prev.timeBudgetMs);
    }
    // Strict growth at the extremes — complexity must materially change depth.
    expect(LIVE_BUDGETS.DETERMINED.scenarios).toBeGreaterThan(LIVE_BUDGETS.TRIVIAL.scenarios);
    expect(LIVE_BUDGETS.DETERMINED.timeBudgetMs).toBeGreaterThan(LIVE_BUDGETS.TRIVIAL.timeBudgetMs);
    expect(LIVE_BUDGETS.TRIVIAL.scenarios).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// buildExplorerPrompt
// ---------------------------------------------------------------------------

describe("buildExplorerPrompt", () => {
  test("CLI prompt embeds the spec, the CLI recipe, and the effort budget numbers", () => {
    const prompt = buildExplorerPrompt(baseInput({ effort: "STANDARD" }));
    expect(prompt).toContain("greet"); // spec excerpt
    expect(prompt.toLowerCase()).toContain("cli"); // recipe selected
    // budget numbers surfaced so the agent scales exploration
    expect(prompt).toContain(String(LIVE_BUDGETS.STANDARD.scenarios));
    // must instruct ACTUAL execution, not test-running
    expect(prompt.toLowerCase()).toContain("actually run");
    // must demand the structured JSON block back
    expect(prompt).toContain("```json");
  });

  test("DETERMINED prompt asks for more scenarios than TRIVIAL", () => {
    const trivial = buildExplorerPrompt(baseInput({ effort: "TRIVIAL" }));
    const determined = buildExplorerPrompt(baseInput({ effort: "DETERMINED" }));
    expect(trivial).toContain(String(LIVE_BUDGETS.TRIVIAL.scenarios));
    expect(determined).toContain(String(LIVE_BUDGETS.DETERMINED.scenarios));
  });

  test("forbids dry-run/synthetic paths and demands post-state assertion for state-change ISC (Fix #2)", () => {
    const prompt = buildExplorerPrompt(baseInput({ effort: "STANDARD" }));
    const lower = prompt.toLowerCase();
    // explicitly names the dry-run/synthetic anti-pattern as non-evidence
    expect(lower).toContain("dry-run");
    expect(lower).toContain("synthetic");
    // demands a real post-state assertion (mtime / exit code / log line)
    expect(lower).toContain("post-state");
    expect(lower).toContain("mtime");
    // must forbid PASS without an observed real side effect
    expect(lower).toContain("no real side effect exercised");
  });
});

// ---------------------------------------------------------------------------
// parseExplorerOutput
// ---------------------------------------------------------------------------

describe("parseExplorerOutput", () => {
  test("extracts the last fenced json block", () => {
    const out =
      "```json\n{\"scenarios\":[],\"verdict\":\"FAIL\"}\n```\n" +
      "final answer:\n```json\n{\"scenarios\":[{\"id\":\"s1\",\"kind\":\"happy\",\"verdict\":\"PASS\"}],\"verdict\":\"PASS\"}\n```";
    const parsed = parseExplorerOutput(out);
    expect(parsed?.verdict).toBe("PASS");
    expect(parsed?.scenarios).toHaveLength(1);
  });

  test("returns null when no parseable json present", () => {
    expect(parseExplorerOutput("I could not run anything, sorry.")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// runLiveVerification — core behavior
// ---------------------------------------------------------------------------

describe("runLiveVerification", () => {
  test("native surface short-circuits to HUMAN_REQUIRED without spawning an explorer", async () => {
    let called = false;
    const result = await runLiveVerification(baseInput({ surface: "native" }), {
      runExplorer: () => {
        called = true;
        return { success: true, stdout: "", stderr: "", exitCode: 0, timedOut: false };
      },
    });
    expect(called).toBe(false);
    expect(result.verdict).toBe("HUMAN_REQUIRED");
    expect(result.humanVerificationRequired).toBe(true);
    expect(result.noEvidence).toBe(false); // a legitimate disposition, not missing evidence
    expect(result.warnings.join(" ").toLowerCase()).toContain("device");
  });

  test("all PASS scenarios → verdict PASS, counts populated, transcript persisted", async () => {
    const explorer = fakeExplorer({
      verdict: "PASS",
      scenarios: [
        { id: "s1", kind: "happy", description: "greet Alice", command: "greet Alice", expected: "Hello, Alice", observed: "Hello, Alice", exitCode: 0, verdict: "PASS" },
        { id: "s2", kind: "edge", description: "empty name", command: "greet ''", expected: "usage error", observed: "usage error", exitCode: 1, verdict: "PASS" },
        { id: "s3", kind: "error", description: "too many args", command: "greet a b", expected: "error", observed: "error", exitCode: 1, verdict: "PASS" },
      ],
    });
    const tx = captureTranscript();
    const result = await runLiveVerification(baseInput(), {
      runExplorer: explorer.fn,
      writeTranscript: tx.writeTranscript,
      now: () => 1000,
      persistDir: "/tmp/lv",
    });

    expect(result.verdict).toBe("PASS");
    expect(result.scenariosRun).toBe(3);
    expect(result.scenariosPassed).toBe(3);
    expect(result.scenariosFailed).toBe(0);
    expect(result.edgeCasesExplored).toBe(2); // edge + error
    expect(result.noEvidence).toBe(false);
    expect(tx.writes).toHaveLength(1);
    expect(tx.writes[0].path).toContain("item-123");
    expect(result.transcriptPath).toBe(tx.writes[0].path);
  });

  test("any FAIL scenario → verdict FAIL even if explorer self-reports PASS", async () => {
    const explorer = fakeExplorer({
      verdict: "PASS", // explorer lies/optimistic
      scenarios: [
        { id: "s1", kind: "happy", description: "greet", expected: "Hello", observed: "TypeError", exitCode: 1, verdict: "FAIL" },
      ],
    });
    const result = await runLiveVerification(baseInput(), { runExplorer: explorer.fn, writeTranscript: () => {} });
    expect(result.verdict).toBe("FAIL");
    expect(result.scenariosFailed).toBe(1);
  });

  test("no parseable evidence → noEvidence true and hard FAIL (explorer was still invoked)", async () => {
    let called = false;
    const result = await runLiveVerification(baseInput(), {
      runExplorer: () => {
        called = true;
        return { success: true, stdout: "I was unable to run it.", stderr: "", exitCode: 0, timedOut: false };
      },
      writeTranscript: () => {},
    });
    expect(called).toBe(true);
    expect(result.noEvidence).toBe(true);
    expect(result.verdict).toBe("FAIL");
  });

  test("explorer timeout → FAIL with a timeout warning (real AgentSpawner shape: infraUnavailable also true)", async () => {
    // AgentSpawner.isInfraUnavailable() always sets infraUnavailable=true when
    // timedOut=true (`if (res.preSpawnGated || res.timedOut) return true;` in
    // lib/core/AgentSpawner.ts), so a real spawn NEVER produces {timedOut:true}
    // alone — omitting infraUnavailable here would give false assurance that
    // timeouts don't trip environmentBlocked without exercising the actual bug.
    const result = await runLiveVerification(baseInput(), {
      runExplorer: () => ({
        success: false,
        stdout: "",
        stderr: "",
        exitCode: 124,
        timedOut: true,
        infraUnavailable: true,
      }),
      writeTranscript: () => {},
    });
    expect(result.verdict).toBe("FAIL");
    expect(result.environmentBlocked).toBeFalsy();
    expect(result.warnings.join(" ").toLowerCase()).toContain("timeout");
  });

  test("passes the effort time budget through to the explorer call", async () => {
    const explorer = fakeExplorer({ verdict: "PASS", scenarios: [{ id: "s1", kind: "happy", verdict: "PASS" }] });
    await runLiveVerification(baseInput({ effort: "TRIVIAL" }), { runExplorer: explorer.fn, writeTranscript: () => {} });
    expect(explorer.calls[0].timeoutMs).toBe(LIVE_BUDGETS.TRIVIAL.timeBudgetMs);
    expect(explorer.calls[0].cwd).toBe("/tmp/worktree");
  });

  // -------------------------------------------------------------------------
  // B3 FIX ROUND — FIX 1: infra-blocked explorer runs must not be recorded
  // as a code-blaming FAIL. AgentSpawner reports these via
  // AgentSpawnResult.infraUnavailable / .preSpawnGated; LiveVerifier must map
  // them onto its existing "could not run" semantics (environmentBlocked),
  // same as SelfVerifyRunner already does for "nothing allowlisted to run".
  // -------------------------------------------------------------------------

  test("pre-spawn rate-limit gated explorer result → environmentBlocked, NOT a blamed code FAIL", async () => {
    const result = await runLiveVerification(baseInput(), {
      runExplorer: () => ({
        success: false,
        stdout: "",
        stderr: "",
        exitCode: -1,
        timedOut: false,
        infraUnavailable: true,
        preSpawnGated: true,
      }),
      writeTranscript: () => {},
    });
    expect(result.environmentBlocked).toBe(true);
    expect(result.mode).toBe("explorer");
    expect(result.warnings.join(" ").toLowerCase()).toMatch(/rate-limit|infrastructure/);
  });

  test("post-spawn infra-unavailable (rate-limit output detected, not pre-spawn-gated) → environmentBlocked", async () => {
    const result = await runLiveVerification(baseInput(), {
      runExplorer: () => ({
        success: false,
        stdout: "You've hit your limit · resets 3pm",
        stderr: "",
        exitCode: 1,
        timedOut: false,
        infraUnavailable: true,
        preSpawnGated: false,
      }),
      writeTranscript: () => {},
    });
    expect(result.environmentBlocked).toBe(true);
  });

  test("a real explorer process failure (no infra signal) still hard-FAILs as before — not environmentBlocked", async () => {
    const result = await runLiveVerification(baseInput(), {
      runExplorer: () => ({
        success: false,
        stdout: "",
        stderr: "some genuine crash",
        exitCode: 1,
        timedOut: false,
      }),
      writeTranscript: () => {},
    });
    expect(result.environmentBlocked).toBeFalsy();
    expect(result.verdict).toBe("FAIL");
    expect(result.noEvidence).toBe(true);
  });

  // -------------------------------------------------------------------------
  // B3 FIX ROUND 2 — REGRESSION FIX: a pure timeout must NOT be re-labeled
  // environmentBlocked. AgentSpawner.isInfraUnavailable() folds timedOut into
  // infraUnavailable (rate-limit-signal classification), so a REAL spawn
  // timeout always produces {timedOut:true, infraUnavailable:true}. Before this
  // fix, LiveVerifier's `environmentBlocked = preSpawnGated || infraUnavailable`
  // treated that shape as environment-blocked — a genuinely hanging explorer
  // (exactly what Phase L must hard-FAIL) re-staged as "environment blocked...
  // work may be fine" without ever consuming a retry, up to 8 cooldown loops
  // (WorkOrchestrator.ts). The fix: environmentBlocked = preSpawnGated ||
  // (infraUnavailable && !timedOut) — a timeout always falls through to the
  // pre-existing noEvidence hard-FAIL path (PhaseL.ts noEvidence handling).
  // -------------------------------------------------------------------------

  test("REGRESSION: realistic spawn-timeout shape {timedOut:true, infraUnavailable:true, preSpawnGated:false} must NOT be environmentBlocked", async () => {
    const result = await runLiveVerification(baseInput(), {
      runExplorer: () => ({
        success: false,
        stdout: "",
        stderr: "",
        exitCode: -1,
        timedOut: true,
        infraUnavailable: true,
        preSpawnGated: false,
      }),
      writeTranscript: () => {},
    });
    // The timeout must keep PRE-FIX behavior: normal noEvidence hard-FAIL,
    // never silently re-staged as an infra/environment condition.
    expect(result.environmentBlocked).toBe(false);
    expect(result.verdict).toBe("FAIL");
    expect(result.noEvidence).toBe(true);
    expect(result.warnings.join(" ").toLowerCase()).toContain("timeout");
  });
});
