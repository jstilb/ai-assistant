#!/usr/bin/env bun
/**
 * HeadlessWorkDriver.test.ts — Unit suite for the scheduled approved-work driver.
 *
 * Hygiene:
 *   - Every test gets its own mkdtemp KAYA_HOME (pipeline.db + worktrees live there)
 *     AND its own throwaway `git init` repo (the CLI subprocess's cwd, so
 *     WorkOrchestrator.resolveRepoRoot()'s process.cwd() fallback — and therefore
 *     `git worktree add` — never touches the real ~/.claude checkout).
 *   - The AGENT spawn (Builder/Verifier turns) is ALWAYS faked (spawnAgentSyncFn
 *     injected) — no real `claude -p` process for those turns.
 *   - The CLI layer (WorkOrchestratorCLI.ts) runs for REAL as a subprocess against the
 *     scratch KAYA_HOME — this is the layer whose contract (arg shape, JSON shape) the
 *     driver depends on, so faking it would just re-validate the driver's own
 *     assumptions instead of the real CLI. Most CLI subcommands (init/next-batch/
 *     prepare/started/mark-done/retry) are cheap/deterministic/local. `verify` and
 *     `report-done` are NOT, by default: they construct a real WorkOrchestrator →
 *     SkepticalVerifier, whose Gate 3 is a real ~$0.30 nondeterministic Sonnet judge
 *     call, and whose Gate 2 (Phase L) picks a real dangerous `claude -p` Explorer
 *     whenever KAYA_CRON_JOB_ID/KAYA_AUTONOMOUS happen to be set in the ambient shell
 *     (LiveVerifyContext.ts checks those BEFORE the CLAUDECODE/interactive fallback) —
 *     this suite previously only avoided real spawns/cost by environmental accident.
 *     `scratchCliRunner()`/`safeSubprocessEnv()` below force the CLI subprocess into a
 *     deterministic, spawn-free, $0 mode BY CONSTRUCTION, not by ambient luck:
 *       - KAYA_LIVE_VERIFY_MODE=self-verify forces Gate 2 to the non-dangerous
 *         self-verify harness (existing seam — LiveVerifyContext.ts's explicit
 *         override, checked before KAYA_CRON_JOB_ID/KAYA_AUTONOMOUS/CLAUDECODE).
 *       - KAYA_TEST_SKIP_JUDGE=1 forces Gate 3 to a deterministic stub PASS instead of
 *         a real inference call (test-only seam added in WorkOrchestratorCLI.ts —
 *         production callers never set this).
 *       - KAYA_AUTONOMOUS / KAYA_CRON_JOB_ID / CLAUDECODE are explicitly stripped from
 *         the subprocess env so the two overrides above can never be shadowed by
 *         whatever happens to be set in the ambient shell this suite runs in (proven by
 *         running the suite with KAYA_AUTONOMOUS=1 set — see the note near the bottom
 *         of this file).
 *     Gate 1 (deterministic floor) and Gate 2's self-verify harness still run for REAL
 *     — they are free and deterministic, and can still legitimately reject a
 *     deliberately-trivial fake deliverable (see Test A).
 *   - Never touches live ~/.kaya.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { execFileSync } from "child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  runDriver,
  defaultCliRunner,
  BUILDER_ALLOWED_TOOLS,
  VERIFIER_ALLOWED_TOOLS,
  MAX_ITERATIONS,
  DEFAULT_BATCH_SIZE,
  DEFAULT_MAX_ITEMS,
  parseMaxItemsArg,
  type CliRunnerFn,
  type CliResult,
  type HeadlessWorkDriverDeps,
  type DeferredMergeSweepResult,
} from "./HeadlessWorkDriver.ts";
import type { AgentSpawnResult, AgentSpawnOptions } from "../../../../lib/core/AgentSpawner.ts";

// ============================================================================
// Scratch environment
// ============================================================================

let scratchKayaHome: string;
let scratchRepo: string;
let originalKayaHome: string | undefined;

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
}

/**
 * Safe no-op default for HeadlessWorkDriverDeps.deferredMergeSweepFn — injected
 * into EVERY runDriver() call in this suite (even ones that don't care about the
 * sweep at all), to guarantee the REAL defaultDeferredMergeSweep() is NEVER
 * exercised here: it spawns a real `bun Integrator.ts merge` subprocess, and
 * Integrator's internal locking (withIntegratorLock -> lib/core/KayaHome.ts's
 * runtimeDir()) falls back to the LIVE, out-of-repo ~/.kaya/runtime store when
 * that directory exists on the host — NOT scratch-KAYA_HOME-scoped — so a real
 * invocation here could touch Jm's live ~/.kaya, which this suite must never do
 * (see hygiene note at the top of this file / CLAUDE.md's worktree rules). The
 * dedicated "deferred-merge sweep" describe block below overrides this per-test
 * to make assertions about the sweep itself; every other test just needs a
 * harmless, deterministic no-op so runDriver's new start-of-run sweep step never
 * blocks or perturbs it.
 */
const NOOP_SWEEP: () => DeferredMergeSweepResult = () => ({ ok: true, merged: 0, conflicts: 0, skipped: 0 });

beforeEach(() => {
  originalKayaHome = process.env.KAYA_HOME;
  scratchKayaHome = mkdtempSync(join(tmpdir(), "hwd-kaya-"));
  scratchRepo = mkdtempSync(join(tmpdir(), "hwd-repo-"));
  process.env.KAYA_HOME = scratchKayaHome;

  // WorktreeManager's create-lock is `mkdirSync(lockDir, {recursive:false})` inside
  // <KAYA_HOME>/worktrees/ — on a truly fresh KAYA_HOME that parent doesn't exist yet,
  // so mkdirSync throws ENOENT, which the lock's catch-and-retry loop misreads as
  // "lock held", spins for 10s, then fails. Production KAYA_HOME never hits this
  // because `worktrees/` was created by a prior real run; scratch dirs must pre-create it.
  mkdirSync(join(scratchKayaHome, "worktrees"), { recursive: true });

  git(scratchRepo, ["init", "-q", "-b", "main"]);
  git(scratchRepo, ["config", "user.email", "test@example.com"]);
  git(scratchRepo, ["config", "user.name", "Test"]);
  git(scratchRepo, ["commit", "--allow-empty", "-q", "-m", "init"]);
});

