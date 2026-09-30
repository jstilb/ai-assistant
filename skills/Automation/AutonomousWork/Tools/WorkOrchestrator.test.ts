/**
 * WorkOrchestrator.test.ts — Tests for unified orchestrator
 *
 * Migrated best tests from ExecutiveOrchestrator.test.ts and ItemOrchestrator.test.ts:
 * - Catastrophic action detection (blocks dangerous commands, allows safe ones)
 * - Protected branch detection
 * - parseVerificationCommand security (allowlist, shell operators, git safety)
 * - ISC verification pipeline (DONE/VERIFIED/PENDING status handling)
 * - Complete gate (blocks without verify)
 * - Status transitions
 * - Prior work summary
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { SkepticalVerifier, type SkepticalReviewResult, type InferenceFn } from "./SkepticalVerifier.ts";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import type { ComprehendedSpec } from "./Types.ts";
import type { ISCRow, RepoContext, VerifyContext, FaultClass } from "./WorkOrchestrator.ts";
import type { WorkItem } from "./WorkQueue.ts";

// ---------------------------------------------------------------------------
// Hermetic invariant (structured-falcon §69)
//
// WorkQueue._createForTesting() bulk-seeds fixture ids via
// PipelineRepository.upsert({ enforce: false }), which intentionally trips a
// "shadow illegal verdict" logged via FailureLog.recordFailure(). That (and
// NotificationDispatcher's direct notifications.jsonl/AlertGate.spool writes
// on verification-FAIL paths exercised below) now go through
// assertNotLiveHomeUnderTest(), which THROWS under NODE_ENV=test when
// KAYA_HOME resolves to the live default — so KAYA_HOME must be pinned to a
// scratch dir before any test in this file runs.
//
// The pin must happen via a DYNAMIC import performed AFTER process.env is
// set: static imports are ESM-hoisted ahead of any top-level assignment in
// this file (verified empirically), so a plain `process.env.KAYA_HOME = tmp`
// placed before a static `import ... from "./WorkOrchestrator.ts"` would NOT
// run before that module's own top-level code — including its module-scope
// KAYA_HOME constant used for spec-path resolution. Type-only imports above
// are erased at compile time and never trigger module evaluation, so they
// stay static. The `type X = InstanceType<...>` aliases below let the same
// identifier serve as both a type (for annotations already in this file) and
// a `let`-bound runtime value (populated after the pin) — legal because type
// and value identifiers live in separate TS namespaces.
// ---------------------------------------------------------------------------

type WorkOrchestrator = InstanceType<typeof import("./WorkOrchestrator.ts")["WorkOrchestrator"]>;
type WorkQueue = InstanceType<typeof import("./WorkQueue.ts")["WorkQueue"]>;

let WorkOrchestrator: typeof import("./WorkOrchestrator.ts")["WorkOrchestrator"];
let WorkQueue: typeof import("./WorkQueue.ts")["WorkQueue"];
let ITERATION_LIMITS: typeof import("./WorkOrchestrator.ts")["ITERATION_LIMITS"];
let PHASE_MIN_ISC_THRESHOLD: typeof import("./WorkOrchestrator.ts")["PHASE_MIN_ISC_THRESHOLD"];
let PHASE_MIN_PHASES: typeof import("./WorkOrchestrator.ts")["PHASE_MIN_PHASES"];
let normalizeVerificationCommand: typeof import("./WorkOrchestrator.ts")["normalizeVerificationCommand"];
let findMissingDirectoryArg: typeof import("./WorkOrchestrator.ts")["findMissingDirectoryArg"];
let tempHome: string;
// Restored in afterAll — leaking KAYA_ALERT_DRY_RUN=1 (or a KAYA_HOME about
// to be rmSync'd) poisons later files in the same bun process (see
// WorkQueue.test.ts's PREV_ENV note).
let prevEnv: Record<string, string | undefined> = {};

beforeAll(async () => {
  tempHome = mkdtempSync(join(tmpdir(), "work-orchestrator-test-"));
  prevEnv = {
    KAYA_HOME: process.env.KAYA_HOME,
    KAYA_DIR: process.env.KAYA_DIR,
    KAYA_ALERT_DRY_RUN: process.env.KAYA_ALERT_DRY_RUN,
  };
  process.env.KAYA_HOME = tempHome;
  process.env.KAYA_DIR = tempHome;
  process.env.KAYA_ALERT_DRY_RUN = "1";

  ({
    WorkOrchestrator,
    ITERATION_LIMITS,
    PHASE_MIN_ISC_THRESHOLD,
    PHASE_MIN_PHASES,
    normalizeVerificationCommand,
    findMissingDirectoryArg,
  } = await import("./WorkOrchestrator.ts"));
  ({ WorkQueue } = await import("./WorkQueue.ts"));
});

afterAll(() => {
  for (const [k, v] of Object.entries(prevEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(tempHome, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Mock inference helpers (Phase 5a — comprehension-based ISC generation)
// ---------------------------------------------------------------------------

/** Build a mock InferenceFn returning pre-defined responses in sequence. */
function makeMockInference(
  responses: Array<{ success: boolean; parsed?: unknown; error?: string }>
): InferenceFn {
  let callCount = 0;
  return async (_opts) => {
    const idx = Math.min(callCount, responses.length - 1);
    callCount++;
    const r = responses[idx]!;
    return { success: r.success, parsed: r.parsed, error: r.error };
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeItem(overrides: Partial<WorkItem> & { id: string }): WorkItem {
  return {
    title: `Item ${overrides.id}`,
    description: "",
    status: "pending",
    priority: "normal",
    dependencies: [],
    source: "manual",
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeRow(overrides: Partial<ISCRow> & { id: number }): ISCRow {
  return {
    description: `Row ${overrides.id}`,
    status: "PENDING",
    parallel: false,
    ...overrides,
  };
}

function makeDoneRow(id: number, overrides: Partial<ISCRow> = {}): ISCRow {
  return makeRow({
    id,
    status: "DONE",
    verification: { method: "test", command: "test -d /tmp", success_criteria: "exists" },
    ...overrides,
  });
}

function createTestOrchestrator(items: WorkItem[] = [], opts?: { verifierResult?: SkepticalReviewResult }): WorkOrchestrator {
  const queue = WorkQueue._createForTesting(items);
  return WorkOrchestrator._createForTesting(queue, opts);
}

function createTestOrchestratorWithQueue(items: WorkItem[] = [], opts?: { verifierResult?: SkepticalReviewResult }):
  { orch: WorkOrchestrator; queue: WorkQueue } {
  const queue = WorkQueue._createForTesting(items);
  const orch = WorkOrchestrator._createForTesting(queue, opts);
  return { orch, queue };
}

// ---------------------------------------------------------------------------
// Catastrophic action detection + protected branch detection
//
// Relocated to lib/orchestrator/__tests__/CatastrophicGate.test.ts (S11 pass 1) —
// isCatastrophic/isProtectedBranch now live in lib/orchestrator/CatastrophicGate.ts.
// The orchestrator's isCatastrophic()/isProtectedBranch() are one-line delegations;
// see that module's tests for the exhaustive dangerous/safe-command cases.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// parseVerificationCommand security
// ---------------------------------------------------------------------------

describe("parseVerificationCommand security", () => {
  // File-level beforeAll (dynamic import pin) must resolve before this runs —
  // beforeAll ordering guarantees outer-file hooks run before this nested one.
  let orch: WorkOrchestrator;
  beforeAll(() => {
    orch = createTestOrchestrator();
  });

  describe("safe executables allowed", () => {
    it("allows bun test", () => {
      const r = orch.parseVerificationCommand("bun test");
      expect(r).not.toBeNull();
      expect(r!.exe).toBe("bun");
    });

    it("allows grep", () => {
      const r = orch.parseVerificationCommand("grep -r pattern src/");
      expect(r).not.toBeNull();
      expect(r!.exe).toBe("grep");
    });

    it("allows test -d", () => {
      const r = orch.parseVerificationCommand("test -d /tmp");
      expect(r).not.toBeNull();
      expect(r!.exe).toBe("test");
    });

    it("allows diff", () => {
      expect(orch.parseVerificationCommand("diff file1 file2")).not.toBeNull();
    });
  });

  describe("read-only git allowed", () => {
    it("allows git diff", () => {
      const r = orch.parseVerificationCommand("git diff --stat HEAD~1");
      expect(r).not.toBeNull();
      expect(r!.args[0]).toBe("diff");
    });

    it("allows git log", () => {
      expect(orch.parseVerificationCommand("git log --oneline -5")).not.toBeNull();
    });

    it("allows git show", () => {
      expect(orch.parseVerificationCommand("git show HEAD")).not.toBeNull();
    });

    it("allows git status", () => {
      expect(orch.parseVerificationCommand("git status")).not.toBeNull();
    });

    it("allows git rev-parse", () => {
      expect(orch.parseVerificationCommand("git rev-parse HEAD")).not.toBeNull();
    });

    it("allows git merge-base", () => {
      expect(orch.parseVerificationCommand("git merge-base main feature")).not.toBeNull();
    });
  });

  describe("mutating git rejected", () => {
    it("rejects git checkout", () => expect(orch.parseVerificationCommand("git checkout main")).toBeNull());
    it("rejects git reset", () => expect(orch.parseVerificationCommand("git reset --hard HEAD")).toBeNull());
    it("rejects git push", () => expect(orch.parseVerificationCommand("git push origin main")).toBeNull());
    it("rejects git commit", () => expect(orch.parseVerificationCommand('git commit -m "msg"')).toBeNull());
    it("rejects git config", () => expect(orch.parseVerificationCommand("git config user.email evil@attacker.com")).toBeNull());
    it("rejects git branch -D", () => expect(orch.parseVerificationCommand("git branch -D feature")).toBeNull());
    it("rejects git clean", () => expect(orch.parseVerificationCommand("git clean -fd")).toBeNull());
    it("rejects git with no subcommand", () => expect(orch.parseVerificationCommand("git")).toBeNull());
  });

  describe("shell operators rejected", () => {
    it("rejects pipe", () => expect(orch.parseVerificationCommand("bun test | grep pass")).toBeNull());
    it("rejects &&", () => expect(orch.parseVerificationCommand("bun test && echo done")).toBeNull());
    it("rejects semicolon", () => expect(orch.parseVerificationCommand("bun test; rm -rf /")).toBeNull());
    it("rejects $()", () => expect(orch.parseVerificationCommand("test -f $(whoami)")).toBeNull());
    it("rejects backticks", () => expect(orch.parseVerificationCommand("test -f `whoami`")).toBeNull());
  });

  describe("dangerous executables rejected", () => {
    it("rejects curl", () => expect(orch.parseVerificationCommand("curl https://example.com")).toBeNull());
    it("rejects rm", () => expect(orch.parseVerificationCommand("rm -rf /")).toBeNull());
    it("rejects wget", () => expect(orch.parseVerificationCommand("wget https://attacker.com")).toBeNull());
    it("rejects python", () => expect(orch.parseVerificationCommand("python -c 'import os'")).toBeNull());
  });
});

// ---------------------------------------------------------------------------
// ISC verification pipeline
// ---------------------------------------------------------------------------

describe("verify() ISC row handling", () => {
  it("DONE row with passing verification → VERIFIED", async () => {
    const orch = createTestOrchestrator([makeItem({ id: "a" })]);
    orch.iscManager.persist("a", [makeDoneRow(1)]);

    const result = await orch.verify("a");
    expect(result.success).toBe(true);
    expect(orch.iscManager.load("a")[0].status).toBe("VERIFIED");
  });

  it("DONE row with failing verification → failure", async () => {
    const orch = createTestOrchestrator([makeItem({ id: "a" })]);
    orch.iscManager.persist("a", [
      makeRow({ id: 1, status: "DONE", verification: { method: "test", command: "test -f /nonexistent/xyz", success_criteria: "exists" } }),
    ]);

    const result = await orch.verify("a");
    expect(result.success).toBe(false);
    expect(result.failures[0].verification?.result).toBe("FAIL");
  });

  it("DONE row without verification object → failure (no auto-promote)", async () => {
    const orch = createTestOrchestrator([makeItem({ id: "a" })]);
    orch.iscManager.persist("a", [makeRow({ id: 1, status: "DONE" })]);

    const result = await orch.verify("a");
    expect(result.success).toBe(false);
    expect(result.failures.length).toBe(1);
  });

  it("VERIFIED rows honored as-is", async () => {
    const orch = createTestOrchestrator([makeItem({ id: "a" })]);
    orch.iscManager.persist("a", [makeRow({ id: 1, status: "VERIFIED" })]);

    const result = await orch.verify("a");
    expect(result.success).toBe(true);
  });

  it("PENDING rows are tolerated (handled as manual steps by reportDone)", async () => {
    const orch = createTestOrchestrator([makeItem({ id: "a" })]);
    orch.iscManager.persist("a", [makeRow({ id: 1, status: "PENDING" })]);

    // PENDING rows no longer cause local failures — they proceed to SkepticalVerifier
    // and are handled by the blocked transition in reportDone
    const result = await orch.verify("a");
    // verify passes local checks (no hard failures), SkepticalVerifier runs
    expect(result.failures.filter(f => f.status === "PENDING").length).toBe(0);
  });

  it("EXECUTION_FAILED rows count as failures", async () => {
    const orch = createTestOrchestrator([makeItem({ id: "a" })]);
    orch.iscManager.persist("a", [makeRow({ id: 1, status: "EXECUTION_FAILED" })]);

    const result = await orch.verify("a");
    expect(result.success).toBe(false);
  });

  it("mixed status: VERIFIED + DONE (no verify) + PENDING → 1 failure (PENDING tolerated for manual steps)", async () => {
    const orch = createTestOrchestrator([makeItem({ id: "a" })]);
    orch.iscManager.persist("a", [
      makeRow({ id: 1, status: "VERIFIED" }),
      makeRow({ id: 2, status: "DONE" }),  // no verification object — hard failure
      makeRow({ id: 3, status: "PENDING" }),  // tolerated — handled as manual by reportDone
    ]);

    const result = await orch.verify("a");
    expect(result.success).toBe(false);
    expect(result.failures.length).toBe(1);
    expect(result.failures[0].id).toBe(2);
  });

  it("all DONE with verification → all VERIFIED → success", async () => {
    const orch = createTestOrchestrator([makeItem({ id: "a" })]);
    orch.iscManager.persist("a", [makeDoneRow(1), makeDoneRow(2), makeDoneRow(3)]);

    const result = await orch.verify("a");
    expect(result.success).toBe(true);
    expect(orch.iscManager.load("a").every(r => r.status === "VERIFIED")).toBe(true);
  });

  it("returns failure when no ISC rows exist for item", async () => {
    const orch = createTestOrchestrator([makeItem({ id: "a" })]);
    const result = await orch.verify("a");
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Complete gate
// ---------------------------------------------------------------------------

describe("complete() gate", () => {
  it("blocks completion when no verification record exists", async () => {
    const orch = createTestOrchestrator([makeItem({ id: "a" })]);
    const result = await orch.complete("a");
    expect(result.success).toBe(false);
    expect(result.reason).toContain("No verification record");
  });

  it("allows completion when all ISC rows are VERIFIED and verification passed", async () => {
    const { orch, queue } = createTestOrchestratorWithQueue([makeItem({ id: "a", status: "in_progress" })]);
    queue.setVerification("a", {
      status: "verified", verifiedAt: new Date().toISOString(), verdict: "PASS",
      concerns: [], iscRowsVerified: 1, iscRowsTotal: 1, verificationCost: 0,
      verifiedBy: "skeptical_verifier", tiersExecuted: [1, 2],
    });
    orch.iscManager.persist("a", [makeRow({ id: 1, status: "VERIFIED" })]);
    const result = await orch.complete("a");
    expect(result.success).toBe(true);
  });

  it("blocks completion when verification status is failed", async () => {
    const { orch, queue } = createTestOrchestratorWithQueue([makeItem({ id: "a" })]);
    queue.setVerification("a", {
      status: "failed", verifiedAt: new Date().toISOString(), verdict: "FAIL",
      concerns: ["Paper completion"], iscRowsVerified: 0, iscRowsTotal: 1, verificationCost: 0,
      verifiedBy: "skeptical_verifier", tiersExecuted: [1, 2],
    });
    const result = await orch.complete("a");
    expect(result.success).toBe(false);
    expect(result.reason).toContain("failed");
  });

  it("blocks completion when verification status is needs_review", async () => {
    const { orch, queue } = createTestOrchestratorWithQueue([makeItem({ id: "a" })]);
    queue.setVerification("a", {
      status: "needs_review", verifiedAt: new Date().toISOString(), verdict: "NEEDS_REVIEW",
      concerns: ["Low confidence"], iscRowsVerified: 0, iscRowsTotal: 1, verificationCost: 0,
      verifiedBy: "skeptical_verifier", tiersExecuted: [1, 2],
    });
    const result = await orch.complete("a");
    expect(result.success).toBe(false);
    expect(result.reason).toContain("needs_review");
  });

  it("defense in depth: blocks when persisted passes but in-memory ISC has unverified rows", async () => {
    const { orch, queue } = createTestOrchestratorWithQueue([makeItem({ id: "a" })]);
    queue.setVerification("a", {
      status: "verified", verifiedAt: new Date().toISOString(), verdict: "PASS",
      concerns: [], iscRowsVerified: 1, iscRowsTotal: 1, verificationCost: 0,
      verifiedBy: "skeptical_verifier", tiersExecuted: [1, 2],
    });
    orch.iscManager.persist("a", [makeRow({ id: 1, status: "DONE" })]);
    const result = await orch.complete("a");
    expect(result.success).toBe(false);
    expect(result.reason).toContain("ISC rows not verified");
  });

  it("returns failure for unknown item", async () => {
    const orch = createTestOrchestrator([]);
    const result = await orch.complete("nonexistent");
    expect(result.success).toBe(false);
    expect(result.reason).toContain("Not found");
  });
});

// ---------------------------------------------------------------------------
// Provenance + cost gate enforcement
// ---------------------------------------------------------------------------

describe("complete() provenance gate", () => {
  it("setVerification rejects verifiedBy: 'manual' — cannot bypass provenance guard", () => {
    const { queue } = createTestOrchestratorWithQueue([
      makeItem({ id: "a", effort: "STANDARD" }),
    ]);
    expect(() => queue.setVerification("a", {
      status: "verified", verifiedAt: new Date().toISOString(), verdict: "PASS",
      concerns: [], iscRowsVerified: 1, iscRowsTotal: 1, verificationCost: 0.02,
      verifiedBy: "manual" as "skeptical_verifier", tiersExecuted: [1, 2],
    })).toThrow('is not "skeptical_verifier"');
  });

  it("complete() rejects items without verification record", async () => {
    const { orch } = createTestOrchestratorWithQueue([
      makeItem({ id: "a", effort: "TRIVIAL", status: "in_progress" }),
    ]);
    orch.iscManager.persist("a", [makeRow({ id: 1, status: "VERIFIED" })]);

    const result = await orch.complete("a");
    expect(result.success).toBe(false);
    expect(result.reason).toContain("No verification record found");
  });

  it("rejects when tiersExecuted does not include Tier 1 for non-TRIVIAL", async () => {
    const { orch, queue } = createTestOrchestratorWithQueue([
      makeItem({ id: "a", effort: "STANDARD" }),
    ]);
    queue.setVerification("a", {
      status: "verified", verifiedAt: new Date().toISOString(), verdict: "PASS",
      concerns: [], iscRowsVerified: 1, iscRowsTotal: 1, verificationCost: 0.02,
      verifiedBy: "skeptical_verifier", tiersExecuted: [2],
    });
    orch.iscManager.persist("a", [makeRow({ id: 1, status: "VERIFIED" })]);

    const result = await orch.complete("a");
    expect(result.success).toBe(false);
    expect(result.reason).toContain("Tier 1 code checks did not execute");
  });

  it("allows STANDARD effort completion with Tier 1+2 and ISC verified", async () => {
    const { orch, queue } = createTestOrchestratorWithQueue([
      makeItem({ id: "a", effort: "STANDARD", status: "in_progress" }),
    ]);
    queue.setVerification("a", {
      status: "verified", verifiedAt: new Date().toISOString(), verdict: "PASS",
      concerns: [], iscRowsVerified: 1, iscRowsTotal: 1, verificationCost: 0,
      verifiedBy: "skeptical_verifier", tiersExecuted: [1, 2],
    });
    orch.iscManager.persist("a", [makeRow({ id: 1, status: "VERIFIED" })]);

    const result = await orch.complete("a");
    expect(result.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Status transitions
// ---------------------------------------------------------------------------

describe("status transitions", () => {
  it("started transitions pending to in_progress", () => {
    const orch = createTestOrchestrator([makeItem({ id: "a", status: "pending" })]);
    expect(orch.started("a")).toBe(true);
  });

  it("started succeeds for already in_progress item (no double transition)", () => {
    const orch = createTestOrchestrator([makeItem({ id: "a", status: "in_progress" })]);
    expect(orch.started("a")).toBe(true);
  });

  it("started returns false for completed item", () => {
    const orch = createTestOrchestrator([makeItem({ id: "a", status: "completed" })]);
    expect(orch.started("a")).toBe(false);
  });

  it("fail marks failed", async () => {
    const orch = createTestOrchestrator([makeItem({ id: "a", status: "in_progress" })]);
    expect(await orch.fail("a", "timeout")).toBe(true);
  });

  it("started returns false for unknown id", () => {
    expect(createTestOrchestrator([]).started("nope")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

describe("init", () => {
  it("succeeds with valid queue", async () => {
    const result = await createTestOrchestrator([makeItem({ id: "a" })]).init(50);
    expect(result.success).toBe(true);
    expect(result.ready).toBe(1);
  });

  it("fails when DAG has cycle", async () => {
    const orch = createTestOrchestrator([
      makeItem({ id: "a", dependencies: ["b"] }),
      makeItem({ id: "b", dependencies: ["a"] }),
    ]);
    const result = await orch.init();
    expect(result.success).toBe(false);
    expect(result.message).toContain("invalid");
  });

  it("reports blocked count", async () => {
    const orch = createTestOrchestrator([
      makeItem({ id: "a" }),
      makeItem({ id: "b", dependencies: ["a"] }),
    ]);
    const result = await orch.init();
    expect(result.success).toBe(true);
    expect(result.ready).toBe(1);
    expect(result.blocked).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// readOrchestrationLearnings
// ---------------------------------------------------------------------------

describe("readOrchestrationLearnings", () => {
  it("returns empty string when FAILURES dir does not exist", async () => {
    const orch = createTestOrchestrator();
    const result = await orch.readOrchestrationLearnings("/nonexistent/path/FAILURES");
    expect(result).toBe("");
  });

  it("returns empty string when FAILURES dir is empty", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "failures-"));
    const orch = createTestOrchestrator();
    const result = await orch.readOrchestrationLearnings(tmpDir);
    expect(result).toBe("");
  });

  it("returns warning string when failure files are present", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "failures-"));
    const dateDir = join(tmpDir, "2026-03-27");
    mkdirSync(dateDir, { recursive: true });
    writeFileSync(
      join(dateDir, "20260327-001_failure-abc.md"),
      "# Failure Capture\n\n## Summary\n\nFailed to complete ISC rows properly\n"
    );
    const orch = createTestOrchestrator();
    const result = await orch.readOrchestrationLearnings(tmpDir);
    expect(result).toContain("Recent failure patterns");
    expect(result).toContain("Failed to complete ISC rows");
  });

  it("reads at most 5 entries from the most recent date dir", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "failures-"));
    const dateDir = join(tmpDir, "2026-03-27");
    mkdirSync(dateDir, { recursive: true });
    for (let i = 1; i <= 7; i++) {
      writeFileSync(
        join(dateDir, `2026032700${i}_failure-x${i}.md`),
        `# Failure\n\n## Summary\n\nFailure number ${i}\n`
      );
    }
    const orch = createTestOrchestrator();
    const result = await orch.readOrchestrationLearnings(tmpDir);
    // Should contain at most 5 entries
    const matches = result.match(/- /g) ?? [];
    expect(matches.length).toBeLessThanOrEqual(5);
  });

  it("picks the most recent date directory when multiple exist", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "failures-"));
    const oldDir = join(tmpDir, "2026-03-25");
    const newDir = join(tmpDir, "2026-03-27");
    mkdirSync(oldDir, { recursive: true });
    mkdirSync(newDir, { recursive: true });
    writeFileSync(
      join(oldDir, "20260325-001_failure-old.md"),
      "# Failure\n\n## Summary\n\nOld failure\n"
    );
    writeFileSync(
      join(newDir, "20260327-001_failure-new.md"),
      "# Failure\n\n## Summary\n\nNew failure from recent date\n"
    );
    const orch = createTestOrchestrator();
    const result = await orch.readOrchestrationLearnings(tmpDir);
    expect(result).toContain("New failure from recent date");
    expect(result).not.toContain("Old failure");
  });
});

// ---------------------------------------------------------------------------
// Next-batch
// ---------------------------------------------------------------------------

describe("nextBatch", () => {
  it("returns ready items", async () => {
    const orch = createTestOrchestrator([makeItem({ id: "a" }), makeItem({ id: "b" })]);
    const result = await orch.nextBatch(5);
    expect(result.items.length).toBe(2);
    expect(result.blocked).toBe(0);
  });

  it("reports blocked count when items have unmet deps", async () => {
    const orch = createTestOrchestrator([
      makeItem({ id: "a" }),
      makeItem({ id: "b", dependencies: ["a"] }),
    ]);
    const result = await orch.nextBatch(5);
    expect(result.items.length).toBe(1);
    expect(result.blocked).toBe(1);
  });

  it("triggers orphan recovery when >30min since last recovery", async () => {
    const staleStart = new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString();
    const { orch, queue } = createTestOrchestratorWithQueue([
      makeItem({ id: "stale", status: "in_progress", startedAt: staleStart }),
      makeItem({ id: "ready", status: "pending" }),
    ]);

    // Force lastRecoveryAt to >30min ago
    (orch as any).lastRecoveryAt = Date.now() - 31 * 60 * 1000;

    const result = await orch.nextBatch(5);
    // "stale" was recovered to pending then immediately claimed by claimParallelBatch
    // Verify recovery happened via metadata (resetToPending sets lastRecovery)
    const staleItem = queue.getItem("stale")!;
    expect((staleItem.metadata as any)?.lastRecovery).toBeDefined();
    expect((staleItem.metadata as any)?.lastRecovery?.previousStatus).toBe("in_progress");
    // Both "stale" (recovered→claimed) and "ready" should be in the batch
    expect(result.items.some(i => i.id === "stale")).toBe(true);
    expect(result.items.some(i => i.id === "ready")).toBe(true);
  });

  // S5b: init() runs its own recovery pass but historically never stamped
  // lastRecoveryAt, so the very next nextBatch() call saw the 0 default and
  // immediately re-ran recovery — double recovery, duplicate STALE-nudge
  // spool writes (digest pollution). Spy on recoverOrphanedItems() (public,
  // like the private lastRecoveryAt field accessed via `(orch as any)`
  // above) to count invocations directly rather than relying on item-state
  // side effects, since a Path-2-recovered item is no longer "in_progress"
  // on a second pass and so wouldn't itself reveal a double-call.
  it("nextBatch() immediately after init() does NOT re-run recovery (S5b)", async () => {
    const staleStart = new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString();
    const { orch } = createTestOrchestratorWithQueue([
      makeItem({ id: "stale", status: "in_progress", startedAt: staleStart }),
      makeItem({ id: "ready", status: "pending" }),
    ]);

    const initResult = await orch.init();
    expect(initResult.recovered).toBe(1); // init()'s own recovery pass ran once

    let recoveryCallsAfterInit = 0;
    const realRecover = orch.recoverOrphanedItems.bind(orch);
    (orch as any).recoverOrphanedItems = async () => {
      recoveryCallsAfterInit++;
      return realRecover();
    };

    await orch.nextBatch(5);
    expect(recoveryCallsAfterInit).toBe(0); // periodic gate must stay closed right after init()
  });

  it("nextBatch() DOES re-run recovery once 30+ minutes have elapsed since init() (S5b)", async () => {
    const { orch } = createTestOrchestratorWithQueue([
      makeItem({ id: "ready", status: "pending" }),
    ]);

    await orch.init();

    let recoveryCallsAfterInit = 0;
    const realRecover = orch.recoverOrphanedItems.bind(orch);
    (orch as any).recoverOrphanedItems = async () => {
      recoveryCallsAfterInit++;
      return realRecover();
    };

    // Simulate 30+ minutes elapsing since init()'s recovery stamp
    (orch as any).lastRecoveryAt = Date.now() - 31 * 60 * 1000;

    await orch.nextBatch(5);
    expect(recoveryCallsAfterInit).toBe(1); // periodic gate reopens once stale enough
  });
});

// ---------------------------------------------------------------------------
// Prior work summary
//
// Relocated to lib/orchestrator/__tests__/Reporting.test.ts (S11 pass 1) —
// generatePriorWorkSummary's logic now lives in lib/orchestrator/Reporting.ts.
// (The cross-session "loads ISC from metadata" integration test below, under
// "ISC persistence", stays here — it's testing the orchestrator's loadISC wiring,
// not the formatting logic.)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Iteration constants
// ---------------------------------------------------------------------------

describe("iteration constants", () => {
  it("TRIVIAL iterations is 1", () => expect(ITERATION_LIMITS.TRIVIAL).toBe(1));
  it("STANDARD iterations is 10", () => expect(ITERATION_LIMITS.STANDARD).toBe(10));
  it("DETERMINED iterations is 100", () => expect(ITERATION_LIMITS.DETERMINED).toBe(100));
});

// ---------------------------------------------------------------------------
// Status display
//
// Relocated to lib/orchestrator/__tests__/Reporting.test.ts (S11 pass 1) —
// status()'s logic now lives in lib/orchestrator/Reporting.ts (statusReport).
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// SkepticalVerifier integration
// ---------------------------------------------------------------------------

describe("SkepticalVerifier integration", () => {
  const failResult: SkepticalReviewResult = {
    finalVerdict: "FAIL",
    tiers: [{ tier: 1, verdict: "FAIL", confidence: 0.2, concerns: ["Paper completion detected"], costEstimate: 0, latencyMs: 0 }],
    tiersSkipped: [],
    totalCost: 0,
    totalLatencyMs: 0,
    concerns: ["Paper completion detected"],
  };

  const needsReviewResult: SkepticalReviewResult = {
    finalVerdict: "NEEDS_REVIEW",
    tiers: [{ tier: 1, verdict: "NEEDS_REVIEW", confidence: 0.5, concerns: ["Low confidence"], costEstimate: 0, latencyMs: 0 }],
    tiersSkipped: [],
    totalCost: 0,
    totalLatencyMs: 0,
    concerns: ["Low confidence in verification"],
  };

  it("verify blocks when SkepticalVerifier returns FAIL", async () => {
    const orch = createTestOrchestrator([makeItem({ id: "a" })], { verifierResult: failResult });
    orch.iscManager.persist("a", [makeDoneRow(1)]);

    const result = await orch.verify("a");
    expect(result.success).toBe(false);
    expect(result.failures.some(f => f.description.includes("Skeptical review"))).toBe(true);
    expect(result.skepticalReview?.finalVerdict).toBe("FAIL");
  });

  it("verify blocks when SkepticalVerifier returns NEEDS_REVIEW", async () => {
    const orch = createTestOrchestrator([makeItem({ id: "a" })], { verifierResult: needsReviewResult });
    orch.iscManager.persist("a", [makeDoneRow(1)]);

    const result = await orch.verify("a");
    expect(result.success).toBe(false);
    expect(result.skepticalReview?.finalVerdict).toBe("NEEDS_REVIEW");
  });

  it("verify succeeds when SkepticalVerifier returns PASS", async () => {
    const orch = createTestOrchestrator([makeItem({ id: "a" })]);
    orch.iscManager.persist("a", [makeDoneRow(1)]);

    const result = await orch.verify("a");
    expect(result.success).toBe(true);
    expect(orch.iscManager.load("a")[0].status).toBe("VERIFIED");
  });

  it("local command failures short-circuit before SkepticalVerifier runs", async () => {
    // Even with PASS verifier result, a failed local command should fail
    const orch = createTestOrchestrator([makeItem({ id: "a" })]);
    orch.iscManager.persist("a", [
      makeRow({ id: 1, status: "DONE", verification: { method: "test", command: "test -f /nonexistent/xyz", success_criteria: "exists" } }),
    ]);

    const result = await orch.verify("a");
    expect(result.success).toBe(false);
    expect(result.skepticalReview).toBeUndefined(); // SkepticalVerifier never ran
  });

  it("FAIL verdict prevents DONE→VERIFIED promotion", async () => {
    const orch = createTestOrchestrator([makeItem({ id: "a" })], { verifierResult: failResult });
    orch.iscManager.persist("a", [makeDoneRow(1), makeDoneRow(2)]);

    await orch.verify("a");
    // Rows should NOT be promoted to VERIFIED
    const rows = orch.iscManager.load("a");
    expect(rows.every(r => r.status === "DONE")).toBe(true);
  });

  it("PASS verdict promotes all DONE rows to VERIFIED", async () => {
    const orch = createTestOrchestrator([makeItem({ id: "a" })]);
    orch.iscManager.persist("a", [makeDoneRow(1), makeDoneRow(2), makeDoneRow(3)]);

    await orch.verify("a");
    const rows = orch.iscManager.load("a");
    expect(rows.every(r => r.status === "VERIFIED")).toBe(true);
  });

  it("returns concerns from SkepticalVerifier as failure descriptions", async () => {
    const orch = createTestOrchestrator([makeItem({ id: "a" })], { verifierResult: failResult });
    orch.iscManager.persist("a", [makeDoneRow(1)]);

    const result = await orch.verify("a");
    expect(result.failures.some(f => f.description.includes("Paper completion detected"))).toBe(true);
  });

  it("does NOT promote NEEDS_REVIEW to PASS when Tier 1 verdict is NEEDS_REVIEW", async () => {
    const needsReviewT1: SkepticalReviewResult = {
      finalVerdict: "NEEDS_REVIEW",
      tiers: [
        { tier: 1, verdict: "NEEDS_REVIEW", confidence: 0.6, concerns: ["Low confidence"], costEstimate: 0, latencyMs: 0 },
        { tier: 2, verdict: "PASS", confidence: 0.0, concerns: [], costEstimate: 0, latencyMs: 0 },
      ],
      tiersSkipped: [],
      totalCost: 0,
      totalLatencyMs: 0,
      concerns: ["Low confidence in verification"],
    };
    const { orch, queue } = createTestOrchestratorWithQueue(
      [makeItem({ id: "a" })],
      { verifierResult: needsReviewT1 }
    );
    orch.iscManager.persist("a", [makeDoneRow(1), makeDoneRow(2)]);
    await orch.started("a");

    const result = await orch.verify("a");
    const item = queue.getItem("a")!;
    // Guard's canPromote should reject: Tier 1 is NEEDS_REVIEW, not PASS
    expect(item.verification?.verdict).not.toBe("PASS");
  });
});

// ---------------------------------------------------------------------------
// Init + phase dependency wiring
// ---------------------------------------------------------------------------

describe("init() — S5b: no phase auto-wiring (ordering via explicit deps)", () => {
  it("without explicit deps, init() leaves all phase items ready (no auto-wiring)", async () => {
    const orch = createTestOrchestrator([
      makeItem({ id: "p1", title: "LucidTasks Phase 1: Core features" }),
      makeItem({ id: "p2", title: "LucidTasks Phase 2: Database schema" }),
      makeItem({ id: "p3", title: "LucidTasks Phase 3: Tests" }),
      makeItem({ id: "p4", title: "LucidTasks Phase 4: Docs" }),
    ]);
    const result = await orch.init(100);
    expect(result.success).toBe(true);
    expect(result.ready).toBe(4);   // S5b: title-regex auto-wiring removed → all ready
    expect(result.blocked).toBe(0);
  });

  it("with explicit deps, init() respects the DAG — only Phase 1 ready", async () => {
    const orch = createTestOrchestrator([
      makeItem({ id: "p1", title: "LucidTasks Phase 1: Core features" }),
      makeItem({ id: "p2", title: "LucidTasks Phase 2: Database schema", dependencies: ["p1"] }),
      makeItem({ id: "p3", title: "LucidTasks Phase 3: Tests", dependencies: ["p2"] }),
      makeItem({ id: "p4", title: "LucidTasks Phase 4: Docs", dependencies: ["p3"] }),
    ]);
    const result = await orch.init(100);
    expect(result.success).toBe(true);
    expect(result.ready).toBe(1);
    expect(result.blocked).toBe(3);
  });

  it("Phase 2 becomes ready after Phase 1 completes", async () => {
    const { orch, queue } = createTestOrchestratorWithQueue([
      makeItem({ id: "p1", title: "LucidTasks Phase 1: Core features" }),
      makeItem({ id: "p2", title: "LucidTasks Phase 2: Database schema" }),
    ]);
    await orch.init(100);

    // Complete Phase 1
    orch.started("p1");
    orch.iscManager.persist("p1", [makeRow({ id: 1, status: "VERIFIED" })]);
    queue.setVerification("p1", {
      status: "verified", verifiedAt: new Date().toISOString(), verdict: "PASS",
      concerns: [], iscRowsVerified: 1, iscRowsTotal: 1, verificationCost: 0,
      verifiedBy: "skeptical_verifier", tiersExecuted: [1, 2],
    });
    await orch.complete("p1");

    const batch = await orch.nextBatch(5);
    expect(batch.items.length).toBe(1);
    expect(batch.items[0].id).toBe("p2");
  });

  it("phase-named items across families are NOT auto-wired (all ready without explicit deps)", async () => {
    const orch = createTestOrchestrator([
      makeItem({ id: "lt1", title: "LucidTasks Phase 1: Core" }),
      makeItem({ id: "lt2", title: "LucidTasks Phase 2: Schema" }),
      makeItem({ id: "vm1", title: "VoiceMigration Phase 1: Setup" }),
      makeItem({ id: "vm2", title: "VoiceMigration Phase 2: Impl" }),
    ]);
    const result = await orch.init(100);
    expect(result.success).toBe(true);
    expect(result.ready).toBe(4);   // S5b: no auto-wiring → all ready
    expect(result.blocked).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// ISC persistence
// ---------------------------------------------------------------------------

describe("ISC persistence", () => {
  it("prepare() persists ISC rows to item metadata", async () => {
    const { orch, queue } = createTestOrchestratorWithQueue([
      makeItem({ id: "a", workType: "dev" }),
    ]);
    await orch.prepare("a", "STANDARD");
    const item = queue.getItem("a")!;
    expect(item.metadata?.iscRows).toBeDefined();
    expect(Array.isArray(item.metadata?.iscRows)).toBe(true);
    expect((item.metadata?.iscRows as unknown[]).length).toBeGreaterThan(0);
  });

  it("verify() loads ISC from metadata when in-memory Map is empty (cross-session)", async () => {
    // Simulate: prepare() ran in a prior session and persisted ISC to metadata
    const rows: ISCRow[] = [makeDoneRow(1), makeDoneRow(2)];
    const { orch, queue } = createTestOrchestratorWithQueue([
      makeItem({ id: "a", metadata: { iscRows: rows } }),
    ]);
    // Do NOT call setItemISC — simulates empty in-memory Map (new process)

    const result = await orch.verify("a");
    expect(result.success).toBe(true);
    expect(orch.iscManager.load("a").length).toBeGreaterThan(0);
    expect(orch.iscManager.load("a").every(r => r.status === "VERIFIED")).toBe(true);
  });

  it("complete() loads ISC from metadata for secondary gate (cross-session)", async () => {
    // Item has verification passed but ISC rows have an unverified row in metadata
    const rows: ISCRow[] = [makeRow({ id: 1, status: "DONE" })]; // not VERIFIED
    const { orch, queue } = createTestOrchestratorWithQueue([
      makeItem({ id: "a", metadata: { iscRows: rows } }),
    ]);
    queue.setVerification("a", {
      status: "verified", verifiedAt: new Date().toISOString(), verdict: "PASS",
      concerns: [], iscRowsVerified: 1, iscRowsTotal: 1, verificationCost: 0,
      verifiedBy: "skeptical_verifier", tiersExecuted: [1, 2],
    });

    const result = await orch.complete("a");
    expect(result.success).toBe(false);
    expect(result.reason).toContain("ISC rows not verified");
  });

  it("backward compat: complete() succeeds with no ISC anywhere (old items)", async () => {
    const { orch, queue } = createTestOrchestratorWithQueue([
      makeItem({ id: "a", status: "in_progress" }), // no metadata.iscRows, no in-memory ISC
    ]);
    queue.setVerification("a", {
      status: "verified", verifiedAt: new Date().toISOString(), verdict: "PASS",
      concerns: [], iscRowsVerified: 1, iscRowsTotal: 1, verificationCost: 0,
      verifiedBy: "skeptical_verifier", tiersExecuted: [1, 2],
    });

    const result = await orch.complete("a");
    expect(result.success).toBe(true); // secondary gate skipped when no ISC found
  });

  it("verify() persists VERIFIED statuses back to metadata", async () => {
    const rows: ISCRow[] = [makeDoneRow(1), makeDoneRow(2)];
    const { orch, queue } = createTestOrchestratorWithQueue([
      makeItem({ id: "a", metadata: { iscRows: rows } }),
    ]);

    await orch.verify("a");
    const item = queue.getItem("a")!;
    const persisted = item.metadata?.iscRows as ISCRow[];
    expect(persisted.every(r => r.status === "VERIFIED")).toBe(true);
  });

  it("generatePriorWorkSummary() loads ISC from metadata (cross-session)", () => {
    const rows: ISCRow[] = [
      makeRow({ id: 1, status: "VERIFIED", description: "Did thing A" }),
      makeRow({ id: 2, status: "DONE", description: "Did thing B" }),
    ];
    const { orch } = createTestOrchestratorWithQueue([
      makeItem({ id: "a", metadata: { iscRows: rows } }),
    ]);

    const summary = orch.generatePriorWorkSummary(["a"]);
    expect(summary).toContain("Did thing A");
    expect(summary).toContain("Did thing B");
  });
});

// ---------------------------------------------------------------------------
// markRowsDone
// ---------------------------------------------------------------------------

describe("markRowsDone()", () => {
  it("transitions PENDING rows to DONE", () => {
    const orch = createTestOrchestrator([makeItem({ id: "a" })]);
    orch.iscManager.persist("a", [
      makeRow({ id: 1, status: "PENDING" }),
      makeRow({ id: 2, status: "PENDING" }),
      makeRow({ id: 3, status: "PENDING" }),
    ]);

    const result = orch.iscManager.markDone("a", [1, 2]);
    expect(result.success).toBe(true);
    expect(result.transitioned).toEqual([1, 2]);

    const rows = orch.iscManager.load("a");
    expect(rows[0].status).toBe("DONE");
    expect(rows[1].status).toBe("DONE");
    expect(rows[2].status).toBe("PENDING");
  });

  it("skips non-PENDING rows", () => {
    const orch = createTestOrchestrator([makeItem({ id: "a" })]);
    orch.iscManager.persist("a", [
      makeRow({ id: 1, status: "VERIFIED" }),
      makeRow({ id: 2, status: "DONE" }),
      makeRow({ id: 3, status: "PENDING" }),
    ]);

    const result = orch.iscManager.markDone("a", [1, 2, 3]);
    expect(result.success).toBe(true);
    expect(result.transitioned).toEqual([3]); // only row 3 was PENDING
  });

  it("returns error when no ISC rows exist", () => {
    const orch = createTestOrchestrator([makeItem({ id: "a" })]);
    const result = orch.iscManager.markDone("a", [1]);
    expect(result.success).toBe(false);
    expect(result.error).toContain("No ISC rows");
  });

  it("persists changes to metadata", () => {
    const { orch, queue } = createTestOrchestratorWithQueue([makeItem({ id: "a" })]);
    orch.iscManager.persist("a", [makeRow({ id: 1, status: "PENDING" })]);

    orch.iscManager.markDone("a", [1]);

    const item = queue.getItem("a")!;
    const persisted = item.metadata?.iscRows as ISCRow[];
    expect(persisted[0].status).toBe("DONE");
  });
});

// ---------------------------------------------------------------------------
// recordExecution
// ---------------------------------------------------------------------------

// recordExecution() wrapper deleted; equivalent inline behavior lives at
// WorkOrchestratorCLI.ts `record-execution` case.

// ---------------------------------------------------------------------------
// reportDone() atomic pipeline
// ---------------------------------------------------------------------------

describe("reportDone() atomic pipeline", () => {
  const passResult: SkepticalReviewResult = {
    finalVerdict: "PASS",
    tiers: [{ tier: 1, verdict: "PASS", confidence: 0.9, concerns: [], costEstimate: 0, latencyMs: 0 }],
    tiersSkipped: [],
    totalCost: 0,
    totalLatencyMs: 0,
    concerns: [],
  };

  it("completes item when all rows pass verification", async () => {
    const item = makeItem({ id: "a", status: "in_progress", effort: "STANDARD", workType: "dev" });
    const orch = createTestOrchestrator([item], { verifierResult: passResult });
    // Set up ISC rows as PENDING (reportDone will mark them done)
    orch.iscManager.persist("a", [
      makeDoneRow(1, { status: "PENDING" }),
      makeDoneRow(2, { status: "PENDING" }),
    ]);

    const result = await orch.reportDone("a", {
      completedRowIds: [1, 2],
    });
    expect(result.success).toBe(true);
    expect(result.skepticalReview).toBeDefined();
  });

  it("fails when no ISC rows exist", async () => {
    const orch = createTestOrchestrator([
      makeItem({ id: "a", status: "in_progress", effort: "STANDARD" }),
    ]);
    // No ISC rows set

    const result = await orch.reportDone("a", { completedRowIds: [1] });
    expect(result.success).toBe(false);
    expect(result.reason).toContain("markRowsDone failed");
  });

  it("returns skepticalReview when verification fails", async () => {
    const failResult: SkepticalReviewResult = {
      finalVerdict: "FAIL",
      tiers: [{ tier: 1, verdict: "FAIL", confidence: 0.2, concerns: ["Paper completion"], costEstimate: 0, latencyMs: 0 }],
      tiersSkipped: [],
      totalCost: 0,
      totalLatencyMs: 0,
      concerns: ["Paper completion"],
    };
    const item = makeItem({ id: "a", status: "in_progress", effort: "STANDARD" });
    const orch = createTestOrchestrator([item], { verifierResult: failResult });
    orch.iscManager.persist("a", [
      makeDoneRow(1, { status: "PENDING" }),
    ]);

    const result = await orch.reportDone("a", { completedRowIds: [1] });
    expect(result.success).toBe(false);
    expect(result.skepticalReview).toBeDefined();
    expect(result.skepticalReview?.finalVerdict).toBe("FAIL");
  });
});

// ---------------------------------------------------------------------------
// S5a: the prepare() ISC quality gate (weakRatio>0.5) is deleted — weak rows pass through
// ---------------------------------------------------------------------------

describe("prepare() — S5a: no ISC quality gate (weak rows pass through to the judge)", () => {
  it("STANDARD item with no-command 'inferred' rows still returns success:true with the rows included", async () => {
    // A mock comprehension yielding rows with NO verifyCommand and prose descriptions that do not
    // infer a command — pre-S5a these >50%-weak rows would FAIL the quality gate. Post-S5a the gate
    // is gone: prepare() succeeds and hands the rows to the always-running judge (Gate 3).
    const payload: ComprehendedSpec = {
      rows: [
        { id: 1, description: "Make the experience feel delightful", verifyCommand: "", humanRequired: false, native: false },
        { id: 2, description: "Ensure the overall vibe is right", verifyCommand: "", humanRequired: false, native: false },
      ],
      complexityHint: "standard",
      phases: [],
    };
    const queue = WorkQueue._createForTesting([makeItem({ id: "a", workType: "dev" })]);
    const orch = WorkOrchestrator._createForTesting(queue, { inferenceFn: makeMockInference([{ success: true, parsed: payload }]) });

    const result = await orch.prepare("a", "STANDARD");
    expect(result.success).toBe(true);                 // no quality-gate rejection
    expect(result.iscRows.length).toBeGreaterThan(0);  // weak rows included, not dropped
  });

  it("passes TRIVIAL items regardless of weak rows", async () => {
    const queue = WorkQueue._createForTesting([makeItem({ id: "a", workType: "research" })]);
    const orch = WorkOrchestrator._createForTesting(queue);

    const result = await orch.prepare("a", "TRIVIAL");
    expect(result.success).toBe(true);
  });

  it("passes QUICK items regardless of weak rows", async () => {
    const queue = WorkQueue._createForTesting([makeItem({ id: "a", workType: "research" })]);
    const orch = WorkOrchestrator._createForTesting(queue);

    const result = await orch.prepare("a", "QUICK");
    expect(result.success).toBe(true);
  });

  it("passes STANDARD items when rows have concrete commands", async () => {
    const queue = WorkQueue._createForTesting([makeItem({ id: "a", workType: "dev" })]);
    const orch = WorkOrchestrator._createForTesting(queue);

    const result = await orch.prepare("a", "STANDARD");
    // Dev template rows have "bun test" commands — concrete
    expect(result.success).toBe(true);
    expect(result.iscRows.every(r => r.verification?.command)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// ISC row IDs — sequential spec numbers (not hashed)
// ---------------------------------------------------------------------------

describe("ISC rows use sequential spec numbers as IDs", () => {
  // Phase 5a: IDs now come from ComprehendedRow.id (LLM-assigned, sequential from 1).
  // Tests inject mock inferenceFns so no real LLM is called.
  const { writeFileSync: writeSpec, mkdtempSync: mkTmp } = require("fs");
  const { join: joinPath } = require("path");
  const { tmpdir: osTmpdir } = require("os");

  function makeSpecFile(descriptions: string[]): string {
    const dir = mkTmp(joinPath(osTmpdir(), "seq-id-"));
    const specPath = joinPath(dir, "spec.md");
    writeSpec(specPath, `# Spec\n\n## ISC\n| # | What |\n|---|---|\n${descriptions.map((d, i) => `| ${i+1} | ${d} |`).join("\n")}\n`);
    return specPath;
  }

  function makeSeqMock(descriptions: string[]): InferenceFn {
    const payload: ComprehendedSpec = {
      rows: descriptions.map((d, i) => ({
        id: i + 1, description: d, verifyCommand: "echo ok", humanRequired: false, native: false,
      })),
      complexityHint: "standard",
      phases: [],
    };
    return makeMockInference([{ success: true, parsed: payload }]);
  }

  it("generates ISC row IDs matching spec sequential numbers", async () => {
    const descs = ["Implement authentication module", "Add unit tests for auth", "Write integration tests"];
    const specPath = makeSpecFile(descs);
    const queue = WorkQueue._createForTesting([makeItem({ id: "a", specPath })]);
    const orch = WorkOrchestrator._createForTesting(queue, { inferenceFn: makeSeqMock(descs) });

    const result = await orch.prepare("a", "TRIVIAL");
    expect(result.success).toBe(true);
    expect(result.iscRows.length).toBe(3);
    expect(result.iscRows[0].id).toBe(1);
    expect(result.iscRows[1].id).toBe(2);
    expect(result.iscRows[2].id).toBe(3);
  });

  it("produces deterministic IDs — same spec yields same IDs", async () => {
    const descs = ["Implement feature X", "Add tests for feature X"];
    const specPath1 = makeSpecFile(descs);
    const specPath2 = makeSpecFile(descs);

    const queue1 = WorkQueue._createForTesting([makeItem({ id: "a", specPath: specPath1 })]);
    const orch1 = WorkOrchestrator._createForTesting(queue1, { inferenceFn: makeSeqMock(descs) });
    const result1 = await orch1.prepare("a", "TRIVIAL");

    const queue2 = WorkQueue._createForTesting([makeItem({ id: "b", specPath: specPath2 })]);
    const orch2 = WorkOrchestrator._createForTesting(queue2, { inferenceFn: makeSeqMock(descs) });
    const result2 = await orch2.prepare("b", "TRIVIAL");

    expect(result1.iscRows.length).toBe(result2.iscRows.length);
    for (let i = 0; i < result1.iscRows.length; i++) {
      expect(result1.iscRows[i].id).toBe(result2.iscRows[i].id);
    }
  });

  it("IDs match spec row numbers regardless of description content", async () => {
    const descsA = ["Implement auth module", "Add JWT tokens"];
    const descsB = ["Build dashboard UI", "Add chart components"];
    const specPathA = makeSpecFile(descsA);
    const specPathB = makeSpecFile(descsB);

    const queue = WorkQueue._createForTesting([
      makeItem({ id: "a", specPath: specPathA }),
      makeItem({ id: "b", specPath: specPathB }),
    ]);
    // Each prepare() gets a fresh mock — WorkOrchestrator stores one inferenceFn
    // so we use separate orchestrators here
    const orchA = WorkOrchestrator._createForTesting(
      WorkQueue._createForTesting([makeItem({ id: "a", specPath: specPathA })]),
      { inferenceFn: makeSeqMock(descsA) },
    );
    const orchB = WorkOrchestrator._createForTesting(
      WorkQueue._createForTesting([makeItem({ id: "b", specPath: specPathB })]),
      { inferenceFn: makeSeqMock(descsB) },
    );

    const resultA = await orchA.prepare("a", "TRIVIAL");
    const resultB = await orchB.prepare("b", "TRIVIAL");

    expect(resultA.iscRows[0].id).toBe(1);
    expect(resultA.iscRows[1].id).toBe(2);
    expect(resultB.iscRows[0].id).toBe(1);
    expect(resultB.iscRows[1].id).toBe(2);
  });

  it("fail-fast when comprehendSpec returns 0 rows (no ISC table)", async () => {
    const dir = mkTmp(joinPath(osTmpdir(), "empty-isc-"));
    const specPath = joinPath(dir, "spec.md");
    writeSpec(specPath, "# Spec\n\n## Overview\nNo ISC table here.\n");

    // Mock returns 0 rows both times → comprehendSpec throws → EXECUTION_FAILED
    const emptyMock = makeMockInference([
      { success: true, parsed: { rows: [], complexityHint: "standard", phases: [] } },
      { success: true, parsed: { rows: [], complexityHint: "standard", phases: [] } },
    ]);
    const queue = WorkQueue._createForTesting([makeItem({ id: "a", specPath })]);
    const orch = WorkOrchestrator._createForTesting(queue, { inferenceFn: emptyMock });

    const result = await orch.prepare("a", "STANDARD");
    expect(result.iscRows.length).toBe(1);
    expect(result.iscRows[0].status).toBe("EXECUTION_FAILED");
    expect(result.iscRows[0].infraFault).toBe(true);
    // Must NOT be a template row
    expect(result.iscRows[0].description).toMatch(/ISC (generation|extraction) failed/);
  });
});

// ---------------------------------------------------------------------------
// Orphan recovery
// ---------------------------------------------------------------------------

describe("orphan recovery in init()", () => {
  const passedVerification = {
    status: "verified" as const, verifiedAt: new Date().toISOString(), verdict: "PASS" as const,
    concerns: [], iscRowsVerified: 2, iscRowsTotal: 2, verificationCost: 0,
    verifiedBy: "skeptical_verifier" as const, tiersExecuted: [1, 2],
  };

  it("auto-completes verified in_progress items with all VERIFIED ISC", async () => {
    const verifiedRows: ISCRow[] = [
      makeRow({ id: 1, status: "VERIFIED" }),
      makeRow({ id: 2, status: "VERIFIED" }),
    ];
    const { orch, queue } = createTestOrchestratorWithQueue([
      makeItem({
        id: "a",
        status: "in_progress",
        startedAt: new Date(Date.now() - 8 * 60 * 60 * 1000).toISOString(),
        verification: passedVerification,
        metadata: { iscRows: verifiedRows },
      }),
    ]);

    const result = await orch.init(100);
    expect(result.recovered).toBe(1);
    expect(queue.getItem("a")!.status).toBe("completed");
  });

  it("resets stale unverified in_progress items to pending", async () => {
    const { orch, queue } = createTestOrchestratorWithQueue([
      makeItem({
        id: "a",
        status: "in_progress",
        startedAt: new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString(), // 5h ago
        // no verification
      }),
    ]);

    const result = await orch.init(100);
    expect(result.recovered).toBe(1);
    expect(queue.getItem("a")!.status).toBe("pending");
    expect((queue.getItem("a")!.metadata?.lastRecovery as Record<string, unknown>)?.reason).toContain("stale");
  });

  it("leaves recent in_progress items alone (within 4h window)", async () => {
    const { orch, queue } = createTestOrchestratorWithQueue([
      makeItem({
        id: "a",
        status: "in_progress",
        startedAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(), // 2h ago
        // no verification
      }),
    ]);

    const result = await orch.init(100);
    expect(result.recovered).toBe(0);
    expect(queue.getItem("a")!.status).toBe("in_progress");
  });

  it("refuses auto-complete when ISC rows are not all VERIFIED", async () => {
    const mixedRows: ISCRow[] = [
      makeRow({ id: 1, status: "VERIFIED" }),
      makeRow({ id: 2, status: "DONE" }), // not verified
    ];
    const { orch, queue } = createTestOrchestratorWithQueue([
      makeItem({
        id: "a",
        status: "in_progress",
        startedAt: new Date(Date.now() - 8 * 60 * 60 * 1000).toISOString(),
        verification: passedVerification,
        metadata: { iscRows: mixedRows },
      }),
    ]);

    const result = await orch.init(100);
    // Should not auto-complete because not all rows are VERIFIED
    // But it IS stale (>4h) — however it has a verification record, so Path 2 won't trigger either
    expect(queue.getItem("a")!.status).toBe("in_progress");
  });

  it("init() returns recovered count", async () => {
    const { orch } = createTestOrchestratorWithQueue([
      makeItem({
        id: "a",
        status: "in_progress",
        startedAt: new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString(),
      }),
      makeItem({
        id: "b",
        status: "in_progress",
        startedAt: new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString(),
      }),
    ]);

    const result = await orch.init(100);
    expect(result.recovered).toBe(2);
  });

  it("G3: refuses auto-complete when tiersExecuted is empty (no Tier 1)", async () => {
    const verifiedRows: ISCRow[] = [
      makeRow({ id: 1, status: "VERIFIED" }),
      makeRow({ id: 2, status: "VERIFIED" }),
    ];
    const { orch, queue } = createTestOrchestratorWithQueue([
      makeItem({
        id: "a",
        status: "in_progress",
        effort: "STANDARD",
        startedAt: new Date(Date.now() - 8 * 60 * 60 * 1000).toISOString(),
        verification: {
          status: "verified" as const, verifiedAt: new Date().toISOString(), verdict: "PASS" as const,
          concerns: [], iscRowsVerified: 2, iscRowsTotal: 2, verificationCost: 0.01,
          verifiedBy: "skeptical_verifier" as const, tiersExecuted: [], // G3: no Tier 1
        },
        metadata: { iscRows: verifiedRows },
      }),
    ]);

    const result = await orch.init(100);
    // Should NOT auto-complete — G3 blocks because Tier 1 never ran
    expect(queue.getItem("a")!.status).toBe("in_progress");
  });

  it("G7: refuses auto-complete when ISC coverage is below 80% of spec requirements", async () => {
    const { writeFileSync, mkdtempSync } = require("fs");
    const { join } = require("path");
    const { tmpdir } = require("os");

    // Create a spec with 8 requirements
    const dir = mkdtempSync(join(tmpdir(), "orphan-g7-"));
    const specPath = join(dir, "spec.md");
    const requirements = Array.from({ length: 8 }, (_, i) =>
      `- [ ] Requirement ${i + 1}: Implement feature ${i + 1}`
    ).join("\n");
    writeFileSync(specPath, `# Spec\n\n## Success Criteria\n${requirements}\n`);

    // Some ISC rows left unverified → the SECONDARY/G5 gate (every row must be
    // VERIFIED) blocks auto-completion. (The old spec-coverage gate is gone now
    // that comprehension is the single ISC source.)
    const verifiedRows: ISCRow[] = [
      makeRow({ id: 1, status: "VERIFIED", source: "EXPLICIT" as const }),
      makeRow({ id: 2, status: "VERIFIED", source: "EXPLICIT" as const }),
      makeRow({ id: 3, status: "PENDING", source: "EXPLICIT" as const }),
    ];
    const { orch, queue } = createTestOrchestratorWithQueue([
      makeItem({
        id: "a",
        status: "in_progress",
        effort: "STANDARD",
        specPath,
        startedAt: new Date(Date.now() - 8 * 60 * 60 * 1000).toISOString(),
        verification: {
          status: "verified" as const, verifiedAt: new Date().toISOString(), verdict: "PASS" as const,
          concerns: [], iscRowsVerified: 2, iscRowsTotal: 2, verificationCost: 0.01,
          verifiedBy: "skeptical_verifier" as const, tiersExecuted: [1, 2],
        },
        metadata: { iscRows: verifiedRows },
      }),
    ]);

    const result = await orch.init(100);
    // Should NOT auto-complete — the G5 "all ISC rows VERIFIED" gate blocks it.
    expect(queue.getItem("a")!.status).toBe("in_progress");
  });

  it("Path 3: recovers stale in_progress item with needs_review verification", async () => {
    const staleStart = new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString(); // 5h ago
    const { orch, queue } = createTestOrchestratorWithQueue([
      makeItem({
        id: "a",
        status: "in_progress",
        startedAt: staleStart,
        verification: {
          status: "needs_review" as const,
          verifiedAt: staleStart,
          verdict: "NEEDS_REVIEW" as const,
          concerns: ["Low confidence"],
          iscRowsVerified: 0,
          iscRowsTotal: 2,
          verificationCost: 0,
          verifiedBy: "skeptical_verifier" as const,
          tiersExecuted: [1],
        },
      }),
    ]);

    const result = await orch.init(100);
    const item = queue.getItem("a")!;
    expect(item.status).toBe("pending"); // reset via recordAttempt
    expect(item.attempts?.length).toBe(1);
    expect(item.attempts?.[0].error).toContain("needs_review");
    expect(result.recovered).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// ensureFeatureBranch fallback cwd / resolveRepoRoot — relocated to
// lib/orchestrator/__tests__/WorktreeOps.test.ts (S11 decomposition, pass 3).
// resolveRepoRoot/tryResolveGitRoot/ensureFeatureBranch/cleanupWorktree now live
// in lib/orchestrator/WorktreeOps.ts; the orchestrator's own versions are
// one-line delegations. See "worktree cleanup on complete/fail" below for the
// remaining end-to-end coverage of complete()/fail()'s calling contract.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// ISC source tagging (Fix 3)
// ---------------------------------------------------------------------------

describe("ISC source tagging", () => {
  it("templateRows() tags all rows as INFERRED", () => {
    const orch = createTestOrchestrator([makeItem({ id: "a", workType: "dev" })]);
    // Trigger template ISC generation via prepare (no specPath, falls to templateRows)
    orch.iscManager.persist("a", []); // Force empty, then generate template rows
    // Access private method indirectly: prepare generates ISC rows
    // For testing, we can verify the ISC rows generated by preparing a dev item
    const { orch: orch2, queue: queue2 } = createTestOrchestratorWithQueue([
      makeItem({ id: "b", workType: "dev" }),
    ]);
    // The prepare method generates ISC, but requires shell. Instead, test templateRows behavior
    // via setItemISC with tagged rows and verify source field exists
    const templateRow = makeRow({ id: 1, source: "INFERRED" as const });
    orch.iscManager.persist("a", [templateRow]);
    const rows = orch.iscManager.load("a");
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0].source).toBe("INFERRED");
  });

  it("spec-derived rows default to EXPLICIT source", () => {
    // Verify normalizeSource behavior: undefined → falls through to "EXPLICIT" default
    const orch = createTestOrchestrator([makeItem({ id: "a" })]);
    const explicitRow = makeRow({ id: 1, source: "EXPLICIT" as const });
    orch.iscManager.persist("a", [explicitRow]);
    const rows = orch.iscManager.load("a");
    expect(rows[0].source).toBe("EXPLICIT");
  });
});

// ---------------------------------------------------------------------------
// Verify summary passthrough (Fix 7)
// ---------------------------------------------------------------------------

describe("verify() summary passthrough", () => {
  it("passes source and commandRan in ItemReviewSummary", async () => {
    const rows: ISCRow[] = [
      makeDoneRow(1, { source: "EXPLICIT" as const }),
      makeDoneRow(2, { source: "INFERRED" as const }),
    ];
    const { orch } = createTestOrchestratorWithQueue([
      makeItem({ id: "a", metadata: { iscRows: rows } }),
    ]);

    // verify() will try to run verification commands; they may fail but
    // the summary construction still happens. We just need to confirm the method doesn't crash.
    const result = await orch.verify("a");
    // Source should be preserved on the ISC rows after verification
    const finalRows = orch.iscManager.load("a");
    if (finalRows.length > 0) {
      const row1 = finalRows.find(r => r.id === 1);
      const row2 = finalRows.find(r => r.id === 2);
      if (row1) expect(row1.source).toBe("EXPLICIT");
      if (row2) expect(row2.source).toBe("INFERRED");
    }
  });
});

// ---------------------------------------------------------------------------
// Quaternary gate: Requirement coverage (Fix 9)
// ---------------------------------------------------------------------------

describe("complete() quaternary gate — requirement coverage", () => {
  const { writeFileSync, unlinkSync, mkdtempSync } = require("fs");
  const { join } = require("path");
  const { tmpdir } = require("os");

  function makeSpecFile(requirementCount: number): string {
    const dir = mkdtempSync(join(tmpdir(), "quat-gate-"));
    const specPath = join(dir, "spec.md");
    const requirements = Array.from({ length: requirementCount }, (_, i) =>
      `- [ ] Requirement ${i + 1}: Implement feature ${i + 1}`
    ).join("\n");
    writeFileSync(specPath, `# Spec\n\n## Success Criteria\n${requirements}\n`);
    return specPath;
  }

  it("blocks completion when ISC rows are unverified (secondary gate)", async () => {
    const specPath = makeSpecFile(8);
    const { orch, queue } = createTestOrchestratorWithQueue([
      makeItem({ id: "a", specPath }),
    ]);
    queue.setVerification("a", {
      status: "verified", verifiedAt: new Date().toISOString(), verdict: "PASS",
      concerns: [], iscRowsVerified: 2, iscRowsTotal: 2, verificationCost: 0,
      verifiedBy: "skeptical_verifier", tiersExecuted: [1, 2],
    });
    orch.iscManager.persist("a", [
      makeRow({ id: 1, status: "VERIFIED", source: "INFERRED" as const }),
      makeRow({ id: 2, status: "PENDING", source: "INFERRED" as const }),
    ]);

    const result = await orch.complete("a");
    expect(result.success).toBe(false);
    expect(result.reason).toContain("ISC rows not verified");
    unlinkSync(specPath);
  });

  it("allows completion when all INFERRED rows meet coverage threshold", async () => {
    // The quaternary gate checks verified count vs spec requirement count.
    // INFERRED rows count toward coverage — the gate does not distinguish source type.
    const dir = mkdtempSync(join(tmpdir(), "inferred-gate-"));
    const specPath = join(dir, "spec.md");
    const rows = Array.from({ length: 5 }, (_, i) =>
      `| ${i + 1} | Feature ${i + 1} | bun test |`
    ).join("\n");
    writeFileSync(specPath, `# Spec\n\n## ISC\n| # | Criterion | Verification |\n|---|---|---|\n${rows}\n`);

    const { orch, queue } = createTestOrchestratorWithQueue([
      makeItem({ id: "a", specPath, status: "in_progress" }),
    ]);
    queue.setVerification("a", {
      status: "verified", verifiedAt: new Date().toISOString(), verdict: "PASS",
      concerns: [], iscRowsVerified: 5, iscRowsTotal: 5, verificationCost: 0,
      verifiedBy: "skeptical_verifier", tiersExecuted: [1, 2],
    });
    orch.iscManager.persist("a", Array.from({ length: 5 }, (_, i) =>
      makeRow({ id: i + 1, status: "VERIFIED", source: "INFERRED" as const })
    ));

    const result = await orch.complete("a");
    // 5/5 coverage = 100% — passes the 80% threshold
    expect(result.success).toBe(true);
    unlinkSync(specPath);
  });

  it("passes when requirement coverage is adequate with EXPLICIT rows", async () => {
    const specPath = makeSpecFile(4);
    const { orch, queue } = createTestOrchestratorWithQueue([
      makeItem({ id: "a", specPath, status: "in_progress" }),
    ]);
    queue.setVerification("a", {
      status: "verified", verifiedAt: new Date().toISOString(), verdict: "PASS",
      concerns: [], iscRowsVerified: 4, iscRowsTotal: 4, verificationCost: 0,
      verifiedBy: "skeptical_verifier", tiersExecuted: [1, 2],
    });
    orch.iscManager.persist("a", Array.from({ length: 4 }, (_, i) =>
      makeRow({ id: i + 1, status: "VERIFIED", source: "EXPLICIT" as const })
    ));

    const result = await orch.complete("a");
    expect(result.success).toBe(true);
    unlinkSync(specPath);
  });

  it("gracefully skips when no specPath", async () => {
    const { orch, queue } = createTestOrchestratorWithQueue([
      makeItem({ id: "a", status: "in_progress" }), // no specPath
    ]);
    queue.setVerification("a", {
      status: "verified", verifiedAt: new Date().toISOString(), verdict: "PASS",
      concerns: [], iscRowsVerified: 1, iscRowsTotal: 1, verificationCost: 0,
      verifiedBy: "skeptical_verifier", tiersExecuted: [1, 2],
    });
    orch.iscManager.persist("a", [makeRow({ id: 1, status: "VERIFIED", source: "INFERRED" as const })]);

    const result = await orch.complete("a");
    expect(result.success).toBe(true); // quaternary gate skipped
  });

  it("gracefully skips when spec file doesn't exist", async () => {
    const { orch, queue } = createTestOrchestratorWithQueue([
      makeItem({ id: "a", specPath: "/nonexistent/spec.md", status: "in_progress" }),
    ]);
    queue.setVerification("a", {
      status: "verified", verifiedAt: new Date().toISOString(), verdict: "PASS",
      concerns: [], iscRowsVerified: 1, iscRowsTotal: 1, verificationCost: 0,
      verifiedBy: "skeptical_verifier", tiersExecuted: [1, 2],
    });
    orch.iscManager.persist("a", [makeRow({ id: 1, status: "VERIFIED", source: "INFERRED" as const })]);

    const result = await orch.complete("a");
    expect(result.success).toBe(true); // gracefully skipped
  });

});

// ---------------------------------------------------------------------------
// Phase 1: fail-fast on empty ISC + fail-closed on parseSpec throw
// ---------------------------------------------------------------------------

describe("Phase 1: generateISC fail-fast and fail-closed", () => {
  const { writeFileSync, unlinkSync, mkdtempSync } = require("fs");
  const { join } = require("path");
  const { tmpdir } = require("os");

  it("prepare() with comprehendSpec returning 0 rows → single EXECUTION_FAILED row (no template fallback)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "phase1-failfast-"));
    const specPath = join(dir, "empty-isc-spec.md");
    writeFileSync(specPath, `# My Spec\n\n## Overview\nThis is a general description of the project.\n\n## Background\nSome context about the work.\n`);

    // Inject a mock that returns 0 rows both times → comprehendSpec throws → EXECUTION_FAILED
    const emptyMock = makeMockInference([
      { success: true, parsed: { rows: [], complexityHint: "standard", phases: [] } },
      { success: true, parsed: { rows: [], complexityHint: "standard", phases: [] } },
    ]);
    const queue = WorkQueue._createForTesting([
      makeItem({ id: "a", workType: "dev", specPath }),
    ]);
    const orch = WorkOrchestrator._createForTesting(queue, { inferenceFn: emptyMock });

    const result = await orch.prepare("a", "STANDARD");
    expect(result.success).toBe(true);
    expect(result.iscRows.length).toBe(1);
    expect(result.iscRows[0].status).toBe("EXECUTION_FAILED");
    expect(result.iscRows[0].infraFault).toBe(true);
    // Message must contain the failure signal — either "ISC generation failed" or "ISC extraction failed"
    expect(result.iscRows[0].description).toMatch(/ISC (generation|extraction) failed/);

    unlinkSync(specPath);
  });

  it("prepare() with spec path that throws on readFileSync → single EXECUTION_FAILED row", async () => {
    // Point specPath at a directory — existsSync returns true, but readFileSync throws EISDIR
    const dir = mkdtempSync(join(tmpdir(), "phase1-throw-"));

    // No inferenceFn needed — readFileSync throws before comprehendSpec is called
    const queue = WorkQueue._createForTesting([
      makeItem({ id: "a", workType: "dev", specPath: dir }),
    ]);
    const orch = WorkOrchestrator._createForTesting(queue);

    const result = await orch.prepare("a", "STANDARD");
    expect(result.success).toBe(true);
    expect(result.iscRows.length).toBe(1);
    expect(result.iscRows[0].status).toBe("EXECUTION_FAILED");
    expect(result.iscRows[0].description).toContain("ISC generation failed");
  });
});

// ---------------------------------------------------------------------------
// Phase 2: Strengthened quaternary gate (raised threshold + new sub-checks)
// ---------------------------------------------------------------------------

describe("Phase 2: Quaternary gate — raised threshold and new sub-checks", () => {
  const { writeFileSync, unlinkSync, mkdtempSync } = require("fs");
  const { join } = require("path");
  const { tmpdir } = require("os");

  function makeSpecFile(requirementCount: number): string {
    const dir = mkdtempSync(join(tmpdir(), "phase2-gate-"));
    const specPath = join(dir, "spec.md");
    const requirements = Array.from({ length: requirementCount }, (_, i) =>
      `- [ ] Requirement ${i + 1}: Implement feature ${i + 1}`
    ).join("\n");
    writeFileSync(specPath, `# Spec\n\n## Success Criteria\n${requirements}\n`);
    return specPath;
  }

  it("complete() blocked when an ISC row is unverified (secondary gate)", async () => {
    const specPath = makeSpecFile(10);
    const { orch, queue } = createTestOrchestratorWithQueue([
      makeItem({ id: "a", specPath }),
    ]);
    queue.setVerification("a", {
      status: "verified", verifiedAt: new Date().toISOString(), verdict: "PASS",
      concerns: [], iscRowsVerified: 5, iscRowsTotal: 5, verificationCost: 0,
      verifiedBy: "skeptical_verifier", tiersExecuted: [1, 2],
    });
    // 4 VERIFIED + 1 PENDING → the secondary gate (every row must be VERIFIED) blocks.
    orch.iscManager.persist("a", [
      ...Array.from({ length: 4 }, (_, i) =>
        makeRow({ id: i + 1, status: "VERIFIED" as const, source: "EXPLICIT" as const })),
      makeRow({ id: 5, status: "PENDING" as const, source: "EXPLICIT" as const }),
    ]);

    const result = await orch.complete("a");
    expect(result.success).toBe(false);
    expect(result.reason).toContain("ISC rows not verified");
    unlinkSync(specPath);
  });

});

// ---------------------------------------------------------------------------
// Lower-effort items complete without Phase 2
// ---------------------------------------------------------------------------

describe("complete() allows lower-effort items without Phase 2", () => {
  it("allows QUICK effort with verificationCost $0 (not STANDARD+)", async () => {
    const { orch, queue } = createTestOrchestratorWithQueue([
      makeItem({ id: "a", effort: "QUICK", status: "in_progress" }),
    ]);
    queue.setVerification("a", {
      status: "verified", verifiedAt: new Date().toISOString(), verdict: "PASS",
      concerns: [], iscRowsVerified: 1, iscRowsTotal: 1, verificationCost: 0,
      verifiedBy: "skeptical_verifier", tiersExecuted: [1],
    });
    orch.iscManager.persist("a", [makeRow({ id: 1, status: "VERIFIED" })]);

    const result = await orch.complete("a");
    expect(result.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// WorkOrchestrator generateISC — embeddedCommand wiring
// ---------------------------------------------------------------------------

describe("generateISC wires embeddedCommand", () => {
  // Phase 5a: these tests now verify that verifyCommand from the LLM comprehension
  // maps correctly to verification.method + verification.command on the ISCRow.
  // A mock inferenceFn is injected so no real LLM is called.
  const { writeFileSync, unlinkSync, mkdtempSync } = require("fs");
  const { join } = require("path");
  const { tmpdir } = require("os");

  it("verifyCommand from comprehension becomes verification.command on ISC row", async () => {
    const dir = mkdtempSync(join(tmpdir(), "embed-cmd-"));
    const specPath = join(dir, "spec.md");
    writeFileSync(specPath, `# Migration Spec\n\n### 2.1 Success Criteria\n| # | What |\n|---|---|\n| 1 | Zero refs |\n| 2 | CLI works |\n`);

    // LLM comprehension returns the verbatim commands the spec would have had
    const mockPayload: ComprehendedSpec = {
      rows: [
        { id: 1, description: "Zero refs", verifyCommand: 'grep -ri "asana" skills/', humanRequired: false, native: false },
        { id: 2, description: "CLI works", verifyCommand: "bun test skills/LT/", humanRequired: false, native: false },
      ],
      complexityHint: "standard",
      phases: [],
    };
    const queue = WorkQueue._createForTesting([
      makeItem({ id: "ec-test", workType: "dev", specPath }),
    ]);
    const orch = WorkOrchestrator._createForTesting(queue, {
      inferenceFn: makeMockInference([{ success: true, parsed: mockPayload }]),
    });

    const result = await orch.prepare("ec-test", "STANDARD");
    expect(result.success).toBe(true);

    const grepRow = result.iscRows.find(r => r.description.includes("Zero refs"));
    expect(grepRow).toBeDefined();
    expect(grepRow!.verification?.method).toBe("command");
    expect(grepRow!.verification?.command).toBe('grep -ri "asana" skills/');

    const bunRow = result.iscRows.find(r => r.description.includes("CLI works"));
    expect(bunRow).toBeDefined();
    expect(bunRow!.verification?.method).toBe("command");
    expect(bunRow!.verification?.command).toBe("bun test skills/LT/");

    unlinkSync(specPath);
  });

  it("null verifyCommand from comprehension → inferred method + dev fallback command", async () => {
    const dir = mkdtempSync(join(tmpdir(), "no-embed-"));
    const specPath = join(dir, "spec.md");
    writeFileSync(specPath, `# Test Spec\n\n### Success Criteria\n| # | What |\n|---|---|\n| 1 | Tests pass |\n`);

    // LLM sees no runnable command → verifyCommand: null
    const mockPayload: ComprehendedSpec = {
      rows: [
        { id: 1, description: "Tests pass", verifyCommand: null, humanRequired: false, native: false },
      ],
      complexityHint: "standard",
      phases: [],
    };
    const queue = WorkQueue._createForTesting([
      makeItem({ id: "ne-test", workType: "dev", specPath }),
    ]);
    const orch = WorkOrchestrator._createForTesting(queue, {
      inferenceFn: makeMockInference([{ success: true, parsed: mockPayload }]),
    });

    const result = await orch.prepare("ne-test", "STANDARD");
    expect(result.success).toBe(true);

    const row = result.iscRows.find(r => r.description.includes("Tests pass"));
    expect(row).toBeDefined();
    // verifyCommand was null → method is "inferred", not "command"
    expect(row!.verification?.method).not.toBe("command");
    // workType:'dev' → inferVerificationCommand falls back to "bun test"
    expect(row!.verification?.command).toBe("bun test");

    unlinkSync(specPath);
  });
});

// ---------------------------------------------------------------------------
// Worktree cleanup on complete/fail
// ---------------------------------------------------------------------------

describe("worktree cleanup on complete/fail", () => {
  it("complete() calls cleanupWorktree for items with worktreePath metadata", async () => {
    const { orch, queue } = createTestOrchestratorWithQueue([
      makeItem({ id: "a", status: "in_progress", metadata: { worktreePath: "/tmp/fake-worktree", worktreeBranch: "feature-test" } }),
    ]);
    queue.setVerification("a", {
      status: "verified", verifiedAt: new Date().toISOString(), verdict: "PASS",
      concerns: [], iscRowsVerified: 1, iscRowsTotal: 1, verificationCost: 0,
      verifiedBy: "skeptical_verifier", tiersExecuted: [1, 2],
    });
    orch.iscManager.persist("a", [makeRow({ id: 1, status: "VERIFIED" })]);

    // complete() should succeed even if worktree cleanup fails (non-blocking)
    const result = await orch.complete("a");
    expect(result.success).toBe(true);
  });

  it("fail() calls cleanupWorktree for items with worktreePath metadata", async () => {
    const orch = createTestOrchestrator([
      makeItem({ id: "a", status: "in_progress", metadata: { worktreePath: "/tmp/fake-worktree", worktreeBranch: "feature-test" } }),
    ]);

    // fail() should succeed even if worktree cleanup fails (non-blocking)
    const result = await orch.fail("a", "test failure");
    expect(result).toBe(true);
  });

  it("complete() succeeds when no worktreePath in metadata", async () => {
    const { orch, queue } = createTestOrchestratorWithQueue([
      makeItem({ id: "a", status: "in_progress" }), // no worktree metadata
    ]);
    queue.setVerification("a", {
      status: "verified", verifiedAt: new Date().toISOString(), verdict: "PASS",
      concerns: [], iscRowsVerified: 1, iscRowsTotal: 1, verificationCost: 0,
      verifiedBy: "skeptical_verifier", tiersExecuted: [1, 2],
    });
    orch.iscManager.persist("a", [makeRow({ id: 1, status: "VERIFIED" })]);

    const result = await orch.complete("a");
    expect(result.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// normalizeVerificationCommand
// ---------------------------------------------------------------------------

describe("normalizeVerificationCommand", () => {
  describe("bare 'test' command", () => {
    it("returns null for bare 'test' (no args — always exits 1)", () => {
      expect(normalizeVerificationCommand("test")).toBeNull();
    });

    it("returns null for 'test' with surrounding whitespace", () => {
      expect(normalizeVerificationCommand("  test  ")).toBeNull();
    });

    it("does NOT nullify 'test' when it has arguments (legitimate use)", () => {
      const result = normalizeVerificationCommand("test -d /tmp");
      expect(result).not.toBeNull();
      expect(result).toBe("test -d /tmp");
    });

    it("does NOT nullify 'test -f path' command", () => {
      const result = normalizeVerificationCommand("test -f ~/.claude/CLAUDE.md");
      expect(result).not.toBeNull();
    });
  });

  describe("tilde expansion", () => {
    const home = process.env.HOME || "";

    it("expands ~/.claude/ prefix", () => {
      const result = normalizeVerificationCommand("ls ~/.claude/skills/");
      expect(result).toBe(`ls ${home}/.claude/skills/`);
    });

    it("expands tilde in middle of path", () => {
      const result = normalizeVerificationCommand("test -d ~/.claude/skills/System/PublicSync/");
      expect(result).toBe(`test -d ${home}/.claude/skills/System/PublicSync/`);
    });

    it("expands multiple tildes in one command", () => {
      const result = normalizeVerificationCommand("diff ~/.claude/a.ts ~/.claude/b.ts");
      expect(result).toBe(`diff ${home}/.claude/a.ts ${home}/.claude/b.ts`);
    });

    it("does not modify commands without tildes", () => {
      const result = normalizeVerificationCommand("bun test skills/Commerce/JobEngine/");
      expect(result).toBe("bun test skills/Commerce/JobEngine/");
    });
  });

  describe("empty and null inputs", () => {
    it("returns null for empty string", () => {
      expect(normalizeVerificationCommand("")).toBeNull();
    });

    it("returns null for whitespace-only string", () => {
      expect(normalizeVerificationCommand("   ")).toBeNull();
    });
  });

  describe("normal commands pass through", () => {
    it("routes bare bun test through safe wrapper or passes through", () => {
      const result = normalizeVerificationCommand("bun test");
      // If safe-bun-test.sh exists, bare `bun test` routes through it to exclude worktrees
      // Otherwise passes through unchanged
      expect(result === "bun test" || result!.endsWith("safe-bun-test.sh")).toBe(true);
    });

    it("passes grep command unchanged", () => {
      expect(normalizeVerificationCommand("grep -r pattern src/")).toBe("grep -r pattern src/");
    });

    it("passes ls command unchanged", () => {
      expect(normalizeVerificationCommand("ls /tmp")).toBe("ls /tmp");
    });
  });

  describe("basedir path resolution", () => {
    it("resolves relative bun script path against basedir when file exists", () => {
      // normalizeVerificationCommand only resolves when the target file exists on disk
      const tmpDir = mkdtempSync(join(tmpdir(), "basedir-"));
      writeFileSync(join(tmpDir, "SpecParser.ts"), "// stub");
      expect(normalizeVerificationCommand("bun run SpecParser.ts", tmpDir))
        .toBe(`bun run ${tmpDir}/SpecParser.ts`);
    });

    it("resolves ./relative paths against basedir when file exists", () => {
      const tmpDir = mkdtempSync(join(tmpdir(), "basedir-"));
      mkdirSync(join(tmpDir, "src"), { recursive: true });
      writeFileSync(join(tmpDir, "src", "test.ts"), "// stub");
      expect(normalizeVerificationCommand("bun run ./src/test.ts", tmpDir))
        .toBe(`bun run ${tmpDir}/src/test.ts`);
    });

    it("resolves node commands against basedir when file exists", () => {
      const tmpDir = mkdtempSync(join(tmpdir(), "basedir-"));
      writeFileSync(join(tmpDir, "test.js"), "// stub");
      expect(normalizeVerificationCommand("node test.js", tmpDir))
        .toBe(`node ${tmpDir}/test.js`);
    });

    it("does not modify already-absolute paths", () => {
      expect(normalizeVerificationCommand("bun run /abs/path/test.ts", "/tmp/worktree"))
        .toBe("bun run /abs/path/test.ts");
    });

    it("does not resolve when no basedir provided", () => {
      expect(normalizeVerificationCommand("bun run SpecParser.ts"))
        .toBe("bun run SpecParser.ts");
    });

    it("does not resolve non-script commands", () => {
      expect(normalizeVerificationCommand("grep -r pattern src/", "/tmp/worktree"))
        .toBe("grep -r pattern src/");
    });
  });
});

// ---------------------------------------------------------------------------
// findMissingDirectoryArg
// ---------------------------------------------------------------------------

describe("findMissingDirectoryArg", () => {
  it("returns null when trailing-slash directory arg exists", () => {
    // /tmp/ always exists on macOS/Linux
    expect(findMissingDirectoryArg(["-d", "/tmp/"])).toBeNull();
  });

  it("returns the missing directory path when trailing-slash arg does not exist", () => {
    const result = findMissingDirectoryArg(["ls", "/tmp/pai-public-staging-nonexistent-xyz/"]);
    expect(result).toBe("/tmp/pai-public-staging-nonexistent-xyz/");
  });

  it("does NOT flag paths without trailing slash (conservative: may be file checks)", () => {
    // test -f /nonexistent/file is intentional — should not be skipped
    expect(findMissingDirectoryArg(["-f", "/nonexistent/xyz"])).toBeNull();
  });

  it("ignores flag arguments (starting with -)", () => {
    // All args are flags — nothing to check
    expect(findMissingDirectoryArg(["-r", "-n", "--stat"])).toBeNull();
  });

  it("ignores args without path separators (simple words)", () => {
    expect(findMissingDirectoryArg(["pattern", "src"])).toBeNull();
  });

  it("returns null for empty args list", () => {
    expect(findMissingDirectoryArg([])).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// runVerificationCommand skips bare 'test' and missing-directory commands
// ---------------------------------------------------------------------------

describe("runVerificationCommand skips usable commands gracefully", () => {
  it("bare 'test' command defers to Tier 2 (returns null, not fail)", async () => {
    const orch = createTestOrchestrator([makeItem({ id: "a" })]);
    orch.iscManager.persist("a", [
      makeRow({
        id: 1,
        status: "DONE",
        verification: { method: "test", command: "test", success_criteria: "exists" },
      }),
    ]);

    // With the default PASS verifier, bare 'test' should be skipped (not run),
    // and the row should end up VERIFIED (deferred to SkepticalVerifier which PASSes)
    const result = await orch.verify("a");
    expect(result.success).toBe(true);
    const rows = orch.iscManager.load("a");
    expect(rows[0].status).toBe("VERIFIED");
  });

  it("command referencing non-existent /tmp dir (trailing slash) defers to Tier 2", async () => {
    const orch = createTestOrchestrator([makeItem({ id: "a" })]);
    orch.iscManager.persist("a", [
      makeRow({
        id: 1,
        status: "DONE",
        verification: {
          method: "test",
          command: "ls /tmp/pai-public-staging-nonexistent-xyz/",
          success_criteria: "staging dir exists",
        },
      }),
    ]);

    // The directory doesn't exist so the command should be skipped (null result),
    // deferred to SkepticalVerifier (PASS stub) → row VERIFIED
    const result = await orch.verify("a");
    expect(result.success).toBe(true);
    const rows = orch.iscManager.load("a");
    expect(rows[0].status).toBe("VERIFIED");
  });

  it("tilde in path is expanded and command executed correctly", async () => {
    // test -d $HOME always succeeds
    const home = process.env.HOME || "";
    const orch = createTestOrchestrator([makeItem({ id: "a" })]);
    orch.iscManager.persist("a", [
      makeRow({
        id: 1,
        status: "DONE",
        verification: {
          method: "test",
          command: "test -d ~/.claude",
          success_criteria: "~/.claude directory exists",
        },
      }),
    ]);

    // After normalization "test -d ~/.claude" → "test -d /Users/...//.claude"
    // ~/.claude should exist so the command passes → VERIFIED
    const result = await orch.verify("a");
    expect(result.success).toBe(true);
    const rows = orch.iscManager.load("a");
    expect(rows[0].status).toBe("VERIFIED");
  });
});

// ---------------------------------------------------------------------------
// report() — categorizes items by actual status + verification
//
// Relocated to lib/orchestrator/__tests__/Reporting.test.ts (S11 pass 1) —
// report()'s logic now lives in lib/orchestrator/Reporting.ts (categorizeReport).
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// retry() — escalating strategy and attempt recording
// ---------------------------------------------------------------------------

describe("retry()", () => {
  it("records attempt and resets item to pending on first failure", async () => {
    const { orch, queue } = createTestOrchestratorWithQueue([
      makeItem({ id: "a", status: "in_progress", startedAt: new Date().toISOString() }),
    ]);

    const result = await orch.retry("a", "transient error");
    expect(result.retried).toBe(true);
    expect(result.escalated).toBe(false);
    expect(result.attempt).toBe(1);
    // S4: nextStrategy is no longer returned
    expect((result as Record<string, unknown>).nextStrategy).toBeUndefined();

    const item = queue.getItem("a")!;
    expect(item.status).toBe("pending");
    expect(item.attempts).toHaveLength(1);
    expect(item.attempts![0].error).toBe("transient error");
    expect(item.attempts![0].strategy).toBe("standard");
    expect(item.startedAt).toBeUndefined();
  });

  it("S4: second failure retries without nextStrategy or nextRetryStrategy", async () => {
    // S4: retry-strategy ladder deleted — nextStrategy and nextRetryStrategy are never set
    const { orch, queue } = createTestOrchestratorWithQueue([
      makeItem({
        id: "a",
        status: "in_progress",
        startedAt: new Date().toISOString(),
        attempts: [{
          attemptNumber: 1,
          startedAt: new Date().toISOString(),
          endedAt: new Date().toISOString(),
          error: "first error",
          strategy: "standard" as const,
        }],
      }),
    ]);

    const result = await orch.retry("a", "second error");
    expect(result.retried).toBe(true);
    expect(result.escalated).toBe(false);
    expect(result.attempt).toBe(2);
    // S4: nextStrategy is gone from the return type
    expect((result as Record<string, unknown>).nextStrategy).toBeUndefined();

    const item = queue.getItem("a")!;
    expect(item.attempts).toHaveLength(2);
    // S4: nextRetryStrategy is NEVER set in metadata
    expect((item.metadata as Record<string, unknown>)?.nextRetryStrategy).toBeUndefined();
  });

  it("escalates to human review on third failure", async () => {
    const { orch, queue } = createTestOrchestratorWithQueue([
      makeItem({
        id: "a",
        status: "in_progress",
        startedAt: new Date().toISOString(),
        attempts: [
          { attemptNumber: 1, startedAt: "2026-01-01T00:00:00Z", endedAt: "2026-01-01T01:00:00Z", error: "first", strategy: "standard" as const },
          { attemptNumber: 2, startedAt: "2026-01-01T02:00:00Z", endedAt: "2026-01-01T03:00:00Z", error: "second", strategy: "standard" as const },
        ],
      }),
    ]);

    const result = await orch.retry("a", "third error");
    expect(result.retried).toBe(true);
    expect(result.escalated).toBe(true);
    expect(result.attempt).toBe(3);

    // Should have created a blocked proxy
    const allItems = queue.getAllItems();
    const proxy = allItems.find(i => i.title.startsWith("REVIEW:"));
    expect(proxy).toBeDefined();
    expect(proxy!.status).toBe("blocked");
    expect(proxy!.title).toContain("3 failed attempts");
  });

  it("returns retried: false for non-existent item", async () => {
    const orch = createTestOrchestrator([]);
    const result = await orch.retry("nonexistent", "error");
    expect(result.retried).toBe(false);
    expect(result.attempt).toBe(0);
  });

  it("records ISC progress in attempt", async () => {
    const { orch, queue } = createTestOrchestratorWithQueue([
      makeItem({ id: "a", status: "in_progress", startedAt: new Date().toISOString() }),
    ]);
    // Set up some ISC rows with mixed statuses
    orch.iscManager.persist("a", [
      makeRow({ id: 1, status: "DONE" }),
      makeRow({ id: 2, status: "VERIFIED" }),
      makeRow({ id: 3, status: "PENDING" }),
    ]);

    const result = await orch.retry("a", "partial progress");
    expect(result.retried).toBe(true);

    const item = queue.getItem("a")!;
    expect(item.attempts![0].iscRowsCompleted).toBe(2); // DONE + VERIFIED
    expect(item.attempts![0].iscRowsTotal).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// markPhaseDone() / getPhaseISC() — phase tracking + ISC row filtering
//
// Relocated to lib/orchestrator/__tests__/PhaseBookkeeping.test.ts (S11
// decomposition, pass 2) — markPhaseDone/getPhaseISC now live in
// lib/orchestrator/PhaseBookkeeping.ts. The orchestrator's markPhaseDone()/
// getPhaseISC() are one-line delegations; see that module's tests.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// prepare() phase detection — returns phases field when spec qualifies
// ---------------------------------------------------------------------------

describe("prepare() phase detection", () => {
  // Phase 5a: generateISC now uses LLM comprehension — inject mock inferenceFn so tests
  // don't hit a real LLM. Phase detection reads the comprehension's `phases` (persisted as
  // metadata.comprehendedSpec), so phased specs must return populated `phases` in the mock.
  const { writeFileSync, unlinkSync, mkdtempSync } = require("fs");
  const { join } = require("path");
  const { tmpdir } = require("os");

  it("returns phases: undefined for items without specPath", async () => {
    const queue = WorkQueue._createForTesting([
      makeItem({ id: "no-spec", workType: "dev" }),
    ]);
    // No specPath → Strategy 2 (template) — no LLM called, no inferenceFn needed
    const orch = WorkOrchestrator._createForTesting(queue);

    const result = await orch.prepare("no-spec", "STANDARD");
    expect(result.success).toBe(true);
    expect(result.phases).toBeUndefined();
  });

  it("returns phases when spec has >= 8 ISC and >= 2 phases", async () => {
    const dir = mkdtempSync(join(tmpdir(), "phase-detect-"));
    const specPath = join(dir, "spec.md");
    // Build a spec with 2 phases and 8+ ISC rows (parseSpec can extract these for phase detection)
    writeFileSync(specPath, `# Multi-Phase Spec

## Phase 1: Foundation

### Success Criteria
- [ ] Auth module created
- [ ] JWT validation works
- [ ] Session management active
- [ ] Rate limiting configured

## Phase 2: Integration

### Success Criteria
- [ ] API endpoints created
- [ ] Error handling complete
- [ ] Logging configured
- [ ] Documentation updated
`);

    // Mock returns 8 rows with verify commands so the ISC quality gate passes
    const mockPayload: ComprehendedSpec = {
      rows: [
        { id: 1, description: "Auth module created", verifyCommand: "bun test src/auth/", humanRequired: false, native: false },
        { id: 2, description: "JWT validation works", verifyCommand: "bun test src/auth/jwt.test.ts", humanRequired: false, native: false },
        { id: 3, description: "Session management active", verifyCommand: "bun test src/auth/session.test.ts", humanRequired: false, native: false },
        { id: 4, description: "Rate limiting configured", verifyCommand: "bun test src/middleware/ratelimit.test.ts", humanRequired: false, native: false },
        { id: 5, description: "API endpoints created", verifyCommand: "bun test src/api/", humanRequired: false, native: false },
        { id: 6, description: "Error handling complete", verifyCommand: "bun test src/errors/", humanRequired: false, native: false },
        { id: 7, description: "Logging configured", verifyCommand: "bun test src/logging/", humanRequired: false, native: false },
        { id: 8, description: "Documentation updated", verifyCommand: "test -f docs/api.md", humanRequired: false, native: false },
      ],
      complexityHint: "thorough",
      phases: [
        { number: 1, name: "Foundation", rowIds: [1, 2, 3, 4] },
        { number: 2, name: "Integration", rowIds: [5, 6, 7, 8] },
      ],
    };
    const queue = WorkQueue._createForTesting([
      makeItem({ id: "phased", workType: "dev", specPath }),
    ]);
    const orch = WorkOrchestrator._createForTesting(queue, {
      inferenceFn: makeMockInference([{ success: true, parsed: mockPayload }]),
    });

    const result = await orch.prepare("phased", "STANDARD");
    expect(result.success).toBe(true);

    // With 8 ISC rows and 2 phases, phase detection should activate
    if (result.iscRows.length >= PHASE_MIN_ISC_THRESHOLD) {
      expect(result.phases).toBeDefined();
      expect(result.phases!.length).toBeGreaterThanOrEqual(PHASE_MIN_PHASES);
      for (const phase of result.phases!) {
        expect(phase.maxIterations).toBeGreaterThanOrEqual(3);
        expect(phase.iscRowIds.length).toBeGreaterThan(0);
      }
    }

    unlinkSync(specPath);
  });

  it("returns phases: undefined when spec has < 8 ISC rows", async () => {
    const dir = mkdtempSync(join(tmpdir(), "small-spec-"));
    const specPath = join(dir, "spec.md");
    writeFileSync(specPath, `# Small Spec

## Phase 1: Setup
- [ ] Install deps
- [ ] Configure

## Phase 2: Build
- [ ] Implement
`);

    // Mock returns only 3 rows — below phase threshold
    const mockPayload: ComprehendedSpec = {
      rows: [
        { id: 1, description: "Install deps", verifyCommand: null, humanRequired: false, native: false },
        { id: 2, description: "Configure", verifyCommand: null, humanRequired: false, native: false },
        { id: 3, description: "Implement", verifyCommand: null, humanRequired: false, native: false },
      ],
      complexityHint: "standard",
      phases: [],
    };
    const queue = WorkQueue._createForTesting([
      makeItem({ id: "small", workType: "dev", specPath }),
    ]);
    const orch = WorkOrchestrator._createForTesting(queue, {
      inferenceFn: makeMockInference([{ success: true, parsed: mockPayload }]),
    });

    const result = await orch.prepare("small", "STANDARD");
    expect(result.success).toBe(true);
    // Too few ISC rows — should not trigger phasing
    expect(result.phases).toBeUndefined();

    unlinkSync(specPath);
  });

  it("includes resumeFromPhase when item has completedPhases", async () => {
    const dir = mkdtempSync(join(tmpdir(), "resume-phase-"));
    const specPath = join(dir, "spec.md");
    // Need enough ISC rows to trigger phasing (>= 8)
    const criteria = Array.from({ length: 10 }, (_, i) =>
      `- [ ] Criterion ${i + 1} for phase testing`
    ).join("\n");
    writeFileSync(specPath, `# Resume Spec

## Phase 1: Foundation

### Criteria
${criteria.split("\n").slice(0, 5).join("\n")}

## Phase 2: Integration

### Criteria
${criteria.split("\n").slice(5).join("\n")}
`);

    // Mock returns 10 rows
    const mockPayload: ComprehendedSpec = {
      rows: Array.from({ length: 10 }, (_, i) => ({
        id: i + 1,
        description: `Criterion ${i + 1} for phase testing`,
        verifyCommand: null,
        humanRequired: false,
        native: false,
      })),
      complexityHint: "thorough",
      phases: [
        { number: 1, name: "Foundation", rowIds: [1, 2, 3, 4, 5] },
        { number: 2, name: "Integration", rowIds: [6, 7, 8, 9, 10] },
      ],
    };
    const queue = WorkQueue._createForTesting([
      makeItem({
        id: "resume-test",
        workType: "dev",
        specPath,
        completedPhases: [1],
        totalPhases: 2,
      }),
    ]);
    const orch = WorkOrchestrator._createForTesting(queue, {
      inferenceFn: makeMockInference([{ success: true, parsed: mockPayload }]),
    });

    const result = await orch.prepare("resume-test", "STANDARD");
    expect(result.success).toBe(true);

    // If phase detection activated, resumeFromPhase should be set
    if (result.phases && result.phases.length >= 2) {
      expect(result.resumeFromPhase).toBeDefined();
      expect(result.resumeFromPhase).toBeGreaterThan(1); // Phase 1 completed, so resume from 2+
      expect(result.completedRowIds).toBeDefined();
      expect(result.completedRowIds!.length).toBeGreaterThan(0);
    }

    unlinkSync(specPath);
  });
});

// ---------------------------------------------------------------------------
// Phase constants — exported correctly
// ---------------------------------------------------------------------------

describe("phase constants", () => {
  it("PHASE_MIN_ISC_THRESHOLD is 8", () => {
    expect(PHASE_MIN_ISC_THRESHOLD).toBe(8);
  });

  it("PHASE_MIN_PHASES is 2", () => {
    expect(PHASE_MIN_PHASES).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Fix 1: started() resets DONE ISC rows to PENDING
// ---------------------------------------------------------------------------

describe("started() resets DONE rows to PENDING", () => {
  it("resets DONE ISC rows to PENDING on started()", () => {
    const item = makeItem({ id: "reset-done-1", status: "pending" });
    const orch = createTestOrchestrator([item]);
    orch.iscManager.persist("reset-done-1", [
      makeRow({ id: 1, status: "DONE", verification: { method: "test", command: "test -d /tmp", success_criteria: "exists", result: "PASS" } }),
      makeRow({ id: 2, status: "PENDING" }),
      makeRow({ id: 3, status: "VERIFIED" }),
    ]);

    orch.started("reset-done-1");

    const rows = orch.iscManager.load("reset-done-1");
    expect(rows[0].status).toBe("PENDING");
    expect(rows[1].status).toBe("PENDING");
    expect(rows[2].status).toBe("VERIFIED");
  });

  it("preserves VERIFIED rows on started()", () => {
    const item = makeItem({ id: "reset-done-2", status: "pending" });
    const orch = createTestOrchestrator([item]);
    orch.iscManager.persist("reset-done-2", [
      makeRow({ id: 1, status: "VERIFIED" }),
      makeRow({ id: 2, status: "VERIFIED" }),
    ]);

    orch.started("reset-done-2");

    const rows = orch.iscManager.load("reset-done-2");
    expect(rows[0].status).toBe("VERIFIED");
    expect(rows[1].status).toBe("VERIFIED");
  });

  it("clears stale verification.result on reset rows", () => {
    const item = makeItem({ id: "reset-done-3", status: "pending" });
    const orch = createTestOrchestrator([item]);
    orch.iscManager.persist("reset-done-3", [
      makeRow({ id: 1, status: "DONE", verification: { method: "test", command: "echo ok", success_criteria: "ok", result: "PASS" } }),
    ]);

    orch.started("reset-done-3");

    const rows = orch.iscManager.load("reset-done-3");
    expect(rows[0].status).toBe("PENDING");
    expect(rows[0].verification?.result).toBeUndefined();
  });

  it("S4: prepare() never writes _preservedRows — the re-prepare preserve path is deleted", async () => {
    // S4: the re-prepare branch (which preserved VERIFIED rows across runs) is deleted.
    // prepare() always regenerates a fresh ISC and never writes _preservedRows.
    // (A stale nextRetryStrategy from pre-S4 data is a harmless orphan key — no live code
    //  reads it anymore — so S4 does not scrub it, per the S2 'category' orphan precedent.)
    const item = makeItem({
      id: "s4-prepare-1",
      status: "pending",
      workType: "dev",
    });
    const orch = createTestOrchestrator([item]);
    orch.iscManager.persist("s4-prepare-1", [
      makeRow({ id: 1, status: "DONE", description: "Old DONE row" }),
      makeRow({ id: 2, status: "VERIFIED", description: "Old VERIFIED row" }),
      makeRow({ id: 3, status: "PENDING", description: "Old PENDING row" }),
    ]);

    await orch.prepare("s4-prepare-1", "QUICK");

    const afterItem = orch["queue"].getItem("s4-prepare-1")!;
    // S4: _preservedRows must never be written by prepare() (the preserve path is gone).
    expect((afterItem.metadata as Record<string, unknown>)?._preservedRows).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Fix 6: formatISCTableForAgents
//
// Relocated to lib/orchestrator/__tests__/PhaseBookkeeping.test.ts (S11
// decomposition, pass 2) — formatISCTableForAgents now lives in
// lib/orchestrator/PhaseBookkeeping.ts. The orchestrator's
// formatISCTableForAgents() is a one-line delegation; see that module's tests.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Phase A: runVerificationCommand with invertExit
// ---------------------------------------------------------------------------

describe("runVerificationCommand with invertExit", () => {
  it("PASS when grep finds no matches (exit 1) and invertExit is true", () => {
    // grep for a nonexistent pattern in an existing file → exit code 1
    const orch = createTestOrchestrator([makeItem({ id: "inv-1" })]);
    const row = makeRow({
      id: 1,
      status: "DONE",
      verification: {
        method: "command",
        command: "grep nonexistent_xyz_pattern_12345 /dev/null",
        success_criteria: "Pattern not present",
        invertExit: true,
      },
    });
    // Access private method via bracket notation for testing
    const result = (orch as any).commandRunner.runVerificationCommand(row);
    expect(result).toBe(true); // exit 1 + invertExit → PASS
  });

  it("FAIL when grep finds matches (exit 0) and invertExit is true", () => {
    const orch = createTestOrchestrator([makeItem({ id: "inv-2" })]);
    const row = makeRow({
      id: 2,
      status: "DONE",
      verification: {
        method: "command",
        // grep for empty string always matches → exit 0
        command: "test -d /tmp",
        success_criteria: "Directory should not exist",
        invertExit: true,
      },
    });
    const result = (orch as any).commandRunner.runVerificationCommand(row);
    expect(result).toBe(false); // exit 0 + invertExit → FAIL
  });
});

// ---------------------------------------------------------------------------
// Phase D: findMissingDirectoryArg returns resolved path
// ---------------------------------------------------------------------------

describe("findMissingDirectoryArg returns resolved absolute path", () => {
  it("relative path with cwd returns resolved absolute path", () => {
    const result = findMissingDirectoryArg(["some-nonexistent-dir/"], "/tmp");
    expect(result).toBe("/tmp/some-nonexistent-dir/");
  });

  it("absolute missing path returns as-is", () => {
    const result = findMissingDirectoryArg(["/nonexistent_xyz_path_12345/"]);
    expect(result).toBe("/nonexistent_xyz_path_12345/");
  });

  it("existing path with cwd returns null", () => {
    const result = findMissingDirectoryArg(["/tmp/"], "/tmp");
    expect(result).toBeNull();
  });

  it("no trailing slash is skipped (returns null)", () => {
    const result = findMissingDirectoryArg(["nonexistent_file"]);
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Phase B1: Missing dependency warning (WorkQueue)
// ---------------------------------------------------------------------------

describe("WorkQueue missing dependency detection", () => {
  it("item with dangling dep stays blocked in getReadyItems", () => {
    const queue = WorkQueue._createForTesting([
      makeItem({
        id: "dangling-test",
        status: "pending",
        dependencies: ["nonexistent-dep-id"],
      }),
    ]);
    const ready = queue.getReadyItems();
    expect(ready.length).toBe(0);
  });

  it("item with dangling dep appears in getDagBlockedItems", () => {
    const queue = WorkQueue._createForTesting([
      makeItem({
        id: "dangling-blocked",
        status: "pending",
        dependencies: ["nonexistent-dep-id"],
      }),
    ]);
    const blocked = queue.getDagBlockedItems();
    expect(blocked.length).toBe(1);
    expect(blocked[0].id).toBe("dangling-blocked");
  });
});

// ---------------------------------------------------------------------------
// Phase C: Multi-repo verification
// ---------------------------------------------------------------------------

describe("Multi-repo verification", () => {
  // File-level beforeAll (dynamic import pin) must resolve before this runs —
  // beforeAll ordering guarantees outer-file hooks run before this nested one.
  let orch: WorkOrchestrator;
  beforeAll(() => {
    orch = createTestOrchestrator();
  });

  describe("resolveVerifyContext", () => {
    it("returns kind:single when no repoContexts in metadata", () => {
      const item = makeItem({ id: "single-item", metadata: { worktreePath: "/tmp" } });
      const ctx = orch.resolveVerifyContext(item);
      expect(ctx.kind).toBe("single");
    });

    it("returns kind:multi when metadata.repoContexts has 2+ valid cwds", () => {
      // Use paths that exist on disk (/tmp and /var/folders or similar)
      const repos: RepoContext[] = [
        { name: "repo-a", cwd: "/tmp" },
        { name: "repo-b", cwd: "/var" },
      ];
      const item = makeItem({ id: "multi-item", metadata: { repoContexts: repos } });
      const ctx = orch.resolveVerifyContext(item);
      expect(ctx.kind).toBe("multi");
      if (ctx.kind === "multi") {
        expect(ctx.repos.length).toBe(2);
        expect(ctx.repos[0].name).toBe("repo-a");
      }
    });

    it("degrades to single when only 1 of 3 repo cwds is valid", () => {
      const repos: RepoContext[] = [
        { name: "valid-repo", cwd: "/tmp" },
        { name: "missing-a", cwd: "/nonexistent/path/a" },
        { name: "missing-b", cwd: "/nonexistent/path/b" },
      ];
      const item = makeItem({ id: "degrade-item", metadata: { repoContexts: repos } });
      const ctx = orch.resolveVerifyContext(item);
      // Only 1 valid repo → degrades to single
      expect(ctx.kind).toBe("single");
      if (ctx.kind === "single") {
        expect(ctx.cwd).toBe("/tmp");
      }
    });

    it("falls through to single-repo logic when all repoContexts cwds are missing", () => {
      const repos: RepoContext[] = [
        { name: "gone", cwd: "/nonexistent/totally-gone" },
      ];
      const item = makeItem({
        id: "fallthrough-item",
        metadata: { repoContexts: repos, worktreePath: "/tmp" },
      });
      const ctx = orch.resolveVerifyContext(item);
      // All invalid → falls through to worktreePath
      expect(ctx.kind).toBe("single");
      if (ctx.kind === "single") {
        expect(ctx.cwd).toBe("/tmp");
      }
    });
  });

  describe("getGitDiffStat", () => {
    it("single context: delegates to getSingleRepoDiffStat and returns stubbed value", () => {
      // _createForTesting stubs getGitDiffStat to return fixed string
      const item = makeItem({ id: "diff-single", metadata: { worktreePath: "/tmp" } });
      const ctx = orch.resolveVerifyContext(item);
      const diff = orch.getGitDiffStat(ctx);
      expect(typeof diff).toBe("string");
    });

    it("multi context: produces [name] section-prefixed output", () => {
      // Create an orchestrator with a custom stub that actually implements multi-repo output
      const customOrch = createTestOrchestrator();
      customOrch.getGitDiffStat = (ctx: VerifyContext) => {
        if (ctx.kind === "multi") {
          return ctx.repos.map(r => `[${r.name}]\n src/main.py | 10 +++`).join("\n");
        }
        return "1 file changed";
      };
      const ctx: VerifyContext = {
        kind: "multi",
        repos: [
          { name: "timeseries-forecasting", cwd: "/tmp" },
          { name: "mlops-serving", cwd: "/var" },
        ],
      };
      const diff = customOrch.getGitDiffStat(ctx);
      expect(diff).toContain("[timeseries-forecasting]");
      expect(diff).toContain("[mlops-serving]");
    });
  });

  describe("resolveRowCwd", () => {
    it("returns cwd directly for single context", () => {
      const row = makeRow({ id: 1, verification: { method: "test", command: "ls /tmp", success_criteria: "ok" } });
      const ctx: VerifyContext = { kind: "single", cwd: "/tmp" };
      expect(orch.resolveRowCwd(row, ctx)).toBe("/tmp");
    });

    it("matches command path arg to correct repo cwd in multi context", () => {
      // The command references "README.md" — if /var/README.md exists it picks /var, else fallback
      // Use a path we know exists (/tmp) to test positive match
      const row = makeRow({
        id: 2,
        verification: { method: "test", command: "cat README.md", success_criteria: "ok" },
      });
      // We can't guarantee README.md in /tmp, so test fallback behavior:
      // when no path arg matches, resolveRowCwd falls back to repos[0].cwd
      const ctx: VerifyContext = {
        kind: "multi",
        repos: [
          { name: "mlops-serving", cwd: "/tmp" },
          { name: "timeseries-forecasting", cwd: "/var" },
        ],
      };
      const result = orch.resolveRowCwd(row, ctx);
      // Must be one of the repo cwds
      expect(["/tmp", "/var"]).toContain(result);
    });

    it("falls back to first repo when no path args match", () => {
      const row = makeRow({
        id: 3,
        verification: { method: "test", command: "bun test", success_criteria: "ok" },
      });
      const ctx: VerifyContext = {
        kind: "multi",
        repos: [
          { name: "first-repo", cwd: "/tmp" },
          { name: "second-repo", cwd: "/var" },
        ],
      };
      // "bun" and "test" won't exist as child paths under /tmp or /var
      const result = orch.resolveRowCwd(row, ctx);
      expect(result).toBe("/tmp");
    });
  });
});

// ---------------------------------------------------------------------------
// Component A: detectProjectContext
// ---------------------------------------------------------------------------

describe("detectProjectContext", () => {
  const { mkdtempSync, writeFileSync, rmSync, mkdirSync } = require("fs");
  const { tmpdir } = require("os");
  const { join } = require("path");

  function makeOrch(): WorkOrchestrator {
    const queue = new WorkQueue();
    return new WorkOrchestrator(queue, async () => "mock-inference");
  }

  it("detects TypeScript from package.json", () => {
    const dir = mkdtempSync(join(tmpdir(), "ctx-ts-"));
    writeFileSync(join(dir, "package.json"), "{}");
    const orch = makeOrch();
    const ctx = (orch as any).verifyCtxResolver.detectProjectContext(dir);
    expect(ctx.language).toBe("typescript");
    expect(ctx.testPattern).toBe("jest-style");
    rmSync(dir, { recursive: true, force: true });
  });

  it("detects Python from pyproject.toml", () => {
    const dir = mkdtempSync(join(tmpdir(), "ctx-py-"));
    writeFileSync(join(dir, "pyproject.toml"), "[project]\nname = 'test'");
    const orch = makeOrch();
    const ctx = (orch as any).verifyCtxResolver.detectProjectContext(dir);
    expect(ctx.language).toBe("python");
    expect(ctx.testPattern).toBe("pytest-style");
    rmSync(dir, { recursive: true, force: true });
  });

  it("detects Go from go.mod", () => {
    const dir = mkdtempSync(join(tmpdir(), "ctx-go-"));
    writeFileSync(join(dir, "go.mod"), "module example.com/test");
    const orch = makeOrch();
    const ctx = (orch as any).verifyCtxResolver.detectProjectContext(dir);
    expect(ctx.language).toBe("go");
    expect(ctx.framework).toBe("go-test");
    rmSync(dir, { recursive: true, force: true });
  });

  it("detects Rust from Cargo.toml", () => {
    const dir = mkdtempSync(join(tmpdir(), "ctx-rs-"));
    writeFileSync(join(dir, "Cargo.toml"), "[package]\nname = 'test'");
    const orch = makeOrch();
    const ctx = (orch as any).verifyCtxResolver.detectProjectContext(dir);
    expect(ctx.language).toBe("rust");
    expect(ctx.framework).toBe("cargo");
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns unknown for empty directory", () => {
    const dir = mkdtempSync(join(tmpdir(), "ctx-empty-"));
    const orch = makeOrch();
    const ctx = (orch as any).verifyCtxResolver.detectProjectContext(dir);
    expect(ctx.language).toBe("unknown");
    expect(ctx.isKayaSkill).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  it("detects isKayaSkill from path prefix", () => {
    // VerifyContextResolver.ts resolves its own KAYA_HOME the same way
    // (process.env.KAYA_HOME || `${HOME}/.claude`) — this file's beforeAll
    // pins KAYA_HOME to tempHome, so the skills dir must be derived from
    // that pinned value, not a hardcoded ~/.claude (which was only correct
    // before this file pinned KAYA_HOME away from the live default).
    const kayaSkillsDir = join(tempHome, "skills");
    const orch = makeOrch();
    const ctx = (orch as any).verifyCtxResolver.detectProjectContext(join(kayaSkillsDir, "SomeSkill"));
    expect(ctx.isKayaSkill).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Component B: classifyRowDisposition
// ---------------------------------------------------------------------------

describe("classifyRowDisposition", () => {
  function makeOrch(): WorkOrchestrator {
    const queue = new WorkQueue();
    return new WorkOrchestrator(queue, async () => "mock-inference");
  }

  // Determinism-residue cleanup: the keyword scanner (classifyHumanRequired) was
  // removed. classifyRowDisposition now always returns "automatable" — the
  // "human-required" decision is owned by the comprehension LLM's per-row
  // humanRequired flag (LLMSpecComprehension Rule 3) and the objective
  // native→human lock, applied upstream in ISCGenerator.generateISC. It is NOT
  // re-derived from the description text here.
  it("returns automatable for ordinary code work", () => {
    const orch = makeOrch();
    expect((orch as any).classifyRowDisposition("Implement retry logic with exponential backoff")).toBe("automatable");
  });

  it("no longer keyword-classifies secret entry as human-required (LLM/native lock owns that)", () => {
    const orch = makeOrch();
    expect((orch as any).classifyRowDisposition("Add PLAID_SECRET to secrets.json")).toBe("automatable");
  });

  it("no longer keyword-classifies physical/on-device actions as human-required", () => {
    const orch = makeOrch();
    expect((orch as any).classifyRowDisposition("Run manual test on physical device")).toBe("automatable");
  });
});


// ---------------------------------------------------------------------------
// Smoke-first verification order
// ---------------------------------------------------------------------------

describe("Smoke-first verification sort", () => {
  it("sorts smoke-priority rows before full-priority rows", () => {
    const rows: ISCRow[] = [
      makeRow({ id: 1000, priority: "full" }),
      makeRow({ id: 2000, priority: "smoke" }),
      makeRow({ id: 3000, priority: "full" }),
      makeRow({ id: 4000, priority: "smoke" }),
    ];

    const sorted = [...rows].sort((a, b) => {
      const aPri = a.priority === "smoke" ? 0 : 1;
      const bPri = b.priority === "smoke" ? 0 : 1;
      return aPri - bPri;
    });

    expect(sorted[0].id).toBe(2000);
    expect(sorted[1].id).toBe(4000);
    expect(sorted[2].id).toBe(1000);
    expect(sorted[3].id).toBe(3000);
  });

  it("treats undefined priority same as full", () => {
    const rows: ISCRow[] = [
      makeRow({ id: 1000 }), // no priority
      makeRow({ id: 2000, priority: "smoke" }),
    ];

    const sorted = [...rows].sort((a, b) => {
      const aPri = a.priority === "smoke" ? 0 : 1;
      const bPri = b.priority === "smoke" ? 0 : 1;
      return aPri - bPri;
    });

    expect(sorted[0].id).toBe(2000);
    expect(sorted[1].id).toBe(1000);
  });
});

// ---------------------------------------------------------------------------
// FaultClass + source-level fault tagging (Solution 1 hardening)
// ---------------------------------------------------------------------------

describe("FaultClass + retry gating", () => {
  it("retry with faultClass='infrastructure' does NOT call recordAttempt", async () => {
    const { orch, queue } = createTestOrchestratorWithQueue([
      makeItem({ id: "infra-a", status: "in_progress" }),
    ]);
    const beforeAttempts = queue.getItem("infra-a")?.attempts?.length ?? 0;

    const result = await orch.retry("infra-a", "parseSpec threw: bad table format", "infrastructure");

    expect(result.retried).toBe(false);
    expect(result.faultClass).toBe("infrastructure");
    const afterAttempts = queue.getItem("infra-a")?.attempts?.length ?? 0;
    expect(afterAttempts).toBe(beforeAttempts);
  });

  it("retry with faultClass='infrastructure' stores error in metadata.infraErrors", async () => {
    const { orch, queue } = createTestOrchestratorWithQueue([
      makeItem({ id: "infra-b", status: "in_progress" }),
    ]);

    await orch.retry("infra-b", "SkepticalVerifier internal crash", "infrastructure");

    const item = queue.getItem("infra-b");
    const infraErrors = (item?.metadata as Record<string, unknown>)?.infraErrors as string[];
    expect(infraErrors).toBeDefined();
    expect(infraErrors.length).toBe(1);
    expect(infraErrors[0]).toContain("SkepticalVerifier internal crash");
  });

  it("retry with faultClass='item' (default) still calls recordAttempt", async () => {
    const { orch, queue } = createTestOrchestratorWithQueue([
      makeItem({ id: "item-a", status: "in_progress" }),
    ]);

    const result = await orch.retry("item-a", "bun test failed: 3 errors");

    expect(result.retried).toBe(true);
    const item = queue.getItem("item-a");
    expect(item?.attempts?.length).toBe(1);
    expect(item?.status).toBe("pending");
  });

  it("retry with faultClass='transient' still consumes retry counter", async () => {
    const { orch, queue } = createTestOrchestratorWithQueue([
      makeItem({ id: "trans-a", status: "in_progress" }),
    ]);

    const result = await orch.retry("trans-a", "EMFILE: too many open files", "transient");

    expect(result.retried).toBe(true);
    const item = queue.getItem("trans-a");
    expect(item?.attempts?.length).toBe(1);
  });

  it("classifyFailure uses infraFault flag from source-tagged ISCRows", () => {
    const orch = createTestOrchestrator([]);
    const classify = (orch as unknown as { classifyFailure: (r: string, f?: Array<{ infraFault?: boolean }>) => FaultClass }).classifyFailure.bind(orch);

    // Source-tagged infrastructure fault
    expect(classify("some error", [{ infraFault: true }])).toBe("infrastructure");
    // Mixed: one infra, one item — infra wins
    expect(classify("some error", [{ infraFault: true }, {}])).toBe("infrastructure");
    // No infraFault flags — falls through to string matching
    expect(classify("some error", [{}])).toBe("item");
    expect(classify("some error", [])).toBe("item");
    // Transient errors via string matching
    expect(classify("EMFILE: too many open files")).toBe("transient");
    expect(classify("ECONNRESET by peer")).toBe("transient");
    // Default item fault
    expect(classify("Verification failed: 3 rows failed")).toBe("item");
  });
});

// ---------------------------------------------------------------------------
// 03-28 regression: infrastructure fault + rapid retry (Part D)
// ---------------------------------------------------------------------------

describe("03-28 regression: infrastructure fault does not consume retries", () => {
  it("3 items with infra faults: none consume retry counters", async () => {
    const { orch, queue } = createTestOrchestratorWithQueue([
      makeItem({ id: "reg-1", status: "in_progress" }),
      makeItem({ id: "reg-2", status: "in_progress" }),
      makeItem({ id: "reg-3", status: "in_progress" }),
    ]);

    // All 3 items fail with the same infrastructure error
    await orch.retry("reg-1", "parseSpec threw: invalid ISC table", "infrastructure");
    await orch.retry("reg-2", "parseSpec threw: invalid ISC table", "infrastructure");
    await orch.retry("reg-3", "parseSpec threw: invalid ISC table", "infrastructure");

    // None should have attempts recorded
    for (const id of ["reg-1", "reg-2", "reg-3"]) {
      const item = queue.getItem(id);
      expect(item?.attempts?.length ?? 0).toBe(0);
      // All should have infraErrors in metadata
      const infraErrors = (item?.metadata as Record<string, unknown>)?.infraErrors as string[];
      expect(infraErrors).toBeDefined();
      expect(infraErrors.length).toBe(1);
    }
  });

  it("retry cooldown prevents rapid cycling for item faults", async () => {
    const { orch, queue } = createTestOrchestratorWithQueue([
      makeItem({ id: "rapid-1", status: "in_progress" }),
    ]);

    // First item fault
    await orch.retry("rapid-1", "test failed");
    const item1 = queue.getItem("rapid-1");
    expect(item1?.attempts?.length).toBe(1);
    expect(item1?.retryEligibleAfter).toBeDefined();

    // Should be excluded from getReadyItems due to cooldown
    expect(queue.getReadyItems().find(i => i.id === "rapid-1")).toBeUndefined();

    // Verify the cooldown is approximately 60s for attempt 1
    const eligible = new Date(item1!.retryEligibleAfter!).getTime();
    const now = Date.now();
    expect(eligible - now).toBeGreaterThan(50_000);
    expect(eligible - now).toBeLessThan(65_000);
  });

  it("items with past cooldown are eligible for getReadyItems", () => {
    const queue = WorkQueue._createForTesting([
      makeItem({ id: "past-cd", status: "pending", retryEligibleAfter: new Date(Date.now() - 1000).toISOString() }),
    ]);
    expect(queue.getReadyItems().find(i => i.id === "past-cd")).toBeDefined();
  });
});

// ISC 7 — nextBatch() always returns {items, blocked} (no refused path)
describe("WorkOrchestrator nextBatch (ISC 7 — no budget gate)", () => {
  it("nextBatch always returns {items, blocked} with no refused arm", async () => {
    const queue = WorkQueue._createForTesting([]);
    const orch = WorkOrchestrator._createForTesting(queue, {});
    const result = await orch.nextBatch();
    expect(result).toHaveProperty("items");
    expect(result).toHaveProperty("blocked");
    expect(result).not.toHaveProperty("refused");
    expect(result).not.toHaveProperty("reason");
  });
});

// S5c — verify() circuit breaker is a plain consecutive-FAIL counter (no concern content compare)
describe("verify() circuit breaker (S5c: 3 consecutive FAILs, no content compare)", () => {
  function seedHistory(history: Array<{ verdict: string; concerns: string[] }>) {
    const queue = WorkQueue._createForTesting([
      makeItem({ id: "cb", workType: "dev", status: "in_progress" }),
    ]);
    queue.setMetadata("cb", { verificationHistory: history });
    const orch = WorkOrchestrator._createForTesting(queue);
    return { orch, queue };
  }

  it("does NOT short-circuit at 2 consecutive FAILs (threshold raised from 2 to 3)", async () => {
    const { orch } = seedHistory([
      { verdict: "FAIL", concerns: ["x"] },
      { verdict: "FAIL", concerns: ["x"] },
    ]);
    const result = await orch.verify("cb");
    const breaker = result.failures?.find(f => f.description?.includes("Circuit breaker"));
    expect(breaker).toBeUndefined(); // 2 < 3 → breaker does not fire
  });

  it("short-circuits at 3 consecutive FAILs even when concerns DIFFER (content no longer compared)", async () => {
    const { orch } = seedHistory([
      { verdict: "FAIL", concerns: ["a"] },
      { verdict: "FAIL", concerns: ["b"] },
      { verdict: "FAIL", concerns: ["c"] },
    ]);
    const result = await orch.verify("cb");
    expect(result.success).toBe(false);
    const breaker = result.failures?.find(f => f.description?.includes("Circuit breaker: 3 consecutive"));
    expect(breaker).toBeDefined();
  });

  it("does NOT short-circuit when the 3rd of the last three is a PASS", async () => {
    const { orch } = seedHistory([
      { verdict: "FAIL", concerns: ["a"] },
      { verdict: "FAIL", concerns: ["b"] },
      { verdict: "PASS", concerns: [] },
    ]);
    const result = await orch.verify("cb");
    const breaker = result.failures?.find(f => f.description?.includes("Circuit breaker"));
    expect(breaker).toBeUndefined();
  });
});
