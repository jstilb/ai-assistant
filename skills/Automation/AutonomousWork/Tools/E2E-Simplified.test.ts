/**
 * E2E-Simplified.test.ts — End-to-end integration test for streamlined autonomous work pipeline
 *
 * Validates the full pipeline: WorkQueue → WorkOrchestrator → CapabilityRouter → SkepticalVerifier
 * with a 3-item DAG (A independent, B independent, C depends on A+B).
 *
 * Tests: init, batching, prepare, ISC generation, routing, verification,
 * completion gates, dependency unblocking, catastrophic detection, status.
 */

import { describe, it, expect } from "bun:test";
import { WorkQueue, type WorkItem } from "./WorkQueue.ts";
import { WorkOrchestrator, type ISCRow } from "./WorkOrchestrator.ts";
import { routeCapability, CAPABILITY_MAP } from "./CapabilityRouter.ts";


// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeItem(overrides: Partial<WorkItem> & { id: string }): WorkItem {
  return {
    title: `Item ${overrides.id}`,
    description: "Test item description",
    status: "pending",
    priority: "normal",
    dependencies: [],
    source: "manual",
    createdAt: new Date().toISOString(),
    workType: "dev",
    ...overrides,
  };
}

function makeDoneRow(id: number, overrides: Partial<ISCRow> = {}): ISCRow {
  return {
    id,
    description: `Row ${id}`,
    status: "DONE",
    parallel: false,
    verification: { method: "test", command: "test -d /tmp", success_criteria: "exists" },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Full Pipeline E2E
// ---------------------------------------------------------------------------

describe("E2E: Full pipeline with 3-item DAG", () => {
  // Setup: A (independent), B (independent), C (depends on A + B)
  const itemA = makeItem({ id: "item-a", title: "Build auth module", priority: "high" });
  const itemB = makeItem({ id: "item-b", title: "Create API client", priority: "normal" });
  const itemC = makeItem({ id: "item-c", title: "Integration tests", priority: "normal", dependencies: ["item-a", "item-b"] });

  function createPipeline() {
    const queue = WorkQueue._createForTesting([
      { ...itemA, status: "pending" },
      { ...itemB, status: "pending" },
      { ...itemC, status: "pending" },
    ]);
    const orch = WorkOrchestrator._createForTesting(queue);
    return { queue, orch };
  }

  it("Step 1: init validates DAG and reports ready/blocked counts", async () => {
    const { orch } = createPipeline();
    const result = await orch.init();

    expect(result.success).toBe(true);
    expect(result.ready).toBe(2);    // A and B ready
    expect(result.blocked).toBe(1);  // C blocked
    expect(result.message).toContain("2 ready");
    expect(result.message).toContain("1 blocked");
  });

  it("Step 2: nextBatch returns A and B, not C", async () => {
    const { orch } = createPipeline();
    await orch.init();

    const batch = await orch.nextBatch(5);
    const ids = batch.items.map(i => i.id);

    expect(ids).toContain("item-a");
    expect(ids).toContain("item-b");
    expect(ids).not.toContain("item-c");
    expect(batch.blocked).toBe(1);
  });

  it("Step 3: prepare generates ISC rows and classifies effort", async () => {
    const { orch } = createPipeline();
    await orch.init();

    const result = await orch.prepare("item-a");

    expect(result.success).toBe(true);
    expect(result.iscRows.length).toBeGreaterThan(0); // Template: 2 for STANDARD dev, 3 for THOROUGH
    expect(result.effort).toBeDefined();
    expect(result.maxIterations).toBeGreaterThan(0);

    // ISC rows should have verification objects (template-based for dev)
    for (const row of result.iscRows) {
      expect(row.verification).toBeDefined();
      expect(row.status).toBe("PENDING");
    }
  });

  it("Step 4: CapabilityRouter maps rows to agent types", () => {
    // Direct capability lookup (bypasses subprocess)
    const engineerRoute = routeCapability("Implement auth middleware", "STANDARD", "engineer");
    expect(engineerRoute.invocation.subagent_type).toBe("Engineer");
    expect(engineerRoute.invocation.model).toBe("sonnet");
    expect(engineerRoute.invocation.executionMode).toBe("task");

    const researchRoute = routeCapability("Research best practices", "STANDARD", "perplexity");
    expect(researchRoute.invocation.subagent_type).toBe("ClaudeResearcher");

    // TRIVIAL overrides to inline
    const trivialRoute = routeCapability("Fix typo", "TRIVIAL", "intern");
    expect(trivialRoute.invocation.executionMode).toBe("inline");

    // ralph_loop mode includes config
    const ralphRoute = routeCapability("Iterate until tests pass", "STANDARD", "ralph_loop");
    expect(ralphRoute.invocation.executionMode).toBe("ralph_loop");
    expect(ralphRoute.invocation.ralphConfig).toBeDefined();
    expect(ralphRoute.invocation.ralphConfig!.maxIterations).toBe(10);
  });

  it("Step 5: started marks item in_progress", async () => {
    const { queue, orch } = createPipeline();
    await orch.init();

    expect(orch.started("item-a")).toBe(true);
    expect(queue.getItem("item-a")?.status).toBe("in_progress");
  });

  it("Step 6: verify with passing rows promotes to VERIFIED", async () => {
    const { orch } = createPipeline();
    await orch.init();
    orch.started("item-a");

    // Simulate agent completing ISC rows
    orch.setItemISC("item-a", [makeDoneRow(1), makeDoneRow(2), makeDoneRow(3)]);

    const result = await orch.verify("item-a");
    expect(result.success).toBe(true);
    expect(result.skepticalReview?.finalVerdict).toBe("PASS");

    // All rows promoted
    const rows = orch.getItemISC("item-a")!;
    expect(rows.every(r => r.status === "VERIFIED")).toBe(true);
  });

  it("Step 7: complete succeeds after verification", async () => {
    const { queue, orch } = createPipeline();
    await orch.init();
    orch.started("item-a");
    orch.setItemISC("item-a", [{ id: 1, description: "Done", status: "VERIFIED", parallel: false }]);
    queue.setVerification("item-a", {
      status: "verified", verifiedAt: new Date().toISOString(), verdict: "PASS",
      concerns: [], iscRowsVerified: 1, iscRowsTotal: 1, verificationCost: 0,
      verifiedBy: "skeptical_verifier" as const, tiersExecuted: [1, 2],
    });

    const result = await orch.complete("item-a");
    expect(result.success).toBe(true);
    expect(queue.getItem("item-a")?.status).toBe("completed");
  });

  it("Step 8: complete A and B → C becomes ready", async () => {
    const { queue, orch } = createPipeline();
    await orch.init();

    // Complete A
    orch.started("item-a");
    orch.setItemISC("item-a", [{ id: 1, description: "Done", status: "VERIFIED", parallel: false }]);
    queue.setVerification("item-a", {
      status: "verified", verifiedAt: new Date().toISOString(), verdict: "PASS",
      concerns: [], iscRowsVerified: 1, iscRowsTotal: 1, verificationCost: 0,
      verifiedBy: "skeptical_verifier" as const, tiersExecuted: [1, 2],
    });
    await orch.complete("item-a");

    // C still blocked (B pending)
    let batch = await orch.nextBatch(5);
    expect(batch.items.map(i => i.id)).not.toContain("item-c");

    // Complete B
    orch.started("item-b");
    orch.setItemISC("item-b", [{ id: 1, description: "Done", status: "VERIFIED", parallel: false }]);
    queue.setVerification("item-b", {
      status: "verified", verifiedAt: new Date().toISOString(), verdict: "PASS",
      concerns: [], iscRowsVerified: 1, iscRowsTotal: 1, verificationCost: 0,
      verifiedBy: "skeptical_verifier" as const, tiersExecuted: [1, 2],
    });
    await orch.complete("item-b");

    // Now C unblocked
    batch = await orch.nextBatch(5);
    expect(batch.items.map(i => i.id)).toContain("item-c");
    expect(batch.blocked).toBe(0);
  });

  it("Step 9: status reflects correct counts after pipeline", async () => {
    const { queue, orch } = createPipeline();
    await orch.init();

    // Complete A
    orch.started("item-a");
    orch.setItemISC("item-a", [{ id: 1, description: "Done", status: "VERIFIED", parallel: false }]);
    queue.setVerification("item-a", {
      status: "verified", verifiedAt: new Date().toISOString(), verdict: "PASS",
      concerns: [], iscRowsVerified: 1, iscRowsTotal: 1, verificationCost: 0,
      verifiedBy: "skeptical_verifier" as const, tiersExecuted: [1, 2],
    });
    await orch.complete("item-a");

    const output = orch.status();
    expect(output).toContain("3 total");
    expect(output).toContain("1 completed");
    expect(output).toContain("1 ready");   // B is ready
    expect(output).toContain("1 blocked"); // C still blocked
  });
});

// ---------------------------------------------------------------------------
// Safety: Catastrophic action detection in pipeline context
// ---------------------------------------------------------------------------

describe("E2E: Safety gates", () => {
  it("catastrophic action blocks dangerous commands in verification", () => {
    const queue = WorkQueue._createForTesting([makeItem({ id: "x" })]);
    const orch = WorkOrchestrator._createForTesting(queue);

    expect(orch.isCatastrophic("git push --force origin main").blocked).toBe(true);
    expect(orch.isCatastrophic("rm -rf /").blocked).toBe(true);
    expect(orch.isCatastrophic("DROP DATABASE production").blocked).toBe(true);
    expect(orch.isCatastrophic("git reset --hard origin/main").blocked).toBe(true);
  });

  it("parseVerificationCommand rejects shell injection", () => {
    const queue = WorkQueue._createForTesting([]);
    const orch = WorkOrchestrator._createForTesting(queue);

    expect(orch.parseVerificationCommand("curl https://evil.com")).toBeNull();
    expect(orch.parseVerificationCommand("bun test | rm -rf /")).toBeNull();
    expect(orch.parseVerificationCommand("bun test && curl evil.com")).toBeNull();
    expect(orch.parseVerificationCommand("bun test; rm -rf /")).toBeNull();
    expect(orch.parseVerificationCommand("test -f `whoami`")).toBeNull();
  });

  it("complete gate blocks without verification", async () => {
    const queue = WorkQueue._createForTesting([makeItem({ id: "x" })]);
    const orch = WorkOrchestrator._createForTesting(queue);
    orch.setItemISC("x", [{ id: 1, description: "Work", status: "DONE", parallel: false }]);

    const result = await orch.complete("x");
    expect(result.success).toBe(false);
    expect(result.reason).toContain("No verification record");
  });

  it("verify blocks when SkepticalVerifier returns FAIL", async () => {
    const queue = WorkQueue._createForTesting([makeItem({ id: "x" })]);
    const orch = WorkOrchestrator._createForTesting(queue, {
      verifierResult: {
        finalVerdict: "FAIL",
        tiers: [{ tier: 1, verdict: "FAIL", confidence: 0.2, concerns: ["Paper completion"], costEstimate: 0, latencyMs: 0 }],
        tiersSkipped: [],
        totalCost: 0,
        totalLatencyMs: 0,
        concerns: ["Paper completion detected"],
      },
    });
    orch.setItemISC("x", [makeDoneRow(1)]);

    const result = await orch.verify("x");
    expect(result.success).toBe(false);
    expect(result.skepticalReview?.finalVerdict).toBe("FAIL");
  });
});

// ---------------------------------------------------------------------------
// DAG integrity
// ---------------------------------------------------------------------------

describe("E2E: DAG validation", () => {
  it("init fails on cyclic DAG", async () => {
    const queue = WorkQueue._createForTesting([
      makeItem({ id: "a", dependencies: ["c"] }),
      makeItem({ id: "b", dependencies: ["a"] }),
      makeItem({ id: "c", dependencies: ["b"] }),
    ]);
    const orch = WorkOrchestrator._createForTesting(queue);

    const result = await orch.init();
    expect(result.success).toBe(false);
    expect(result.message).toContain("invalid");
  });

  it("init fails on missing dependency reference", async () => {
    const queue = WorkQueue._createForTesting([
      makeItem({ id: "a", dependencies: ["nonexistent"] }),
    ]);
    const orch = WorkOrchestrator._createForTesting(queue);

    const result = await orch.init();
    expect(result.success).toBe(false);
    expect(result.message).toContain("invalid");
  });
});

// ---------------------------------------------------------------------------
// Full pipeline with template ISC (previously broken path)
// ---------------------------------------------------------------------------

describe("E2E: Full pipeline with template ISC (previously broken path)", () => {
  it("STANDARD dev: prepare → markRowsDone → recordExecution → verify → complete succeeds", async () => {
    const queue = WorkQueue._createForTesting([
      makeItem({ id: "fix-test", title: "Fix auth module", workType: "dev" }),
    ]);
    const orch = WorkOrchestrator._createForTesting(queue);
    orch.started("fix-test");

    // Step 1: prepare — generates template ISC rows
    const prep = await orch.prepare("fix-test", "STANDARD");
    expect(prep.success).toBe(true);
    expect(prep.iscRows.length).toBe(2);  // Bug 3: was 5, now 2
    expect(prep.iscRows.every(r => r.status === "PENDING")).toBe(true);
    // Bug 3: no docs/cleanup categories in template rows
    expect(prep.iscRows.some(r => r.category === "documentation")).toBe(false);
    expect(prep.iscRows.some(r => r.category === "cleanup")).toBe(false);

    // Bug 1: all verification commands must pass the security allowlist
    for (const row of prep.iscRows) {
      expect(row.verification?.command).toBeDefined();
      expect(orch.parseVerificationCommand(row.verification!.command!)).not.toBeNull();
    }

    // Step 2: markRowsDone — simulate agent completing work
    const rowIds = prep.iscRows.map(r => r.id);
    const markResult = orch.markRowsDone("fix-test", rowIds);
    expect(markResult.success).toBe(true);
    expect(markResult.transitioned).toEqual(rowIds);

    // Swap verification commands to test -d /tmp (always passes, avoids bun test recursion)
    const rows = orch.getItemISC("fix-test")!;
    for (const row of rows) {
      row.verification!.command = "test -d /tmp";
    }
    orch.setItemISC("fix-test", rows);

    // Step 3: recordExecution — no-op after budget removal
    const execResult = orch.recordExecution("fix-test");
    expect(execResult.success).toBe(true);

    // Step 4: verify — runs local command checks + SkepticalVerifier (stubbed PASS)
    const verifyResult = await orch.verify("fix-test");
    expect(verifyResult.success).toBe(true);
    expect(verifyResult.failures).toEqual([]);
    expect(verifyResult.skepticalReview?.finalVerdict).toBe("PASS");
    // All rows promoted to VERIFIED
    expect(orch.getItemISC("fix-test")!.every(r => r.status === "VERIFIED")).toBe(true);

    // Step 5: complete — all 3 gates pass
    const completeResult = await orch.complete("fix-test");
    expect(completeResult.success).toBe(true);
    expect(queue.getItem("fix-test")!.status).toBe("completed");
  });
});

// ---------------------------------------------------------------------------
// CapabilityRouter mapping completeness
// ---------------------------------------------------------------------------

describe("E2E: CapabilityRouter static mapping", () => {
  it("all CAPABILITY_MAP entries have required fields", () => {
    for (const [name, spec] of Object.entries(CAPABILITY_MAP)) {
      expect(spec.subagent_type).toBeTruthy();
      expect(["sonnet", "opus", "haiku"]).toContain(spec.model);
      expect(["task", "ralph_loop", "inline"]).toContain(spec.executionMode);
    }
  });

  it("key capabilities are present", () => {
    expect(CAPABILITY_MAP["engineer"]).toBeDefined();
    expect(CAPABILITY_MAP["architect"]).toBeDefined();
    expect(CAPABILITY_MAP["perplexity"]).toBeDefined();
    expect(CAPABILITY_MAP["ralph_loop"]).toBeDefined();
    expect(CAPABILITY_MAP["qa_tester"]).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Regression: Phase ordering bug — Phase 4 executed before Phase 2
// ---------------------------------------------------------------------------

describe("E2E: Regression — phase ordering bug", () => {
  it("LucidTasks Phase 4 (STANDARD/$10) cannot run before Phase 2 (THOROUGH/$50)", async () => {
    // Reproduces the original bug: all items have dependencies: [], same priority,
    // and the orchestrator picked Phase 4 as a "quick win" over Phase 2.
    // After fix, wirePhaseDependencies() in init() chains them correctly.
    const queue = WorkQueue._createForTesting([
      makeItem({ id: "lt-p1", title: "LucidTasks Phase 1: Core features", priority: "normal" }),
      makeItem({ id: "lt-p2", title: "LucidTasks Phase 2: Database schema", priority: "normal" }),
      makeItem({ id: "lt-p3", title: "LucidTasks Phase 3: API endpoints", priority: "normal" }),
      makeItem({ id: "lt-p4", title: "LucidTasks Phase 4: Docs and tests", priority: "normal" }),
    ]);
    const orch = WorkOrchestrator._createForTesting(queue);
    const result = await orch.init();

    expect(result.success).toBe(true);
    expect(result.ready).toBe(1);   // Only Phase 1
    expect(result.blocked).toBe(3); // Phase 2, 3, 4

    // Phase 4 must NOT appear in any batch before Phase 1 is complete
    const batch = await orch.nextBatch(5);
    expect(batch.items.length).toBe(1);
    expect(batch.items[0].id).toBe("lt-p1");
    expect(batch.items.map(i => i.id)).not.toContain("lt-p4");

    // Verify the dependency chain is correctly wired: p2→p1, p3→p2, p4→p3
    expect(queue.getItem("lt-p2")!.dependencies).toContain("lt-p1");
    expect(queue.getItem("lt-p3")!.dependencies).toContain("lt-p2");
    expect(queue.getItem("lt-p4")!.dependencies).toContain("lt-p3");
  });
});

// ---------------------------------------------------------------------------
// E2E: Spec coverage gate — template ISC rejected against rich spec
// ---------------------------------------------------------------------------

describe("E2E: Spec coverage gate blocks template ISC against rich spec", () => {
  const { writeFileSync, unlinkSync, mkdtempSync } = require("fs");
  const { join } = require("path");
  const { tmpdir } = require("os");

  it("rejects completion when 2 template ISC rows face 8 spec requirements", async () => {
    // Create spec file with 8 requirements
    const dir = mkdtempSync(join(tmpdir(), "e2e-spec-gate-"));
    const specPath = join(dir, "spec.md");
    writeFileSync(specPath, `# Mobile Gateway Phase 1

## Success Criteria
- [ ] WebSocket connection manager with auto-reconnect
- [ ] Event-driven message routing with type-safe handlers
- [ ] Binary protocol encoder/decoder for mobile payloads
- [ ] Authentication middleware with JWT validation
- [ ] Rate limiting per-connection with sliding window
- [ ] Health check endpoint with deep dependency probing
- [ ] Graceful shutdown with connection draining
- [ ] Metrics collection with Prometheus-compatible export
`);

    // Build pipeline: item with specPath → template ISC (2 rows) → try complete
    const queue = WorkQueue._createForTesting([
      makeItem({ id: "mobile-p1", title: "Mobile Gateway Phase 1", specPath }),
    ]);
    const orch = WorkOrchestrator._createForTesting(queue);
    await orch.init();

    // Simulate template ISC generation (2 generic rows, all INFERRED)
    orch.setItemISC("mobile-p1", [
      makeDoneRow(1, { description: "Implement core functionality", source: "INFERRED" as const, status: "VERIFIED" }),
      makeDoneRow(2, { description: "Add tests and validation", source: "INFERRED" as const, status: "VERIFIED" }),
    ]);

    // Set verification to passed (simulating a permissive verifier)
    queue.setVerification("mobile-p1", {
      status: "verified", verifiedAt: new Date().toISOString(), verdict: "PASS",
      concerns: [], iscRowsVerified: 2, iscRowsTotal: 2, verificationCost: 0.02,
      verifiedBy: "skeptical_verifier" as const, tiersExecuted: [1, 2],
    });

    // Attempt completion — quaternary gate should block
    const result = await orch.complete("mobile-p1");
    expect(result.success).toBe(false);
    expect(result.reason).toContain("Requirement coverage too low");

    // Verify the reason includes the actual counts
    expect(result.reason).toContain("2 verified");
    expect(result.reason).toMatch(/\d+ spec requirements/);

    unlinkSync(specPath);
  });

  it("allows completion when spec-derived ISC covers requirements", async () => {
    const dir = mkdtempSync(join(tmpdir(), "e2e-spec-pass-"));
    const specPath = join(dir, "spec.md");
    writeFileSync(specPath, `# Feature

## Success Criteria
- [ ] Auth module
- [ ] Session management
- [ ] Token refresh
- [ ] Rate limiting
`);

    const queue = WorkQueue._createForTesting([
      makeItem({ id: "feat-1", title: "Feature Implementation", specPath }),
    ]);
    const orch = WorkOrchestrator._createForTesting(queue);
    await orch.init();
    orch.started("feat-1");

    // 4 EXPLICIT rows matching 4 spec requirements (100% coverage)
    orch.setItemISC("feat-1", [
      makeDoneRow(1, { description: "Auth module", source: "EXPLICIT" as const, status: "VERIFIED" }),
      makeDoneRow(2, { description: "Session management", source: "EXPLICIT" as const, status: "VERIFIED" }),
      makeDoneRow(3, { description: "Token refresh", source: "EXPLICIT" as const, status: "VERIFIED" }),
      makeDoneRow(4, { description: "Rate limiting", source: "EXPLICIT" as const, status: "VERIFIED" }),
    ]);

    queue.setVerification("feat-1", {
      status: "verified", verifiedAt: new Date().toISOString(), verdict: "PASS",
      concerns: [], iscRowsVerified: 4, iscRowsTotal: 4, verificationCost: 0.02,
      verifiedBy: "skeptical_verifier" as const, tiersExecuted: [1, 2],
    });

    const result = await orch.complete("feat-1");
    expect(result.success).toBe(true);

    unlinkSync(specPath);
  });
});