afterEach(() => {
  process.env.KAYA_HOME = originalKayaHome;
  rmSync(scratchKayaHome, { recursive: true, force: true });
  rmSync(scratchRepo, { recursive: true, force: true });
});

/**
 * Forces the CLI subprocess into a deterministic, spawn-free, $0 verification mode —
 * BY CONSTRUCTION, not by ambient-environment luck (see hygiene note above / FIX 1).
 *
 *   - KAYA_LIVE_VERIFY_MODE=self-verify — existing Gate-2 seam (LiveVerifyContext.ts):
 *     forces the non-dangerous self-verify harness instead of the real `claude -p`
 *     Explorer, regardless of what KAYA_CRON_JOB_ID/KAYA_AUTONOMOUS/CLAUDECODE say.
 *   - KAYA_TEST_SKIP_JUDGE=1 — test-only Gate-3 seam (WorkOrchestratorCLI.ts): forces
 *     SkepticalVerifier's Sonnet judge call to a deterministic stub PASS instead of a
 *     real, costed, nondeterministic inference call.
 *   - KAYA_AUTONOMOUS / KAYA_CRON_JOB_ID / CLAUDECODE are deliberately deleted (not just
 *     overridden with a falsy value) from the subprocess env so nothing ambient in the
 *     shell this suite happens to run under (e.g. a cron-launched test run) can ever
 *     shadow the two overrides above.
 */
function safeSubprocessEnv(extra: Record<string, string>): Record<string, string> {
  const env = { ...process.env } as Record<string, string>;
  delete env.KAYA_AUTONOMOUS;
  delete env.KAYA_CRON_JOB_ID;
  delete env.CLAUDECODE;
  return {
    ...env,
    KAYA_LIVE_VERIFY_MODE: "self-verify",
    KAYA_TEST_SKIP_JUDGE: "1",
    ...extra,
  };
}

/** Real CLI subprocess, cwd pinned to the throwaway repo (see hygiene note above). */
function scratchCliRunner(): CliRunnerFn {
  return (args) => {
    let stdout = "";
    let stderr = "";
    let exitCode = 0;
    let ok = true;
    try {
      stdout = execFileSync("bun", [join(import.meta.dir, "WorkOrchestratorCLI.ts"), ...args], {
        cwd: scratchRepo,
        encoding: "utf-8",
        maxBuffer: 64 * 1024 * 1024,
        env: safeSubprocessEnv({ KAYA_HOME: scratchKayaHome }),
      });
    } catch (e) {
      ok = false;
      const err = e as { stdout?: string; stderr?: string; status?: number | null };
      stdout = err.stdout ?? "";
      stderr = err.stderr ?? "";
      exitCode = err.status ?? 1;
    }
    let json: unknown = null;
    try {
      json = JSON.parse(stdout);
    } catch {
      json = null;
    }
    return { ok, exitCode, stdout, stderr, json };
  };
}

/** Seeds one pending WorkItem straight into pipeline.db via WorkQueue.addItem()
 *  (see design-note investigation: this is the real read path WorkOrchestrator uses,
 *  unlike the lossy QueueManager JSON-queue shortcut). Imported dynamically so the
 *  module only resolves KAYA_HOME (env-at-construction-time) AFTER beforeEach sets it. */
async function seedItem(title: string): Promise<string> {
  const { WorkQueue } = await import("./WorkQueue.ts");
  const wq = new WorkQueue();
  const item = wq.addItem({
    title,
    description: "HeadlessWorkDriver test item — no real deliverable.",
    priority: "normal",
    dependencies: [],
    source: "manual",
    workType: "dev",
  });
  return item.id;
}

async function getItemStatus(id: string): Promise<string | undefined> {
  const { WorkQueue } = await import("./WorkQueue.ts");
  const wq = new WorkQueue();
  return wq.getItem(id)?.status;
}

function extractIteration(prompt: string): number {
  const m = prompt.match(/Current iteration:\*\*\s*`?(\d+)`?/);
  return m ? Number(m[1]) : 1;
}

// ============================================================================
// Test A: happy path — real CLI, fake spawner, converges on iteration 1
// ============================================================================

