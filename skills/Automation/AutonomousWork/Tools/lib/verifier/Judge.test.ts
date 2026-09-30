/**
 * Judge.test.ts — Unit tests for the pure judge() function.
 */

import { describe, it, expect } from "bun:test";
import { judge } from "./Judge.ts";
import type { ItemReviewSummary, VerificationTier, InferenceFn } from "../../../Tools/SkepticalVerifier.ts";
import { PHASE_2_COST_ESTIMATE_USD } from "../../../Tools/SkepticalVerifier.ts";

function makeSummary(overrides: Partial<ItemReviewSummary> = {}): ItemReviewSummary {
  return {
    itemId: "test-judge-001",
    title: "Implement retry logic",
    description: "Add exponential backoff",
    effort: "STANDARD",
    priority: "MEDIUM",
    iscRows: [
      { id: 1, description: "Implement retry", status: "DONE" },
    ],
    gitDiffStat: " src/retry.ts | 50 +++++\n 1 file changed, 50 insertions(+)",
    executionLogTail: ["Row 1 completed"],
    iterationsUsed: 1,
    ...overrides,
  };
}

function makePhase1(overrides: Partial<VerificationTier> = {}): VerificationTier {
  return {
    tier: 1,
    verdict: "PASS",
    confidence: 0.9,
    concerns: [],
    costEstimate: 0,
    latencyMs: 5,
    ...overrides,
  };
}

const noopExtractSpec = (_: ItemReviewSummary): string => "";

describe("judge() pure function", () => {
  it("returns PASS verdict when inference succeeds and returns PASS", async () => {
    const mockInference: InferenceFn = async () => ({
      success: true,
      parsed: { verdict: "PASS", confidence: 0.95, concerns: [], recommendation: undefined },
    });

    const result = await judge(makeSummary(), makePhase1(), undefined, {
      inferenceFn: mockInference,
      extractSpecFn: noopExtractSpec,
    });

    expect(result.tier).toBe(2);
    expect(result.verdict).toBe("PASS");
    expect(result.confidence).toBe(0.95);
    expect(result.costEstimate).toBe(PHASE_2_COST_ESTIMATE_USD);
  });

  it("returns NEEDS_REVIEW when inference fails with timeout", async () => {
    const mockInference: InferenceFn = async () => {
      throw new Error("Request timeout");
    };

    const result = await judge(makeSummary(), makePhase1(), undefined, {
      inferenceFn: mockInference,
      extractSpecFn: noopExtractSpec,
    });

    expect(result.tier).toBe(2);
    expect(result.verdict).toBe("NEEDS_REVIEW");
    expect(result.concerns.some(c => c.includes("Phase 2 judgment unavailable"))).toBe(true);
    expect(result.costEstimate).toBe(0);
  });

  it("returns NEEDS_REVIEW when inference returns unparseable result", async () => {
    const mockInference: InferenceFn = async () => ({
      success: true,
      parsed: undefined,
      output: "bad output",
    });

    const result = await judge(makeSummary(), makePhase1(), undefined, {
      inferenceFn: mockInference,
      extractSpecFn: noopExtractSpec,
    });

    expect(result.tier).toBe(2);
    expect(result.verdict).toBe("NEEDS_REVIEW");
    expect(result.confidence).toBe(0.3);
  });
});
