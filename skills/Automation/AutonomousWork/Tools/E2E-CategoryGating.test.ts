/**
 * E2E-CategoryGating.test.ts — End-to-end verification of ISC row categorization & cleanup phase gating
 *
 * Tests:
 *   1. inferCategory correctness (SpecParser)
 *   2. templateRows generates lean rows (no mandatory docs/cleanup)
 *   3. complete() gate rejects pending gated category rows
 *   4. Tier 2 skip prevention for TRIVIAL items with gated categories
 *   5. Tier 1 Check 9: stale documentation detection
 */

import { describe, it, expect } from "bun:test";
import { inferCategory } from "./SpecParser.ts";
import { WorkOrchestrator, type ISCRow, type ISCRowCategory } from "./WorkOrchestrator.ts";
import { SkepticalVerifier, type ItemReviewSummary, type InferenceFn } from "./SkepticalVerifier.ts";
import { WorkQueue, type WorkItem } from "./WorkQueue.ts";

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

// ---------------------------------------------------------------------------
// 1. inferCategory correctness
// ---------------------------------------------------------------------------

describe("E2E: inferCategory", () => {
  it("deploy keywords → deployment", () => {
    expect(inferCategory("Deploy launchd plist to system")).toBe("deployment");
    expect(inferCategory("Run launchctl load service")).toBe("deployment");
    expect(inferCategory("Install plist file")).toBe("deployment");
  });

  it("docs keywords → documentation", () => {
    expect(inferCategory("Update SKILL.md architecture section")).toBe("documentation");
    expect(inferCategory("Update README with new API docs")).toBe("documentation");
    expect(inferCategory("Document the new endpoints")).toBe("documentation");
  });

  it("cleanup keywords → cleanup", () => {
    expect(inferCategory("Clean up legacy ElevenLabs config")).toBe("cleanup");
    expect(inferCategory("Remove legacy voice references")).toBe("cleanup");
    expect(inferCategory("Mark deprecated endpoints")).toBe("cleanup");
    expect(inferCategory("Config removal for old settings")).toBe("cleanup");
  });

  it("test keywords → testing", () => {
    expect(inferCategory("Add unit tests for retry logic")).toBe("testing");
    expect(inferCategory("Validate schema against spec")).toBe("testing");
    expect(inferCategory("Assert output matches expected")).toBe("testing");
  });

  it("generic descriptions → implementation", () => {
    expect(inferCategory("Implement HTTP retry with backoff")).toBe("implementation");
    expect(inferCategory("Set up database connection pooling")).toBe("implementation");
  });

  it("uses phaseContext for inference", () => {
    expect(inferCategory("Configure system", "Phase 7: Deployment")).toBe("deployment");
    expect(inferCategory("Update files", "Cleanup phase")).toBe("cleanup");
  });
});

// ---------------------------------------------------------------------------
// 2. templateRows generates lean rows (no mandatory docs/cleanup)
// ---------------------------------------------------------------------------