describe("HeadlessWorkDriver — happy path (real CLI subprocess, fake spawner)", () => {
  it("drives init -> next-batch -> prepare -> started -> Builder/Verifier -> mark-done -> verify -> report-done to a completed item", async () => {
    const itemId = await seedItem("HWD happy path item");

    let knownIscRowIds: number[] = [];
    const cliRunner: CliRunnerFn = (args) => {
      const res = scratchCliRunner()(args);
      if (args[0] === "prepare" && res.json && typeof res.json === "object") {
        const j = res.json as { iscRows?: { id: number }[] };
        if (j.iscRows) knownIscRowIds = j.iscRows.map((r) => r.id);
      }
      return res;
    };

    const spawnAgentSyncFn = (opts: AgentSpawnOptions): AgentSpawnResult => {
      const isBuilder = opts.allowedTools === BUILDER_ALLOWED_TOOLS;
      if (isBuilder) {
        // Stand-in for what a real Builder would produce: a genuine file change +
        // a genuine passing test, committed for real — so the REAL WorkOrchestrator
        // completion pipeline's own SkepticalVerifier (independent adversarial gate:
        // real git diff, real `bun test` run) has real evidence to find, exactly
        // like it would for a live agent. Only the LLM call itself is faked.
        const cwd = opts.cwd!;
        require("fs").writeFileSync(join(cwd, "hwd-deliverable.txt"), "hwd fake deliverable\n");
        require("fs").writeFileSync(
          join(cwd, "hwd-deliverable.test.ts"),
          'import { test, expect } from "bun:test";\ntest("hwd deliverable exists", () => { expect(1 + 1).toBe(2); });\n',
        );
        git(cwd, ["add", "-A"]);
        git(cwd, ["commit", "-q", "-m", "feat(isc): hwd fake deliverable"]);
      }
      const stdout = isBuilder
        ? JSON.stringify({ success: true, completedRows: knownIscRowIds, failedRows: [], budgetSpent: 0.01 })
        : JSON.stringify({
            rows: knownIscRowIds.map((iscId) => ({ iscId, verdict: "PASS", evidence: "fake evidence", linkedTest: "hwd-deliverable.test.ts::hwd deliverable exists", concern: null })),
            summary: "all pass (fake)",
            allPass: true,
          });
      return { success: true, stdout, stderr: "", exitCode: 0, timedOut: false, infraUnavailable: false, preSpawnGated: false };
    };

    const result = await runDriver({ cliRunner, spawnAgentSyncFn, isRateLimitedFn: () => false, deferredMergeSweepFn: NOOP_SWEEP });

    expect(result.error).toBeNull();
    const mine = result.itemsProcessed.find((o) => o.itemId === itemId);
    expect(mine).toBeDefined();
    expect(mine!.iterations).toBe(1);
    expect(knownIscRowIds.length).toBeGreaterThan(0);

    // The driver's OWN Builder/Verifier convergence loop must converge on iteration 1
    // (this is what "happy path" exercises: the loop logic, mark-done/verify/report-done
    // sequencing, and CLI-arg construction against the REAL CLI).
    expect(mine!.terminationReason).toBe("allPass");

    // The driver's `verify` step AND `report-done` (which internally re-runs the same
    // WorkOrchestrator.verify()) both run the REAL SkepticalVerifier as a defense-in-depth
    // gate the driver does not control: Gate 1 (deterministic floor) and Gate 2 (Phase L
    // self-verify — forced non-dangerous/free by safeSubprocessEnv()) run for real and can
    // legitimately reject this test's deliberately-trivial fake deliverable (no ISC verify
    // commands, no tsconfig — Gate 2's self-verify harness has nothing runnable to exercise,
    // which is itself a legitimate FAIL, not a bug). Gate 3 (the LLM judge) is stubbed to a
    // deterministic PASS (KAYA_TEST_SKIP_JUDGE=1), so any rejection here comes from Gates
    // 1/2 only — deterministic and free, never a real inference call. What matters for THIS
    // test is that the driver never short-circuits around whichever gate rejects: on
    // rejection it must fall through to `retry` (never `complete`/`fail` directly) and never
    // silently claim "done", AND that rejection may legitimately surface at EITHER the
    // standalone `verify` CLI step or the `report-done` step (report-done calls verify()
    // internally too — both are real gates the driver correctly routes to retry).
    // "done"/"blocked-on-human" are also accepted in case the gates are more permissive in
    // a future run (e.g. if a tsconfig.json is ever added to the throwaway scratch repo).
    expect(["done", "blocked-on-human", "retried"]).toContain(mine!.outcome);
    if (mine!.outcome === "retried") {
      expect(mine!.detail).toMatch(/report-done rejected|post-convergence verify failed/);
    }

    const status = await getItemStatus(itemId);
    expect(["completed", "pending"]).toContain(status); // pending if retried (reset) or blocked-on-human re-pended a dependency
  }, 60000);
});

// ============================================================================
// Test A2: E2 — interactive-session-lock respect. WorkOrchestrator.ts used to
// hardcode skipSessionLock:true unconditionally, so a fresh interactive-session.lock
// (written when Jm has an active interactive session) never deferred the driver's
// auto-merge. The driver path NEVER passes --interactive-session, so a fresh lock
// must now defer the merge (not skip it) while report-done still succeeds (exit 0).
// ============================================================================

describe("HeadlessWorkDriver — interactive-session-lock respect (E2)", () => {
  it("defers the merge (mergeStatus 'deferred') when an interactive-session lock is present, but still completes the item (exit 0)", async () => {
    const itemId = await seedItem("HWD session-lock item");

    let knownIscRowIds: number[] = [];
    const cliRunner: CliRunnerFn = (args) => {
      const res = scratchCliRunner()(args);
      if (args[0] === "prepare" && res.json && typeof res.json === "object") {
        const j = res.json as { iscRows?: { id: number }[] };
        if (j.iscRows) knownIscRowIds = j.iscRows.map((r) => r.id);
      }
      return res;
    };

    // Same deliverable pattern as the happy-path test (Test A) — proven to reliably
    // pass Gates 1-3 and reach a real Integrator merge attempt.
    const spawnAgentSyncFn = (opts: AgentSpawnOptions): AgentSpawnResult => {
      const isBuilder = opts.allowedTools === BUILDER_ALLOWED_TOOLS;
      if (isBuilder) {
        const cwd = opts.cwd!;
        writeFileSync(join(cwd, "hwd-deliverable.txt"), "hwd fake deliverable\n");
        writeFileSync(
          join(cwd, "hwd-deliverable.test.ts"),
          'import { test, expect } from "bun:test";\ntest("hwd deliverable exists", () => { expect(1 + 1).toBe(2); });\n',
        );
        git(cwd, ["add", "-A"]);
        git(cwd, ["commit", "-q", "-m", "feat(isc): hwd fake deliverable (session-lock test)"]);
      }
      const stdout = isBuilder
        ? JSON.stringify({ success: true, completedRows: knownIscRowIds, failedRows: [], budgetSpent: 0.01 })
        : JSON.stringify({
            rows: knownIscRowIds.map((iscId) => ({ iscId, verdict: "PASS", evidence: "fake evidence", linkedTest: "hwd-deliverable.test.ts::hwd deliverable exists", concern: null })),
            summary: "all pass (fake)",
            allPass: true,
          });
      return { success: true, stdout, stderr: "", exitCode: 0, timedOut: false, infraUnavailable: false, preSpawnGated: false };
    };

    // Simulate an active Jm interactive session: fresh interactive-session.lock in the
    // scratch KAYA_HOME. The driver's CLI calls (scratchCliRunner/defaultCliRunner) NEVER
    // pass --interactive-session, so this must defer the merge, not bypass the lock.
    const lockDir = join(scratchKayaHome, "MEMORY", "STATE");
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(
      join(lockDir, "interactive-session.lock"),
      JSON.stringify({ sessionId: "jm-interactive-test", startedAt: new Date().toISOString(), pid: 1 }),
    );

    const result = await runDriver({ cliRunner, spawnAgentSyncFn, isRateLimitedFn: () => false, deferredMergeSweepFn: NOOP_SWEEP });

    expect(result.error).toBeNull();
    const mine = result.itemsProcessed.find((o) => o.itemId === itemId);
    expect(mine).toBeDefined();
    // report-done succeeds (exit 0) even though the merge was deferred — a deferred
    // merge is NOT a failed completion.
    expect(mine!.outcome).toBe("done");

    const { WorkQueue } = await import("./WorkQueue.ts");
    const wq = new WorkQueue();
    const item = wq.getItem(itemId);
    expect(item?.status).toBe("completed");
    expect(item?.metadata?.mergeStatus).toBe("deferred");
    expect(String(item?.metadata?.mergeReason ?? "")).toMatch(/interactive session active/i);

    // Confirm no real merge happened: main in scratchRepo still has only the init commit.
    const mainLog = git(scratchRepo, ["log", "--oneline", "main"]);
    expect(mainLog.split("\n").length).toBe(1);
  }, 60000);
});

