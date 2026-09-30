/**
 * PhaseL.envblock.test.ts — an environment-blocked live verification (verification
 * could not RUN here) must surface a recognizable marker and block completion, but
 * NOT look like a code FAIL — so the pipeline re-stages instead of escalating to the
 * human board. Phase 6: the verifier path is exercised via SkepticalVerifier.review().
 */

import { test, expect, describe } from "bun:test";
import { SkepticalVerifier, type ItemReviewSummary, type InferenceFn, type LiveVerifyFn } from "./SkepticalVerifier.ts";
import { runPhaseL } from "./lib/verifier/PhaseL.ts";
import type { LiveVerificationResult, LiveVerifierInput } from "./LiveVerifier.ts";

function liveResult(over: Partial<LiveVerificationResult>): LiveVerificationResult {
  return {
    surface: "cli", effort: "STANDARD", verdict: "PASS", humanVerificationRequired: false,
    scenarios: [], scenariosRun: 1, scenariosPassed: 1, scenariosFailed: 0,
    edgeCasesExplored: 0, explorationTimeMs: 10, warnings: [], noEvidence: false, ...over,
  };
}

const throwingInference: InferenceFn = async () => {
  throw new Error("judge (Gate 3) must not run when verification was environment-blocked");
};

function summary(): ItemReviewSummary {
  const liveInput: LiveVerifierInput = {
    itemId: "i1", surface: "cli", effort: "STANDARD", workingDir: "/tmp/wt",
    specExcerpt: "does X", diffPaths: ["bin/x.ts"],
  };
  return {
    itemId: "i1", title: "t", description: "d", effort: "STANDARD", priority: "MEDIUM",
    iscRows: [
      {
        id: 1,
        description: "implement x",
        status: "VERIFIED",
        category: "testing",
        capability: "execution.testing",
        verification: { method: "test", result: "PASS", commandRan: true },
      },
    ],
    gitDiffStat: " bin/x.ts | 10 +\n bin/x.test.ts | 5 +\n 2 files changed, 15 insertions(+)",
    executionLogTail: [], iterationsUsed: 1,
    liveVerificationInput: liveInput,
  };
}

describe("runPhaseL environment block", () => {
  test("environmentBlocked → passed:false, environmentBlocked:true, marker concern, no harsh no-evidence framing", async () => {
    const outcome = await runPhaseL(summary().liveVerificationInput, async () =>
      liveResult({ verdict: "FAIL", environmentBlocked: true, scenarios: [], scenariosRun: 0, warnings: ["no allowlisted command"] }),
    );
    expect(outcome.ran).toBe(true);
    expect(outcome.passed).toBe(false);
    expect(outcome.environmentBlocked).toBe(true);
    expect(outcome.concerns.some((c) => c.includes("LIVE_VERIFICATION_ENVIRONMENT_BLOCK"))).toBe(true);
    // It must NOT masquerade as a "never ran it" code failure.
    expect(outcome.concerns.some((c) => c.includes("no live evidence"))).toBe(false);
  });
});

describe("review() with environment-blocked Phase L", () => {
  test("hard-blocks Gate 3 (verification did not happen) and carries the env-block marker", async () => {
    const liveVerifyFn: LiveVerifyFn = async () =>
      liveResult({ verdict: "FAIL", environmentBlocked: true, scenarios: [], scenariosRun: 0 });
    const verifier = new SkepticalVerifier({ inferenceFn: throwingInference, liveVerifyFn });
    const result = await verifier.review(summary());
    expect(result.finalVerdict).toBe("FAIL");
    expect(result.concerns.some((c) => c.includes("LIVE_VERIFICATION_ENVIRONMENT_BLOCK"))).toBe(true);
  });
});
