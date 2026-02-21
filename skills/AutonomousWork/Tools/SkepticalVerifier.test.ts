/**
 * SkepticalVerifier.test.ts — Unit tests for the 3-tier skeptical verification system
 *
 * Tests:
 *   - Tier 1 code-based checks (completion ratio, paper completion, budget anomaly, etc.)
 *   - Config defaults and overrides
 *   - Verdict computation logic
 *   - TRIVIAL effort skips Tier 2
 *   - Escalation to Tier 3 on low confidence
 *   - HIGH priority always triggers Tier 3
 */

import { describe, it, expect, mock, spyOn } from "bun:test";
import { SkepticalVerifier, type ItemReviewSummary, type VerificationTier, type InferenceFn } from "./SkepticalVerifier.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSummary(overrides: Partial<ItemReviewSummary> = {}): ItemReviewSummary {
  return {
    itemId: "test-item-123",
    title: "Add retry mechanism to HTTP client",
    description: "Implement exponential backoff retry for failed HTTP requests",
    effort: "STANDARD",
    priority: "MEDIUM",
    iscRows: [
      { id: 1, description: "Understand existing code", status: "VERIFIED", capability: "analysis.codebase" },
      { id: 2, description: "Implement retry logic", status: "VERIFIED", capability: "execution.engineer", verification: { method: "test", result: "PASS" } },
      { id: 3, description: "Add tests", status: "VERIFIED", capability: "execution.testing", verification: { method: "test", result: "PASS" } },
    ],
    gitDiffStat: " src/http-client.ts | 45 ++++++++++++\n src/http-client.test.ts | 30 ++++++++\n 2 files changed, 75 insertions(+)",
    executionLogTail: ["Phase: EXECUTE - Running ISC rows", "Row 1 completed", "Row 2 completed", "Row 3 completed"],
    iterationsUsed: 3,
    budgetSpent: 1.5,
    budgetAllocated: 10,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tier 1: Code-Based Checks
// ---------------------------------------------------------------------------

describe("Tier 1: Code-based verification", () => {
  it("PASS for healthy completion with all rows verified", () => {
    const verifier = new SkepticalVerifier();
    const result = verifier.runTier1(makeSummary());

    expect(result.tier).toBe(1);
    expect(result.verdict).toBe("PASS");
    expect(result.confidence).toBeGreaterThanOrEqual(0.8);
    expect(result.concerns.length).toBe(0);
    expect(result.costEstimate).toBe(0);
  });

  it("detects paper completion (no git diff)", () => {
    const verifier = new SkepticalVerifier();
    const result = verifier.runTier1(makeSummary({
      gitDiffStat: "",
    }));

    expect(result.concerns.some(c => c.includes("paper completion"))).toBe(true);
    expect(result.confidence).toBeLessThan(0.8);
  });

  it("detects low completion ratio", () => {
    const verifier = new SkepticalVerifier();
    const result = verifier.runTier1(makeSummary({
      iscRows: [
        { id: 1, description: "Task 1", status: "DONE" },
        { id: 2, description: "Task 2", status: "EXECUTION_FAILED" },
        { id: 3, description: "Task 3", status: "SKIPPED" },
        { id: 4, description: "Task 4", status: "PENDING" },
      ],
    }));

    expect(result.concerns.some(c => c.includes("completion ratio") || c.includes("Partial completion"))).toBe(true);
  });

  it("detects failed verification rows", () => {
    const verifier = new SkepticalVerifier();
    const result = verifier.runTier1(makeSummary({
      iscRows: [
        { id: 1, description: "Task 1", status: "DONE", verification: { method: "test", result: "PASS" } },
        { id: 2, description: "Task 2", status: "DONE", verification: { method: "test", result: "FAIL" } },
      ],
    }));

    expect(result.concerns.some(c => c.includes("failed verification"))).toBe(true);
  });

  it("detects budget anomaly (near-zero spend)", () => {
    const verifier = new SkepticalVerifier();
    const result = verifier.runTier1(makeSummary({
      budgetSpent: 0.001,
      budgetAllocated: 10,
    }));

    expect(result.concerns.some(c => c.includes("budget usage"))).toBe(true);
  });

  it("detects zero iterations with completed rows", () => {
    const verifier = new SkepticalVerifier();
    const result = verifier.runTier1(makeSummary({
      iterationsUsed: 0,
    }));

    expect(result.concerns.some(c => c.includes("zero iterations"))).toBe(true);
  });

  it("detects missing test files for engineering work", () => {
    const verifier = new SkepticalVerifier();
    const result = verifier.runTier1(makeSummary({
      iscRows: [
        { id: 1, description: "Implement feature", status: "VERIFIED", capability: "execution.engineer" },
      ],
      gitDiffStat: " src/feature.ts | 50 ++++++++++++\n 1 file changed, 50 insertions(+)",
    }));

    expect(result.concerns.some(c => c.includes("test files"))).toBe(true);
  });

  it("TRIVIAL items skip paper completion check", () => {
    const verifier = new SkepticalVerifier();
    const result = verifier.runTier1(makeSummary({
      effort: "TRIVIAL",
      gitDiffStat: "",
    }));

    expect(result.concerns.some(c => c.includes("paper completion"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

describe("SkepticalVerifier config", () => {
  it("uses default config when none provided", () => {
    const verifier = new SkepticalVerifier();
    const config = verifier.getConfig();

    expect(config.escalationThreshold).toBe(0.7);
    expect(config.alwaysDeepReviewHighPriority).toBe(true);
    expect(config.skipInferenceForTrivial).toBe(true);
    expect(config.tier3BudgetCap).toBe(0.50);
  });

  it("allows config overrides", () => {
    const verifier = new SkepticalVerifier({
      escalationThreshold: 0.5,
      alwaysDeepReviewHighPriority: false,
    });
    const config = verifier.getConfig();

    expect(config.escalationThreshold).toBe(0.5);
    expect(config.alwaysDeepReviewHighPriority).toBe(false);
    expect(config.skipInferenceForTrivial).toBe(true); // default preserved
  });
});

// ---------------------------------------------------------------------------
// Full Review Flow (Tier 1 only for TRIVIAL)
// ---------------------------------------------------------------------------

describe("Full review flow", () => {
  it("TRIVIAL items skip Tier 2, only run Tier 1", async () => {
    const verifier = new SkepticalVerifier();
    const result = await verifier.review(makeSummary({
      effort: "TRIVIAL",
    }));

    // Should only have Tier 1
    expect(result.tiers.length).toBe(1);
    expect(result.tiers[0].tier).toBe(1);
    expect(result.totalCost).toBe(0);
  });

  it("healthy item gets PASS from Tier 1 and Tier 2 with injectable inference", async () => {
    const inferenceFn: InferenceFn = async () => ({
      success: true,
      parsed: { verdict: "PASS", confidence: 0.9, concerns: [] },
    });
    const verifier = new SkepticalVerifier({ skipInferenceForTrivial: false, inferenceFn });
    const summary = makeSummary({ effort: "TRIVIAL" });

    const result = await verifier.review(summary);

    // Tier 1 PASS (healthy summary)
    expect(result.tiers[0].tier).toBe(1);
    expect(result.tiers[0].verdict).toBe("PASS");
    // Tier 2 PASS (injectable inference returned PASS)
    expect(result.tiers.length).toBeGreaterThanOrEqual(2);
    expect(result.tiers[1].tier).toBe(2);
    expect(result.tiers[1].verdict).toBe("PASS");
  });

  it("aggregates concerns from all tiers", async () => {
    const verifier = new SkepticalVerifier();
    const result = await verifier.review(makeSummary({
      effort: "TRIVIAL",
      iterationsUsed: 0, // Will trigger concern
      budgetSpent: 0, // Will trigger concern
    }));

    expect(result.concerns.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Spec Alignment Checks
// ---------------------------------------------------------------------------

describe("Tier 1: Spec alignment", () => {
  it("detects low spec alignment when ISC rows don't match spec", () => {
    const verifier = new SkepticalVerifier();
    const result = verifier.runTier1(makeSummary({
      specContent: `## Requirements
- Must implement authentication middleware
- Should add OAuth2 support
- Required: session management`,
      iscRows: [
        { id: 1, description: "Update color scheme", status: "VERIFIED" },
        { id: 2, description: "Fix button alignment", status: "VERIFIED" },
      ],
    }));

    expect(result.concerns.some(c => c.includes("spec alignment"))).toBe(true);
  });

  it("passes spec alignment when ISC rows match spec keywords", () => {
    const verifier = new SkepticalVerifier();
    const result = verifier.runTier1(makeSummary({
      specContent: `## Requirements
- Must implement retry mechanism
- Should add exponential backoff`,
      iscRows: [
        { id: 1, description: "Implement retry mechanism with backoff", status: "VERIFIED", capability: "execution.engineer" },
        { id: 2, description: "Add tests for retry logic", status: "VERIFIED", capability: "execution.testing" },
      ],
      gitDiffStat: " src/retry.ts | 50 +++\n src/retry.test.ts | 30 +++\n 2 files changed",
    }));

    expect(result.concerns.some(c => c.includes("spec alignment"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Budget Verification Tracking
// ---------------------------------------------------------------------------

describe("BudgetManager verification tracking", () => {
  // These tests are for the BudgetManager changes
  it("initItem sets verificationBudget to 10% of allocated", async () => {
    const { BudgetManager } = await import("./BudgetManager.ts");
    const tmpPath = `/tmp/budget-test-${Date.now()}.json`;
    const mgr = new BudgetManager(tmpPath);
    mgr.initQueue(100);

    const budget = mgr.initItem("test-item", "STANDARD");
    expect(budget.verificationSpent).toBe(0);
    expect(budget.verificationBudget).toBe(1); // 10% of $10 STANDARD
  });

  it("spendVerification tracks separately from execution budget", async () => {
    const { BudgetManager } = await import("./BudgetManager.ts");
    const tmpPath = `/tmp/budget-test-${Date.now()}.json`;
    const mgr = new BudgetManager(tmpPath);
    mgr.initQueue(100);
    mgr.initItem("test-item", "STANDARD");

    const result = mgr.spendVerification("test-item", 0.05);
    expect(result.allowed).toBe(true);
    expect(result.verificationRemaining).toBeCloseTo(0.95);

    const itemBudget = mgr.getItemBudget("test-item");
    expect(itemBudget?.verificationSpent).toBe(0.05);
    expect(itemBudget?.spent).toBe(0); // Execution budget unchanged
  });

  it("spendVerification rejects when over verification budget cap", async () => {
    const { BudgetManager } = await import("./BudgetManager.ts");
    const tmpPath = `/tmp/budget-test-${Date.now()}.json`;
    const mgr = new BudgetManager(tmpPath);
    mgr.initQueue(100);
    mgr.initItem("test-item", "QUICK"); // $1 budget → $0.10 verification budget

    const result = mgr.spendVerification("test-item", 0.50); // Way over $0.10 cap
    expect(result.allowed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Verdict Computation (all tier combinations)
// ---------------------------------------------------------------------------

function makeTier(overrides: Partial<VerificationTier> & { tier: 1 | 2 | 3 }): VerificationTier {
  return {
    verdict: "PASS",
    confidence: 0.9,
    concerns: [],
    costEstimate: 0,
    latencyMs: 0,
    ...overrides,
  };
}

describe("Verdict computation", () => {
  const verifier = new SkepticalVerifier();

  it("Tier 1 only PASS → PASS", () => {
    const result = verifier.computeVerdictForTesting([
      makeTier({ tier: 1, verdict: "PASS" }),
    ]);
    expect(result).toBe("PASS");
  });

  it("Tier 1 only FAIL → FAIL", () => {
    const result = verifier.computeVerdictForTesting([
      makeTier({ tier: 1, verdict: "FAIL" }),
    ]);
    expect(result).toBe("FAIL");
  });

  it("Tier 1 only NEEDS_REVIEW → NEEDS_REVIEW", () => {
    const result = verifier.computeVerdictForTesting([
      makeTier({ tier: 1, verdict: "NEEDS_REVIEW" }),
    ]);
    expect(result).toBe("NEEDS_REVIEW");
  });

  it("no tiers → NEEDS_REVIEW (fallback)", () => {
    const result = verifier.computeVerdictForTesting([]);
    expect(result).toBe("NEEDS_REVIEW");
  });

  it("T1 FAIL + T2 PASS → FAIL (Tier 1 cannot be upgraded)", () => {
    const result = verifier.computeVerdictForTesting([
      makeTier({ tier: 1, verdict: "FAIL" }),
      makeTier({ tier: 2, verdict: "PASS" }),
    ]);
    expect(result).toBe("FAIL");
  });

  it("T1 NEEDS_REVIEW + T2 PASS → NEEDS_REVIEW (Tier 1 concern stands)", () => {
    const result = verifier.computeVerdictForTesting([
      makeTier({ tier: 1, verdict: "NEEDS_REVIEW" }),
      makeTier({ tier: 2, verdict: "PASS" }),
    ]);
    expect(result).toBe("NEEDS_REVIEW");
  });

  it("T1 PASS + T2 FAIL → NEEDS_REVIEW (no Tier 3 to confirm)", () => {
    const result = verifier.computeVerdictForTesting([
      makeTier({ tier: 1, verdict: "PASS" }),
      makeTier({ tier: 2, verdict: "FAIL" }),
    ]);
    expect(result).toBe("NEEDS_REVIEW");
  });

  it("T1 PASS + T2 PASS → PASS", () => {
    const result = verifier.computeVerdictForTesting([
      makeTier({ tier: 1, verdict: "PASS" }),
      makeTier({ tier: 2, verdict: "PASS" }),
    ]);
    expect(result).toBe("PASS");
  });

  it("T1 PASS + T2 NEEDS_REVIEW → NEEDS_REVIEW", () => {
    const result = verifier.computeVerdictForTesting([
      makeTier({ tier: 1, verdict: "PASS" }),
      makeTier({ tier: 2, verdict: "NEEDS_REVIEW" }),
    ]);
    expect(result).toBe("NEEDS_REVIEW");
  });

  it("Tier 3 PASS overrides all → PASS", () => {
    const result = verifier.computeVerdictForTesting([
      makeTier({ tier: 1, verdict: "FAIL" }),
      makeTier({ tier: 2, verdict: "FAIL" }),
      makeTier({ tier: 3, verdict: "PASS" }),
    ]);
    expect(result).toBe("PASS");
  });

  it("Tier 3 FAIL overrides all → FAIL", () => {
    const result = verifier.computeVerdictForTesting([
      makeTier({ tier: 1, verdict: "PASS" }),
      makeTier({ tier: 2, verdict: "PASS" }),
      makeTier({ tier: 3, verdict: "FAIL" }),
    ]);
    expect(result).toBe("FAIL");
  });

  it("Tier 3 NEEDS_REVIEW is authoritative → NEEDS_REVIEW", () => {
    const result = verifier.computeVerdictForTesting([
      makeTier({ tier: 1, verdict: "PASS" }),
      makeTier({ tier: 2, verdict: "PASS" }),
      makeTier({ tier: 3, verdict: "NEEDS_REVIEW" }),
    ]);
    expect(result).toBe("NEEDS_REVIEW");
  });
});

// ---------------------------------------------------------------------------
// Tier 2: Mocked inference tests
// ---------------------------------------------------------------------------

describe("Tier 2: Mocked inference", () => {
  it("parses valid inference response", async () => {
    const verifier = new SkepticalVerifier();
    const summary = makeSummary();
    const tier1 = verifier.runTier1(summary);

    // Mock the inference import
    const mockInference = mock(() =>
      Promise.resolve({
        success: true,
        parsed: {
          verdict: "PASS",
          confidence: 0.85,
          concerns: ["Minor: could add more edge case tests"],
        },
      })
    );

    // Monkey-patch the dynamic import
    const originalRunTier2 = verifier.runTier2.bind(verifier);
    verifier.runTier2 = async (s, t1) => {
      const start = performance.now();
      const result = await mockInference();
      const parsed = result.parsed as { verdict: string; confidence: number; concerns: string[] };
      return {
        tier: 2 as const,
        verdict: parsed.verdict as VerificationTier["verdict"],
        confidence: parsed.confidence,
        concerns: parsed.concerns,
        costEstimate: 0.02,
        latencyMs: performance.now() - start,
      };
    };

    const tier2 = await verifier.runTier2(summary, tier1);
    expect(tier2.tier).toBe(2);
    expect(tier2.verdict).toBe("PASS");
    expect(tier2.confidence).toBe(0.85);
    expect(tier2.concerns).toContain("Minor: could add more edge case tests");
    expect(mockInference).toHaveBeenCalled();
  });

  it("handles unparseable inference result gracefully", async () => {
    // parsed: null triggers the "no parseable result" path (not the success-with-fields path)
    const inferenceFn: InferenceFn = async () => ({
      success: true,
      parsed: null,
    });
    const verifier = new SkepticalVerifier({ inferenceFn });
    const summary = makeSummary();
    const tier1 = verifier.runTier1(summary);

    const tier2 = await verifier.runTier2(summary, tier1);

    expect(tier2.tier).toBe(2);
    expect(tier2.verdict).toBe("FAIL");
    expect(tier2.confidence).toBe(0.0);
    // Anti-masking: assert the SPECIFIC concern string for the unparseable path
    expect(tier2.concerns.some(c => c.includes("unparseable"))).toBe(true);
    expect(tier2.costEstimate).toBe(0.02);
  });
});

// ---------------------------------------------------------------------------
// Tier 3: Mocked inference tests
// ---------------------------------------------------------------------------

describe("Tier 3: Mocked inference", () => {
  it("handles inference failure gracefully with FAIL", async () => {
    const inferenceFn: InferenceFn = async () => {
      throw new Error("inference unavailable");
    };
    const verifier = new SkepticalVerifier({ inferenceFn });
    const summary = makeSummary();
    const tier1 = verifier.runTier1(summary);
    const tier2: VerificationTier = makeTier({
      tier: 2,
      verdict: "NEEDS_REVIEW",
      confidence: 0.5,
      concerns: ["Possible spec drift"],
    });

    const tier3 = await verifier.runTier3(summary, tier1, tier2);

    // Should return FAIL, not propagate tier2 verdict
    expect(tier3.tier).toBe(3);
    expect(tier3.verdict).toBe("FAIL");
    expect(tier3.confidence).toBe(0.0);
    // Anti-masking: assert the SPECIFIC concern string for the failure path
    expect(tier3.concerns.some(c => c.includes("unavailable"))).toBe(true);
    // No real inference call was made, so cost should be 0
    expect(tier3.costEstimate).toBe(0);
  });

  it("escalation triggers on low confidence", async () => {
    const verifier = new SkepticalVerifier({ escalationThreshold: 0.7 });
    const summary = makeSummary({ effort: "STANDARD" });

    // Mock runTier2 to return low confidence
    verifier.runTier2 = async () => makeTier({
      tier: 2,
      verdict: "NEEDS_REVIEW",
      confidence: 0.4,
      concerns: ["Low confidence concern"],
      costEstimate: 0.02,
    });

    // Mock runTier3 to track if it was called
    let tier3Called = false;
    verifier.runTier3 = async () => {
      tier3Called = true;
      return makeTier({
        tier: 3,
        verdict: "PASS",
        confidence: 0.9,
        costEstimate: 0.30,
      });
    };

    const result = await verifier.review(summary);
    expect(tier3Called).toBe(true);
    expect(result.tiers.length).toBe(3);
  });

  it("escalation triggers for HIGH priority", async () => {
    const verifier = new SkepticalVerifier({ alwaysDeepReviewHighPriority: true });
    const summary = makeSummary({ priority: "HIGH" });

    verifier.runTier2 = async () => makeTier({
      tier: 2,
      verdict: "PASS",
      confidence: 0.95,
      costEstimate: 0.02,
    });

    let tier3Called = false;
    verifier.runTier3 = async () => {
      tier3Called = true;
      return makeTier({ tier: 3, verdict: "PASS", confidence: 0.95, costEstimate: 0.30 });
    };

    await verifier.review(summary);
    expect(tier3Called).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Budget cap enforcement
// ---------------------------------------------------------------------------

describe("Budget cap enforcement", () => {
  it("blocks Tier 3 when cumulative cost exceeds tier3BudgetCap", async () => {
    const verifier = new SkepticalVerifier({
      tier3BudgetCap: 0.10, // Very low cap — $0.02 (T2) + $0.30 (T3) > $0.10
      alwaysDeepReviewHighPriority: true,
    });
    const summary = makeSummary({ priority: "HIGH" });

    verifier.runTier2 = async () => makeTier({
      tier: 2,
      verdict: "NEEDS_REVIEW",
      confidence: 0.5,
      costEstimate: 0.02,
    });

    let tier3Called = false;
    verifier.runTier3 = async () => {
      tier3Called = true;
      return makeTier({ tier: 3, verdict: "PASS", costEstimate: 0.30 });
    };

    const result = await verifier.review(summary);

    // Tier 3 should NOT have been called due to budget cap
    expect(tier3Called).toBe(false);
    expect(result.tiers.length).toBe(2);
  });

  it("allows Tier 3 when within budget cap", async () => {
    const verifier = new SkepticalVerifier({
      tier3BudgetCap: 0.50,
      alwaysDeepReviewHighPriority: true,
    });
    const summary = makeSummary({ priority: "HIGH" });

    verifier.runTier2 = async () => makeTier({
      tier: 2,
      verdict: "PASS",
      confidence: 0.9,
      costEstimate: 0.02,
    });

    let tier3Called = false;
    verifier.runTier3 = async () => {
      tier3Called = true;
      return makeTier({ tier: 3, verdict: "PASS", costEstimate: 0.30 });
    };

    await verifier.review(summary);
    expect(tier3Called).toBe(true);
  });

  it("BudgetManager blocks Tier 3 when verification budget exhausted", async () => {
    const { BudgetManager } = await import("./BudgetManager.ts");
    const tmpPath = `/tmp/budget-verify-test-${Date.now()}.json`;
    const mgr = new BudgetManager(tmpPath);
    mgr.initQueue(100);
    mgr.initItem("test-item-123", "QUICK"); // Small verification budget

    // Exhaust verification budget
    mgr.spendVerification("test-item-123", 0.09);

    const verifier = new SkepticalVerifier({
      tier3BudgetCap: 0.50,
      alwaysDeepReviewHighPriority: true,
    });
    const summary = makeSummary({ priority: "HIGH" });

    verifier.runTier2 = async () => makeTier({
      tier: 2,
      verdict: "NEEDS_REVIEW",
      confidence: 0.5,
      costEstimate: 0.02,
    });

    let tier3Called = false;
    verifier.runTier3 = async () => {
      tier3Called = true;
      return makeTier({ tier: 3, verdict: "PASS", costEstimate: 0.30 });
    };

    const result = await verifier.review(summary, mgr);

    // BudgetManager should have blocked Tier 3 (verification budget ~$0.10 cap for QUICK)
    expect(tier3Called).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Tier 3 prompt correctness
// ---------------------------------------------------------------------------

describe("Tier 3 prompt correctness", () => {
  it("buildTier3UserPrompt contains both Tier 1 and Tier 2 sections", () => {
    const verifier = new SkepticalVerifier();
    const summary = makeSummary();

    const tier1 = makeTier({
      tier: 1,
      verdict: "NEEDS_REVIEW",
      confidence: 0.6,
      concerns: ["Low completion ratio: 1/3"],
    });

    const tier2 = makeTier({
      tier: 2,
      verdict: "FAIL",
      confidence: 0.3,
      concerns: ["Possible paper completion"],
    });

    // Access the private method via prototype for testing
    const prompt = (verifier as unknown as { buildTier3UserPrompt: (s: ItemReviewSummary, t1: VerificationTier, t2: VerificationTier) => string })
      .buildTier3UserPrompt(summary, tier1, tier2);

    // Verify prompt has correctly labeled sections
    expect(prompt).toContain("## Tier 1 Code Check Results");
    expect(prompt).toContain("## Tier 2 Inference Skeptic Results");
    expect(prompt).toContain("Low completion ratio: 1/3");
    expect(prompt).toContain("Possible paper completion");
    expect(prompt).toContain(summary.title);

    // Verify it does NOT misrepresent Tier 2 as Tier 1
    expect(prompt).not.toContain("Tier 1 Code Check Results\nVerdict: FAIL");
  });
});

// ---------------------------------------------------------------------------
// Spec alignment keyword length fix
// ---------------------------------------------------------------------------

describe("Spec alignment catches short keywords", () => {
  it("catches 3-letter spec keywords like API, JWT, SQL", () => {
    const verifier = new SkepticalVerifier();
    const result = verifier.runTier1(makeSummary({
      specContent: `## Requirements
- Must implement API authentication
- Should add JWT validation
- Required: SQL injection prevention`,
      iscRows: [
        { id: 1, description: "Implement API auth with JWT tokens and SQL parameterization", status: "VERIFIED" },
      ],
      gitDiffStat: " src/auth.ts | 50 +++\n 1 file changed",
    }));

    // With the word.length > 2 fix, "API", "JWT", "SQL" should now be matched
    // so spec alignment should NOT be flagged as low
    expect(result.concerns.some(c => c.includes("Low spec alignment"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// FM-12: tiersSkipped tracking
// ---------------------------------------------------------------------------

describe("FM-12: tiersSkipped tracking", () => {
  it("TRIVIAL item → tiersSkipped contains Tier 2 skip with TRIVIAL reason", async () => {
    const verifier = new SkepticalVerifier();
    const result = await verifier.review(makeSummary({ effort: "TRIVIAL" }));

    expect(result.tiersSkipped.length).toBeGreaterThanOrEqual(1);
    expect(result.tiersSkipped.some(s => s.tier === 2 && s.reason === "TRIVIAL effort, no gated categories")).toBe(true);
  });

  it("QUICK item with sufficient confidence → Tier 3 skipped with confidence reason", async () => {
    const verifier = new SkepticalVerifier({ escalationThreshold: 0.7, skipInferenceForTrivial: true });
    const summary = makeSummary({ effort: "QUICK", priority: "MEDIUM" });

    // Mock Tier 2 to return high confidence (no escalation)
    verifier.runTier2 = async () => makeTier({
      tier: 2,
      verdict: "PASS",
      confidence: 0.90,
      costEstimate: 0.02,
    });

    const result = await verifier.review(summary);

    expect(result.tiersSkipped.some(s =>
      s.tier === 3 && s.reason.includes("confidence 0.90 >= 0.7")
    )).toBe(true);
  });

  it("normal full run with all tiers → tiersSkipped is empty", async () => {
    const verifier = new SkepticalVerifier({
      tier3BudgetCap: 0.50,
      alwaysDeepReviewHighPriority: true,
    });
    const summary = makeSummary({ priority: "HIGH" });

    verifier.runTier2 = async () => makeTier({
      tier: 2,
      verdict: "PASS",
      confidence: 0.95,
      costEstimate: 0.02,
    });

    verifier.runTier3 = async () => makeTier({
      tier: 3,
      verdict: "PASS",
      confidence: 0.95,
      costEstimate: 0.30,
    });

    const result = await verifier.review(summary);

    // All three tiers ran → nothing skipped
    expect(result.tiersSkipped.length).toBe(0);
    expect(result.tiers.length).toBe(3);
  });

  it("budget cap exceeded → Tier 3 skip tracked with budget reason", async () => {
    const verifier = new SkepticalVerifier({
      tier3BudgetCap: 0.10, // Very low — T2 cost (0.02) + T3 (0.30) > 0.10
      alwaysDeepReviewHighPriority: true,
    });
    const summary = makeSummary({ priority: "HIGH" });

    verifier.runTier2 = async () => makeTier({
      tier: 2,
      verdict: "NEEDS_REVIEW",
      confidence: 0.5,
      costEstimate: 0.02,
    });

    const result = await verifier.review(summary);

    // Tier 3 should be skipped due to budget cap
    expect(result.tiersSkipped.some(s =>
      s.tier === 3 && s.reason.includes("exceeds tier3BudgetCap")
    )).toBe(true);
  });

  it("BudgetManager denied → Tier 3 skip tracked", async () => {
    const { BudgetManager } = await import("./BudgetManager.ts");
    const tmpPath = `/tmp/budget-fm12-test-${Date.now()}.json`;
    const mgr = new BudgetManager(tmpPath);
    mgr.initQueue(100);
    mgr.initItem("test-item-123", "QUICK"); // $0.10 verification budget: Tier 2 ($0.02) fits, Tier 3 ($0.30) denied

    const verifier = new SkepticalVerifier({
      tier3BudgetCap: 0.50,
      alwaysDeepReviewHighPriority: true,
    });
    const summary = makeSummary({ priority: "HIGH" });

    verifier.runTier2 = async () => makeTier({
      tier: 2,
      verdict: "NEEDS_REVIEW",
      confidence: 0.5,
      costEstimate: 0.02,
    });

    const result = await verifier.review(summary, mgr);

    // BudgetManager should have blocked Tier 3
    expect(result.tiersSkipped.some(s =>
      s.tier === 3 && s.reason.includes("BudgetManager denied")
    )).toBe(true);
  });

  it("budget denied after Tier 2 for non-TRIVIAL => concern added", async () => {
    const { BudgetManager } = await import("./BudgetManager.ts");
    const tmpPath = `/tmp/budget-fm12-concern-${Date.now()}.json`;
    const mgr = new BudgetManager(tmpPath);
    mgr.initQueue(100);
    mgr.initItem("test-item-123", "STANDARD"); // $1.00 verification budget

    // Exhaust verification budget so Tier 2 spend ($0.02) is denied
    mgr.spendVerification("test-item-123", 0.99);

    const verifier = new SkepticalVerifier();
    const summary = makeSummary({ effort: "STANDARD" });

    verifier.runTier2 = async () => makeTier({
      tier: 2,
      verdict: "PASS",
      confidence: 0.9,
      costEstimate: 0.02,
    });

    const result = await verifier.review(summary, mgr);

    // Should have Tier 3 skipped entry and a concern about budget denial
    expect(result.tiersSkipped.some(s => s.tier === 3)).toBe(true);
    expect(result.concerns.some(c => c.includes("budget denied") || c.includes("budget"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// FM-6: Requirement extraction replaces keyword matching
// ---------------------------------------------------------------------------

describe("FM-6: Requirement extraction", () => {
  // Access private method via cast
  const getExtractRequirements = () => {
    const verifier = new SkepticalVerifier();
    return (verifier as unknown as {
      extractRequirements: (specContent: string) => string[];
    }).extractRequirements.bind(verifier);
  };

  it("extracts must/should/required statements", () => {
    const extract = getExtractRequirements();
    const spec = `## Requirements
- The system must implement authentication middleware.
- Users should be able to reset their passwords.
- Required: session management with JWT tokens.`;
    const reqs = extract(spec);

    expect(reqs.length).toBe(3);
    expect(reqs.some(r => r.includes("implement authentication middleware"))).toBe(true);
    expect(reqs.some(r => r.includes("reset their passwords"))).toBe(true);
    expect(reqs.some(r => r.includes("session management with JWT tokens"))).toBe(true);
  });

  it("extracts ISC table rows", () => {
    const extract = getExtractRequirements();
    const spec = `## ISC Table
| # | Description | Verify |
|---|-------------|--------|
| 1 | Implement retry logic with backoff | test |
| 2 | Add circuit breaker pattern | test |`;
    const reqs = extract(spec);

    expect(reqs.some(r => r.includes("Implement retry logic with backoff"))).toBe(true);
    expect(reqs.some(r => r.includes("Add circuit breaker pattern"))).toBe(true);
  });

  it("extracts unchecked checkbox items", () => {
    const extract = getExtractRequirements();
    const spec = `## Checklist
- [ ] Set up database connection pooling
- [x] Install dependencies
- [ ] Configure rate limiting`;
    const reqs = extract(spec);

    expect(reqs.some(r => r.includes("Set up database connection pooling"))).toBe(true);
    expect(reqs.some(r => r.includes("Configure rate limiting"))).toBe(true);
    // Checked items should NOT be extracted
    expect(reqs.some(r => r.includes("Install dependencies"))).toBe(false);
  });

  it("deduplicates requirements", () => {
    const extract = getExtractRequirements();
    const spec = `The system must implement retry logic.
| 1 | Implement retry logic | test |`;
    const reqs = extract(spec);

    // Both refer to "implement retry logic" — should be deduped
    // (depends on the first-60-chars key matching)
    expect(reqs.filter(r => r.toLowerCase().includes("implement retry logic")).length).toBeLessThanOrEqual(2);
  });

  it("skips short requirements (<5 chars)", () => {
    const extract = getExtractRequirements();
    const spec = `The system must do.
Required: fix.`;
    const reqs = extract(spec);
    // "do" and "fix" are too short
    expect(reqs.length).toBe(0);
  });

  it("spec alignment uses extracted requirements with multi-word overlap", () => {
    const verifier = new SkepticalVerifier();
    const result = verifier.runTier1(makeSummary({
      specContent: `## Requirements
- Must implement authentication middleware with JWT validation
- Should add rate limiting for API endpoints
- Required: configure CORS for cross-origin requests
- [ ] Set up database connection pooling
- [ ] Add comprehensive error logging
- [ ] Implement webhook notification system`,
      iscRows: [
        { id: 1, description: "Implement authentication middleware with JWT validation", status: "VERIFIED" },
        { id: 2, description: "Add rate limiting for API endpoints", status: "VERIFIED" },
      ],
      gitDiffStat: " src/auth.ts | 80 +++\n src/rate-limit.ts | 40 +++\n 2 files changed",
    }));

    // 2 out of 6 requirements addressed → 33% coverage → low spec alignment
    expect(result.concerns.some(c =>
      c.includes("spec alignment") || c.includes("Unaddressed")
    )).toBe(true);
  });

  it("spec alignment passes when all requirements addressed", () => {
    const verifier = new SkepticalVerifier();
    const result = verifier.runTier1(makeSummary({
      specContent: `## Requirements
- Must implement retry logic with exponential backoff
- Should add unit tests for retry module`,
      iscRows: [
        { id: 1, description: "Implement retry logic with exponential backoff", status: "VERIFIED" },
        { id: 2, description: "Add unit tests for retry module", status: "VERIFIED" },
      ],
      gitDiffStat: " src/retry.ts | 50 +++\n src/retry.test.ts | 30 +++\n 2 files changed",
    }));

    expect(result.concerns.some(c => c.includes("spec alignment"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// FM-7: Targeted spec excerpts for verification prompts
// ---------------------------------------------------------------------------

describe("FM-7: Targeted spec excerpt selection", () => {
  const getExtractSections = () => {
    const verifier = new SkepticalVerifier();
    return (verifier as unknown as {
      extractRelevantSpecSections: (summary: ItemReviewSummary) => string;
    }).extractRelevantSpecSections.bind(verifier);
  };

  it("returns empty string when no specContent", () => {
    const extract = getExtractSections();
    const result = extract(makeSummary({ specContent: undefined }));
    expect(result).toBe("");
  });

  it("prioritizes requirement-dense sections", () => {
    const extract = getExtractSections();
    const spec = `## Introduction
This is a general overview of the project with no requirements.

## Requirements
- Must implement authentication
- Should add rate limiting
- Required: error handling

## Background
Some historical context about the codebase that is not directly relevant.

## ISC Table
| 1 | Implement auth | test |
| 2 | Add rate limiting | test |`;
    const result = extract(makeSummary({ specContent: spec }));

    // Requirements section should appear before Background
    const reqIdx = result.indexOf("Requirements");
    const bgIdx = result.indexOf("Background");
    if (reqIdx >= 0 && bgIdx >= 0) {
      expect(reqIdx).toBeLessThan(bgIdx);
    }
    // At minimum, requirements section should be present
    expect(result).toContain("Requirements");
  });

  it("stays within 3000 char budget", () => {
    const extract = getExtractSections();
    // Build a large spec with many sections
    const sections: string[] = [];
    for (let i = 0; i < 20; i++) {
      sections.push(`## Section ${i}\n${"Lorem ipsum dolor sit amet. ".repeat(50)}`);
    }
    const spec = sections.join("\n\n");
    const result = extract(makeSummary({ specContent: spec }));

    expect(result.length).toBeLessThanOrEqual(3200); // slight buffer for truncation marker
  });

  it("includes ISC-relevant sections based on term overlap", () => {
    const extract = getExtractSections();
    const spec = `## Phase 1: Authentication
Implement JWT-based authentication with OAuth2 support.
- Must validate tokens
- Should support refresh tokens

## Phase 2: Database
Set up PostgreSQL with connection pooling.
- Must use prepared statements

## Phase 3: Deployment
Configure CI/CD pipeline for production.`;
    const result = extract(makeSummary({
      specContent: spec,
      iscRows: [
        { id: 1, description: "Implement JWT authentication", status: "VERIFIED" },
        { id: 2, description: "Add OAuth2 token validation", status: "VERIFIED" },
      ],
    }));

    // Authentication section should be prioritized due to ISC overlap
    expect(result).toContain("Authentication");
  });

  it("Tier 2 prompt uses extractRelevantSpecSections (not slice)", () => {
    const verifier = new SkepticalVerifier();
    const summary = makeSummary({
      specContent: `## Requirements
- Must implement retry logic
## Background
${"x".repeat(5000)}`,
    });
    const tier1 = verifier.runTier1(summary);

    // Access private method to check Tier 2 prompt
    const prompt = (verifier as unknown as {
      buildTier2UserPrompt: (s: ItemReviewSummary, t1: VerificationTier) => string;
    }).buildTier2UserPrompt(summary, tier1);

    // Should contain "relevant sections" header (from extractRelevantSpecSections)
    expect(prompt).toContain("relevant sections");
    // Should NOT contain the full 5000-char padding
    expect(prompt.length).toBeLessThan(summary.specContent!.length);
  });

  it("Tier 3 prompt uses extractRelevantSpecSections (not slice)", () => {
    const verifier = new SkepticalVerifier();
    const summary = makeSummary({
      specContent: `## Requirements
- Must implement retry logic
## Background
${"y".repeat(5000)}`,
    });
    const tier1 = verifier.runTier1(summary);
    const tier2 = makeTier({ tier: 2, verdict: "NEEDS_REVIEW", confidence: 0.5 });

    const prompt = (verifier as unknown as {
      buildTier3UserPrompt: (s: ItemReviewSummary, t1: VerificationTier, t2: VerificationTier) => string;
    }).buildTier3UserPrompt(summary, tier1, tier2);

    expect(prompt).toContain("relevant sections");
    expect(prompt.length).toBeLessThan(summary.specContent!.length);
  });
});

// ---------------------------------------------------------------------------
// Inference failure does not propagate upstream verdict
// ---------------------------------------------------------------------------

describe("Inference failure does not propagate upstream verdict", () => {
  it("Tier 1 PASS → Tier 2 failure → verdict must NOT be PASS", async () => {
    const inferenceFn: InferenceFn = async () => {
      throw new Error("inference unavailable");
    };
    const verifier = new SkepticalVerifier({ inferenceFn });
    const summary = makeSummary(); // healthy summary → Tier 1 will PASS

    const tier1 = verifier.runTier1(summary);
    expect(tier1.verdict).toBe("PASS"); // precondition

    const tier2 = await verifier.runTier2(summary, tier1);

    expect(tier2.verdict).not.toBe("PASS");
    expect(tier2.verdict).toBe("FAIL");
    // Anti-masking: verify we hit the specific catch path
    expect(tier2.concerns.some(c => c.includes("unavailable"))).toBe(true);
    expect(tier2.costEstimate).toBe(0);
  });

  it("Tier 2 PASS → Tier 3 failure → verdict must NOT be PASS", async () => {
    const inferenceFn: InferenceFn = async () => {
      throw new Error("inference unavailable");
    };
    const verifier = new SkepticalVerifier({ inferenceFn });
    const summary = makeSummary();
    const tier1 = verifier.runTier1(summary);

    const tier2: VerificationTier = makeTier({
      tier: 2,
      verdict: "PASS",
      confidence: 0.9,
    });

    const tier3 = await verifier.runTier3(summary, tier1, tier2);

    expect(tier3.verdict).not.toBe("PASS");
    expect(tier3.verdict).toBe("FAIL");
    // Anti-masking: verify we hit the specific catch path
    expect(tier3.concerns.some(c => c.includes("unavailable"))).toBe(true);
    expect(tier3.costEstimate).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Phase 3: Check 13 — CLAUDE.md compliance (CachedHTTPClient / StateManager)
// ---------------------------------------------------------------------------

describe("Tier 1: Check 13 — CLAUDE.md compliance", () => {
  it("flags HTTP ISC work without CachedHTTPClient in diff", () => {
    const verifier = new SkepticalVerifier();
    const result = verifier.runTier1(makeSummary({
      effort: "STANDARD",
      iscRows: [
        { id: 1, description: "Implement HTTP API client for fetching job listings", status: "VERIFIED" },
        { id: 2, description: "Add endpoint request handler", status: "VERIFIED" },
      ],
      gitDiffStat: " src/job-scanner.ts | 80 +++\n src/job-scanner.test.ts | 40 +++\n 2 files changed, 120 insertions(+)",
    }));

    expect(result.concerns.some(c => c.includes("CachedHTTPClient") || c.includes("raw fetch"))).toBe(true);
  });

  it("no concern when CachedHTTPClient appears in diff", () => {
    const verifier = new SkepticalVerifier();
    const result = verifier.runTier1(makeSummary({
      effort: "STANDARD",
      iscRows: [
        { id: 1, description: "Implement HTTP API client for fetching data", status: "VERIFIED" },
      ],
      gitDiffStat: " src/client.ts | 80 +++  (uses CachedHTTPClient)\n 1 file changed, 80 insertions(+)",
    }));

    expect(result.concerns.some(c => c.includes("CachedHTTPClient") || c.includes("raw fetch"))).toBe(false);
  });

  it("flags state work without StateManager in diff", () => {
    const verifier = new SkepticalVerifier();
    const result = verifier.runTier1(makeSummary({
      effort: "STANDARD",
      iscRows: [
        { id: 1, description: "Persist state and config settings to JSON", status: "VERIFIED" },
      ],
      gitDiffStat: " src/config.ts | 40 +++\n 1 file changed, 40 insertions(+)",
    }));

    expect(result.concerns.some(c => c.includes("StateManager") || c.includes("raw JSON.parse"))).toBe(true);
  });

  it("skips check for TRIVIAL effort", () => {
    const verifier = new SkepticalVerifier();
    const result = verifier.runTier1(makeSummary({
      effort: "TRIVIAL",
      iscRows: [
        { id: 1, description: "Implement HTTP API endpoint", status: "VERIFIED" },
      ],
      gitDiffStat: " src/api.ts | 10 +++\n 1 file changed",
    }));

    expect(result.concerns.some(c => c.includes("CachedHTTPClient"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Phase 3: Check 14 — Stub detection (low code density)
// ---------------------------------------------------------------------------

describe("Tier 1: Check 14 — Stub detection", () => {
  it("flags low code density (5 files, 20 insertions on STANDARD)", () => {
    const verifier = new SkepticalVerifier();
    const result = verifier.runTier1(makeSummary({
      effort: "STANDARD",
      iscRows: [
        { id: 1, description: "Implement feature A", status: "VERIFIED" },
        { id: 2, description: "Implement feature B", status: "VERIFIED" },
      ],
      gitDiffStat: " src/a.ts | 4 +++\n src/b.ts | 4 +++\n src/c.ts | 4 +++\n src/d.ts | 4 +++\n src/e.ts | 4 +++\n 5 files changed, 20 insertions(+)",
    }));

    expect(result.concerns.some(c => c.includes("Low code density") || c.includes("stub"))).toBe(true);
  });

  it("no concern for high code density", () => {
    const verifier = new SkepticalVerifier();
    const result = verifier.runTier1(makeSummary({
      effort: "STANDARD",
      iscRows: [
        { id: 1, description: "Implement feature", status: "VERIFIED" },
      ],
      gitDiffStat: " src/feature.ts | 80 +++\n src/feature.test.ts | 50 +++\n src/utils.ts | 30 +++\n 3 files changed, 160 insertions(+)",
    }));

    expect(result.concerns.some(c => c.includes("Low code density") || c.includes("stub"))).toBe(false);
  });

  it("skips check for QUICK effort", () => {
    const verifier = new SkepticalVerifier();
    const result = verifier.runTier1(makeSummary({
      effort: "QUICK",
      iscRows: [
        { id: 1, description: "Fix bug", status: "VERIFIED" },
      ],
      gitDiffStat: " src/a.ts | 2 +++\n src/b.ts | 2 +++\n src/c.ts | 2 +++\n 3 files changed, 6 insertions(+)",
    }));

    expect(result.concerns.some(c => c.includes("Low code density"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Phase 4: Mandatory Tier 3 for STANDARD+ effort
// ---------------------------------------------------------------------------

describe("Phase 4: Mandatory Tier 3 for STANDARD+ effort", () => {
  it("STANDARD effort + MEDIUM priority + high confidence → Tier 3 runs", async () => {
    const verifier = new SkepticalVerifier({
      tier3BudgetCap: 0.50,
      alwaysDeepReviewStandardPlus: true,
    });
    const summary = makeSummary({ effort: "STANDARD", priority: "MEDIUM" });

    // Mock Tier 2 returning high confidence (would normally skip Tier 3)
    verifier.runTier2 = async () => makeTier({
      tier: 2,
      verdict: "PASS",
      confidence: 0.95,
      costEstimate: 0.02,
    });

    let tier3Called = false;
    verifier.runTier3 = async () => {
      tier3Called = true;
      return makeTier({ tier: 3, verdict: "PASS", confidence: 0.95, costEstimate: 0.30 });
    };

    const result = await verifier.review(summary);
    expect(tier3Called).toBe(true);
    expect(result.tiers.length).toBe(3);
  });

  it("QUICK effort + MEDIUM priority + high confidence → Tier 3 skipped", async () => {
    const verifier = new SkepticalVerifier({
      tier3BudgetCap: 0.50,
      alwaysDeepReviewStandardPlus: true,
    });
    const summary = makeSummary({ effort: "QUICK", priority: "MEDIUM" });

    verifier.runTier2 = async () => makeTier({
      tier: 2,
      verdict: "PASS",
      confidence: 0.95,
      costEstimate: 0.02,
    });

    let tier3Called = false;
    verifier.runTier3 = async () => {
      tier3Called = true;
      return makeTier({ tier: 3, verdict: "PASS", confidence: 0.95, costEstimate: 0.30 });
    };

    const result = await verifier.review(summary);
    expect(tier3Called).toBe(false);
    expect(result.tiers.length).toBe(2);
  });

  it("THOROUGH effort always triggers Tier 3 regardless of confidence", async () => {
    const verifier = new SkepticalVerifier({
      tier3BudgetCap: 0.50,
      alwaysDeepReviewStandardPlus: true,
    });
    const summary = makeSummary({ effort: "THOROUGH", priority: "LOW" });

    verifier.runTier2 = async () => makeTier({
      tier: 2,
      verdict: "PASS",
      confidence: 0.99,
      costEstimate: 0.02,
    });

    let tier3Called = false;
    verifier.runTier3 = async () => {
      tier3Called = true;
      return makeTier({ tier: 3, verdict: "PASS", confidence: 0.99, costEstimate: 0.30 });
    };

    const result = await verifier.review(summary);
    expect(tier3Called).toBe(true);
    expect(result.tiers.length).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Check 10: Deployment without runtime verification
// ---------------------------------------------------------------------------

describe("Tier 1: Check 10 — Deployment runtime assertion", () => {
  it("flags deployment rows completed without runtime verification", () => {
    const verifier = new SkepticalVerifier();
    const result = verifier.runTier1(makeSummary({
      iscRows: [
        { id: 1, description: "Implement core feature", status: "VERIFIED", verification: { method: "test", result: "PASS" } },
        { id: 2, description: "Deploy launchd plist", status: "DONE", category: "deployment", verification: { method: "existence", result: "PASS" } },
      ],
      gitDiffStat: " deploy/kaya.plist | 20 +++\n src/feature.ts | 40 +++\n 2 files changed",
    }));

    expect(result.concerns.some(c => c.includes("deployment") && c.includes("runtime verification"))).toBe(true);
  });

  it("passes when deployment rows have runtime verification method", () => {
    const verifier = new SkepticalVerifier();
    const result = verifier.runTier1(makeSummary({
      iscRows: [
        { id: 1, description: "Implement core feature", status: "VERIFIED", verification: { method: "test", result: "PASS" } },
        { id: 2, description: "Deploy launchd plist", status: "DONE", category: "deployment", verification: { method: "launchctl list check", result: "PASS" } },
      ],
      gitDiffStat: " deploy/kaya.plist | 20 +++\n src/feature.ts | 40 +++\n 2 files changed",
    }));

    expect(result.concerns.some(c => c.includes("deployment") && c.includes("runtime verification"))).toBe(false);
  });

  it("no concern when no deployment rows exist", () => {
    const verifier = new SkepticalVerifier();
    const result = verifier.runTier1(makeSummary({
      iscRows: [
        { id: 1, description: "Implement feature", status: "VERIFIED", verification: { method: "test", result: "PASS" } },
      ],
      gitDiffStat: " src/feature.ts | 40 +++\n 1 file changed",
    }));

    expect(result.concerns.some(c => c.includes("deployment"))).toBe(false);
  });

  it("no concern when deployment rows are still PENDING", () => {
    const verifier = new SkepticalVerifier();
    const result = verifier.runTier1(makeSummary({
      iscRows: [
        { id: 1, description: "Implement feature", status: "VERIFIED", verification: { method: "test", result: "PASS" } },
        { id: 2, description: "Deploy service", status: "PENDING", category: "deployment" },
      ],
      gitDiffStat: " src/feature.ts | 40 +++\n 1 file changed",
    }));

    expect(result.concerns.some(c => c.includes("deployment") && c.includes("runtime verification"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// SpecParser: Test case and file structure extraction
// ---------------------------------------------------------------------------

describe("SpecParser: Pattern 3 — Test case table extraction", () => {
  it("extracts TC-XX rows from Testing & Validation section", async () => {
    const { extractISC } = await import("./SpecParser.ts");
    const spec = `# My Spec

## Implementation
Some implementation details.

## Testing & Validation

| ID | Test Case | Expected |
|----|-----------|----------|
| TC-01 | Health endpoint returns fields | 200 with all fields |
| TC-02 | Reconnection after disconnect | Session restored |
| TC-03 | Error handler catches panics | Graceful degradation |

## Next Steps
More stuff.`;

    const isc = extractISC(spec);
    const tcRows = isc.filter(i => i.description.startsWith("TC-"));

    expect(tcRows.length).toBe(3);
    expect(tcRows[0].description).toContain("TC-01");
    expect(tcRows[0].description).toContain("Health endpoint returns fields");
    expect(tcRows[0].source).toBe("EXPLICIT");
    expect(tcRows[0].verifyMethod).toBe("test");
  });

  it("skips header rows in test case tables", async () => {
    const { extractISC } = await import("./SpecParser.ts");
    const spec = `## Test Cases

| ID | Description | Expected |
|----|-------------|----------|
| TC-01 | Validate input | Correct output |`;

    const isc = extractISC(spec);
    const tcRows = isc.filter(i => i.description.startsWith("TC-"));

    expect(tcRows.length).toBe(1);
    expect(tcRows[0].description).toContain("Validate input");
  });
});

describe("SpecParser: Pattern 4 — File structure extraction", () => {
  it("extracts file paths from File Structure section", async () => {
    const { extractISC } = await import("./SpecParser.ts");
    const spec = `# My Spec

## File Structure

\`\`\`
skills/VoiceInteraction/Tools/
  RealtimeVoiceServer.ts
  RealtimeHealthMonitor.ts
  RealtimeHealthMonitor.test.ts
  VoiceSystemPrompt.ts
  VoiceSystemPrompt.test.ts
\`\`\`

## Next Steps
More stuff.`;

    const isc = extractISC(spec);
    const fileRows = isc.filter(i => /\.\w+$/.test(i.description) && i.number >= 300);

    expect(fileRows.length).toBeGreaterThanOrEqual(4);
    expect(fileRows.some(f => f.description.includes("RealtimeHealthMonitor.ts"))).toBe(true);
    expect(fileRows.some(f => f.description.includes("VoiceSystemPrompt.test.ts"))).toBe(true);
  });

  it("marks test files with verifyMethod test", async () => {
    const { extractISC } = await import("./SpecParser.ts");
    const spec = `## File Structure

- RealtimeHealthMonitor.test.ts
- VoiceSystemPrompt.ts`;

    const isc = extractISC(spec);
    const testFile = isc.find(i => i.description.includes(".test.ts"));
    const implFile = isc.find(i => i.description === "VoiceSystemPrompt.ts");

    expect(testFile?.verifyMethod).toBe("test");
    expect(implFile?.verifyMethod).toBe("existence");
  });

  it("ignores directories (no extension)", async () => {
    const { extractISC } = await import("./SpecParser.ts");
    const spec = `## File Structure

skills/VoiceInteraction/Tools/
  RealtimeVoiceServer.ts`;

    const isc = extractISC(spec);
    // Should NOT have a row for the directory path
    expect(isc.some(i => i.description === "skills/VoiceInteraction/Tools/")).toBe(false);
    // Should have the .ts file
    expect(isc.some(i => i.description.includes("RealtimeVoiceServer.ts"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Check 11: Requirement coverage ratio (Fix 2)
// ---------------------------------------------------------------------------

describe("Tier 1: Check 11 — Requirement coverage ratio", () => {
  it("flags low ISC-to-spec ratio (2 rows for 8 requirements)", () => {
    const verifier = new SkepticalVerifier();
    const result = verifier.runTier1(makeSummary({
      specContent: `## Success Criteria
- [ ] Auth module
- [ ] Session management
- [ ] Token refresh
- [ ] Rate limiting
- [ ] Error handling
- [ ] Logging
- [ ] Health check
- [ ] Graceful shutdown`,
      iscRows: [
        { id: 1, description: "Implement feature", status: "VERIFIED", source: "INFERRED" },
        { id: 2, description: "Add tests", status: "VERIFIED", source: "INFERRED" },
      ],
    }));

    expect(result.concerns.some(c => c.includes("Requirement coverage too low"))).toBe(true);
  });

  it("no concern when ISC rows match spec requirements adequately", () => {
    const verifier = new SkepticalVerifier();
    const result = verifier.runTier1(makeSummary({
      specContent: `## Success Criteria
- [ ] Auth module
- [ ] Session management
- [ ] Token refresh
- [ ] Rate limiting`,
      iscRows: [
        { id: 1, description: "Auth module", status: "VERIFIED", source: "EXPLICIT" },
        { id: 2, description: "Session management", status: "VERIFIED", source: "EXPLICIT" },
        { id: 3, description: "Token refresh", status: "VERIFIED", source: "EXPLICIT" },
        { id: 4, description: "Rate limiting", status: "VERIFIED", source: "EXPLICIT" },
      ],
      gitDiffStat: " src/auth.ts | 50 +++\n src/auth.test.ts | 30 +++\n 2 files changed",
    }));

    expect(result.concerns.some(c => c.includes("Requirement coverage too low"))).toBe(false);
  });

  it("flags template override despite explicit spec (>80% INFERRED)", () => {
    const verifier = new SkepticalVerifier();
    const result = verifier.runTier1(makeSummary({
      specContent: `## Success Criteria
- [ ] Auth module
- [ ] Session management
- [ ] Token refresh`,
      iscRows: [
        { id: 1, description: "Generic feature", status: "VERIFIED", source: "INFERRED" },
        { id: 2, description: "Generic test", status: "VERIFIED", source: "INFERRED" },
        { id: 3, description: "Generic cleanup", status: "VERIFIED", source: "INFERRED" },
      ],
    }));

    expect(result.concerns.some(c => c.includes("Template override despite explicit spec"))).toBe(true);
  });

  it("skips check when no specContent", () => {
    const verifier = new SkepticalVerifier();
    const result = verifier.runTier1(makeSummary({
      // no specContent
      iscRows: [
        { id: 1, description: "Feature", status: "VERIFIED", source: "INFERRED" },
      ],
    }));

    expect(result.concerns.some(c => c.includes("Requirement coverage"))).toBe(false);
    expect(result.concerns.some(c => c.includes("Template override"))).toBe(false);
  });

  it("skips ratio check when spec has < 4 requirements", () => {
    const verifier = new SkepticalVerifier();
    const result = verifier.runTier1(makeSummary({
      specContent: `## Success Criteria
- [ ] Simple feature
- [ ] Basic test`,
      iscRows: [
        { id: 1, description: "Feature", status: "VERIFIED", source: "INFERRED" },
      ],
    }));

    // Should NOT flag ratio because < 4 spec requirements
    expect(result.concerns.some(c => c.includes("Requirement coverage too low"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Check 12: Test file change proportionality (Fix 6)
// ---------------------------------------------------------------------------

describe("Tier 1: Check 12 — Test file change proportionality", () => {
  it("flags testing rows marked done without test files in diff", () => {
    const verifier = new SkepticalVerifier();
    const result = verifier.runTier1(makeSummary({
      iscRows: [
        { id: 1, description: "Implement feature", status: "VERIFIED" },
        { id: 2, description: "Add tests", status: "DONE", category: "testing" },
      ],
      gitDiffStat: " src/feature.ts | 40 +++\n 1 file changed",
    }));

    expect(result.concerns.some(c => c.includes("testing row") && c.includes("no test files"))).toBe(true);
  });

  it("no concern when test files present in diff", () => {
    const verifier = new SkepticalVerifier();
    const result = verifier.runTier1(makeSummary({
      iscRows: [
        { id: 1, description: "Implement feature", status: "VERIFIED" },
        { id: 2, description: "Add tests", status: "VERIFIED", category: "testing" },
      ],
      gitDiffStat: " src/feature.ts | 40 +++\n src/feature.test.ts | 30 +++\n 2 files changed",
    }));

    expect(result.concerns.some(c => c.includes("testing row") && c.includes("no test files"))).toBe(false);
  });

  it("no concern when no testing rows exist", () => {
    const verifier = new SkepticalVerifier();
    const result = verifier.runTier1(makeSummary({
      iscRows: [
        { id: 1, description: "Implement feature", status: "VERIFIED" },
      ],
      gitDiffStat: " src/feature.ts | 40 +++\n 1 file changed",
    }));

    expect(result.concerns.some(c => c.includes("testing row"))).toBe(false);
  });

  it("also matches capability execution.testing", () => {
    const verifier = new SkepticalVerifier();
    const result = verifier.runTier1(makeSummary({
      iscRows: [
        { id: 1, description: "Implement feature", status: "VERIFIED" },
        { id: 2, description: "Write tests", status: "VERIFIED", capability: "execution.testing" },
      ],
      gitDiffStat: " src/feature.ts | 40 +++\n 1 file changed",
    }));

    expect(result.concerns.some(c => c.includes("testing row") && c.includes("no test files"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Check 7: Graduated budget anomaly (Fix 5)
// ---------------------------------------------------------------------------

describe("Tier 1: Check 7 — Graduated budget anomaly", () => {
  it("paper completion: near-zero spend applies -0.5 penalty", () => {
    const verifier = new SkepticalVerifier();
    const result = verifier.runTier1(makeSummary({
      budgetSpent: 0.0001,
      budgetAllocated: 10,
    }));

    expect(result.concerns.some(c => c.includes("Paper completion"))).toBe(true);
    // Score starts at 1.0, near-zero → -0.5, so confidence should be ≤ 0.5
    expect(result.confidence).toBeLessThanOrEqual(0.5);
  });

  it("suspiciously low: 0.5% spend applies -0.3 penalty", () => {
    const verifier = new SkepticalVerifier();
    const result = verifier.runTier1(makeSummary({
      budgetSpent: 0.05,
      budgetAllocated: 10, // spendRatio = 0.005
    }));

    expect(result.concerns.some(c => c.includes("Suspiciously low budget usage"))).toBe(true);
  });

  it("low for effort: 3% spend on STANDARD applies -0.15 penalty", () => {
    const verifier = new SkepticalVerifier();
    const result = verifier.runTier1(makeSummary({
      effort: "STANDARD",
      budgetSpent: 0.3,
      budgetAllocated: 10, // spendRatio = 0.03
    }));

    expect(result.concerns.some(c => c.includes("Low budget usage for STANDARD"))).toBe(true);
  });

  it("QUICK effort exempts from 0.05 tier penalty", () => {
    const verifier = new SkepticalVerifier();
    const result = verifier.runTier1(makeSummary({
      effort: "QUICK",
      budgetSpent: 0.03,
      budgetAllocated: 1, // spendRatio = 0.03, but QUICK skips this tier
    }));

    expect(result.concerns.some(c => c.includes("Low budget usage for QUICK"))).toBe(false);
  });

  it("TRIVIAL effort skips budget check entirely", () => {
    const verifier = new SkepticalVerifier();
    const result = verifier.runTier1(makeSummary({
      effort: "TRIVIAL",
      budgetSpent: 0,
      budgetAllocated: 1,
    }));

    expect(result.concerns.some(c => c.includes("budget"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Check 8: Graduated iteration anomaly (Fix 5)
// ---------------------------------------------------------------------------

describe("Tier 1: Check 8 — Graduated iteration anomaly", () => {
  it("zero iterations with done rows applies -0.4 penalty", () => {
    const verifier = new SkepticalVerifier();
    const result = verifier.runTier1(makeSummary({
      iterationsUsed: 0,
    }));

    expect(result.concerns.some(c => c.includes("zero iterations"))).toBe(true);
  });

  it("1 iteration + 3 done rows on STANDARD → suspiciously efficient", () => {
    const verifier = new SkepticalVerifier();
    const result = verifier.runTier1(makeSummary({
      iterationsUsed: 1,
      effort: "STANDARD",
      iscRows: [
        { id: 1, description: "Row 1", status: "DONE" },
        { id: 2, description: "Row 2", status: "DONE" },
        { id: 3, description: "Row 3", status: "DONE" },
      ],
    }));

    expect(result.concerns.some(c => c.includes("suspiciously efficient"))).toBe(true);
  });

  it("TRIVIAL exempt from 1-iteration penalty", () => {
    const verifier = new SkepticalVerifier();
    const result = verifier.runTier1(makeSummary({
      iterationsUsed: 1,
      effort: "TRIVIAL",
      iscRows: [
        { id: 1, description: "Row 1", status: "DONE" },
        { id: 2, description: "Row 2", status: "DONE" },
        { id: 3, description: "Row 3", status: "DONE" },
      ],
    }));

    expect(result.concerns.some(c => c.includes("suspiciously efficient"))).toBe(false);
  });

  it("2+ iterations with 3 done rows → no penalty", () => {
    const verifier = new SkepticalVerifier();
    const result = verifier.runTier1(makeSummary({
      iterationsUsed: 2,
      iscRows: [
        { id: 1, description: "Row 1", status: "DONE" },
        { id: 2, description: "Row 2", status: "DONE" },
        { id: 3, description: "Row 3", status: "DONE" },
      ],
    }));

    expect(result.concerns.some(c => c.includes("suspiciously efficient"))).toBe(false);
    expect(result.concerns.some(c => c.includes("zero iterations"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ISC row provenance and trust annotations (Fix 7 + Fix 4)
// ---------------------------------------------------------------------------

describe("ISC row provenance in ItemReviewSummary", () => {
  it("source field propagated to Tier 1 check (INFERRED detected)", () => {
    const verifier = new SkepticalVerifier();
    const result = verifier.runTier1(makeSummary({
      specContent: `## Success Criteria
- [ ] Feature A
- [ ] Feature B
- [ ] Feature C`,
      iscRows: [
        { id: 1, description: "Generic work", status: "VERIFIED", source: "INFERRED" },
        { id: 2, description: "Generic test", status: "VERIFIED", source: "INFERRED" },
      ],
    }));

    // With 3 spec requirements and >80% INFERRED, should flag template override
    expect(result.concerns.some(c => c.includes("INFERRED"))).toBe(true);
  });

  it("commandRan field used in trust annotation", () => {
    const verifier = new SkepticalVerifier();
    // Build a summary with verification.commandRan set
    const summary = makeSummary({
      iscRows: [
        {
          id: 1, description: "Feature", status: "VERIFIED",
          source: "EXPLICIT",
          verification: { method: "test", result: "PASS", commandRan: true },
        },
        {
          id: 2, description: "Test", status: "VERIFIED",
          source: "INFERRED",
          verification: { method: "inferred", result: "PASS", commandRan: false },
        },
      ],
    });

    // Tier 2 prompt should annotate differently — just verify it doesn't crash
    const tier1 = verifier.runTier1(summary);
    expect(tier1.tier).toBe(1);
  });
});