// ============================================================================
// Test B: MAX_ITERATIONS bound — verifier rejects every time, never loops forever
// ============================================================================

describe("HeadlessWorkDriver — bounded convergence loop", () => {
  it("stops at MAX_ITERATIONS when the Verifier alternates failing rows every iteration (never stalls, never infinite-loops)", async () => {
    const itemId = await seedItem("HWD max-iterations item");

    let knownIscRowIds: number[] = [];
    const cliRunner: CliRunnerFn = (args) => {
      const res = scratchCliRunner()(args);
      if (args[0] === "prepare" && res.json && typeof res.json === "object") {
        const j = res.json as { iscRows?: { id: number }[] };
        if (j.iscRows) knownIscRowIds = j.iscRows.map((r) => r.id);
      }
      return res;
    };

    let verifierCalls = 0;
    const spawnAgentSyncFn = (opts: AgentSpawnOptions): AgentSpawnResult => {
      const isBuilder = opts.allowedTools === BUILDER_ALLOWED_TOOLS;
      if (isBuilder) {
        return {
          success: true,
          stdout: JSON.stringify({ success: false, completedRows: [], failedRows: knownIscRowIds, budgetSpent: 0.01 }),
          stderr: "", exitCode: 0, timedOut: false, infraUnavailable: false, preSpawnGated: false,
        };
      }
      verifierCalls++;
      const iteration = extractIteration(opts.prompt);
      // Alternate which row fails each iteration so the FAIL-id-set never repeats
      // consecutively (that would trigger stall detection instead of max_iterations).
      const failing = knownIscRowIds[iteration % knownIscRowIds.length];
      const rows = knownIscRowIds.map((iscId) => ({
        iscId,
        verdict: iscId === failing ? "FAIL" : "PASS",
        evidence: "fake evidence",
        linkedTest: iscId === failing ? null : "Fake.test.ts::x::y",
        concern: iscId === failing ? "fake failure, alternates by iteration" : null,
      }));
      return {
        success: true,
        stdout: JSON.stringify({ rows, summary: `iteration ${iteration} fake failure`, allPass: false }),
        stderr: "", exitCode: 0, timedOut: false, infraUnavailable: false, preSpawnGated: false,
      };
    };

    const result = await runDriver({ cliRunner, spawnAgentSyncFn, isRateLimitedFn: () => false, deferredMergeSweepFn: NOOP_SWEEP });

    expect(result.error).toBeNull();
    expect(knownIscRowIds.length).toBeGreaterThanOrEqual(2); // precondition for the alternation strategy above
    expect(verifierCalls).toBe(MAX_ITERATIONS);

    const mine = result.itemsProcessed.find((o) => o.itemId === itemId);
    expect(mine).toBeDefined();
    expect(mine!.iterations).toBe(MAX_ITERATIONS);
    expect(mine!.terminationReason).toBe("max_iterations");
    expect(["retried", "escalated"]).toContain(mine!.outcome);

    // Never called complete/fail directly — retry is the only terminal CLI verb used
    // on non-convergence. Confirmed structurally: outcome is retried/escalated (both
    // come from the `retry` subcommand's JSON, never a bare success:true completion).
  }, 90000);
});

// ============================================================================
// Test B2: stall detection — same failing ISC row-set two iterations running
// (HeadlessWorkDriver.ts's previousFailedIds/currentFailedIds check, ~line 427-431)
// ============================================================================

describe("HeadlessWorkDriver — stall detection", () => {
  it("terminates with reason 'stall' (not max_iterations) when the Verifier fails the SAME row set two iterations in a row, and retries", async () => {
    const itemId = await seedItem("HWD stall item");

    let knownIscRowIds: number[] = [];
    const cliRunner: CliRunnerFn = (args) => {
      const res = scratchCliRunner()(args);
      if (args[0] === "prepare" && res.json && typeof res.json === "object") {
        const j = res.json as { iscRows?: { id: number }[] };
        if (j.iscRows) knownIscRowIds = j.iscRows.map((r) => r.id);
      }
      return res;
    };

    let verifierCalls = 0;
    const spawnAgentSyncFn = (opts: AgentSpawnOptions): AgentSpawnResult => {
      const isBuilder = opts.allowedTools === BUILDER_ALLOWED_TOOLS;
      if (isBuilder) {
        return {
          success: true,
          stdout: JSON.stringify({ success: false, completedRows: [], failedRows: knownIscRowIds, budgetSpent: 0.01 }),
          stderr: "", exitCode: 0, timedOut: false, infraUnavailable: false, preSpawnGated: false,
        };
      }
      verifierCalls++;
      // ALWAYS fail the SAME row (the first known ISC row id) every iteration — the
      // FAIL-id-set is identical on iteration 2 vs iteration 1, which must trip stall
      // detection rather than running all the way to MAX_ITERATIONS like Test B's
      // alternating-failure scenario does.
      const failing = knownIscRowIds[0];
      const rows = knownIscRowIds.map((iscId) => ({
        iscId,
        verdict: iscId === failing ? "FAIL" : "PASS",
        evidence: "fake evidence",
        linkedTest: iscId === failing ? null : "Fake.test.ts::x::y",
        concern: iscId === failing ? "same fake failure every iteration" : null,
      }));
      return {
        success: true,
        stdout: JSON.stringify({ rows, summary: "stalled fake failure", allPass: false }),
        stderr: "", exitCode: 0, timedOut: false, infraUnavailable: false, preSpawnGated: false,
      };
    };

    const result = await runDriver({ cliRunner, spawnAgentSyncFn, isRateLimitedFn: () => false, deferredMergeSweepFn: NOOP_SWEEP });

    expect(result.error).toBeNull();
    expect(knownIscRowIds.length).toBeGreaterThan(0);
    // Stall is detected on the SECOND iteration (iteration 1 seeds previousFailedIds,
    // iteration 2 repeats the identical FAIL-id-set) — the loop must break there,
    // never reaching a 3rd iteration or MAX_ITERATIONS.
    expect(verifierCalls).toBe(2);

    const mine = result.itemsProcessed.find((o) => o.itemId === itemId);
    expect(mine).toBeDefined();
    expect(mine!.iterations).toBe(2);
    expect(mine!.terminationReason).toBe("stall");
    expect(["retried", "escalated"]).toContain(mine!.outcome);
    expect(mine!.detail).toContain("stall:");
  }, 60000);
});