describe("E2E: templateRows category generation", () => {
  it("STANDARD dev generates 2 rows (implement + test), no docs/cleanup", async () => {
    const queue = WorkQueue._createForTesting([makeItem({ id: "std", workType: "dev" })]);
    const orch = WorkOrchestrator._createForTesting(queue);
    const result = await orch.prepare("std");
    const categories = result.iscRows.map(r => r.category);

    expect(categories).toContain("implementation");
    expect(categories).toContain("testing");
    expect(categories).not.toContain("documentation");
    expect(categories).not.toContain("cleanup");
    expect(result.iscRows.length).toBe(2);
  });

  it("TRIVIAL dev has NO docs/cleanup rows", async () => {
    const queue = WorkQueue._createForTesting([makeItem({ id: "triv", workType: "dev" })]);
    const orch = WorkOrchestrator._createForTesting(queue);
    const result = await orch.prepare("triv", "TRIVIAL");

    expect(result.iscRows.some(r => r.category === "documentation")).toBe(false);
    expect(result.iscRows.some(r => r.category === "cleanup")).toBe(false);
  });

  it("QUICK dev has NO docs/cleanup rows", async () => {
    const queue = WorkQueue._createForTesting([makeItem({ id: "qk", workType: "dev" })]);
    const orch = WorkOrchestrator._createForTesting(queue);
    const result = await orch.prepare("qk", "QUICK");

    expect(result.iscRows.some(r => r.category === "documentation")).toBe(false);
    expect(result.iscRows.some(r => r.category === "cleanup")).toBe(false);
  });

  it("THOROUGH dev has 3 rows (implement + test + edge case), no docs/cleanup", async () => {
    const queue = WorkQueue._createForTesting([makeItem({ id: "th", workType: "dev" })]);
    const orch = WorkOrchestrator._createForTesting(queue);
    const result = await orch.prepare("th", "THOROUGH");

    expect(result.iscRows.some(r => r.category === "documentation")).toBe(false);
    expect(result.iscRows.some(r => r.category === "cleanup")).toBe(false);
    expect(result.iscRows.length).toBe(3); // implement + test + edge case
  });

  it("research workType has NO docs/cleanup rows", async () => {
    const queue = WorkQueue._createForTesting([makeItem({ id: "res", workType: "research" })]);
    const orch = WorkOrchestrator._createForTesting(queue);
    const result = await orch.prepare("res");

    expect(result.iscRows.some(r => r.category === "documentation")).toBe(false);
    expect(result.iscRows.some(r => r.category === "cleanup")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 3. complete() gate rejects pending gated categories
// ---------------------------------------------------------------------------

describe("E2E: Completion gate enforcement", () => {
  it("blocks when documentation row is PENDING", async () => {
    const queue = WorkQueue._createForTesting([makeItem({ id: "g1" })]);
    const orch = WorkOrchestrator._createForTesting(queue);
    queue.setVerification("g1", {
      status: "verified", verifiedAt: new Date().toISOString(), verdict: "PASS",
      concerns: [], iscRowsVerified: 3, iscRowsTotal: 4, verificationCost: 0,
      verifiedBy: "skeptical_verifier" as const, tiersExecuted: [1, 2],
    });
    orch.setItemISC("g1", [
      { id: 1, description: "Implement", status: "VERIFIED", category: "implementation", parallel: false },
      { id: 2, description: "Tests", status: "VERIFIED", category: "testing", parallel: false },
      { id: 3, description: "Update docs", status: "PENDING", category: "documentation", parallel: false },
      { id: 4, description: "Cleanup", status: "VERIFIED", category: "cleanup", parallel: false },
    ]);

    const result = await orch.complete("g1");
    // Hits the secondary gate (unverified rows) before tertiary
    expect(result.success).toBe(false);
    expect(result.reason).toBeDefined();
  });

  it("blocks when cleanup row is not VERIFIED (tertiary gate)", async () => {
    const queue = WorkQueue._createForTesting([makeItem({ id: "g2" })]);
    const orch = WorkOrchestrator._createForTesting(queue);
    queue.setVerification("g2", {
      status: "verified", verifiedAt: new Date().toISOString(), verdict: "PASS",
      concerns: [], iscRowsVerified: 4, iscRowsTotal: 4, verificationCost: 0,
      verifiedBy: "skeptical_verifier" as const, tiersExecuted: [1, 2],
    });
    // All rows VERIFIED except cleanup is DONE (not VERIFIED)
    orch.setItemISC("g2", [
      { id: 1, description: "Implement", status: "VERIFIED", category: "implementation", parallel: false },
      { id: 2, description: "Tests", status: "VERIFIED", category: "testing", parallel: false },
      { id: 3, description: "Docs", status: "VERIFIED", category: "documentation", parallel: false },
      { id: 4, description: "Cleanup", status: "DONE", category: "cleanup", parallel: false },
    ]);

    const result = await orch.complete("g2");
    expect(result.success).toBe(false);
    // Could be secondary gate (DONE != VERIFIED) or tertiary
    expect(result.reason).toContain("not verified");
  });

  it("passes when all gated rows are VERIFIED", async () => {
    const queue = WorkQueue._createForTesting([makeItem({ id: "g3", status: "in_progress" })]);
    const orch = WorkOrchestrator._createForTesting(queue);
    queue.setVerification("g3", {
      status: "verified", verifiedAt: new Date().toISOString(), verdict: "PASS",
      concerns: [], iscRowsVerified: 4, iscRowsTotal: 4, verificationCost: 0,
      verifiedBy: "skeptical_verifier" as const, tiersExecuted: [1, 2],
    });
    orch.setItemISC("g3", [
      { id: 1, description: "Implement", status: "VERIFIED", category: "implementation", parallel: false },
      { id: 2, description: "Tests", status: "VERIFIED", category: "testing", parallel: false },
      { id: 3, description: "Docs", status: "VERIFIED", category: "documentation", parallel: false },
      { id: 4, description: "Cleanup", status: "VERIFIED", category: "cleanup", parallel: false },
    ]);

    const result = await orch.complete("g3");
    expect(result.success).toBe(true);
  });

  it("backward compat: no category field → passes normally", async () => {
    const queue = WorkQueue._createForTesting([makeItem({ id: "g4", status: "in_progress" })]);
    const orch = WorkOrchestrator._createForTesting(queue);
    queue.setVerification("g4", {
      status: "verified", verifiedAt: new Date().toISOString(), verdict: "PASS",
      concerns: [], iscRowsVerified: 1, iscRowsTotal: 1, verificationCost: 0,
      verifiedBy: "skeptical_verifier" as const, tiersExecuted: [1, 2],
    });
    orch.setItemISC("g4", [
      { id: 1, description: "Do something", status: "VERIFIED", parallel: false },
    ]);

    const result = await orch.complete("g4");
    expect(result.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 4. Tier 2 skip prevention for TRIVIAL + gated categories
// ---------------------------------------------------------------------------

describe("E2E: Tier 2 skip prevention", () => {
  it("TRIVIAL with no gated categories → Tier 2 skipped", async () => {
    const verifier = new SkepticalVerifier();
    const result = await verifier.review({
      itemId: "t1", title: "Fix typo", description: "Fix typo", effort: "TRIVIAL",
      priority: "LOW",
      iscRows: [{ id: 1, description: "Fix it", status: "VERIFIED", category: "implementation" }],
      gitDiffStat: " file.ts | 1 +\n 1 file changed", executionLogTail: [],
      iterationsUsed: 1, budgetSpent: 0.01, budgetAllocated: 0.1,
    });

    expect(result.tiersSkipped.some(s => s.tier === 2)).toBe(true);
    expect(result.tiers.length).toBe(1);
  });

  it("TRIVIAL WITH documentation category → Tier 2 runs", async () => {
    const inferenceFn: InferenceFn = async () => ({
      success: true, parsed: { verdict: "PASS", confidence: 0.9, concerns: [] },
    });
    const verifier = new SkepticalVerifier({ inferenceFn });
    const result = await verifier.review({
      itemId: "t2", title: "Update docs", description: "Update docs", effort: "TRIVIAL",
      priority: "LOW",
      iscRows: [
        { id: 1, description: "Fix it", status: "VERIFIED", category: "implementation" },
        { id: 2, description: "Update SKILL.md", status: "VERIFIED", category: "documentation" },
      ],
      gitDiffStat: " SKILL.md | 5 +\n 1 file changed", executionLogTail: [],
      iterationsUsed: 1, budgetSpent: 0.01, budgetAllocated: 0.1,
    });

    expect(result.tiersSkipped.some(s => s.tier === 2)).toBe(false);
    expect(result.tiers.some(t => t.tier === 2)).toBe(true);
  });

  it("TRIVIAL WITH cleanup category → Tier 2 runs", async () => {
    const inferenceFn: InferenceFn = async () => ({
      success: true, parsed: { verdict: "PASS", confidence: 0.9, concerns: [] },
    });
    const verifier = new SkepticalVerifier({ inferenceFn });
    const result = await verifier.review({
      itemId: "t3", title: "Cleanup", description: "Cleanup", effort: "TRIVIAL",
      priority: "LOW",
      iscRows: [
        { id: 1, description: "Remove old config", status: "VERIFIED", category: "cleanup" },
      ],
      gitDiffStat: " config.json | 3 -\n 1 file changed", executionLogTail: [],
      iterationsUsed: 1, budgetSpent: 0.01, budgetAllocated: 0.1,
    });

    expect(result.tiersSkipped.some(s => s.tier === 2)).toBe(false);
    expect(result.tiers.some(t => t.tier === 2)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 5. Tier 1 Check 9: stale documentation detection
// ---------------------------------------------------------------------------

describe("E2E: Tier 1 stale documentation detection", () => {
  it("flags when doc/cleanup rows exist but none completed", () => {
    const verifier = new SkepticalVerifier();
    const result = verifier.runTier1({
      itemId: "s1", title: "Feature", description: "Feature", effort: "STANDARD",
      priority: "MEDIUM",
      iscRows: [
        { id: 1, description: "Implement", status: "VERIFIED", category: "implementation" },
        { id: 2, description: "Update docs", status: "PENDING", category: "documentation" },
        { id: 3, description: "Clean up config", status: "PENDING", category: "cleanup" },
      ],
      gitDiffStat: " src/feature.ts | 50 +++\n 1 file changed", executionLogTail: ["done"],
      iterationsUsed: 3, budgetSpent: 1.5, budgetAllocated: 10,
    });

    expect(result.concerns.some(c => c.includes("documentation/cleanup rows present but none completed"))).toBe(true);
  });

  it("no concern when doc/cleanup rows are completed", () => {
    const verifier = new SkepticalVerifier();
    const result = verifier.runTier1({
      itemId: "s2", title: "Feature", description: "Feature", effort: "STANDARD",
      priority: "MEDIUM",
      iscRows: [
        { id: 1, description: "Implement", status: "VERIFIED", category: "implementation" },
        { id: 2, description: "Update docs", status: "DONE", category: "documentation" },
        { id: 3, description: "Clean up config", status: "VERIFIED", category: "cleanup" },
      ],
      gitDiffStat: " src/feature.ts | 50 +++\n docs/ | 5 +\n 2 files changed", executionLogTail: ["done"],
      iterationsUsed: 3, budgetSpent: 1.5, budgetAllocated: 10,
    });

    expect(result.concerns.some(c => c.includes("documentation/cleanup rows present but none completed"))).toBe(false);
  });

  it("no concern when there are no doc/cleanup rows at all", () => {
    const verifier = new SkepticalVerifier();
    const result = verifier.runTier1({
      itemId: "s3", title: "Feature", description: "Feature", effort: "STANDARD",
      priority: "MEDIUM",
      iscRows: [
        { id: 1, description: "Implement", status: "VERIFIED", category: "implementation" },
        { id: 2, description: "Test", status: "VERIFIED", category: "testing" },
      ],
      gitDiffStat: " src/feature.ts | 50 +++\n 2 files changed", executionLogTail: ["done"],
      iterationsUsed: 3, budgetSpent: 1.5, budgetAllocated: 10,
    });

    expect(result.concerns.some(c => c.includes("documentation/cleanup"))).toBe(false);
  });
});
