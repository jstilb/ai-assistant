/**
 * DeterministicFloor.test.ts — Unit tests for the deterministic floor pure function.
 */

import { describe, it, expect } from "bun:test";
import { applyDeterministicFloor } from "./DeterministicFloor.ts";
import type { VerificationTier } from "../../../Tools/SkepticalVerifier.ts";

function makeTier1(overrides: Partial<VerificationTier> = {}): VerificationTier {
  return {
    tier: 1,
    verdict: "PASS",
    confidence: 0.9,
    concerns: [],
    costEstimate: 0,
    latencyMs: 10,
    ...overrides,
  };
}

describe("applyDeterministicFloor", () => {
  it("caps PASS to NEEDS_REVIEW when Phase 1 has deterministic failures", () => {
    const concerns: string[] = [];
    const tiers: VerificationTier[] = [
      makeTier1({
        deterministicFailures: [{ checkName: "gate-a-test-failure", detail: "test suite failed" }],
      }),
    ];
    const result = applyDeterministicFloor(tiers, "PASS", concerns);
    expect(result).toBe("NEEDS_REVIEW");
    expect(concerns.some(c => c.includes("DeterministicFloor"))).toBe(true);
    expect(concerns.some(c => c.includes("gate-a-test-failure"))).toBe(true);
  });

  it("passes through when no deterministic failures", () => {
    const concerns: string[] = [];
    const tiers: VerificationTier[] = [makeTier1()];
    const result = applyDeterministicFloor(tiers, "PASS", concerns);
    expect(result).toBe("PASS");
    expect(concerns.length).toBe(0);
  });

  it("does not cap when verdict is already FAIL", () => {
    const concerns: string[] = [];
    const tiers: VerificationTier[] = [
      makeTier1({
        deterministicFailures: [{ checkName: "verification-fail-rate", detail: "rows failed" }],
      }),
    ];
    const result = applyDeterministicFloor(tiers, "FAIL", concerns);
    expect(result).toBe("FAIL");
    expect(concerns.length).toBe(0);
  });
});