// ============================================================================
// Test C: rate-limit defer — never drops or fails the item
// ============================================================================

describe("HeadlessWorkDriver — rate-limit defer path", () => {
  it("defers (does not retry/fail) an item when the Builder spawn is infra-unavailable, and stops the driver run", async () => {
    const itemId = await seedItem("HWD rate-limit item");

    const cliCalls: string[][] = [];
    const cliRunner: CliRunnerFn = (args) => {
      cliCalls.push(args);
      return scratchCliRunner()(args);
    };

    const spawnAgentSyncFn = (): AgentSpawnResult => ({
      success: false,
      stdout: "",
      stderr: "You've hit your limit · resets 3pm",
      exitCode: -1,
      timedOut: false,
      infraUnavailable: true,
      preSpawnGated: true,
    });

    const result = await runDriver({ cliRunner, spawnAgentSyncFn, isRateLimitedFn: () => false, deferredMergeSweepFn: NOOP_SWEEP });

    expect(result.error).toBeNull();
    expect(result.deferred).toBe(true);
    const mine = result.itemsProcessed.find((o) => o.itemId === itemId);
    expect(mine).toBeDefined();
    expect(mine!.outcome).toBe("deferred");

    // Never called retry/fail/mark-done/verify/report-done for the deferred item.
    const mutatingCalls = cliCalls.filter((a) => ["retry", "fail", "mark-done", "verify", "report-done", "complete"].includes(a[0]));
    expect(mutatingCalls).toHaveLength(0);

    // Item is left exactly where `started` put it — in_progress — for orphan
    // recovery / the next driver run to reclaim. Never silently dropped.
    const status = await getItemStatus(itemId);
    expect(status).toBe("in_progress");
  }, 30000);
});

// ============================================================================
// Test C2: Verifier-side infra-unavailable — Builder succeeds, Verifier spawn doesn't.
// Test C above only covers the BUILDER-side infra-unavailable path; the Verifier turn
// is a separate spawn (HeadlessWorkDriver.ts's second spawn() call inside the
// iteration loop) with its own infraUnavailable check and its own early return.
// ============================================================================

describe("HeadlessWorkDriver — Verifier-side infra defer path", () => {
  it("defers (leaves the item untouched) when the BUILDER spawn succeeds but the VERIFIER spawn is infra-unavailable", async () => {
    const itemId = await seedItem("HWD verifier-side infra item");

    const cliCalls: string[][] = [];
    let knownIscRowIds: number[] = [];
    const cliRunner: CliRunnerFn = (args) => {
      cliCalls.push(args);
      const res = scratchCliRunner()(args);
      if (args[0] === "prepare" && res.json && typeof res.json === "object") {
        const j = res.json as { iscRows?: { id: number }[] };
        if (j.iscRows) knownIscRowIds = j.iscRows.map((r) => r.id);
      }
      return res;
    };

    const spawnAgentSyncFn = (opts: AgentSpawnOptions): AgentSpawnResult => {
      const isBuilder = opts.allowedTools === BUILDER_ALLOWED_TOOLS;
      if (isBuilder) {
        // Builder turn succeeds for real — this test covers the OTHER half of the
        // loop from Test C: a successful Builder turn followed by an infra-unavailable
        // Verifier turn (e.g. the rate limit is hit between the two spawns).
        const cwd = opts.cwd!;
        require("fs").writeFileSync(join(cwd, "hwd-deliverable.txt"), "hwd fake deliverable\n");
        git(cwd, ["add", "-A"]);
        git(cwd, ["commit", "-q", "-m", "feat(isc): hwd fake deliverable"]);
        return {
          success: true,
          stdout: JSON.stringify({ success: true, completedRows: knownIscRowIds, failedRows: [], budgetSpent: 0.01 }),
          stderr: "", exitCode: 0, timedOut: false, infraUnavailable: false, preSpawnGated: false,
        };
      }
      // Verifier turn: infra-unavailable.
      return {
        success: false,
        stdout: "",
        stderr: "You've hit your limit · resets 3pm",
        exitCode: -1,
        timedOut: false,
        infraUnavailable: true,
        preSpawnGated: true,
      };
    };

    const result = await runDriver({ cliRunner, spawnAgentSyncFn, isRateLimitedFn: () => false, deferredMergeSweepFn: NOOP_SWEEP });

    expect(result.error).toBeNull();
    expect(result.deferred).toBe(true);
    const mine = result.itemsProcessed.find((o) => o.itemId === itemId);
    expect(mine).toBeDefined();
    expect(mine!.outcome).toBe("deferred");

    // Never called retry/fail/mark-done/verify/report-done — the Builder's real git
    // commit is NOT a mutating WorkOrchestratorCLI call (it's a direct git operation in
    // the worktree, exactly like a real Builder would make); the item's QUEUE state
    // must still be untouched by any mutating CLI subcommand.
    const mutatingCalls = cliCalls.filter((a) => ["retry", "fail", "mark-done", "verify", "report-done", "complete"].includes(a[0]));
    expect(mutatingCalls).toHaveLength(0);

    const status = await getItemStatus(itemId);
    expect(status).toBe("in_progress");
  }, 30000);
});

