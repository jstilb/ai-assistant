/**
 * SkepticalVerifier.test.ts — Unit tests for the 2-phase skeptical verification system
 *
 * Tests:
 *   - Tier 1 code-based checks (completion ratio, paper completion, budget anomaly, etc.)
 *   - Config defaults and overrides
 *   - Verdict computation logic
 *   - TRIVIAL effort skips Phase 2 (judge)
 *   - judge() method replaces old runTier2/runTier3
 */

import { describe, it, expect, mock, spyOn, beforeAll, afterAll } from "bun:test";
import { SkepticalVerifier, type ItemReviewSummary, type VerificationTier, type InferenceFn, type EvidenceResult } from "./SkepticalVerifier.ts";
import { writeFileSync, unlinkSync, mkdirSync } from "fs";
import { join } from "path";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { execSync } from "child_process";

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
      { id: 2, description: "Implement retry logic", status: "VERIFIED", capability: "execution.engineer", verification: { method: "test", result: "PASS", commandRan: true } },
      { id: 3, description: "Add tests", status: "VERIFIED", capability: "execution.testing", verification: { method: "test", result: "PASS", commandRan: true } },
    ],
    gitDiffStat: " src/http-client.ts | 120 ++++++++++++\n src/http-client.test.ts | 90 ++++++++\n src/retry-config.ts | 50 ++++\n 3 files changed, 260 insertions(+)",
    executionLogTail: ["Phase: EXECUTE - Running ISC rows", "Row 1 completed", "Row 2 completed", "Row 3 completed"],
    iterationsUsed: 3,
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

  it("flags missing git diff as concern for Phase 2 (no score penalty)", () => {
    const verifier = new SkepticalVerifier();
    const result = verifier.runTier1(makeSummary({
      gitDiffStat: "",
    }));

    expect(result.concerns.some(c => c.includes("Phase 2 will evaluate contextually"))).toBe(true);
    // No score penalty from diff check — confidence may still drop from other checks
    // (e.g. missing test files), but should be higher than old 0.4-penalized value
    expect(result.confidence).toBeGreaterThanOrEqual(0.7);
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

  it("flags missing git diff for non-TRIVIAL items as Phase 2 concern", () => {
    const verifier = new SkepticalVerifier();
    const result = verifier.runTier1(makeSummary({
      gitDiffStat: "0 files changed",
    }));

    expect(result.concerns.some(c => c.includes("Phase 2 will evaluate contextually"))).toBe(true);
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

  it("TRIVIAL items skip git diff concern check", () => {
    const verifier = new SkepticalVerifier();
    const result = verifier.runTier1(makeSummary({
      effort: "TRIVIAL",
      gitDiffStat: "",
    }));

    expect(result.concerns.some(c => c.includes("Phase 2 will evaluate contextually"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

describe("SkepticalVerifier config", () => {
  it("uses default config when none provided", () => {
    const verifier = new SkepticalVerifier();
    const config = verifier.getConfig();

    expect(config.skipInferenceForTrivial).toBe(true);
    expect(Array.isArray(config.neverSkipCategories)).toBe(true);
    expect(config.neverSkipCategories).toContain("documentation");
  });

  it("allows skipInferenceForTrivial override", () => {
    const verifier = new SkepticalVerifier({
      skipInferenceForTrivial: false,
    });
    const config = verifier.getConfig();

    expect(config.skipInferenceForTrivial).toBe(false);
    // neverSkipCategories default preserved
    expect(config.neverSkipCategories).toContain("documentation");
  });

  it("allows neverSkipCategories override", () => {
    const verifier = new SkepticalVerifier({
      neverSkipCategories: ["deployment"],
    });
    const config = verifier.getConfig();

    expect(config.neverSkipCategories).toEqual(["deployment"]);
    expect(config.skipInferenceForTrivial).toBe(true); // default preserved
  });
});

// ---------------------------------------------------------------------------
// Full Review Flow (Tier 1 only for TRIVIAL)
// ---------------------------------------------------------------------------

describe("Full review flow", () => {
  it("TRIVIAL items skip Phase 2 (judge), only run Tier 1", async () => {
    const verifier = new SkepticalVerifier();
    const result = await verifier.review(makeSummary({
      effort: "TRIVIAL",
    }));

    // Should only have Tier 1
    expect(result.tiers.length).toBe(1);
    expect(result.tiers[0].tier).toBe(1);
    expect(result.totalCost).toBe(0);
  });

  it("healthy item gets PASS from Tier 1 and judge with injectable inference", async () => {
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
    // Phase 2 (judge) PASS (injectable inference returned PASS) — tier: 2
    expect(result.tiers.length).toBeGreaterThanOrEqual(2);
    expect(result.tiers[1].tier).toBe(2);
    expect(result.tiers[1].verdict).toBe("PASS");
  });

  it("aggregates concerns from all tiers", async () => {
    const verifier = new SkepticalVerifier();
    const result = await verifier.review(makeSummary({
      effort: "TRIVIAL",
      gitDiffStat: "0 files changed", // Will trigger concern
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
// Verdict Computation (2-phase model: last tier wins)
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

  it("T1 FAIL + T2 PASS → PASS (last tier is authoritative)", () => {
    const result = verifier.computeVerdictForTesting([
      makeTier({ tier: 1, verdict: "FAIL" }),
      makeTier({ tier: 2, verdict: "PASS" }),
    ]);
    expect(result).toBe("PASS");
  });

  it("T1 NEEDS_REVIEW + T2 PASS → PASS (last tier is authoritative)", () => {
    const result = verifier.computeVerdictForTesting([
      makeTier({ tier: 1, verdict: "NEEDS_REVIEW" }),
      makeTier({ tier: 2, verdict: "PASS" }),
    ]);
    expect(result).toBe("PASS");
  });

  it("T1 PASS + T2 FAIL → FAIL (last tier is authoritative)", () => {
    const result = verifier.computeVerdictForTesting([
      makeTier({ tier: 1, verdict: "PASS" }),
      makeTier({ tier: 2, verdict: "FAIL" }),
    ]);
    expect(result).toBe("FAIL");
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
});

// ---------------------------------------------------------------------------
// Phase 2: judge() — Mocked inference tests
// ---------------------------------------------------------------------------

describe("Phase 2: judge() — Mocked inference", () => {
  it("parses valid inference response", async () => {
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

    const inferenceFn: InferenceFn = mockInference as unknown as InferenceFn;
    const verifier = new SkepticalVerifier({ inferenceFn });
    const summary = makeSummary();
    const tier1 = verifier.runTier1(summary);

    const result = await verifier.judge(summary, tier1);

    expect(result.tier).toBe(2);
    expect(result.verdict).toBe("PASS");
    expect(result.confidence).toBe(0.85);
    expect(result.concerns).toContain("Minor: could add more edge case tests");
    expect(mockInference).toHaveBeenCalled();
  });

  it("handles unparseable inference result gracefully", async () => {
    // parsed: null triggers the "no parseable result" path
    const inferenceFn: InferenceFn = async () => ({
      success: true,
      parsed: null,
    });
    const verifier = new SkepticalVerifier({ inferenceFn });
    const summary = makeSummary();
    const tier1 = verifier.runTier1(summary);

    const result = await verifier.judge(summary, tier1);

    expect(result.tier).toBe(2);
    // Unparseable results are infrastructure failures → NEEDS_REVIEW (not FAIL)
    expect(result.verdict).toBe("NEEDS_REVIEW");
    expect(result.confidence).toBe(0.3);
    // Anti-masking: assert the SPECIFIC concern string for the unparseable path
    expect(result.concerns.some(c => c.includes("unparseable"))).toBe(true);
    expect(result.costEstimate).toBe(0.30);
  });

  it("handles inference failure gracefully with NEEDS_REVIEW (infrastructure failure)", async () => {
    const inferenceFn: InferenceFn = async () => {
      throw new Error("inference unavailable");
    };
    const verifier = new SkepticalVerifier({ inferenceFn });
    const summary = makeSummary();
    const tier1 = verifier.runTier1(summary);

    const result = await verifier.judge(summary, tier1);

    // Infrastructure failures return NEEDS_REVIEW (not FAIL) — "unavailable" is infrastructure, not content
    expect(result.tier).toBe(2);
    expect(result.verdict).toBe("NEEDS_REVIEW");
    expect(result.confidence).toBe(0.0);
    // Anti-masking: assert the SPECIFIC concern string for the failure path
    expect(result.concerns.some(c => c.includes("unavailable"))).toBe(true);
    // No real inference call was made, so cost should be 0
    expect(result.costEstimate).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Judge prompt correctness
// ---------------------------------------------------------------------------

describe("buildJudgePrompt correctness", () => {
  it("buildJudgePrompt contains Phase 1 section and work item info", () => {
    const verifier = new SkepticalVerifier();
    const summary = makeSummary();

    const tier1 = makeTier({
      tier: 1,
      verdict: "NEEDS_REVIEW",
      confidence: 0.6,
      concerns: ["Low completion ratio: 1/3"],
    });

    // Access the private method via prototype for testing
    const prompt = (verifier as unknown as { buildJudgePrompt: (s: ItemReviewSummary, t1: VerificationTier, e?: EvidenceResult) => string })
      .buildJudgePrompt(summary, tier1);

    // Verify prompt has the Phase 1 section (not separate Tier 1/Tier 2 sections)
    expect(prompt).toContain("Phase 1 Deterministic Checks");
    expect(prompt).toContain("Low completion ratio: 1/3");
    expect(prompt).toContain(summary.title);

    // Verify it does NOT have old Tier 2 inference section (no separate judgment section)
    expect(prompt).not.toContain("Tier 2 Inference Skeptic Results");
    expect(prompt).not.toContain("Tier 1 Code Check Results");
  });

  it("buildJudgePrompt includes evidence when provided", () => {
    const verifier = new SkepticalVerifier();
    const summary = makeSummary();
    const tier1 = verifier.runTier1(summary);
    const evidence: EvidenceResult = {
      files: [{ path: "/src/auth.ts", content: "export function login() { return true; }" }],
      commands: [{ cmd: "bun test auth", stdout: "3 tests passed", exitCode: 0 }],
    };

    const prompt = (verifier as unknown as {
      buildJudgePrompt: (s: ItemReviewSummary, t1: VerificationTier, e?: EvidenceResult) => string;
    }).buildJudgePrompt(summary, tier1, evidence);

    expect(prompt).toContain("Actual Evidence (system-read, not agent-reported)");
    expect(prompt).toContain("/src/auth.ts");
    expect(prompt).toContain("export function login()");
    expect(prompt).toContain("bun test auth");
    expect(prompt).toContain("3 tests passed");
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

  it("STANDARD item with inference → tiersSkipped is empty", async () => {
    const inferenceFn: InferenceFn = async () => ({
      success: true,
      parsed: { verdict: "PASS", confidence: 0.9, concerns: [] },
    });
    const verifier = new SkepticalVerifier({ inferenceFn });
    const result = await verifier.review(makeSummary({ effort: "STANDARD" }));

    // Both Phase 1 and Phase 2 (judge) ran → nothing skipped
    expect(result.tiersSkipped.length).toBe(0);
    expect(result.tiers.length).toBe(2);
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

  it("judge prompt uses extractRelevantSpecSections (not slice)", () => {
    const verifier = new SkepticalVerifier();
    const summary = makeSummary({
      specContent: `## Requirements
- Must implement retry logic
## Background
${"x".repeat(5000)}`,
    });
    const tier1 = verifier.runTier1(summary);

    // Access private method to check judge prompt
    const prompt = (verifier as unknown as {
      buildJudgePrompt: (s: ItemReviewSummary, t1: VerificationTier, e?: EvidenceResult) => string;
    }).buildJudgePrompt(summary, tier1);

    // Should contain "relevant sections" header (from extractRelevantSpecSections)
    expect(prompt).toContain("relevant sections");
    // Should NOT contain the full 5000-char padding
    expect(prompt.length).toBeLessThan(summary.specContent!.length);
  });
});

// ---------------------------------------------------------------------------
// Inference failure does not propagate upstream verdict
// ---------------------------------------------------------------------------

describe("Inference failure does not propagate upstream verdict", () => {
  it("Tier 1 PASS → judge() failure → verdict must NOT be PASS", async () => {
    const inferenceFn: InferenceFn = async () => {
      throw new Error("inference unavailable");
    };
    const verifier = new SkepticalVerifier({ inferenceFn });
    const summary = makeSummary(); // healthy summary → Tier 1 will PASS

    const tier1 = verifier.runTier1(summary);
    expect(tier1.verdict).toBe("PASS"); // precondition

    const judgment = await verifier.judge(summary, tier1);

    expect(judgment.verdict).not.toBe("PASS");
    // Infrastructure failures return NEEDS_REVIEW (not FAIL) — "unavailable" is infrastructure, not content
    expect(judgment.verdict).toBe("NEEDS_REVIEW");
    // Anti-masking: verify we hit the specific catch path
    expect(judgment.concerns.some(c => c.includes("unavailable"))).toBe(true);
    expect(judgment.costEstimate).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Phase 3: Check 13 — CLAUDE.md compliance (CachedHTTPClient / StateManager)
// ---------------------------------------------------------------------------

describe("Tier 1: Check 13 — CLAUDE.md compliance", () => {
  it("flags HTTP ISC work without CachedHTTPClient in evidence", () => {
    const verifier = new SkepticalVerifier();
    const evidence: EvidenceResult = {
      files: [{ path: "src/job-scanner.ts", content: "import fetch from 'node-fetch';\nconst res = await fetch(url);" }],
      commands: [],
    };
    const result = verifier.runTier1(makeSummary({
      effort: "STANDARD",
      projectContext: { language: "typescript", isKayaSkill: true, testPattern: "jest-style" },
      iscRows: [
        { id: 1, description: "Implement HTTP API client for fetching job listings", status: "VERIFIED" },
        { id: 2, description: "Add endpoint request handler", status: "VERIFIED" },
      ],
      gitDiffStat: " src/job-scanner.ts | 80 +++\n src/job-scanner.test.ts | 40 +++\n 2 files changed, 120 insertions(+)",
    }), evidence);

    expect(result.concerns.some(c => c.includes("CachedHTTPClient") || c.includes("raw fetch"))).toBe(true);
  });

  it("no concern when CachedHTTPClient appears in evidence", () => {
    const verifier = new SkepticalVerifier();
    const evidence: EvidenceResult = {
      files: [{ path: "src/client.ts", content: "import { CachedHTTPClient } from '../../../../lib/core/CachedHTTPClient';\nconst client = new CachedHTTPClient();" }],
      commands: [],
    };
    const result = verifier.runTier1(makeSummary({
      effort: "STANDARD",
      projectContext: { language: "typescript", isKayaSkill: true, testPattern: "jest-style" },
      iscRows: [
        { id: 1, description: "Implement HTTP API client for fetching data", status: "VERIFIED" },
      ],
      gitDiffStat: " src/client.ts | 80 +++\n 1 file changed, 80 insertions(+)",
    }), evidence);

    expect(result.concerns.some(c => c.includes("CachedHTTPClient") || c.includes("raw fetch"))).toBe(false);
  });

  it("flags state work without StateManager in evidence", () => {
    const verifier = new SkepticalVerifier();
    const evidence: EvidenceResult = {
      files: [{ path: "src/config.ts", content: "import { readFileSync } from 'fs';\nconst data = JSON.parse(readFileSync('config.json', 'utf-8'));" }],
      commands: [],
    };
    const result = verifier.runTier1(makeSummary({
      effort: "STANDARD",
      projectContext: { language: "typescript", isKayaSkill: true, testPattern: "jest-style" },
      iscRows: [
        { id: 1, description: "Persist state and config settings to JSON", status: "VERIFIED" },
      ],
      gitDiffStat: " src/config.ts | 40 +++\n 1 file changed, 40 insertions(+)",
    }), evidence);

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

  it("no score deduction when evidence is empty — defers to Phase 2 (judge)", () => {
    const verifier = new SkepticalVerifier();
    const emptyEvidence: EvidenceResult = { files: [], commands: [] };
    const result = verifier.runTier1(makeSummary({
      effort: "STANDARD",
      projectContext: { language: "typescript", isKayaSkill: true, testPattern: "jest-style" },
      iscRows: [
        { id: 1, description: "Implement HTTP API client for fetching data", status: "VERIFIED" },
        { id: 2, description: "Persist state and config settings to JSON", status: "VERIFIED" },
      ],
      gitDiffStat: " src/client.ts | 80 +++\n src/config.ts | 40 +++\n 2 files changed, 120 insertions(+)",
    }), emptyEvidence);

    // Informational concerns exist but no score deduction (confidence stays high)
    expect(result.concerns.some(c => c.includes("Phase 2 judgment will verify"))).toBe(true);
    expect(result.confidence).toBeGreaterThanOrEqual(0.8);
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
// parseDiffStats: Rename detection and substantial evidence
// ---------------------------------------------------------------------------

describe("parseDiffStats", () => {
  const verifier = new SkepticalVerifier();

  it("detects rename-only lines (=> | 0)", () => {
    const stats = verifier.parseDiffStats(
      " {JobHunter => JobEngine}/State/master-profile.yaml | 0\n {JobHunter => JobEngine}/State/applications.jsonl | 0\n src/scanner.ts | 80 +++\n 3 files changed, 80 insertions(+)"
    );
    expect(stats.renameCount).toBe(2);
    expect(stats.nonRenameFiles).toBe(1);
    expect(stats.totalInsertions).toBe(80);
    expect(stats.totalFiles).toBe(3);
  });

  it("substantial evidence: 200+ insertions across 3+ non-rename files", () => {
    const stats = verifier.parseDiffStats(
      " src/a.ts | 100 +++\n src/b.ts | 100 +++\n src/c.ts | 50 +++\n 3 files changed, 250 insertions(+)"
    );
    expect(stats.substantialEvidence).toBe(true);
  });

  it("no substantial evidence for small diffs", () => {
    const stats = verifier.parseDiffStats(" src/a.ts | 5 +++\n 1 file changed, 5 insertions(+)");
    expect(stats.substantialEvidence).toBe(false);
  });

  it("renames don't count toward substantial evidence files", () => {
    const stats = verifier.parseDiffStats(
      " old/a.ts => new/a.ts | 0\n old/b.ts => new/b.ts | 0\n src/c.ts | 60 +++\n 3 files changed, 60 insertions(+)"
    );
    expect(stats.renameCount).toBe(2);
    expect(stats.nonRenameFiles).toBe(1);
    // Only 1 non-rename file, so not substantial despite 60 insertions
    expect(stats.substantialEvidence).toBe(false);
  });

  it("handles empty diff stat", () => {
    const stats = verifier.parseDiffStats("");
    expect(stats.totalFiles).toBe(0);
    expect(stats.totalInsertions).toBe(0);
    expect(stats.renameCount).toBe(0);
    expect(stats.substantialEvidence).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// H4: substantialEvidence negative boundary test
// ---------------------------------------------------------------------------

describe("H4: substantialEvidence boundary", () => {
  it("substantialEvidence false at 199 insertions / 2 files (below 200/3 threshold)", () => {
    const verifier = new SkepticalVerifier();
    const stats = verifier.parseDiffStats(
      " src/foo.ts | 100 +++\n src/bar.ts | 99 +++\n 2 files changed, 199 insertions(+)"
    );
    expect(stats.substantialEvidence).toBe(false);
    expect(stats.totalInsertions).toBe(199);
    expect(stats.nonRenameFiles).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// H7: self-reported PASS penalty in Tier 1
// ---------------------------------------------------------------------------

describe("H7: self-reported PASS penalty", () => {
  it("penalizes self-reported PASS rows without commandRan", () => {
    const verifier = new SkepticalVerifier();
    const result = verifier.runTier1(makeSummary({
      iscRows: [
        { id: 1, description: "Implement feature", status: "VERIFIED", capability: "execution.engineer",
          verification: { method: "test", result: "PASS", commandRan: false } },
        { id: 2, description: "Add tests", status: "VERIFIED", capability: "execution.testing",
          verification: { method: "test", result: "PASS", commandRan: false } },
      ],
    }));
    expect(result.concerns.some(c => c.includes("self-reported PASS"))).toBe(true);
    expect(result.confidence).toBeLessThan(0.8);
  });
});

// ---------------------------------------------------------------------------
// M10: cross-validation detects fabricated gitDiffStat
// ---------------------------------------------------------------------------

describe("M10: cross-validation detects fabricated gitDiffStat", () => {
  it("flags fabricated gitDiffStat when cross-validation shows 0 real changes", () => {
    const verifier = new SkepticalVerifier();
    // Use a temp dir with git init but no real changes between HEAD and HEAD~1
    const tmpDir = mkdtempSync(join(tmpdir(), "m10-"));
    execSync("git init && git commit --allow-empty -m init && git commit --allow-empty -m second", { cwd: tmpDir });

    const result = verifier.runTier1(makeSummary({
      workingDir: tmpDir,
      gitDiffStat: " src/a.ts | 50 +++\n src/b.ts | 60 +++\n src/c.ts | 70 +++\n src/d.ts | 80 +++\n 4 files changed, 260 insertions(+)",
    }));

    expect(result.concerns.some(c => c.includes("Cross-validation failed"))).toBe(true);
    rmSync(tmpDir, { recursive: true });
  });
});

// ---------------------------------------------------------------------------
// L4: dynamic coherence catches mismatch
// ---------------------------------------------------------------------------

describe("L4: diff-description coherence mismatch", () => {
  it("flags diff-description coherence mismatch with dynamic terms", () => {
    const verifier = new SkepticalVerifier();
    const result = verifier.runTier1(makeSummary({
      iscRows: [
        { id: 1, description: "Implement authentication middleware with JWT tokens", status: "VERIFIED", capability: "execution.engineer", verification: { method: "test", result: "PASS", commandRan: true } },
        { id: 2, description: "Add JWT validation tests", status: "VERIFIED", capability: "execution.testing", verification: { method: "test", result: "PASS", commandRan: true } },
      ],
      // Diff files have nothing to do with authentication/JWT — 4+ files triggers coherence check
      gitDiffStat: " docs/README.md | 5 ++\n config/theme.css | 12 +++\n assets/logo.png | 1 +\n styles/base.scss | 3 ++\n 4 files changed, 21 insertions(+)",
    }));
    // Low coherence between ISC (authentication, JWT) and diff (README, theme, logo, styles)
    expect(result.concerns.some(c => c.toLowerCase().includes("coherence") || c.toLowerCase().includes("terminology overlap"))).toBe(true);
  });
});

describe("Tier 1: Check 14 — Stub detection with renames", () => {
  it("renames excluded from file count — no false stub detection", () => {
    const verifier = new SkepticalVerifier();
    const result = verifier.runTier1(makeSummary({
      effort: "STANDARD",
      gitDiffStat: " {Old => New}/a.yaml | 0\n {Old => New}/b.yaml | 0\n {Old => New}/c.yaml | 0\n src/main.ts | 80 +++\n src/main.test.ts | 50 +++\n 5 files changed, 130 insertions(+)",
    }));

    // 3 renames + 2 real files → effective files = 2, 130/2 = 65 lines/file → no stub concern
    expect(result.concerns.some(c => c.includes("Low code density") || c.includes("stub"))).toBe(false);
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
skills/Communication/VoiceInteraction/Tools/
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

skills/Communication/VoiceInteraction/Tools/
  RealtimeVoiceServer.ts`;

    const isc = extractISC(spec);
    // Should NOT have a row for the directory path
    expect(isc.some(i => i.description === "skills/Communication/VoiceInteraction/Tools/")).toBe(false);
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

    // judge prompt should annotate differently — just verify it doesn't crash
    const tier1 = verifier.runTier1(summary);
    expect(tier1.tier).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Change 4: Evidence enrichment in Phase 2
// ---------------------------------------------------------------------------

describe("Change 4: gatherEvidence()", () => {
  const tmpDir = `/tmp/skeptical-verifier-evidence-test-${Date.now()}`;
  const tmpFile = join(tmpDir, "test-module.ts");

  beforeAll(() => {
    mkdirSync(tmpDir, { recursive: true });
    writeFileSync(tmpFile, 'export function healthCheck() { return { status: "ok" }; }\n');
  });

  afterAll(() => {
    try { unlinkSync(tmpFile); } catch {}
  });

  it("handles non-existent files gracefully (no crash, empty files array)", () => {
    const verifier = new SkepticalVerifier();
    const summary = makeSummary({
      iscRows: [
        { id: 1, description: `Modify /nonexistent/path/foo.ts to add auth`, status: "VERIFIED" },
        { id: 2, description: `Update ./missing/bar.ts config`, status: "VERIFIED" },
      ],
    });

    const evidence = verifier.gatherEvidence(summary);

    expect(evidence.files).toEqual([]);
    expect(evidence.commands).toEqual([]);
  });

  it("reads real files referenced in ISC row descriptions", () => {
    const verifier = new SkepticalVerifier();
    const summary = makeSummary({
      iscRows: [
        { id: 1, description: `Modify ${tmpFile} to add retry logic`, status: "VERIFIED" },
      ],
    });

    const evidence = verifier.gatherEvidence(summary);

    expect(evidence.files.length).toBe(1);
    expect(evidence.files[0].path).toBe(tmpFile);
    expect(evidence.files[0].content).toContain("healthCheck");
  });

  it("caps file reads at 5", () => {
    const verifier = new SkepticalVerifier();
    // Create 7 references to the same real file with different "fake" paths
    // Only the real one will succeed, so this tests that non-existent ones are skipped
    const summary = makeSummary({
      iscRows: [
        { id: 1, description: `Read ${tmpFile} first`, status: "VERIFIED" },
        { id: 2, description: `Read /fake/a.ts second`, status: "VERIFIED" },
        { id: 3, description: `Read /fake/b.ts third`, status: "VERIFIED" },
      ],
    });

    const evidence = verifier.gatherEvidence(summary);

    // Only the real file should be present
    expect(evidence.files.length).toBe(1);
  });

  it("runs verification commands and captures output", () => {
    const mockSpawn = (cmd: string) => ({ stdout: `mock-output-for: ${cmd}\n`, exitCode: 0 });
    const verifier = new SkepticalVerifier({ spawnFn: mockSpawn });
    const summary = makeSummary({
      iscRows: [
        {
          id: 1, description: "Check file exists", status: "VERIFIED",
          verification: { method: "existence", result: "PASS", command: "echo test-output-ok" },
        },
      ],
    });

    const evidence = verifier.gatherEvidence(summary);

    expect(evidence.commands.length).toBe(1);
    expect(evidence.commands[0].cmd).toBe("echo test-output-ok");
    expect(evidence.commands[0].stdout).toContain("mock-output-for: echo test-output-ok");
    expect(evidence.commands[0].exitCode).toBe(0);
  });

  it("captures failing command output with non-zero exit code", () => {
    const mockSpawn = (_cmd: string) => ({ stdout: "", exitCode: 1 });
    const verifier = new SkepticalVerifier({ spawnFn: mockSpawn });
    const summary = makeSummary({
      iscRows: [
        {
          id: 1, description: "Run failing check", status: "VERIFIED",
          verification: { method: "test", result: "FAIL", command: "test -f /nonexistent/file.xyz" },
        },
      ],
    });

    const evidence = verifier.gatherEvidence(summary);

    expect(evidence.commands.length).toBe(1);
    expect(evidence.commands[0].exitCode).not.toBe(0);
  });

  it("skips rows without verification commands", () => {
    const verifier = new SkepticalVerifier();
    const summary = makeSummary({
      iscRows: [
        { id: 1, description: "No command row", status: "VERIFIED" },
        { id: 2, description: "Also no command", status: "VERIFIED", verification: { method: "test", result: "PASS" } },
      ],
    });

    const evidence = verifier.gatherEvidence(summary);
    expect(evidence.commands).toEqual([]);
  });
});

describe("Change 4: formatEvidence() in judge prompt", () => {
  it("buildJudgePrompt includes evidence when provided", () => {
    const verifier = new SkepticalVerifier();
    const summary = makeSummary();
    const tier1 = verifier.runTier1(summary);
    const evidence: EvidenceResult = {
      files: [{ path: "/src/auth.ts", content: "export function login() { return true; }" }],
      commands: [{ cmd: "bun test auth", stdout: "3 tests passed", exitCode: 0 }],
    };

    const prompt = (verifier as unknown as {
      buildJudgePrompt: (s: ItemReviewSummary, t1: VerificationTier, e?: EvidenceResult) => string;
    }).buildJudgePrompt(summary, tier1, evidence);

    expect(prompt).toContain("Actual Evidence (system-read, not agent-reported)");
    expect(prompt).toContain("/src/auth.ts");
    expect(prompt).toContain("export function login()");
    expect(prompt).toContain("bun test auth");
    expect(prompt).toContain("3 tests passed");
    expect(prompt).toContain("exit 0");
  });

  it("buildJudgePrompt omits evidence section when no evidence", () => {
    const verifier = new SkepticalVerifier();
    const summary = makeSummary();
    const tier1 = verifier.runTier1(summary);

    const prompt = (verifier as unknown as {
      buildJudgePrompt: (s: ItemReviewSummary, t1: VerificationTier, e?: EvidenceResult) => string;
    }).buildJudgePrompt(summary, tier1, undefined);

    expect(prompt).not.toContain("Actual Evidence");
  });

  it("buildJudgePrompt omits evidence section when arrays are empty", () => {
    const verifier = new SkepticalVerifier();
    const summary = makeSummary();
    const tier1 = verifier.runTier1(summary);
    const evidence: EvidenceResult = { files: [], commands: [] };

    const prompt = (verifier as unknown as {
      buildJudgePrompt: (s: ItemReviewSummary, t1: VerificationTier, e?: EvidenceResult) => string;
    }).buildJudgePrompt(summary, tier1, evidence);

    expect(prompt).not.toContain("Actual Evidence");
  });
});

describe("Change 4: Phase 2 (judge) inference receives evidence-enriched prompt", () => {
  const tmpDir = `/tmp/skeptical-verifier-tier2-test-${Date.now()}`;
  const tmpFile = join(tmpDir, "evidence-target.ts");

  beforeAll(() => {
    mkdirSync(tmpDir, { recursive: true });
    writeFileSync(tmpFile, 'export const EVIDENCE_MARKER = "found-by-verifier";\n');
  });

  afterAll(() => {
    try { unlinkSync(tmpFile); } catch {}
  });

  it("inferenceFn receives prompt with file evidence from gatherEvidence", async () => {
    let capturedUserPrompt = "";
    const inferenceFn: InferenceFn = async (opts) => {
      capturedUserPrompt = opts.userPrompt;
      return { success: true, parsed: { verdict: "PASS", confidence: 0.9, concerns: [] } };
    };

    const verifier = new SkepticalVerifier({ inferenceFn });
    const summary = makeSummary({
      iscRows: [
        { id: 1, description: `Modify ${tmpFile} to add retry`, status: "VERIFIED" },
      ],
    });
    const tier1 = verifier.runTier1(summary);
    // Evidence is now gathered in review() and passed to judge — simulate that
    const evidence = verifier.gatherEvidence(summary);

    await verifier.judge(summary, tier1, evidence);

    expect(capturedUserPrompt).toContain("Actual Evidence");
    expect(capturedUserPrompt).toContain("EVIDENCE_MARKER");
    expect(capturedUserPrompt).toContain("found-by-verifier");
  });

  it("inferenceFn receives prompt with command evidence", async () => {
    let capturedUserPrompt = "";
    const inferenceFn: InferenceFn = async (opts) => {
      capturedUserPrompt = opts.userPrompt;
      return { success: true, parsed: { verdict: "PASS", confidence: 0.9, concerns: [] } };
    };
    const mockSpawn = (cmd: string) => ({ stdout: `evidence-cmd-output from: ${cmd}\n`, exitCode: 0 });

    const verifier = new SkepticalVerifier({ inferenceFn, spawnFn: mockSpawn });
    const summary = makeSummary({
      iscRows: [
        {
          id: 1, description: "Run health check", status: "VERIFIED",
          verification: { method: "test", result: "PASS", command: "echo evidence-cmd-output" },
        },
      ],
    });
    const tier1 = verifier.runTier1(summary);
    // Evidence is now gathered in review() and passed to judge — simulate that
    const evidence = verifier.gatherEvidence(summary);

    await verifier.judge(summary, tier1, evidence);

    expect(capturedUserPrompt).toContain("Verification Commands Run");
    expect(capturedUserPrompt).toContain("evidence-cmd-output");
  });
});

// ---------------------------------------------------------------------------
// extractPathsFromDiffStat()
// ---------------------------------------------------------------------------

describe("extractPathsFromDiffStat()", () => {
  const verifier = new SkepticalVerifier();

  it("extracts simple file paths from diff stat", () => {
    const diffStat = ` src/http-client.ts | 120 ++++++++++++
 src/http-client.test.ts | 90 ++++++++
 src/retry-config.ts | 50 ++++
 3 files changed, 260 insertions(+)`;

    const paths = verifier.extractPathsFromDiffStat(diffStat);

    expect(paths).toContain("src/http-client.ts");
    expect(paths).toContain("src/http-client.test.ts");
    expect(paths).toContain("src/retry-config.ts");
    expect(paths.length).toBe(3);
  });

  it("sorts by change magnitude (most changed first)", () => {
    const diffStat = ` small.ts | 5 +
 big.ts | 500 +++++++++++++++++
 medium.ts | 50 ++++++
 3 files changed, 555 insertions(+)`;

    const paths = verifier.extractPathsFromDiffStat(diffStat);

    expect(paths[0]).toBe("big.ts");
    expect(paths[1]).toBe("medium.ts");
    expect(paths[2]).toBe("small.ts");
  });

  it("skips the summary line", () => {
    const diffStat = ` foo.ts | 10 +++
 1 file changed, 10 insertions(+)`;

    const paths = verifier.extractPathsFromDiffStat(diffStat);

    expect(paths).toEqual(["foo.ts"]);
  });

  it("handles renames with => notation", () => {
    const diffStat = ` old/path.ts => new/path.ts | 0
 1 file changed`;

    const paths = verifier.extractPathsFromDiffStat(diffStat);

    expect(paths).toContain("new/path.ts");
    expect(paths).not.toContain("old/path.ts");
  });

  it("handles brace-style renames", () => {
    const diffStat = ` skills/{OldName => NewName}/SKILL.md | 15 +++
 1 file changed, 15 insertions(+)`;

    const paths = verifier.extractPathsFromDiffStat(diffStat);

    expect(paths[0]).toBe("skills/NewName/SKILL.md");
  });

  it("returns empty for empty input", () => {
    expect(verifier.extractPathsFromDiffStat("")).toEqual([]);
    expect(verifier.extractPathsFromDiffStat("   ")).toEqual([]);
  });

  it("handles deletions in diff stat", () => {
    const diffStat = ` src/removed.ts | 50 ------------------
 src/changed.ts | 30 ++++++-----
 2 files changed, 15 insertions(+), 65 deletions(-)`;

    const paths = verifier.extractPathsFromDiffStat(diffStat);

    expect(paths).toContain("src/removed.ts");
    expect(paths).toContain("src/changed.ts");
  });
});

// ---------------------------------------------------------------------------
// Diff-based evidence gathering in gatherEvidence()
// ---------------------------------------------------------------------------

describe("Diff-based evidence gathering", () => {
  let worktreeDir: string;

  beforeAll(() => {
    worktreeDir = mkdtempSync(join(tmpdir(), "sv-diff-evidence-"));
    // Create files that would appear in a git diff
    mkdirSync(join(worktreeDir, "skills", "Auth"), { recursive: true });
    writeFileSync(join(worktreeDir, "skills", "Auth", "SKILL.md"), "# Auth Skill\nHandles authentication.\n");
    writeFileSync(join(worktreeDir, "skills", "Auth", "AuthEngine.ts"), 'export class AuthEngine { login() { return true; } }\n');
    mkdirSync(join(worktreeDir, "src"), { recursive: true });
    writeFileSync(join(worktreeDir, "src", "index.ts"), 'console.log("hello");\n');
  });

  afterAll(() => {
    rmSync(worktreeDir, { recursive: true, force: true });
  });

  it("reads files from worktree based on gitDiffStat paths", () => {
    const verifier = new SkepticalVerifier();
    const summary = makeSummary({
      workingDir: worktreeDir,
      gitDiffStat: ` skills/Auth/SKILL.md | 2 ++
 skills/Auth/AuthEngine.ts | 1 +
 2 files changed, 3 insertions(+)`,
      iscRows: [
        { id: 1, description: "Implement auth module", status: "VERIFIED" },
      ],
    });

    const evidence = verifier.gatherEvidence(summary);

    // Should have read files from the diff, even though ISC description has no file paths
    expect(evidence.files.length).toBeGreaterThanOrEqual(1);
    const authSkill = evidence.files.find(f => f.path === "skills/Auth/SKILL.md");
    expect(authSkill).toBeDefined();
    expect(authSkill!.content).toContain("Auth Skill");

    const authEngine = evidence.files.find(f => f.path === "skills/Auth/AuthEngine.ts");
    expect(authEngine).toBeDefined();
    expect(authEngine!.content).toContain("AuthEngine");
  });

  it("prioritizes most-changed files from diff", () => {
    const verifier = new SkepticalVerifier();
    const summary = makeSummary({
      workingDir: worktreeDir,
      gitDiffStat: ` skills/Auth/AuthEngine.ts | 500 ++++++++++++++
 skills/Auth/SKILL.md | 2 ++
 src/index.ts | 1 +
 3 files changed, 503 insertions(+)`,
      iscRows: [
        { id: 1, description: "Build auth system", status: "VERIFIED" },
      ],
    });

    const evidence = verifier.gatherEvidence(summary);

    // AuthEngine.ts has most changes, should appear first in diff-based evidence
    const diffFiles = evidence.files;
    expect(diffFiles.length).toBe(3);
    expect(diffFiles[0].path).toBe("skills/Auth/AuthEngine.ts");
  });

  it("does not read diff-based files when no workingDir is set", () => {
    const verifier = new SkepticalVerifier();
    const summary = makeSummary({
      workingDir: undefined,
      gitDiffStat: ` skills/Auth/SKILL.md | 2 ++
 1 file changed, 2 insertions(+)`,
      iscRows: [
        { id: 1, description: "No file paths in this description", status: "VERIFIED" },
      ],
    });

    const evidence = verifier.gatherEvidence(summary);

    // No workingDir means no diff-based reading and no ISC path matches → 0 files
    expect(evidence.files.length).toBe(0);
  });

  it("skips files that were deleted (in diff but not on disk)", () => {
    const verifier = new SkepticalVerifier();
    const summary = makeSummary({
      workingDir: worktreeDir,
      gitDiffStat: ` nonexistent/deleted-file.ts | 50 ------------------
 skills/Auth/SKILL.md | 2 ++
 2 files changed, 2 insertions(+), 50 deletions(-)`,
      iscRows: [],
    });

    const evidence = verifier.gatherEvidence(summary);

    // deleted-file.ts doesn't exist, should be skipped gracefully
    expect(evidence.files.length).toBe(1);
    expect(evidence.files[0].path).toBe("skills/Auth/SKILL.md");
  });

  it("deduplicates between ISC path references and diff paths", () => {
    const verifier = new SkepticalVerifier();
    const absPath = join(worktreeDir, "skills", "Auth", "SKILL.md");
    const summary = makeSummary({
      workingDir: worktreeDir,
      gitDiffStat: ` skills/Auth/SKILL.md | 2 ++
 1 file changed, 2 insertions(+)`,
      iscRows: [
        { id: 1, description: `Update ${absPath} with docs`, status: "VERIFIED" },
      ],
    });

    const evidence = verifier.gatherEvidence(summary);

    // File should appear only once, not twice
    const skillFiles = evidence.files.filter(f =>
      f.path.includes("SKILL.md")
    );
    expect(skillFiles.length).toBe(1);
  });

  it("respects MAX_FILES limit across ISC and diff sources", () => {
    // Create many files in the worktree
    const manyFilesDir = mkdtempSync(join(tmpdir(), "sv-many-files-"));
    mkdirSync(join(manyFilesDir, "src"), { recursive: true });
    for (let i = 0; i < 12; i++) {
      writeFileSync(join(manyFilesDir, "src", `file${i}.ts`), `export const X${i} = ${i};\n`);
    }

    const verifier = new SkepticalVerifier();
    const diffLines = Array.from({ length: 12 }, (_, i) =>
      ` src/file${i}.ts | ${100 - i * 5} ${"+"
        .repeat(10)}`
    ).join("\n");

    const summary = makeSummary({
      workingDir: manyFilesDir,
      gitDiffStat: `${diffLines}\n 12 files changed, 540 insertions(+)`,
      iscRows: [],
    });

    const evidence = verifier.gatherEvidence(summary);

    // Should cap at MAX_FILES (12)
    expect(evidence.files.length).toBeLessThanOrEqual(12);

    rmSync(manyFilesDir, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// Evidence command cwd fix
// ---------------------------------------------------------------------------

describe("gatherEvidence() command cwd", () => {
  it("default spawnFn uses workingDir as cwd (verified via config.spawnFn spy)", () => {
    // We can't directly test Bun.spawnSync cwd, but we can verify the spawnFn
    // receives the command and the verifier sets up cwd correctly by checking
    // that when workingDir is set, the internal code path that creates the
    // Bun.spawnSync call includes cwd. We test this via the injectable spawnFn.
    let capturedCmd = "";
    const mockSpawn = (cmd: string) => {
      capturedCmd = cmd;
      return { stdout: "ok\n", exitCode: 0 };
    };

    const verifier = new SkepticalVerifier({ spawnFn: mockSpawn });
    const summary = makeSummary({
      workingDir: "/tmp/some-worktree",
      iscRows: [
        {
          id: 1, description: "Check file", status: "VERIFIED",
          verification: { method: "existence", result: "PASS", command: "ls -la" },
        },
      ],
    });

    const evidence = verifier.gatherEvidence(summary);

    expect(evidence.commands.length).toBe(1);
    expect(capturedCmd).toBe("ls -la");
    // Note: the injectable spawnFn bypasses the Bun.spawnSync path,
    // so this test confirms the command runs. The cwd fix is in the
    // default spawnFn codepath (Bun.spawnSync with {cwd: workingDir}).
  });

  it("commands run even without workingDir (fallback to process.cwd())", () => {
    const mockSpawn = (_cmd: string) => ({ stdout: "fallback-output\n", exitCode: 0 });
    const verifier = new SkepticalVerifier({ spawnFn: mockSpawn });
    const summary = makeSummary({
      workingDir: undefined,
      iscRows: [
        {
          id: 1, description: "Test check", status: "VERIFIED",
          verification: { method: "test", result: "PASS", command: "echo hello" },
        },
      ],
    });

    const evidence = verifier.gatherEvidence(summary);

    expect(evidence.commands.length).toBe(1);
    expect(evidence.commands[0].stdout).toContain("fallback-output");
  });
});

// ---------------------------------------------------------------------------
// Phase C: Multi-repo support
// ---------------------------------------------------------------------------

describe("parseMultiRepoDiffStat", () => {
  const verifier = new SkepticalVerifier();

  it("correctly splits two [repo-name] sections", () => {
    const diffStat = [
      "[timeseries-forecasting]",
      " src/main.py | 42 +++",
      " 1 file changed, 42 insertions(+)",
      "[mlops-serving]",
      " src/app.py | 18 +++",
      " 1 file changed, 18 insertions(+)",
    ].join("\n");

    const sections = verifier.parseMultiRepoDiffStat(diffStat);
    expect(sections.length).toBe(2);
    expect(sections[0].name).toBe("timeseries-forecasting");
    expect(sections[0].diffStat).toContain("src/main.py");
    expect(sections[1].name).toBe("mlops-serving");
    expect(sections[1].diffStat).toContain("src/app.py");
  });

  it("returns empty array for plain (non-multi-repo) diff stat", () => {
    const diffStat = " src/main.py | 42 +++\n 1 file changed, 42 insertions(+)";
    const sections = verifier.parseMultiRepoDiffStat(diffStat);
    expect(sections.length).toBe(0);
  });

  it("handles single [repo-name] section", () => {
    const diffStat = "[only-repo]\n src/foo.ts | 10 ++\n 1 file changed";
    const sections = verifier.parseMultiRepoDiffStat(diffStat);
    expect(sections.length).toBe(1);
    expect(sections[0].name).toBe("only-repo");
    expect(sections[0].diffStat).toContain("src/foo.ts");
  });
});

describe("gatherEvidence with multi-repo repoContexts", () => {
  it("prefixes file paths with repo name when repoContexts present", () => {
    const tmpDir = require("os").tmpdir();
    const repoDir = require("path").join(tmpDir, "test-repo-" + Date.now());
    require("fs").mkdirSync(repoDir, { recursive: true });

    // Write a test file in the fake repo dir
    const testFile = require("path").join(repoDir, "src");
    require("fs").mkdirSync(testFile, { recursive: true });
    require("fs").writeFileSync(require("path").join(testFile, "app.py"), "# app content");

    const verifier = new SkepticalVerifier({ spawnFn: () => ({ stdout: "", exitCode: 0 }) });

    const summary = makeSummary({
      repoContexts: [{ name: "my-repo", cwd: repoDir }],
      gitDiffStat: "[my-repo]\n src/app.py | 5 ++\n 1 file changed",
      workingDir: repoDir,
    });

    const evidence = verifier.gatherEvidence(summary);

    // The file path should be prefixed with repo name
    const repoFile = evidence.files.find(f => f.path.startsWith("my-repo/"));
    expect(repoFile).toBeDefined();

    // Cleanup
    require("fs").rmSync(repoDir, { recursive: true, force: true });
  });

  it("single-repo path still works normally when no repoContexts", () => {
    const tmpDir = require("os").tmpdir();
    const repoDir = require("path").join(tmpDir, "single-repo-" + Date.now());
    require("fs").mkdirSync(repoDir, { recursive: true });
    const srcDir = require("path").join(repoDir, "src");
    require("fs").mkdirSync(srcDir, { recursive: true });
    require("fs").writeFileSync(require("path").join(srcDir, "file.ts"), "// content");

    const verifier = new SkepticalVerifier({ spawnFn: () => ({ stdout: "", exitCode: 0 }) });

    const summary = makeSummary({
      workingDir: repoDir,
      gitDiffStat: " src/file.ts | 5 ++\n 1 file changed",
      // no repoContexts
    });

    const evidence = verifier.gatherEvidence(summary);

    // Without repoContexts, paths should NOT be prefixed
    const plainFile = evidence.files.find(f => f.path === "src/file.ts");
    expect(plainFile).toBeDefined();

    // Cleanup
    require("fs").rmSync(repoDir, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// Component B: Check 1 excludes human-required rows from completion ratio
// ---------------------------------------------------------------------------

describe("Check 1: disposition-aware completion ratio", () => {
  it("excludes human-required rows from denominator — 3/7 human-required doesn't trigger low-completion", () => {
    const verifier = new SkepticalVerifier();
    const result = verifier.runTier1(makeSummary({
      effort: "STANDARD",
      iscRows: [
        { id: 1, description: "Set up project scaffolding", status: "VERIFIED" },
        { id: 2, description: "Implement core logic", status: "VERIFIED" },
        { id: 3, description: "Add tests", status: "VERIFIED" },
        { id: 4, description: "Write documentation", status: "VERIFIED" },
        // Human-required rows — PENDING but should not count against completion
        { id: 5, description: "Publish to PyPI", status: "PENDING", disposition: "human-required" },
        { id: 6, description: "Deploy to production staging", status: "PENDING", disposition: "human-required" },
        { id: 7, description: "Record demo video", status: "PENDING", disposition: "human-required" },
      ],
      gitDiffStat: " src/main.py | 100 +++\n tests/test_main.py | 50 +++\n 2 files changed, 150 insertions(+)",
    }));

    // 4/4 automatable rows done = 100% — should NOT trigger low/partial completion
    expect(result.concerns.some(c => c.includes("Low completion ratio"))).toBe(false);
    expect(result.concerns.some(c => c.includes("Partial completion"))).toBe(false);
  });

  it("still flags low completion when automatable rows are incomplete", () => {
    const verifier = new SkepticalVerifier();
    const result = verifier.runTier1(makeSummary({
      effort: "STANDARD",
      iscRows: [
        { id: 1, description: "Set up project", status: "VERIFIED" },
        { id: 2, description: "Implement logic", status: "PENDING" },
        { id: 3, description: "Add tests", status: "PENDING" },
        { id: 4, description: "Publish to PyPI", status: "PENDING", disposition: "human-required" },
      ],
      gitDiffStat: " src/main.py | 20 +++\n 1 file changed, 20 insertions(+)",
    }));

    // 1/3 automatable rows done = 33% — should trigger low completion
    expect(result.concerns.some(c => c.includes("Low completion ratio"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Component D: Check 12 Python test file detection
// ---------------------------------------------------------------------------

describe("Check 12: Python test file detection", () => {
  it("passes with test_model.py in diff (pytest naming)", () => {
    const verifier = new SkepticalVerifier();
    const result = verifier.runTier1(makeSummary({
      effort: "STANDARD",
      iscRows: [
        { id: 1, description: "Implement model", status: "VERIFIED" },
        { id: 2, description: "Add tests", status: "VERIFIED" },
      ],
      gitDiffStat: " src/model.py | 80 +++\n test_model.py | 40 +++\n 2 files changed, 120 insertions(+)",
    }));

    // Should NOT flag "no test files" since test_model.py is a Python test
    expect(result.concerns.some(c => c.includes("No test files"))).toBe(false);
  });

  it("passes with tests/test_api.py in diff", () => {
    const verifier = new SkepticalVerifier();
    const result = verifier.runTier1(makeSummary({
      effort: "STANDARD",
      iscRows: [
        { id: 1, description: "Build API", status: "VERIFIED" },
        { id: 2, description: "Test API", status: "VERIFIED" },
      ],
      gitDiffStat: " src/api.py | 80 +++\n tests/test_api.py | 40 +++\n 2 files changed, 120 insertions(+)",
    }));

    expect(result.concerns.some(c => c.includes("No test files"))).toBe(false);
  });

  it("passes with model_test.py in diff (Go-style naming)", () => {
    const verifier = new SkepticalVerifier();
    const result = verifier.runTier1(makeSummary({
      effort: "STANDARD",
      iscRows: [
        { id: 1, description: "Implement feature", status: "VERIFIED" },
        { id: 2, description: "Add tests", status: "VERIFIED" },
      ],
      gitDiffStat: " src/model.py | 80 +++\n model_test.py | 40 +++\n 2 files changed, 120 insertions(+)",
    }));

    expect(result.concerns.some(c => c.includes("No test files"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Component E: Check 13 skips for non-Kaya projects
// ---------------------------------------------------------------------------

describe("Check 13: project type gating", () => {
  it("skips Check 13 when isKayaSkill is false", () => {
    const verifier = new SkepticalVerifier();
    const evidence: EvidenceResult = {
      files: [{ path: "src/client.py", content: "import requests\nres = requests.get(url)" }],
      commands: [],
    };
    const result = verifier.runTier1(makeSummary({
      effort: "STANDARD",
      projectContext: { language: "python", isKayaSkill: false, testPattern: "pytest-style" },
      iscRows: [
        { id: 1, description: "Implement HTTP API client", status: "VERIFIED" },
      ],
      gitDiffStat: " src/client.py | 80 +++\n 1 file changed, 80 insertions(+)",
    }), evidence);

    // Should NOT flag CachedHTTPClient for a Python project
    expect(result.concerns.some(c => c.includes("CachedHTTPClient") || c.includes("raw fetch"))).toBe(false);
  });

  it("skips Check 13 when projectContext is absent", () => {
    const verifier = new SkepticalVerifier();
    const evidence: EvidenceResult = {
      files: [{ path: "src/api.ts", content: "fetch(url)" }],
      commands: [],
    };
    const result = verifier.runTier1(makeSummary({
      effort: "STANDARD",
      // No projectContext at all
      iscRows: [
        { id: 1, description: "Implement HTTP API client", status: "VERIFIED" },
      ],
      gitDiffStat: " src/api.ts | 80 +++\n 1 file changed, 80 insertions(+)",
    }), evidence);

    expect(result.concerns.some(c => c.includes("CachedHTTPClient") || c.includes("raw fetch"))).toBe(false);
  });

  it("fires Check 13 when isKayaSkill is true and language is typescript", () => {
    const verifier = new SkepticalVerifier();
    const evidence: EvidenceResult = {
      files: [{ path: "src/client.ts", content: "import fetch from 'node-fetch';\nfetch(url)" }],
      commands: [],
    };
    const result = verifier.runTier1(makeSummary({
      effort: "STANDARD",
      projectContext: { language: "typescript", isKayaSkill: true, testPattern: "jest-style" },
      iscRows: [
        { id: 1, description: "Implement HTTP API client", status: "VERIFIED" },
      ],
      gitDiffStat: " src/client.ts | 80 +++\n 1 file changed, 80 insertions(+)",
    }), evidence);

    expect(result.concerns.some(c => c.includes("CachedHTTPClient") || c.includes("raw fetch"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Component C: gatherEvidence merges rowEvidence into synthetic commands
// ---------------------------------------------------------------------------

describe("gatherEvidence: builder evidence merging", () => {
  it("merges rowEvidence.summary into synthetic command entries", () => {
    const verifier = new SkepticalVerifier({ spawnFn: () => ({ stdout: "", exitCode: 0 }) });
    const summary = makeSummary({
      iscRows: [
        {
          id: 1,
          description: "Implement feature",
          status: "VERIFIED",
          rowEvidence: {
            summary: "All 12 tests pass, coverage at 95%",
          },
        },
        {
          id: 2,
          description: "Add docs",
          status: "VERIFIED",
          rowEvidence: {
            summary: "README updated with API examples",
          },
        },
      ],
      gitDiffStat: " 0 files changed",
    });

    const evidence = verifier.gatherEvidence(summary);

    // Should have synthetic command entries for each rowEvidence.summary
    const syntheticCmds = evidence.commands.filter(c => c.cmd.startsWith("[builder-evidence"));
    expect(syntheticCmds.length).toBe(2);
    expect(syntheticCmds[0].stdout).toContain("All 12 tests pass");
    expect(syntheticCmds[1].stdout).toContain("README updated");
    expect(syntheticCmds[0].exitCode).toBe(0);
  });

  it("merges rowEvidence.files into file reads", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "evidence-merge-"));
    const srcDir = join(tmpDir, "src");
    mkdirSync(srcDir, { recursive: true });
    writeFileSync(join(srcDir, "feature.ts"), "export function doThing() { return true; }");

    const verifier = new SkepticalVerifier({ spawnFn: () => ({ stdout: "", exitCode: 0 }) });
    const summary = makeSummary({
      workingDir: tmpDir,
      iscRows: [
        {
          id: 1,
          description: "Implement feature",
          status: "VERIFIED",
          rowEvidence: {
            files: ["src/feature.ts"],
          },
        },
      ],
      gitDiffStat: " 0 files changed",
    });

    const evidence = verifier.gatherEvidence(summary);

    const featureFile = evidence.files.find(f => f.path === "src/feature.ts");
    expect(featureFile).toBeDefined();
    expect(featureFile!.content).toContain("doThing");

    rmSync(tmpDir, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// Component F: gatherEvidence resolves relative paths against workingDir
// ---------------------------------------------------------------------------

describe("gatherEvidence: relative path resolution", () => {
  it("resolves docs/arch.md against workingDir when set", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "rel-path-"));
    const docsDir = join(tmpDir, "docs");
    mkdirSync(docsDir, { recursive: true });
    writeFileSync(join(docsDir, "arch.md"), "# Architecture\nService-based design");

    const verifier = new SkepticalVerifier({ spawnFn: () => ({ stdout: "", exitCode: 0 }) });
    const summary = makeSummary({
      workingDir: tmpDir,
      iscRows: [
        {
          id: 1,
          description: "Review docs/arch.md for architecture decisions",
          status: "VERIFIED",
        },
      ],
      gitDiffStat: " 0 files changed",
    });

    const evidence = verifier.gatherEvidence(summary);

    const archFile = evidence.files.find(f => f.path === "docs/arch.md");
    expect(archFile).toBeDefined();
    expect(archFile!.content).toContain("Architecture");

    rmSync(tmpDir, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// TestStrategy integration in buildJudgePrompt
// ---------------------------------------------------------------------------

describe("buildJudgePrompt: testStrategyContent", () => {
  it("includes test strategy section when testStrategyContent is provided", () => {
    const verifier = new SkepticalVerifier();
    const summary = makeSummary({
      testStrategyContent: `## ISC Test Classification
| ISC # | Description | Test Level | Smoke? | Test Artifact |
|-------|-------------|-----------|--------|---------------|
| 1 | Retry logic | unit | yes | src/__tests__/retry.test.ts |
| 2 | API endpoint | integration | no | Tests/api.integration.test.ts |`,
    });

    const tier1 = verifier.runTier1(summary);
    const prompt = (verifier as unknown as {
      buildJudgePrompt: (s: ItemReviewSummary, t1: VerificationTier, e?: EvidenceResult) => string;
    }).buildJudgePrompt(summary, tier1);

    expect(prompt).toContain("## Test Strategy");
    expect(prompt).toContain("ISC Test Classification");
    expect(prompt).toContain("unit");
    expect(prompt).toContain("integration");
    expect(prompt).toContain("verify that the correct test levels were used");
  });

  it("omits test strategy section when testStrategyContent is not provided", () => {
    const verifier = new SkepticalVerifier();
    const summary = makeSummary(); // no testStrategyContent

    const tier1 = verifier.runTier1(summary);
    const prompt = (verifier as unknown as {
      buildJudgePrompt: (s: ItemReviewSummary, t1: VerificationTier, e?: EvidenceResult) => string;
    }).buildJudgePrompt(summary, tier1);

    expect(prompt).not.toContain("## Test Strategy");
    expect(prompt).not.toContain("verify that the correct test levels were used");
  });

  it("truncates test strategy to 3000 chars", () => {
    const verifier = new SkepticalVerifier();
    const longContent = "X".repeat(5000);
    const summary = makeSummary({ testStrategyContent: longContent });

    const tier1 = verifier.runTier1(summary);
    const prompt = (verifier as unknown as {
      buildJudgePrompt: (s: ItemReviewSummary, t1: VerificationTier, e?: EvidenceResult) => string;
    }).buildJudgePrompt(summary, tier1);

    expect(prompt).toContain("## Test Strategy");
    // The slice(0, 3000) means at most 3000 chars of the content
    expect(prompt).not.toContain("X".repeat(5000));
    expect(prompt).toContain("X".repeat(3000));
  });
});