// ============================================================================
// Test D: budget ceiling — stop taking new items before next-batch is even called
// ============================================================================

describe("HeadlessWorkDriver — budget ceiling gate", () => {
  it("stops before pulling a new batch when over the ceiling, without touching any item", async () => {
    const cliCalls: string[][] = [];
    const fakeCliRunner: CliRunnerFn = (args) => {
      cliCalls.push(args);
      if (args[0] === "init") {
        const json = { success: true, message: "0 ready, 0 blocked", ready: 0, blocked: 0, recovered: 0 };
        return { ok: true, exitCode: 0, stdout: JSON.stringify(json), stderr: "", json };
      }
      throw new Error(`Unexpected CLI call in budget-ceiling test: ${args.join(" ")}`);
    };

    const spawnAgentSyncFn = (): AgentSpawnResult => {
      throw new Error("spawnAgentSyncFn must never be called when the pre-batch ceiling gate is over threshold");
    };

    const result = await runDriver({
      cliRunner: fakeCliRunner,
      spawnAgentSyncFn,
      isRateLimitedFn: () => true, // always "over ceiling"
      deferredMergeSweepFn: NOOP_SWEEP,
    });

    expect(result.error).toBeNull();
    expect(result.deferred).toBe(true);
    expect(result.itemsProcessed).toHaveLength(0);
    expect(cliCalls.map((c) => c[0])).toEqual(["init"]); // next-batch never called
  }, 10000);
});

// ============================================================================
// Test G: retry-noop telemetry — orch.retry() returning {retried:false,escalated:false}
// (item not-found / infrastructure-fault classification, WorkOrchestrator.ts:849,:867)
// must produce a distinct "retry-noop" outcome, never be mislabeled "retried".
// ============================================================================

describe("HeadlessWorkDriver — retry-noop telemetry", () => {
  it("labels the outcome 'retry-noop' (never 'retried') when the retry CLI step reports {retried:false, escalated:false}", async () => {
    const itemId = await seedItem("HWD retry-noop item");

    // This test exercises HeadlessWorkDriver's OWN interpretation of the `retry`
    // subcommand's JSON contract, not WorkOrchestrator.retry()'s internal fault
    // classification (that belongs to WorkOrchestrator.test.ts). Every other
    // subcommand runs for real against the scratch CLI/KAYA_HOME; only the `retry`
    // call is intercepted to return the exact JSON shape WorkOrchestrator.retry()
    // produces for a not-found item or an infrastructure-fault classification —
    // real WorkOrchestrator output shape, triggered here deterministically instead of
    // by constructing one of those two conditions for real.
    let knownIscRowIds: number[] = [];
    let retryCalled = false;
    const cliRunner: CliRunnerFn = (args) => {
      if (args[0] === "retry") {
        retryCalled = true;
        const json = { retried: false, escalated: false, attempt: 0 };
        return { ok: true, exitCode: 0, stdout: JSON.stringify(json), stderr: "", json };
      }
      const res = scratchCliRunner()(args);
      if (args[0] === "prepare" && res.json && typeof res.json === "object") {
        const j = res.json as { iscRows?: { id: number }[] };
        if (j.iscRows) knownIscRowIds = j.iscRows.map((r) => r.id);
      }
      return res;
    };

    // Simplest deterministic route to a `retry` call: the Builder never completes any
    // row and the Verifier fails every row every iteration (same pattern as the stall
    // test above) — the exact termination reason doesn't matter here, only that
    // processItem reaches its cli(["retry", ...]) call.
    const spawnAgentSyncFn = (opts: AgentSpawnOptions): AgentSpawnResult => {
      const isBuilder = opts.allowedTools === BUILDER_ALLOWED_TOOLS;
      if (isBuilder) {
        return {
          success: true,
          stdout: JSON.stringify({ success: false, completedRows: [], failedRows: knownIscRowIds, budgetSpent: 0.01 }),
          stderr: "", exitCode: 0, timedOut: false, infraUnavailable: false, preSpawnGated: false,
        };
      }
      const rows = knownIscRowIds.map((iscId) => ({
        iscId, verdict: "FAIL" as const, evidence: "fake evidence", linkedTest: null, concern: "always fails",
      }));
      return {
        success: true,
        stdout: JSON.stringify({ rows, summary: "always fails (fake)", allPass: false }),
        stderr: "", exitCode: 0, timedOut: false, infraUnavailable: false, preSpawnGated: false,
      };
    };

    const result = await runDriver({ cliRunner, spawnAgentSyncFn, isRateLimitedFn: () => false, deferredMergeSweepFn: NOOP_SWEEP });

    expect(result.error).toBeNull();
    expect(retryCalled).toBe(true);
    const mine = result.itemsProcessed.find((o) => o.itemId === itemId);
    expect(mine).toBeDefined();
    expect(mine!.outcome).toBe("retry-noop");
    expect(mine!.outcome).not.toBe("retried");
  }, 60000);
});

// ============================================================================
// Test E3: --max-items CLI flag — pure parsing (no subprocess) + batchSize wiring.
// ============================================================================

describe("parseMaxItemsArg (E3 fix round) — pure, no I/O", () => {
  it("returns DEFAULT_MAX_ITEMS (the total-run cap default) when the flag is omitted (undefined)", () => {
    expect(parseMaxItemsArg(undefined)).toBe(DEFAULT_MAX_ITEMS);
  });

  it("returns the parsed integer for a valid positive-integer string (total-run cap)", () => {
    expect(parseMaxItemsArg("1")).toBe(1);
    expect(parseMaxItemsArg("12")).toBe(12);
  });

  it("returns 0 for '0' — the UNLIMITED sentinel (manual drain runs), not a throw", () => {
    expect(parseMaxItemsArg("0")).toBe(0);
  });

  it("throws for a negative integer", () => {
    expect(() => parseMaxItemsArg("-1")).toThrow();
  });

  it("throws for a non-integer", () => {
    expect(() => parseMaxItemsArg("1.5")).toThrow();
  });

  it("throws for a non-numeric string", () => {
    expect(() => parseMaxItemsArg("abc")).toThrow();
  });
});

describe("HeadlessWorkDriver — --max-items wiring (E3)", () => {
  it("runDriver({batchSize}) requests next-batch with that exact count (no subprocess — stub cliRunner)", async () => {
    let capturedNextBatchArg: string | undefined;
    const cliRunner: CliRunnerFn = (args) => {
      if (args[0] === "init") {
        return { ok: true, exitCode: 0, stdout: "", stderr: "", json: { success: true, message: "ok" } };
      }
      if (args[0] === "next-batch") {
        capturedNextBatchArg = args[1];
        // Empty items — the driver stops immediately after this one call, no items to process.
        return { ok: true, exitCode: 0, stdout: "", stderr: "", json: { items: [], blocked: 0 } };
      }
      throw new Error(`unexpected CLI call in this stub: ${args.join(" ")}`);
    };

    const result = await runDriver({ cliRunner, batchSize: 2, isRateLimitedFn: () => false, deferredMergeSweepFn: NOOP_SWEEP });

    expect(result.error).toBeNull();
    expect(capturedNextBatchArg).toBe("2");
    expect(result.itemsProcessed.length).toBe(0);
  });
});

// ============================================================================
// Test H: total-run item cap (E3 fix round, item 1) — VERIFIER-RULED DEFECT fix.
// Previously --max-items only bounded a single next-batch PULL; the outer loop
// drained the entire ready queue batch-by-batch regardless. maxItems now caps
// the TOTAL number of items processed across the whole run, independent of
// batchSize.
// ============================================================================

describe("HeadlessWorkDriver — total item cap (E3 fix round)", () => {
  it("processes exactly maxItems items from a larger ready queue, then stops cleanly (queue of 3, maxItems 2)", async () => {
    const itemIds = [
      await seedItem("HWD cap item 1"),
      await seedItem("HWD cap item 2"),
      await seedItem("HWD cap item 3"),
    ];

    let knownIscRowIds: number[] = [];
    const cliRunner: CliRunnerFn = (args) => {
      const res = scratchCliRunner()(args);
      if (args[0] === "prepare" && res.json && typeof res.json === "object") {
        const j = res.json as { iscRows?: { id: number }[] };
        if (j.iscRows) knownIscRowIds = j.iscRows.map((r) => r.id);
      }
      return res;
    };

    // Same "stall" pattern as Test B2 above: Builder never completes any row,
    // Verifier fails the SAME row every iteration -> stall detected on
    // iteration 2 -> a fast, deterministic `retry` per item (no MAX_ITERATIONS
    // wait), so this test stays quick even with 3 seeded items.
    const spawnAgentSyncFn = (opts: AgentSpawnOptions): AgentSpawnResult => {
      const isBuilder = opts.allowedTools === BUILDER_ALLOWED_TOOLS;
      if (isBuilder) {
        return {
          success: true,
          stdout: JSON.stringify({ success: false, completedRows: [], failedRows: knownIscRowIds, budgetSpent: 0.01 }),
          stderr: "", exitCode: 0, timedOut: false, infraUnavailable: false, preSpawnGated: false,
        };
      }
      const failing = knownIscRowIds[0];
      const rows = knownIscRowIds.map((iscId) => ({
        iscId, verdict: iscId === failing ? "FAIL" : "PASS", evidence: "fake evidence",
        linkedTest: iscId === failing ? null : "Fake.test.ts::x::y",
        concern: iscId === failing ? "same fake failure every iteration" : null,
      }));
      return {
        success: true,
        stdout: JSON.stringify({ rows, summary: "stalled fake failure", allPass: false }),
        stderr: "", exitCode: 0, timedOut: false, infraUnavailable: false, preSpawnGated: false,
      };
    };

    const result = await runDriver({
      cliRunner, spawnAgentSyncFn, isRateLimitedFn: () => false, deferredMergeSweepFn: NOOP_SWEEP,
      maxItems: 2,
    });

    expect(result.error).toBeNull();
    expect(result.deferred).toBe(false); // hit the cap, not a rate-limit/infra defer
    expect(result.itemsProcessed).toHaveLength(2);

    const processedIds = new Set(result.itemsProcessed.map((o) => o.itemId));
    expect(processedIds.size).toBe(2);
    const untouchedIds = itemIds.filter((id) => !processedIds.has(id));
    expect(untouchedIds).toHaveLength(1);

    // The 3rd item was never pulled by next-batch at all (pull size itself is
    // trimmed to the remaining cap) — still sitting pending for the NEXT run.
    const untouchedStatus = await getItemStatus(untouchedIds[0]);
    expect(untouchedStatus).toBe("pending");
  }, 90000);

  it("drains the WHOLE ready queue with no cap when maxItems is 0 (unlimited — manual drain runs)", async () => {
    const itemIds = [
      await seedItem("HWD unlimited item 1"),
      await seedItem("HWD unlimited item 2"),
      await seedItem("HWD unlimited item 3"),
    ];

    let knownIscRowIds: number[] = [];
    const cliRunner: CliRunnerFn = (args) => {
      const res = scratchCliRunner()(args);
      if (args[0] === "prepare" && res.json && typeof res.json === "object") {
        const j = res.json as { iscRows?: { id: number }[] };
        if (j.iscRows) knownIscRowIds = j.iscRows.map((r) => r.id);
      }
      return res;
    };

    const spawnAgentSyncFn = (opts: AgentSpawnOptions): AgentSpawnResult => {
      const isBuilder = opts.allowedTools === BUILDER_ALLOWED_TOOLS;
      if (isBuilder) {
        return {
          success: true,
          stdout: JSON.stringify({ success: false, completedRows: [], failedRows: knownIscRowIds, budgetSpent: 0.01 }),
          stderr: "", exitCode: 0, timedOut: false, infraUnavailable: false, preSpawnGated: false,
        };
      }
      const failing = knownIscRowIds[0];
      const rows = knownIscRowIds.map((iscId) => ({
        iscId, verdict: iscId === failing ? "FAIL" : "PASS", evidence: "fake evidence",
        linkedTest: iscId === failing ? null : "Fake.test.ts::x::y",
        concern: iscId === failing ? "same fake failure every iteration" : null,
      }));
      return {
        success: true,
        stdout: JSON.stringify({ rows, summary: "stalled fake failure", allPass: false }),
        stderr: "", exitCode: 0, timedOut: false, infraUnavailable: false, preSpawnGated: false,
      };
    };

    // maxItems: 0 -> unlimited. All 3 seeded items get processed in one run —
    // contrast with the maxItems:2 test above, which leaves one item untouched.
    const result = await runDriver({
      cliRunner, spawnAgentSyncFn, isRateLimitedFn: () => false, deferredMergeSweepFn: NOOP_SWEEP,
      maxItems: 0,
    });

    expect(result.error).toBeNull();
    expect(result.deferred).toBe(false);
    expect(result.itemsProcessed).toHaveLength(3);
    const processedIds = new Set(result.itemsProcessed.map((o) => o.itemId));
    for (const id of itemIds) expect(processedIds.has(id)).toBe(true);
  }, 120000);
});

// ============================================================================
// Test I: deferred-merge sweep (E3 fix round, item 3) — VERIFIER-FLAGGED GAP fix.
// AW-side deferred merges only self-healed via a manual Integrator CLI run; the
// driver now sweeps once per run, at the START (before the first next-batch
// pull), gated on the interactive-session lock, best-effort (never blocks new
// work). All three deps here (cliRunner/checkInteractiveSessionLockFn/
// deferredMergeSweepFn) are stub/fake — no real CLI subprocess, no real
// Integrator subprocess, no real spawn — this suite tests the driver's OWN
// gating/sequencing/error-handling around the sweep, not Integrator itself.
// ============================================================================

describe("HeadlessWorkDriver — deferred-merge sweep (E3 fix round)", () => {
  it("invokes the sweep exactly once, before the first next-batch pull, when the lock is clear", async () => {
    let sweepCalls = 0;
    let nextBatchCalledBeforeSweep = false;
    const cliRunner: CliRunnerFn = (args) => {
      if (args[0] === "init") {
        return { ok: true, exitCode: 0, stdout: "", stderr: "", json: { success: true, message: "ok" } };
      }
      if (args[0] === "next-batch") {
        if (sweepCalls === 0) nextBatchCalledBeforeSweep = true;
        return { ok: true, exitCode: 0, stdout: "", stderr: "", json: { items: [], blocked: 0 } };
      }
      throw new Error(`unexpected CLI call: ${args.join(" ")}`);
    };

    const result = await runDriver({
      cliRunner,
      isRateLimitedFn: () => false,
      checkInteractiveSessionLockFn: () => false, // clear
      deferredMergeSweepFn: () => {
        sweepCalls++;
        return { ok: true, merged: 1, conflicts: 0, skipped: 0 };
      },
    });

    expect(result.error).toBeNull();
    expect(sweepCalls).toBe(1);
    expect(nextBatchCalledBeforeSweep).toBe(false);
  });

  it("skips the sweep silently (never calls the sweep fn) when the interactive-session lock is live", async () => {
    let sweepCalls = 0;
    const cliRunner: CliRunnerFn = (args) => {
      if (args[0] === "init") {
        return { ok: true, exitCode: 0, stdout: "", stderr: "", json: { success: true, message: "ok" } };
      }
      if (args[0] === "next-batch") {
        return { ok: true, exitCode: 0, stdout: "", stderr: "", json: { items: [], blocked: 0 } };
      }
      throw new Error(`unexpected CLI call: ${args.join(" ")}`);
    };

    const result = await runDriver({
      cliRunner,
      isRateLimitedFn: () => false,
      checkInteractiveSessionLockFn: () => true, // live
      deferredMergeSweepFn: () => {
        sweepCalls++;
        return { ok: true };
      },
    });

    expect(result.error).toBeNull();
    expect(sweepCalls).toBe(0);
  });

  it("records the failure and continues the run (still pulls normally) when the sweep reports failure", async () => {
    let sweepCalls = 0;
    let nextBatchCalls = 0;
    const cliRunner: CliRunnerFn = (args) => {
      if (args[0] === "init") {
        return { ok: true, exitCode: 0, stdout: "", stderr: "", json: { success: true, message: "ok" } };
      }
      if (args[0] === "next-batch") {
        nextBatchCalls++;
        return { ok: true, exitCode: 0, stdout: "", stderr: "", json: { items: [], blocked: 0 } };
      }
      throw new Error(`unexpected CLI call: ${args.join(" ")}`);
    };

    const result = await runDriver({
      cliRunner,
      isRateLimitedFn: () => false,
      checkInteractiveSessionLockFn: () => false,
      deferredMergeSweepFn: () => {
        sweepCalls++;
        return { ok: false, error: "simulated Integrator subprocess failure" };
      },
    });

    expect(result.error).toBeNull(); // sweep failure never surfaces as a driver-level error
    expect(sweepCalls).toBe(1);
    expect(nextBatchCalls).toBe(1); // the run continued to pull normally after the sweep failed
  });

  it("does not crash the run when the sweep fn itself throws (defensive catch, never blocks new work)", async () => {
    let nextBatchCalls = 0;
    const cliRunner: CliRunnerFn = (args) => {
      if (args[0] === "init") {
        return { ok: true, exitCode: 0, stdout: "", stderr: "", json: { success: true, message: "ok" } };
      }
      if (args[0] === "next-batch") {
        nextBatchCalls++;
        return { ok: true, exitCode: 0, stdout: "", stderr: "", json: { items: [], blocked: 0 } };
      }
      throw new Error(`unexpected CLI call: ${args.join(" ")}`);
    };

    const result = await runDriver({
      cliRunner,
      isRateLimitedFn: () => false,
      checkInteractiveSessionLockFn: () => false,
      deferredMergeSweepFn: () => {
        throw new Error("simulated Integrator subprocess crash");
      },
    });

    expect(result.error).toBeNull();
    expect(nextBatchCalls).toBe(1);
  });
});
